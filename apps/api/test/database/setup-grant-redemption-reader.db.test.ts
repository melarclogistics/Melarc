import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import type {
  DeliveryProvider,
  ProviderMessage,
} from '../../src/platform/auth/ports/delivery-provider.port.js';
import { SetupGrantStore } from '../../src/platform/auth/setup-grants/setup-grant-store.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { DeliveryWorker } from '../../src/platform/delivery/worker/delivery-worker.js';
import { redemptionReaderOver } from '../../src/platform/delivery/worker/redemption-record-reader.js';
import { SetupGrantRedemptionReader } from '../../src/platform/delivery/worker/setup-grant-redemption-reader.js';
import { createServiceLogger } from '../../src/platform/logging/create-logger.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import { SettingsReader } from '../../src/platform/settings/settings-reader.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { grantRow, insertGrant, setGrantState } from './support/credentials.js';
import { withHandle } from './support/handle.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.29 and obligation OB-119: the delivery worker's reader of a setup grant (`SetupGrantRedemptionReader`), as
 * `melarc_worker_runtime` under the `credential_delivery` capability, which holds `SELECT` on three columns of `setup_grant` and no
 * more ("state and expiry only, never the hash", data-scope-registry.md section 5.2). Then a real worker over the real queue, which
 * sends a grant's message only while the grant is still pending.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let work: BuiltService;
let reader: SetupGrantRedemptionReader;
const clock = new SystemClock();
const tokens = new Sha256TokenService();
const cipher = new AesGcmSecretCipher(localKeys());
const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 4, login: WORKER_RUNTIME_ROLE });
  reader = new SetupGrantRedemptionReader({ database: work.service, clock });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await work.close();
  await database.drop();
});

const ago = (minutes: number): Date => new Date(Date.now() - minutes * 60_000);
const standing = (id: string) => reader.standing({ type: 'SETUP_GRANT', id });

describe('the standing of a setup grant, as the worker reads it', () => {
  // Break caught: a live grant read as closed (a message that is never sent) or a closed one as live (a message for a dead link).
  it('is PENDING for a grant that can still be redeemed', async () => {
    const live = await insertGrant(admin, grantRow());
    const bootstrap = await insertGrant(admin, grantRow({ purpose: 'BOOTSTRAP_SETUP' }));

    expect(await standing(live.id)).toBe('PENDING');
    expect(await standing(bootstrap.id)).toBe('PENDING');
  });

  it.each([['CONSUMED'], ['SUPERSEDED']] as const)(
    'is CLOSED for a grant that was %s',
    async (state) => {
      const row = await insertGrant(admin, grantRow());
      await setGrantState(admin, row.id, state);

      expect(await standing(row.id)).toBe('CLOSED');
    },
  );

  it('is CLOSED for a grant that was marked EXPIRED', async () => {
    const row = await insertGrant(admin, grantRow({ issuedAt: ago(60), expiresAt: ago(30) }));
    await setGrantState(admin, row.id, 'EXPIRED');

    expect(await standing(row.id)).toBe('CLOSED');
  });

  // Break caught (plan section 3, "Time"): an expiry judged on the application's clock, or only on the state. A grant still PENDING
  // whose time has passed is closed, judged by the database in the read itself.
  it('is CLOSED for a PENDING grant whose expiry has passed on the database’s clock', async () => {
    const row = await insertGrant(admin, grantRow({ issuedAt: ago(60), expiresAt: ago(30) }));

    expect(await standing(row.id)).toBe('CLOSED');
  });

  it('judges the expiry at the instant itself: equality is closed', async () => {
    const row = await insertGrant(admin, grantRow());
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(`update setup_grant set expires_at = clock_timestamp() where id = $1`, [
        row.id,
      ]);
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }

    expect(await standing(row.id)).toBe('CLOSED');
  });

  // Break caught (SECURITY_DESIGN.md §13.9a: a reader that cannot find out "fails closed", it never reads a missing record as pending
  // and never as closed for good): no such grant is unconfirmed, and so is anything that is not an id.
  it('is UNCONFIRMED for a grant it cannot find, and for an id that is not one', async () => {
    expect(await standing(randomUUID())).toBe('UNCONFIRMED');
    expect(await standing('not-a-uuid')).toBe('UNCONFIRMED');
    expect(await standing('')).toBe('UNCONFIRMED');
  });

  it('answers for a setup grant only: another type of record is not its to read', async () => {
    const row = await insertGrant(admin, grantRow());

    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: row.id })).toBe('UNCONFIRMED');
  });

  // Break caught (the registry: "state and expiry only"): a read that selects more than the three columns the capability holds. It
  // would fail here with the privilege error; the reader is given only the worker's login, so this is the proof the columns are enough.
  it('reads only what the capability may read, under the worker’s own login', async () => {
    const row = await insertGrant(admin, grantRow());

    await expect(standing(row.id)).resolves.toBe('PENDING');
  });
});

describe('a worker that sends only while the grant is pending (OB-119)', () => {
  interface Sent {
    readonly dedupeId: string;
    readonly destination: string;
  }

  function rig() {
    const sent: Sent[] = [];
    const provider: DeliveryProvider = {
      send: (message: ProviderMessage) => {
        sent.push({ dedupeId: message.dedupeId, destination: message.destination });
        return Promise.resolve({ outcome: 'ACCEPTED', providerMessageRef: 'sent-1' } as const);
      },
      status: () => Promise.resolve(null),
    };
    const queue = new PostgresDeliveryQueue({ cipher, clock, work: work.service });
    const worker = new DeliveryWorker({
      queue,
      providers: { EMAIL: provider, SMS: provider },
      providerTimeoutMs: { EMAIL: 2_000, SMS: 2_000 },
      redemption: redemptionReaderOver({ SETUP_GRANT: reader }),
      clock,
      logger: createServiceLogger({
        service: 'melarc-delivery-worker',
        level: 'debug',
        appEnv: 'local',
        destination: { write: () => undefined },
      }),
      metrics: new BoundedMetrics({ policy: 'throw', clock }),
      workerId: 'setup-grant-reader-test',
      concurrency: 1,
      pollIntervalMs: 100,
      leaseMs: 30_000,
      jobBudgetMs: 25_000,
    });
    const store = new SetupGrantStore({ tokens, queue, settings: new SettingsReader(), clock });
    return { sent, worker, store };
  }

  const clear = async (): Promise<void> => {
    await admin.query(
      'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
    );
    await admin.query('delete from credential_delivery_job');
    await admin.query(
      'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
    );
  };

  // Break caught: the worker still unable to send for a real grant, which is what the unbuilt reader meant ("sends nothing and says so").
  it('sends the message of a pending grant, once, to the destination the issuer resolved', async () => {
    await clear();
    const { sent, worker, store } = rig();
    const destination = `new.staff.${randomUUID().slice(0, 8)}@example.test`;
    await withHandle(api.service, authentication, (handle) =>
      store.issue(handle, {
        principal: { type: 'STAFF', id: randomUUID() },
        purpose: 'STAFF_CREDENTIAL_SETUP',
        delivery: {
          kind: 'SETUP_GRANT',
          channel: 'EMAIL',
          destination,
          link: (token) => `https://ops.example.test/setup/credential#token=${token}`,
        },
      }),
    );

    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);

    expect(sent.map((message) => message.destination)).toEqual([destination]);
  });

  const issueWithMessage = (
    store: SetupGrantStore,
    destination: string,
    principal = { type: 'STAFF', id: randomUUID() } as const,
  ) =>
    withHandle(api.service, authentication, (handle) =>
      store.issue(handle, {
        principal,
        purpose: 'STAFF_CREDENTIAL_SETUP',
        delivery: {
          kind: 'SETUP_GRANT',
          channel: 'EMAIL',
          destination,
          link: (token) => `https://ops.example.test/setup/credential#token=${token}`,
        },
      }),
    );
  const jobState = async (grantId: string): Promise<string | undefined> =>
    (
      (
        await admin.query(
          `select state from credential_delivery_job where redemption_record_id = $1`,
          [grantId],
        )
      ).rows[0] as { state: string } | undefined
    )?.state;

  // Break caught (the reader is read "just before the send", on the database's clock): a message sent for a grant whose time has
  // passed while its job was still live. The job's own end is the grant's, so the clock the reader judges is what stops this send.
  it('sends nothing for a grant whose time has passed, and ends the job', async () => {
    await clear();
    const { sent, worker, store } = rig();
    const issued = await issueWithMessage(store, 'late.person@example.test');
    // Only the grant is aged: the job, which the claim judges by its own copy of the end, is still live when it is claimed.
    await admin.query('alter table setup_grant disable trigger setup_grant_update_guard');
    try {
      await admin.query(
        `update setup_grant set issued_at = issued_at - interval '2 hours', expires_at = expires_at - interval '2 hours' where id = $1`,
        [issued.grant.id],
      );
    } finally {
      await admin.query('alter table setup_grant enable trigger setup_grant_update_guard');
    }

    expect(await worker.runOnce()).toBe(true);

    expect(sent).toEqual([]);
    expect(['CANCELLED', 'EXPIRED']).toContain(await jobState(issued.grant.id));
  });

  // Break caught: a message sent for a grant that was consumed while its job was still live (the job is cancelled in the consuming
  // transaction, and a send already past the claim is dead because the reader reads the record again).
  it('sends nothing for a grant that was consumed behind the queue’s back', async () => {
    await clear();
    const { sent, worker, store } = rig();
    const issued = await issueWithMessage(store, 'consumed.person@example.test');
    await setGrantState(admin, issued.grant.id, 'CONSUMED');

    expect(await worker.runOnce()).toBe(true);

    expect(sent).toEqual([]);
    expect(['CANCELLED', 'EXPIRED']).toContain(await jobState(issued.grant.id));
  });

  // Break caught: the earlier message of a grant that was replaced still sent.
  it('sends the message of the later grant only, when a reissue replaced the earlier', async () => {
    await clear();
    const { sent, worker, store } = rig();
    const principal = { type: 'STAFF', id: randomUUID() } as const;
    await issueWithMessage(store, 'first@example.test', principal);
    await issueWithMessage(store, 'second@example.test', principal);

    await worker.runOnce();
    await worker.runOnce();

    expect(sent.map((message) => message.destination)).toEqual(['second@example.test']);
  });
});

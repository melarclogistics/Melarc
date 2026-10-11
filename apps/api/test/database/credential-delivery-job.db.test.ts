import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import type {
  DeliveryRequest,
  DeliveryJobRef,
} from '../../src/platform/auth/ports/delivery-queue.port.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import {
  decodeDeliveryPayload,
  deliveryPayloadContext,
} from '../../src/platform/delivery/delivery-payload.js';
import {
  DELIVERY_CHANNELS,
  DELIVERY_KINDS,
  DELIVERY_PRINCIPAL_TYPES,
  JOB_STATES,
  OUTCOME_CLASSES,
  REDEMPTION_RECORD_TYPES,
} from '../../src/platform/delivery/delivery-vocabulary.js';
import {
  DeliveryContextError,
  DeliveryNotQueueableError,
  DeliveryWorkerSideUnavailableError,
  LeaseLostError,
  UnreadableClaimError,
} from '../../src/platform/delivery/delivery-errors.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from './support/admin.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import {
  PRINCIPAL_1,
  PRINCIPAL_2,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
  HUB_A,
  RIDER_1,
  VENDOR_1,
} from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.17 against a real PostgreSQL: the durable credential-delivery job (`credential_delivery_job`, migration 0009) and the queue
 * over it, as `melarc_api_runtime` for the issuing side (a `SYSTEM` context under `authentication`) and `melarc_worker_runtime`
 * for the worker side (under `credential_delivery`, through the capability role it is given). State machine: state-machines.md
 * §22; SECURITY_DESIGN.md §13.9a. The redemption record is a stand-in table, because the real `setup_grant` and `recovery_request`
 * arrive in S0.29 and S0.50: it has what the job needs of one (an identity, a state and an end).
 *
 * The worker process, its schedule of retries and its shutdown are S0.18's, and the cleanup of material that has ended is S0.19's.
 */

const clock = new ManualClock(new Date('2026-10-10T08:00:00.000Z'));
const SENTINEL_TOKEN = 'SENTINEL-DELIVERY-TOKEN-7c41f0a2b9d3e8156a04c7b2d9e3f1a8';
const SENTINEL_DESTINATION = 'sentinel.recipient@example.test';

let database: TestDatabase;
let api: BuiltService;
let work: BuiltService;
let admin: Admin;
let observer: Observer;
let queue: PostgresDeliveryQueue;
const cipher = new AesGcmSecretCipher(localKeys());

const ISSUER: SecurityContext = systemContext('authentication');
const WORKER: SecurityContext = systemContext('credential_delivery');

beforeAll(async () => {
  database = await createTestDatabase();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 4, login: WORKER_RUNTIME_ROLE });
  admin = await openAdmin(database);
  observer = await observe(database);
  // The stand-in redemption record: an identity, a state and an end. The API writes it in the issuing transaction, as it will
  // write a setup grant; the job holds no reference to it, so nothing here can change it.
  await admin.query(`create table public.delivery_fixture_redemption (
      id uuid primary key, state text not null, expires_at timestamptz not null)`);
  await admin.query('alter table public.delivery_fixture_redemption owner to melarc_owner');
  await admin.query(
    `grant select, insert, update on public.delivery_fixture_redemption to ${API_RUNTIME_ROLE}`,
  );
  queue = new PostgresDeliveryQueue({
    cipher,
    clock,
    work: work.service,
    random: () => 0.5,
  });
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await api.close();
  await work.close();
  await database.drop();
});

// A test that fails midway leaves jobs behind, and the next must not claim them: every test begins with the table empty.
beforeEach(async () => {
  await admin.query('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
});

const inMinutes = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

interface Issued {
  readonly redemptionId: string;
  readonly job: DeliveryJobRef;
  readonly request: DeliveryRequest;
}

function requestFor(over: Partial<DeliveryRequest> = {}): DeliveryRequest {
  return {
    kind: 'SETUP_GRANT',
    redemption: { type: 'SETUP_GRANT', id: randomUUID() },
    principal: { type: 'STAFF', id: PRINCIPAL_1 },
    channel: 'EMAIL',
    destination: SENTINEL_DESTINATION,
    link: `https://ops.example.test/setup/credential#token=${SENTINEL_TOKEN}`,
    expiresAt: inMinutes(30),
    ...over,
  };
}

/** What an issuing operation does: write the redemption record and queue its message in one transaction of the API. */
async function issue(over: Partial<DeliveryRequest> = {}): Promise<Issued> {
  const request = requestFor(over);
  const job = await withHandle(api.service, ISSUER, async (handle, tx) => {
    await tx.execute(
      sql`insert into delivery_fixture_redemption (id, state, expires_at)
          values (${request.redemption.id}, 'PENDING', ${request.expiresAt.toISOString()}::timestamptz)`,
    );
    return queue.enqueue(handle, request);
  });
  return { redemptionId: request.redemption.id, job, request };
}

interface Row {
  readonly id: string;
  readonly kind: string;
  readonly redemption_record_type: string;
  readonly redemption_record_id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly channel: string;
  readonly state: string;
  readonly attempt_count: number;
  readonly deferred_claims: number;
  readonly lease_owner: string | null;
  readonly lease_version: number;
  readonly lease_expires_at: Date | null;
  readonly next_attempt_at: Date;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly provider_dedupe_id: string;
  readonly provider_message_ref: string | null;
  readonly outcome_class: string | null;
  readonly payload_ciphertext: Buffer | null;
  readonly payload_nonce: Buffer | null;
  readonly payload_key_version: number | null;
  readonly payload_envelope_version: number | null;
  readonly payload_erased_at: Date | null;
}

async function rowOf(id: string): Promise<Row> {
  const row = await observer.one<Row>('select * from credential_delivery_job where id = $1', [id]);
  if (row === undefined) throw new Error(`no job ${id}`);
  return row;
}

/** The SQLSTATE of what a statement raised, or `undefined` when it ran. */
async function stateOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code ?? `other: ${String(error)}`;
  }
}

/** Runs `statement` as the context and service given and returns the SQLSTATE it raised. */
function attempt(
  service: BuiltService,
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
): Promise<string | undefined> {
  return stateOf(withHandle(service.service, context, (_handle, tx) => tx.execute(statement)));
}

/** What a statement raised, as the SQLSTATE and the server's own words, or `undefined` when it ran. */
async function refusalOf(
  service: BuiltService,
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  try {
    await withHandle(service.service, context, (_handle, tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code ?? 'other', message: server?.message ?? String(error) };
  }
}

/**
 * What a statement raised when the API's login runs it with the delivery capability's label asserted by hand. The application does
 * not do that (it refuses that capability on the API's connection, `capability-access.ts`), so the table has to be able to hold its
 * line without the application's help.
 */
async function refusalAsForgedWorker(
  statement: ReturnType<typeof sql>,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  try {
    await withHandle(api.service, ISSUER, async (_handle, tx) => {
      await tx.execute(
        sql`select set_config('melarc.task_capability', 'credential_delivery', true)`,
      );
      await tx.execute(statement);
    });
    return undefined;
  } catch (error) {
    const server = serverErrorIn(error);
    return { code: server?.code ?? 'other', message: server?.message ?? String(error) };
  }
}

/** Makes a job's redemption record one that has ended: its end is in the past, and it was made before that. */
const makeOverdue = (id: string) =>
  arrange(
    `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
            created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
    [id],
  );

/**
 * Arranges a state that no operation can reach by itself (an old lease, a past expiry) as the administrator does: the guard that
 * keeps the table honest is switched off for the one statement, and back on.
 */
async function arrange(statement: string, values: unknown[] = []): Promise<void> {
  await admin.query(
    'alter table credential_delivery_job disable trigger credential_delivery_job_guard',
  );
  try {
    await admin.query(statement, values);
  } finally {
    await admin.query(
      'alter table credential_delivery_job enable trigger credential_delivery_job_guard',
    );
  }
}

/** What ends a job's payload: the sealed fields set to nothing and the time it was erased. */
const eraseSealedSql = `payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
          payload_envelope_version = null, payload_erased_at = clock_timestamp()`;

/** Makes the lease of a job one that has ended, as the database's clock sees it. */
const endLease = (id: string) =>
  arrange(
    `update credential_delivery_job set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [id],
  );

/** Makes a job due now. */
const makeDue = (id: string) =>
  arrange(
    `update credential_delivery_job set next_attempt_at = clock_timestamp() - interval '1 second' where id = $1`,
    [id],
  );

/** Claims the next due job with a lease long enough for a test, or fails the test. */
async function claimOne(workerId = 'dw-test-1', leaseMs = 30_000) {
  const claimed = await queue.claim(workerId, leaseMs);
  if (claimed === null) throw new Error('expected a due job');
  return claimed;
}

/** Leaves no job that could be claimed by a later test, whatever an earlier one made. */
async function clearJobs(): Promise<void> {
  await arrange('delete from credential_delivery_job');
  await admin.query('delete from delivery_fixture_redemption');
}

describe('the table and its grants', () => {
  // Break caught: a table that exists for a moment without its owner, or with row-level security off or not forced.
  it('is owned by the owner, with row-level security enabled and forced', async () => {
    const row = await observer.one<Record<string, unknown>>(
      `select pg_get_userbyid(relowner) as owner, relrowsecurity, relforcerowsecurity
         from pg_class where relname = 'credential_delivery_job' and relkind = 'r'`,
    );
    expect(row).toEqual({
      owner: 'melarc_owner',
      relrowsecurity: true,
      relforcerowsecurity: true,
    });
  });

  // Break caught: a closed set of the code that the table does not hold, or the table holding one the code does not know: the two
  // are compared, so neither can change alone.
  it('repeats every closed set of the vocabulary as a CHECK, with exactly the same members', async () => {
    const definitions = await observer.rows<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'credential_delivery_job'::regclass and contype = 'c'`,
    );
    const members = (name: string): string[] => {
      const def = definitions.find((row) => row.conname === `credential_delivery_job_${name}`)?.def;
      if (def === undefined) throw new Error(`no constraint ${name}`);
      // PostgreSQL prints IN (...) as = ANY (ARRAY[...]); the members are the quoted words of the definition, in order.
      return [...def.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1] ?? '');
    };
    expect(members('kind_closed')).toEqual([...DELIVERY_KINDS]);
    expect(members('redemption_type_closed')).toEqual([...REDEMPTION_RECORD_TYPES]);
    expect(members('principal_closed')).toEqual([...DELIVERY_PRINCIPAL_TYPES]);
    expect(members('channel_closed')).toEqual([...DELIVERY_CHANNELS]);
    expect(members('state_closed')).toEqual([...JOB_STATES]);
    expect(members('outcome_class_closed')).toEqual([...OUTCOME_CLASSES]);
  });

  const COLUMNS = [
    'id',
    'kind',
    'redemption_record_type',
    'redemption_record_id',
    'principal_type',
    'principal_id',
    'channel',
    'state',
    'attempt_count',
    'next_attempt_at',
    'expires_at',
    'accepted_at',
    'lease_owner',
    'lease_version',
    'lease_expires_at',
    'provider_dedupe_id',
    'provider_message_ref',
    'outcome_class',
    'payload_ciphertext',
    'payload_nonce',
    'payload_key_version',
    'payload_envelope_version',
    'payload_erased_at',
    'created_at',
    'deferred_claims',
  ] as const;

  async function privileges(role: string, privilege: string): Promise<string[]> {
    const held: string[] = [];
    for (const column of COLUMNS) {
      const row = await observer.one<{ held: boolean }>(
        `select has_column_privilege($1, 'public.credential_delivery_job', $2, $3) as held`,
        [role, column, privilege],
      );
      if (row?.held === true) held.push(column);
    }
    return held;
  }

  // Break caught: the API able to read what it queued (the destination and the token are in the payload), to lease a job, or to change
  // anything about a job but what a cancellation changes. It reads the five columns that find a row to cancel it (not even the job's
  // own identifier, which no statement of the API reads), and updates the seven that a cancellation sets.
  it('gives the API runtime the columns that insert, find and cancel a job, and not the payload or the lease', async () => {
    expect(await privileges(API_RUNTIME_ROLE, 'SELECT')).toEqual([
      'redemption_record_type',
      'redemption_record_id',
      'principal_type',
      'principal_id',
      'state',
    ]);
    expect(await privileges(API_RUNTIME_ROLE, 'UPDATE')).toEqual([
      'state',
      'outcome_class',
      'payload_ciphertext',
      'payload_nonce',
      'payload_key_version',
      'payload_envelope_version',
      'payload_erased_at',
    ]);
    expect(await privileges(API_RUNTIME_ROLE, 'INSERT')).toEqual([...COLUMNS]);
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      const row = await observer.one<{ held: boolean }>(
        `select has_table_privilege($1, 'public.credential_delivery_job', $2) as held`,
        [API_RUNTIME_ROLE, privilege],
      );
      expect(row?.held, privilege).toBe(false);
    }
  });

  // Break caught: the worker able to queue a message of its own, to rewrite what a job is, or to remove one.
  it('gives the worker login, through its capability, the row to read and the columns a lease and an outcome change, and no insert or delete', async () => {
    expect(await privileges(WORKER_RUNTIME_ROLE, 'SELECT')).toEqual([...COLUMNS]);
    expect(await privileges(WORKER_RUNTIME_ROLE, 'UPDATE')).toEqual([
      'state',
      'attempt_count',
      'next_attempt_at',
      'accepted_at',
      'lease_owner',
      'lease_version',
      'lease_expires_at',
      'provider_message_ref',
      'outcome_class',
      'payload_ciphertext',
      'payload_nonce',
      'payload_key_version',
      'payload_envelope_version',
      'payload_erased_at',
      'deferred_claims',
    ]);
    expect(await privileges(WORKER_RUNTIME_ROLE, 'INSERT')).toEqual([]);
    for (const privilege of ['DELETE', 'TRUNCATE']) {
      const row = await observer.one<{ held: boolean }>(
        `select has_table_privilege($1, 'public.credential_delivery_job', $2) as held`,
        [WORKER_RUNTIME_ROLE, privilege],
      );
      expect(row?.held, privilege).toBe(false);
    }
  });

  // Break caught: the API reading the payload it inserted (the destination and the token) by naming the column or by `select *`.
  it('refuses the API a read of the payload, of the lease, and of the whole row', async () => {
    const issued = await issue();
    for (const statement of [
      sql`select payload_ciphertext from credential_delivery_job`,
      sql`select lease_owner from credential_delivery_job`,
      sql`select provider_dedupe_id from credential_delivery_job`,
      sql`select * from credential_delivery_job`,
    ]) {
      expect(await attempt(api, ISSUER, statement)).toBe('42501');
    }
    // What it may read is what finds a row.
    expect(
      await withHandle(api.service, ISSUER, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select state from credential_delivery_job
               where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${issued.request.redemption.id}`,
        );
        return (result.rows[0] as { state: string }).state;
      }),
    ).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: a job tied to another table by a key, or a trigger that does more than guard the job: a job's state could then
  // change a redemption record (the credential's validity is the record's alone, state-machines.md section 22). The real record
  // tables arrive in S0.29 and S0.50; what keeps a job from touching one is that nothing joins the two.
  it('is tied to no other table, and the only thing that runs when a job changes is a guard that reads and writes nothing else', async () => {
    expect(
      await observer.one<{ n: number }>(
        `select count(*)::int as n from pg_constraint
          where contype = 'f'
            and (conrelid = 'credential_delivery_job'::regclass or confrelid = 'credential_delivery_job'::regclass)`,
      ),
    ).toEqual({ n: 0 });
    expect(
      (
        await observer.rows<{ tgname: string }>(
          `select tgname from pg_trigger where tgrelid = 'credential_delivery_job'::regclass and not tgisinternal`,
        )
      ).map((row) => row.tgname),
    ).toEqual(['credential_delivery_job_guard']);
    const body = await observer.one<{ prosrc: string }>(
      `select prosrc from pg_proc where oid = 'melarc.credential_delivery_job_guard'::regproc`,
    );
    // Comments, the words of its messages and the comparison IS DISTINCT FROM are not statements on a table: what is left is conditions on
    // the row and the raising of errors.
    const code = (body?.prosrc ?? '')
      .replace(/--.*$/gm, '')
      .replace(/'[^']*'/g, "''")
      .replace(/IS (NOT )?DISTINCT FROM/gi, '');
    expect(code).toContain('RAISE EXCEPTION');
    expect(code).not.toMatch(/\b(insert|update|delete|select|from|join|perform|execute)\b/i);
  });
});

describe('queueing a message beside its redemption record', () => {
  // Break caught: a message that is not queued with the shape the state machine starts from, or one that holds more than the
  // document says a job holds, or that loses the stable deduplication identity a retry must reuse.
  it('queues a job that is QUEUED, due now, unleased, with the record it serves and its stable provider identity', async () => {
    const issued = await issue({
      kind: 'RECOVERY_LINK',
      redemption: { type: 'RECOVERY_REQUEST', id: randomUUID() },
      principal: { type: 'VENDOR', id: PRINCIPAL_2 },
      channel: 'SMS',
      destination: '+233201234567',
    });
    const row = await rowOf(issued.job.id);

    expect(row).toMatchObject({
      id: issued.job.id,
      kind: 'RECOVERY_LINK',
      redemption_record_type: 'RECOVERY_REQUEST',
      redemption_record_id: issued.request.redemption.id,
      principal_type: 'VENDOR',
      principal_id: PRINCIPAL_2,
      channel: 'SMS',
      state: 'QUEUED',
      attempt_count: 0,
      lease_owner: null,
      lease_version: 0,
      lease_expires_at: null,
      accepted_at: null,
      provider_message_ref: null,
      outcome_class: null,
      payload_erased_at: null,
      provider_dedupe_id: issued.job.providerDedupeId,
      payload_envelope_version: 1,
      payload_key_version: 1,
    });
    // The job ends when the redemption record does, to the millisecond, and is due at once: judged on the database's own clock,
    // because the host's and the server's differ (by tens of milliseconds on this machine, measured on 10 October 2026).
    expect(row.expires_at.getTime()).toBe(issued.request.expiresAt.getTime());
    expect(
      await observer.one<{ due: boolean }>(
        'select next_attempt_at <= clock_timestamp() as due from credential_delivery_job where id = $1',
        [issued.job.id],
      ),
    ).toEqual({ due: true });
    expect(issued.job.providerDedupeId.length).toBeGreaterThanOrEqual(16);
    await clearJobs();
  });

  // Break caught: the destination or the token stored in the clear, in the row's text or in its bytes (Family U sentinel).
  it('stores neither the destination nor the token anywhere in the row, as text or as bytes', async () => {
    const issued = await issue();
    const row = await observer.one<{ stored: string; hex: string }>(
      `select credential_delivery_job::text as stored,
              encode(convert_to(credential_delivery_job::text, 'UTF8'), 'hex') as hex
         from credential_delivery_job where id = $1`,
      [issued.job.id],
    );
    for (const secret of [
      SENTINEL_TOKEN,
      SENTINEL_DESTINATION,
      'ops.example.test',
      'sentinel.recipient',
    ]) {
      expect(row?.stored, secret).not.toContain(secret);
      expect(row?.hex, secret).not.toContain(Buffer.from(secret).toString('hex'));
    }
    const sealed = await rowOf(issued.job.id);
    expect(sealed.payload_ciphertext?.toString('latin1')).not.toContain(SENTINEL_TOKEN);
    await clearJobs();
  });

  // Break caught: a payload that opens under the wrong binding, or that can be moved to another row: the document binds the job id,
  // the kind, the principal and the redemption record as associated data.
  it('seals the payload to the job, the kind, the principal and the record: it opens for them and for nothing else', async () => {
    const first = await issue();
    const second = await issue();
    const a = await rowOf(first.job.id);
    const binding = {
      jobId: a.id,
      kind: 'SETUP_GRANT' as const,
      principal: { type: 'STAFF', id: a.principal_id },
      redemption: { type: 'SETUP_GRANT' as const, id: a.redemption_record_id },
    };
    const sealed = {
      envelopeVersion: Number(a.payload_envelope_version),
      keyVersion: Number(a.payload_key_version),
      nonce: new Uint8Array(a.payload_nonce ?? []),
      ciphertext: new Uint8Array(a.payload_ciphertext ?? []),
    };

    const opened = decodeDeliveryPayload(
      await cipher.open('DELIVERY_PAYLOAD', sealed, deliveryPayloadContext(binding)),
    );
    expect(opened).toEqual({ destination: SENTINEL_DESTINATION, link: first.request.link });

    for (const other of [
      { ...binding, jobId: second.job.id },
      { ...binding, kind: 'MFA_REENROLMENT' as const },
      { ...binding, principal: { type: 'VENDOR', id: a.principal_id } },
      { ...binding, principal: { type: 'STAFF', id: PRINCIPAL_2 } },
      { ...binding, redemption: { type: 'SETUP_GRANT' as const, id: second.redemptionId } },
    ]) {
      await expect(
        cipher.open('DELIVERY_PAYLOAD', sealed, deliveryPayloadContext(other)),
      ).rejects.toMatchObject({ condition: 'AUTHENTICATION_FAILED' });
    }
    // The wrong purpose does not open it either.
    await expect(
      cipher.open('REPLAY_SECRET', sealed, deliveryPayloadContext(binding)),
    ).rejects.toMatchObject({ condition: 'AUTHENTICATION_FAILED' });
    await clearJobs();
  });

  // Break caught: a payload sealed to one kind of message and opened for another. Every kind is bound by its own, so the worker that
  // opens a recovery link, a device grant or a re-enrolment link finds what the issuer sealed.
  it.each([
    ['SETUP_GRANT', 'SETUP_GRANT'],
    ['RECOVERY_LINK', 'RECOVERY_REQUEST'],
    ['DEVICE_GRANT', 'SETUP_GRANT'],
    ['MFA_REENROLMENT', 'SETUP_GRANT'],
  ] as const)('queues a message of kind %s, and the worker opens it', async (kind, recordType) => {
    const issued = await issue({ kind, redemption: { type: recordType, id: randomUUID() } });

    const claimed = await claimOne();

    expect(claimed).toMatchObject({ job: { id: issued.job.id }, kind });
    expect(claimed.request).toMatchObject({
      kind,
      redemption: { type: recordType },
      destination: SENTINEL_DESTINATION,
      link: issued.request.link,
    });
    await clearJobs();
  });

  // Break caught: an enqueue that outlives its transaction (a message sent for a credential that was never issued), or a
  // redemption record that stays when its message is rolled back with it. GBT: the two commit together or not at all.
  it('rolls back with its transaction: neither the job nor the redemption record remains', async () => {
    const request = requestFor();
    const failure = new Error('the issuing operation failed after queueing');
    await expect(
      withHandle(api.service, ISSUER, async (handle, tx) => {
        await tx.execute(
          sql`insert into delivery_fixture_redemption (id, state, expires_at)
              values (${request.redemption.id}, 'PENDING', ${request.expiresAt.toISOString()}::timestamptz)`,
        );
        await queue.enqueue(handle, request);
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(
      await observer.count('credential_delivery_job', {
        redemption_record_id: request.redemption.id,
      }),
    ).toBe(0);
    expect(await observer.count('delivery_fixture_redemption', { id: request.redemption.id })).toBe(
      0,
    );
  });

  // Break caught: a second message for one redemption record ("one queued message per redemption record"), or the second attempt
  // damaging the first.
  it('queues one message per redemption record and leaves the first alone when a second is refused', async () => {
    const first = await issue();
    const before = await rowOf(first.job.id);

    const error = await withHandle(api.service, ISSUER, (handle) =>
      queue.enqueue(handle, { ...first.request, link: `${first.request.link}-again` }),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DeliveryNotQueueableError);
    expect(error).toMatchObject({ code: 'DELIVERY_NOT_QUEUEABLE', reason: 'ALREADY_QUEUED' });
    expect(await rowOf(first.job.id)).toEqual(before);
    expect(
      await observer.count('credential_delivery_job', {
        redemption_record_id: first.request.redemption.id,
      }),
    ).toBe(1);
    await clearJobs();
  });

  // Break caught: a message queued for a credential that has already ended, which could only arrive after it expired.
  it('refuses a message whose redemption record has already ended, and writes nothing', async () => {
    const request = requestFor({ expiresAt: new Date(Date.now() - 1_000) });
    const error = await withHandle(api.service, ISSUER, (handle) =>
      queue.enqueue(handle, request),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'DELIVERY_NOT_QUEUEABLE', reason: 'ENDED' });
    expect(
      await observer.count('credential_delivery_job', {
        redemption_record_id: request.redemption.id,
      }),
    ).toBe(0);
  });

  // Break caught: a malformed request reaching the table, and an error that says what was wrong with the destination or the link
  // by repeating it.
  it.each([
    ['a kind that is not one', { kind: 'PASSWORD_MAIL' }, 'kind'],
    ['a channel that is not one', { channel: 'FAX' }, 'channel'],
    ['a rider as the principal', { principal: { type: 'RIDER', id: PRINCIPAL_1 } }, 'principal'],
    [
      'a principal that is not an identifier',
      { principal: { type: 'STAFF', id: 'ama' } },
      'principal',
    ],
    [
      'a recovery link that serves a setup grant',
      { kind: 'RECOVERY_LINK', redemption: { type: 'SETUP_GRANT', id: randomUUID() } },
      'redemption',
    ],
    [
      'a setup grant that serves a recovery request',
      { kind: 'SETUP_GRANT', redemption: { type: 'RECOVERY_REQUEST', id: randomUUID() } },
      'redemption',
    ],
    ['an address that is not an address', { destination: 'not an address' }, 'destination'],
    ['a number for an email channel', { destination: '+233201234567' }, 'destination'],
    ['an address for an SMS channel', { channel: 'SMS' }, 'destination'],
    ['a link that is not a web address', { link: 'javascript:alert(1)' }, 'link'],
    ['an end that is not a date', { expiresAt: new Date(Number.NaN) }, 'expiresAt'],
    ['no end', { expiresAt: undefined }, 'expiresAt'],
  ] as const)('refuses %s, naming the field and not the value', async (_label, over, field) => {
    const request = { ...requestFor(), ...over } as unknown as DeliveryRequest;
    const error = await withHandle(api.service, ISSUER, (handle) =>
      queue.enqueue(handle, request),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: 'DELIVERY_NOT_QUEUEABLE',
      reason: 'REQUEST_INVALID',
      field,
    });
    const said = `${String(error)} ${JSON.stringify(error)}`;
    expect(said).not.toContain(SENTINEL_TOKEN);
    expect(said).not.toContain(SENTINEL_DESTINATION);
    expect(await observer.count('credential_delivery_job')).toBe(0);
  });

  // Break caught: any context but the issuing capability being able to queue a message (GBT-S: no business principal reaches it).
  it.each([
    ['a staff member', staffContext([HUB_A])],
    ['a vendor', vendorContext(VENDOR_1)],
    ['a rider', riderContext(RIDER_1)],
    ['the rate limiter', systemContext('rate_limit')],
    ['the seed', systemContext('seed')],
  ])('refuses an insert by %s, at the table', async (_who, context) => {
    // Phrased by hand, so that it is the table's policy that refuses it and not the queue's own check of the context.
    const error = await attempt(
      api,
      context,
      sql`insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type,
            principal_id, channel, state, next_attempt_at, expires_at, provider_dedupe_id)
          values (${randomUUID()}, 'SETUP_GRANT', 'SETUP_GRANT', ${randomUUID()}, 'STAFF', ${PRINCIPAL_1}, 'EMAIL', 'QUEUED',
            clock_timestamp(), clock_timestamp() + interval '30 minutes', ${randomUUID()})`,
    );
    // The seed's capability cannot even be opened over the API's connection; the rest are refused by the policy.
    expect([
      '42501',
      'other: SecurityContextError: Invalid security context: taskCapability',
    ]).toContain(error);
    expect(await observer.count('credential_delivery_job')).toBe(0);
  });

  // Break caught: a message queued, or a job cancelled, under a context that is not the issuing capability's. A cancellation under
  // another context finds no row to change and says it cancelled none, which looks like "nothing was live": a superseded message would
  // stay queued, with its token, until it expired. The queue refuses both before it touches anything, where the caller can see it.
  it.each([
    ['a staff member', staffContext([HUB_A])],
    ['a vendor', vendorContext(VENDOR_1)],
    ['a rider', riderContext(RIDER_1)],
    ['the rate limiter', systemContext('rate_limit')],
  ])('refuses to queue or to cancel for %s, and says why', async (_who, context) => {
    const issued = await issue();

    await expect(
      withHandle(api.service, context, (handle) => queue.enqueue(handle, requestFor())),
    ).rejects.toBeInstanceOf(DeliveryContextError);
    await expect(
      withHandle(api.service, context, (handle) =>
        queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption }),
      ),
    ).rejects.toBeInstanceOf(DeliveryContextError);
    await expect(
      withHandle(api.service, context, (handle) =>
        queue.cancel(handle, { by: 'principal', principal: issued.request.principal }),
      ),
    ).rejects.toBeInstanceOf(DeliveryContextError);

    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    expect(await observer.count('credential_delivery_job')).toBe(1);
    await clearJobs();
  });

  // Break caught: a job that begins anywhere but QUEUED (a message that is already ACCEPTED, so that nothing is ever sent for it,
  // or one that is LEASED to a worker that does not exist), however the insert is phrased.
  it.each(['LEASED', 'ACCEPTED', 'CANCELLED', 'RETRYABLE'])(
    'refuses a job inserted already %s',
    async (state) => {
      const id = randomUUID();
      const error = await attempt(
        api,
        ISSUER,
        sql`insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type,
              principal_id, channel, state, next_attempt_at, expires_at, provider_dedupe_id)
            values (${id}, 'SETUP_GRANT', 'SETUP_GRANT', ${randomUUID()}, 'STAFF', ${PRINCIPAL_1}, 'EMAIL', ${state},
              clock_timestamp(), clock_timestamp() + interval '30 minutes', ${randomUUID()})`,
      );
      expect(error).toBe('42501');
    },
  );

  describe('a new job starts untouched, at the database boundary (G2 follow-up, P-6)', () => {
    /**
     * An insert phrased by hand as the issuing identity, with a whole sealed payload so that the column under test is the only thing
     * the table could object to. The column is a name of this file's own, never input.
     */
    const insertWith = (extra?: readonly [column: string, value: string]) =>
      sql`insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type,
            principal_id, channel, state, next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext, payload_nonce,
            payload_key_version, payload_envelope_version${sql.raw(extra === undefined ? '' : `, ${extra[0]}`)})
          values (${randomUUID()}, 'SETUP_GRANT', 'SETUP_GRANT', ${randomUUID()}, 'STAFF', ${PRINCIPAL_1}, 'EMAIL', 'QUEUED',
            clock_timestamp(), clock_timestamp() + interval '30 minutes', ${randomUUID()}, decode('01', 'hex'), decode('02', 'hex'), 1, 1${sql.raw(extra === undefined ? '' : `, ${extra[1]}`)})`;

    // Break caught: a control that is itself malformed, which would make every refusal below true for the wrong reason.
    it('accepts the hand-phrased insert when it starts untouched, and stores no attempt and no deferral credit', async () => {
      expect(await attempt(api, ISSUER, insertWith())).toBeUndefined();
      expect(await attempt(api, ISSUER, insertWith(['attempt_count', '0']))).toBeUndefined();
      expect(await attempt(api, ISSUER, insertWith(['deferred_claims', '0']))).toBeUndefined();

      const rows = await observer.rows<Row>('select * from credential_delivery_job');
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row).toMatchObject({
          state: 'QUEUED',
          attempt_count: 0,
          deferred_claims: 0,
          lease_version: 0,
          lease_owner: null,
          lease_expires_at: null,
          outcome_class: null,
          accepted_at: null,
        });
      }
      await clearJobs();
    });

    // Break caught: a message that begins life having already spent attempts or been credited a deferral. The sends the schedule
    // allows are attempt_count - deferred_claims, so a row that began with either would be sent fewer (or, with a credit, more)
    // times than the Class 1 schedule allows. The issuing identity holds INSERT on every column, so the policy is what refuses it,
    // and the CHECK constraints are the backstop behind it for any other writer.
    it.each([
      ['an attempt already counted', ['attempt_count', '1']],
      ['several attempts already counted', ['attempt_count', '5']],
      ['a deferral credit with no claim to give back', ['deferred_claims', '1']],
      ['a lease version', ['lease_version', '1']],
      ['a lease holder', ['lease_owner', "'dw-x'"]],
      ['a lease end', ['lease_expires_at', "clock_timestamp() + interval '1 minute'"]],
      ['an outcome', ['outcome_class', "'UNKNOWN'"]],
      ['an acceptance time', ['accepted_at', 'clock_timestamp()']],
    ] as const)(
      'refuses a job inserted with %s, as the issuing runtime identity',
      async (_label, extra) => {
        expect(await attempt(api, ISSUER, insertWith(extra))).toBe('42501');
        expect(await observer.count('credential_delivery_job')).toBe(0);
      },
    );

    // Break caught: the policy and the constraint disagreeing about what "untouched" is, which is how a job that started with a
    // deferral credit would pass as the constraint was read by a person.
    it('states in the constraint of a queued job that it has no deferral credit either', async () => {
      const definition = await observer.one<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conname = 'credential_delivery_job_queued_is_untouched'`,
      );

      expect(definition?.def).toMatch(/deferred_claims\s*=\s*0/);
    });

    // Break caught: the normal path being changed by the stricter insert, so that a message the application queues is refused.
    it('still queues a message through the queue, starting at nought attempts and nought deferrals', async () => {
      const issued = await issue();

      expect(await rowOf(issued.job.id)).toMatchObject({
        state: 'QUEUED',
        attempt_count: 0,
        deferred_claims: 0,
        lease_version: 0,
      });
      await clearJobs();
    });
  });

  // Break caught: the worker's capability opened over the API's connection (the API reaching the lease and the payload), and the
  // issuing capability over the worker's (the worker queueing a message).
  it('opens a capability only over the connection that holds its grants', async () => {
    const asWorkerOnApi = await stateOf(
      withHandle(api.service, WORKER, (_handle, tx) => tx.execute(sql`select 1`)),
    );
    const asIssuerOnWorker = await stateOf(
      withHandle(work.service, ISSUER, (_handle, tx) => tx.execute(sql`select 1`)),
    );
    expect(asWorkerOnApi).toContain('SecurityContextError');
    expect(asIssuerOnWorker).toContain('SecurityContextError');
  });
});

describe('cancelling a message when its redemption record is consumed, superseded or invalidated', () => {
  // Break caught: a cancellation that leaves the payload, or that happens in a transaction of its own and survives a rollback of
  // the act that consumed the record. The two commit together: the record's state and the cancelled job.
  it('cancels the job of a record in the transaction that ends the record, and erases the payload', async () => {
    const issued = await issue();

    const cancelled = await withHandle(api.service, ISSUER, async (handle, tx) => {
      await tx.execute(
        sql`update delivery_fixture_redemption set state = 'CONSUMED' where id = ${issued.redemptionId}`,
      );
      return queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption });
    });

    expect(cancelled).toBe(1);
    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({
      state: 'CANCELLED',
      outcome_class: 'CANCELLED',
      payload_ciphertext: null,
      payload_nonce: null,
      payload_key_version: null,
      payload_envelope_version: null,
    });
    expect(row.payload_erased_at).toBeInstanceOf(Date);
    // Idempotent: nothing is left to cancel.
    expect(
      await withHandle(api.service, ISSUER, (handle) =>
        queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption }),
      ),
    ).toBe(0);
    await clearJobs();
  });

  // Break caught: a cancellation that survives the rollback of the act that asked for it (a job cancelled for a record that is
  // still pending would strand the person who was to receive the link).
  it('is rolled back with its transaction', async () => {
    const issued = await issue();
    const failure = new Error('the consuming operation failed');
    await expect(
      withHandle(api.service, ISSUER, async (handle) => {
        await queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    expect((await rowOf(issued.job.id)).payload_ciphertext).not.toBeNull();
    await clearJobs();
  });

  // Break caught: a cancellation that reaches a job of another principal, or a finished job (whose state is history).
  it('cancels the live jobs of a principal and no one else’s, and leaves a finished job as it was', async () => {
    const mine1 = await issue({ principal: { type: 'STAFF', id: PRINCIPAL_1 } });
    const mine2 = await issue({ principal: { type: 'STAFF', id: PRINCIPAL_1 } });
    const theirs = await issue({ principal: { type: 'STAFF', id: PRINCIPAL_2 } });
    const sameIdOtherType = await issue({ principal: { type: 'VENDOR', id: PRINCIPAL_1 } });
    // One of mine has been accepted already.
    const accepted = await claimOne('dw-cancel');
    await queue.recordOutcome(accepted, { outcome: 'ACCEPTED', providerMessageRef: 'ref-1' });
    const finishedId = accepted.job.id;

    const cancelled = await withHandle(api.service, ISSUER, (handle) =>
      queue.cancel(handle, { by: 'principal', principal: { type: 'STAFF', id: PRINCIPAL_1 } }),
    );

    expect(cancelled).toBe(1);
    const states = Object.fromEntries(
      await Promise.all(
        [mine1, mine2, theirs, sameIdOtherType].map(
          async (issued) => [issued.job.id, (await rowOf(issued.job.id)).state] as const,
        ),
      ),
    );
    const live = [mine1, mine2].filter((issued) => issued.job.id !== finishedId);
    expect(states[live[0]?.job.id ?? '']).toBe('CANCELLED');
    expect(states[theirs.job.id]).toBe('QUEUED');
    expect(states[sameIdOtherType.job.id]).toBe('QUEUED');
    expect((await rowOf(finishedId)).state).toBe('ACCEPTED');
    await clearJobs();
  });

  // Break caught: a cancellation by record that reaches more than the one record named: every job of the same type, or every job that
  // carries the same identifier whatever kind of record it serves (the messages of other people would be lost with it).
  it('cancels the job of the record named, and no job of another record or of another type of record', async () => {
    const named = await issue();
    const otherRecord = await issue();
    const otherType = await issue({
      kind: 'RECOVERY_LINK',
      redemption: { type: 'RECOVERY_REQUEST', id: randomUUID() },
    });
    // A recovery request that happens to carry the same identifier: the two are told apart by their type.
    await arrange('update credential_delivery_job set redemption_record_id = $1 where id = $2', [
      named.request.redemption.id,
      otherType.job.id,
    ]);

    const cancelled = await withHandle(api.service, ISSUER, (handle) =>
      queue.cancel(handle, { by: 'redemption', redemption: named.request.redemption }),
    );

    expect(cancelled).toBe(1);
    expect((await rowOf(named.job.id)).state).toBe('CANCELLED');
    expect((await rowOf(otherRecord.job.id)).state).toBe('QUEUED');
    expect((await rowOf(otherType.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: a cancellation that stops at a job already leased (the send in flight is dead because redemption rejects it, but the
  // job must not be left to be retried or accepted).
  it('cancels a job that is leased, and the worker’s later outcome for it is refused', async () => {
    const issued = await issue();
    const claimed = await claimOne('dw-inflight');

    await withHandle(api.service, ISSUER, (handle) =>
      queue.cancel(handle, { by: 'redemption', redemption: issued.request.redemption }),
    );

    expect((await rowOf(issued.job.id)).state).toBe('CANCELLED');
    await expect(
      queue.recordOutcome(claimed, { outcome: 'ACCEPTED', providerMessageRef: 'late' }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const after = await rowOf(issued.job.id);
    expect(after.state).toBe('CANCELLED');
    expect(after.provider_message_ref).toBeNull();
    await clearJobs();
  });
});

describe('the worker side: a claim, a lease and a fence', () => {
  // Break caught: a claim that returns the wrong job, takes no lease, or counts no attempt; and a payload not opened in memory.
  it('claims a due job with a lease on the database’s clock, counts the attempt and opens the payload in memory', async () => {
    const issued = await issue();

    const claimed = await queue.claim('dw-a', 30_000);

    expect(claimed).not.toBeNull();
    expect(claimed).toMatchObject({
      job: { id: issued.job.id, providerDedupeId: issued.job.providerDedupeId },
      leaseVersion: 1,
      attempt: 1,
      reclaimed: false,
      kind: 'SETUP_GRANT',
      channel: 'EMAIL',
    });
    expect(claimed?.request).toEqual({
      kind: 'SETUP_GRANT',
      redemption: issued.request.redemption,
      principal: issued.request.principal,
      channel: 'EMAIL',
      destination: SENTINEL_DESTINATION,
      link: issued.request.link,
      expiresAt: issued.request.expiresAt,
    });
    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({
      state: 'LEASED',
      attempt_count: 1,
      lease_version: 1,
      lease_owner: 'dw-a',
    });
    const lease = await observer.one<{ seconds: number }>(
      `select extract(epoch from (lease_expires_at - clock_timestamp()))::float8 as seconds
         from credential_delivery_job where id = $1`,
      [issued.job.id],
    );
    expect(lease?.seconds).toBeGreaterThan(25);
    expect(lease?.seconds).toBeLessThanOrEqual(30);
    // The payload is still sealed in the row: opening it is in the worker's memory only.
    expect(row.payload_ciphertext).not.toBeNull();
    await clearJobs();
  });

  // Break caught: a job claimed before it is due, after it has ended, or while leased: the three guards of the claim.
  it('claims nothing that is not due, that has ended, or whose lease is still held', async () => {
    const waiting = await issue();
    await arrange(
      `update credential_delivery_job set state = 'RETRYABLE', attempt_count = 1, lease_version = 1, lease_owner = 'dw-x',
              outcome_class = 'UNKNOWN', next_attempt_at = clock_timestamp() + interval '10 minutes' where id = $1`,
      [waiting.job.id],
    );
    const ended = await issue();
    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [ended.job.id],
    );
    const held = await issue();
    const first = await queue.claim('dw-held', 30_000);
    expect(first?.job.id).toBe(held.job.id);

    // Nothing is left: the waiting job is not due, the ended one is past its end, the third is leased.
    expect(await queue.claim('dw-other', 30_000)).toBeNull();
    expect((await rowOf(held.job.id)).lease_owner).toBe('dw-held');
    await clearJobs();
  });

  // Break caught: two workers claiming one job (a message sent twice for nothing) when they ask at the same moment.
  it('gives a job to exactly one of two workers that claim at the same moment', async () => {
    const issued = await issue();

    const results = await Promise.all([queue.claim('dw-1', 30_000), queue.claim('dw-2', 30_000)]);

    const winners = results.filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.job.id).toBe(issued.job.id);
    expect((await rowOf(issued.job.id)).lease_version).toBe(1);
    await clearJobs();
  });

  // Break caught: a claim that waits for a job another worker is working on (a worker stalled behind another's transaction), where it
  // should leave that job and take the next one or none.
  it('does not wait for a job another transaction holds locked', async () => {
    const locked = await issue();
    const other = await issue();
    const holder = await openAdmin(database);
    try {
      // Another worker is part-way through claiming the older job: its row is locked in an open transaction.
      await holder.query('begin');
      await holder.query('select id from credential_delivery_job where id = $1 for update', [
        locked.job.id,
      ]);

      const started = Date.now();
      const claimed = await queue.claim('dw-nowait', 30_000);

      // It took the other job, at once, and did not queue behind the lock.
      expect(claimed?.job.id).toBe(other.job.id);
      expect(Date.now() - started).toBeLessThan(1_500);
      await holder.query('rollback');
    } finally {
      await holder.close();
    }
    await clearJobs();
  });

  // Break caught: a lease that cannot be taken over after it ends (a crash after the commit would strand the message), or a takeover
  // that lets the earlier holder still write, which is what the fence is for.
  it('lets a later worker take over a lease that ended with no outcome, and fences the earlier holder out', async () => {
    const issued = await issue();
    const stale = await claimOne('dw-crashed', 30_000);
    expect(await queue.claim('dw-early', 30_000)).toBeNull();

    await endLease(issued.job.id);
    const taker = await claimOne('dw-taker', 30_000);

    expect(taker).toMatchObject({
      job: { id: issued.job.id, providerDedupeId: issued.job.providerDedupeId },
      leaseVersion: 2,
      attempt: 2,
      reclaimed: true,
    });
    // The same link, taken from the same sealed payload.
    expect(taker.request.link).toBe(stale.request.link);

    await expect(
      queue.recordOutcome(stale, {
        outcome: 'ACCEPTED',
        providerMessageRef: 'from-the-stale-worker',
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    const untouched = await rowOf(issued.job.id);
    expect(untouched).toMatchObject({ state: 'LEASED', lease_owner: 'dw-taker', lease_version: 2 });
    expect(untouched.provider_message_ref).toBeNull();

    await queue.recordOutcome(taker, { outcome: 'ACCEPTED', providerMessageRef: 'from-the-taker' });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'ACCEPTED',
      provider_message_ref: 'from-the-taker',
    });
    await clearJobs();
  });
});

describe('recording the outcome of a send', () => {
  // Break caught: an accepted job that keeps its payload or loses its provider reference, or an outcome written twice. (That a job
  // never changes the redemption record it serves is shown by the table's shape: it is tied to no other table.)
  it('ends an accepted job with its reference kept and its payload erased', async () => {
    const issued = await issue();
    const claimed = await claimOne();

    await queue.recordOutcome(claimed, {
      outcome: 'ACCEPTED',
      providerMessageRef: 'provider-ref-1',
    });

    const row = await rowOf(issued.job.id);
    expect(row).toMatchObject({
      state: 'ACCEPTED',
      outcome_class: 'ACCEPTED',
      provider_message_ref: 'provider-ref-1',
      payload_ciphertext: null,
      payload_nonce: null,
      lease_expires_at: null,
      attempt_count: 1,
      lease_version: 1,
    });
    expect(row.accepted_at).toBeInstanceOf(Date);
    expect(row.payload_erased_at).toBeInstanceOf(Date);
    // A second outcome for the same lease is refused: the job has ended.
    await expect(
      queue.recordOutcome(claimed, { outcome: 'ACCEPTED', providerMessageRef: 'provider-ref-2' }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect((await rowOf(issued.job.id)).provider_message_ref).toBe('provider-ref-1');
    await clearJobs();
  });

  // Break caught: a provider's deterministic rejection retried blindly, a class outside the closed set stored, or the class
  // lost: DESTINATION_NOT_ALLOWED is the one the documents name.
  it.each([
    ['REJECTED', 'REJECTED'],
    ['DESTINATION_NOT_ALLOWED', 'DESTINATION_NOT_ALLOWED'],
    ['something the provider invented', 'REJECTED'],
    ['SCHEDULE_EXHAUSTED', 'REJECTED'],
    ['PAYLOAD_UNREADABLE', 'REJECTED'],
  ])(
    'ends a job the provider rejected as %s with the class %s, payload erased',
    async (reported, stored) => {
      const issued = await issue();
      const claimed = await claimOne();

      await queue.recordOutcome(claimed, { outcome: 'REJECTED', outcomeClass: reported });

      expect(await rowOf(issued.job.id)).toMatchObject({
        state: 'FAILED',
        outcome_class: stored,
        payload_ciphertext: null,
      });
      await clearJobs();
    },
  );

  // Break caught: an unknown outcome treated as a failure (the provider may have accepted the message), or retried with a new
  // identity or a new link: the retry is the same message.
  it('waits and tries again, with the same link and the same provider identity, after an unknown outcome', async () => {
    const issued = await issue();
    const first = await claimOne('dw-r1');

    await queue.recordOutcome(first, { outcome: 'UNKNOWN' });

    const waiting = await rowOf(issued.job.id);
    expect(waiting).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'UNKNOWN',
      attempt_count: 1,
      lease_expires_at: null,
      provider_dedupe_id: issued.job.providerDedupeId,
    });
    expect(waiting.payload_ciphertext).not.toBeNull();
    // About 30 seconds on, with the jitter held at the middle: not yet due.
    const wait = await observer.one<{ seconds: number }>(
      `select extract(epoch from (next_attempt_at - clock_timestamp()))::float8 as seconds
         from credential_delivery_job where id = $1`,
      [issued.job.id],
    );
    expect(wait?.seconds).toBeGreaterThan(25);
    expect(wait?.seconds).toBeLessThanOrEqual(30);
    expect(await queue.claim('dw-r2', 30_000)).toBeNull();

    await makeDue(issued.job.id);
    const second = await claimOne('dw-r2');
    expect(second).toMatchObject({
      attempt: 2,
      leaseVersion: 2,
      reclaimed: false,
      job: { id: issued.job.id, providerDedupeId: issued.job.providerDedupeId },
    });
    expect(second.request.link).toBe(first.request.link);
    expect(second.request.destination).toBe(first.request.destination);
    await clearJobs();
  });

  // Break caught: a provider's Retry-After removing the bound or ignored, and the sixth unknown outcome retried a seventh time.
  it('follows the schedule to its end: a Retry-After lengthens a wait, and the sixth unknown outcome fails the job', async () => {
    const issued = await issue({ expiresAt: inMinutes(60 * 24) });
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await claimOne('dw-schedule');
      await queue.recordOutcome(
        claimed,
        attempt === 1 ? { outcome: 'UNKNOWN', retryAfterMs: 90_000 } : { outcome: 'UNKNOWN' },
      );
      const wait = await observer.one<{ seconds: number }>(
        `select extract(epoch from (next_attempt_at - clock_timestamp()))::float8 as seconds
           from credential_delivery_job where id = $1`,
        [issued.job.id],
      );
      waits.push(Math.round((wait?.seconds ?? 0) / 10) * 10);
      expect((await rowOf(issued.job.id)).state).toBe('RETRYABLE');
      await makeDue(issued.job.id);
    }
    // 90 s (the Retry-After beat the 30 s), then 2 minutes, 10 minutes, 30 minutes, 2 hours.
    expect(waits).toEqual([90, 120, 600, 1800, 7200]);

    const sixth = await claimOne('dw-schedule');
    expect(sixth.attempt).toBe(6);
    const end = await queue.recordOutcome(sixth, { outcome: 'UNKNOWN' });

    expect(end).toEqual({ state: 'FAILED', outcomeClass: 'SCHEDULE_EXHAUSTED' });

    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a retry scheduled for after the redemption record has ended (the schedule is cut off at the expiry, then a
  // terminal failure), judged on the database's clock.
  it('fails the job when its next attempt would fall after the redemption record ends', async () => {
    const issued = await issue({ expiresAt: new Date(Date.now() + 10_000) });
    const claimed = await claimOne();

    await queue.recordOutcome(claimed, { outcome: 'UNKNOWN' });

    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: the worker's other findings recorded as a provider failure, or not recorded at all.
  it('records that the record ended (cancelled while its end is ahead, expired once it has passed), that it could not be confirmed, that the payload would not open and that the worker is stopping', async () => {
    const closed = await issue();
    await queue.recordOutcome(await claimOne(), { outcome: 'REDEMPTION_CLOSED' });
    expect(await rowOf(closed.job.id)).toMatchObject({
      state: 'CANCELLED',
      outcome_class: 'CANCELLED',
      payload_ciphertext: null,
    });

    const expired = await issue();
    const expiredClaim = await claimOne();
    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [expired.job.id],
    );
    expect(await queue.recordOutcome(expiredClaim, { outcome: 'REDEMPTION_CLOSED' })).toEqual({
      state: 'EXPIRED',
      outcomeClass: 'EXPIRED',
    });
    expect(await rowOf(expired.job.id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      payload_ciphertext: null,
    });

    const unconfirmed = await issue();
    await queue.recordOutcome(await claimOne(), { outcome: 'REDEMPTION_UNCONFIRMED' });
    expect(await rowOf(unconfirmed.job.id)).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'REDEMPTION_UNCONFIRMED',
    });

    const unreadable = await issue();
    await makeDue(unreadable.job.id);
    const unreadableClaim = await queue.claim('dw-u', 30_000);
    expect(unreadableClaim?.job.id).toBe(unreadable.job.id);
    if (unreadableClaim === null) throw new Error('unreachable');
    await queue.recordOutcome(unreadableClaim, { outcome: 'PAYLOAD_UNREADABLE' });
    expect(await rowOf(unreadable.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'PAYLOAD_UNREADABLE',
      payload_ciphertext: null,
    });

    const stopping = await issue();
    await makeDue(stopping.job.id);
    const stoppingClaim = await queue.claim('dw-s', 30_000);
    if (stoppingClaim === null) throw new Error('unreachable');
    await queue.recordOutcome(stoppingClaim, { outcome: 'RELINQUISHED' });
    const given = await rowOf(stopping.job.id);
    expect(given).toMatchObject({ state: 'RETRYABLE', outcome_class: 'RELINQUISHED' });
    // It is due again at once for the next worker.
    expect((await queue.claim('dw-next', 30_000))?.job.id).toBe(stopping.job.id);
    await clearJobs();
  });

  // Break caught: an unknown outcome that arrives after the credential has ended being counted as a terminal failure of the
  // provider (and alerting), where the credential simply expired.
  it('expires a job whose redemption record ended while the provider was being called', async () => {
    const issued = await issue();
    const claimed = await claimOne();
    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [issued.job.id],
    );

    const end = await queue.recordOutcome(claimed, { outcome: 'UNKNOWN' });

    expect(end).toEqual({ state: 'EXPIRED', outcomeClass: 'EXPIRED' });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'EXPIRED',
      outcome_class: 'EXPIRED',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a payload that this worker cannot open only because it lacks the key or the format (a rotation it has not been
  // given yet) being destroyed for want of a version: the ciphertext stays, the job waits on the schedule, and the error says nothing
  // of the payload.
  it.each([
    ['a key version it does not hold', 'payload_key_version = 99'],
    ['an envelope version it does not support', 'payload_envelope_version = 9'],
  ])(
    'reports a claim sealed under %s as one it cannot open yet, and keeps the payload when the outcome is unknown',
    async (_label, change) => {
      const sealed = await issue();
      await arrange(`update credential_delivery_job set ${change} where id = $1`, [sealed.job.id]);

      const error = await queue.claim('dw-skew', 30_000).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(UnreadableClaimError);
      expect((error as UnreadableClaimError).reason).toBe('NOT_HELD');
      const leased = (error as UnreadableClaimError).leased;
      expect(leased).toMatchObject({
        job: { id: sealed.job.id },
        leaseVersion: 1,
        attempt: 1,
        deferrals: 0,
        kind: 'SETUP_GRANT',
        channel: 'EMAIL',
      });
      const said = `${String(error)} ${JSON.stringify(error)}`;
      expect(said).not.toContain(SENTINEL_TOKEN);
      expect(said).not.toContain(SENTINEL_DESTINATION);

      await queue.recordOutcome(leased, { outcome: 'UNKNOWN' });
      const kept = await rowOf(sealed.job.id);
      expect(kept).toMatchObject({ state: 'RETRYABLE', outcome_class: 'UNKNOWN' });
      expect(kept.payload_ciphertext).not.toBeNull();
      expect(kept.payload_erased_at).toBeNull();
      await clearJobs();
    },
  );

  // Break caught: a ciphertext moved from one job to another opening there: the associated data names the row.
  it('does not open a payload that was copied from another job', async () => {
    const donor = await issue();
    const target = await issue();
    await arrange(
      `update credential_delivery_job t set payload_ciphertext = d.payload_ciphertext, payload_nonce = d.payload_nonce,
              payload_key_version = d.payload_key_version, payload_envelope_version = d.payload_envelope_version
         from credential_delivery_job d where t.id = $1 and d.id = $2`,
      [target.job.id, donor.job.id],
    );
    await arrange(
      `update credential_delivery_job set next_attempt_at = clock_timestamp() + interval '1 hour' where id = $1`,
      [donor.job.id],
    );

    const error = await queue.claim('dw-copy', 30_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnreadableClaimError);
    // A ciphertext that does not authenticate as this row's is one no worker will ever open: it ends, and its payload is erased.
    expect((error as UnreadableClaimError).reason).toBe('UNREADABLE');
    const leased = (error as UnreadableClaimError).leased;
    expect(leased.job.id).toBe(target.job.id);
    await queue.recordOutcome(leased, { outcome: 'PAYLOAD_UNREADABLE' });
    expect(await rowOf(target.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'PAYLOAD_UNREADABLE',
      payload_ciphertext: null,
    });
    await clearJobs();
  });

  // Break caught: a layout the payload is not written in being taken for one a newer worker could read, or the reverse: a payload
  // that opens but is not what this build writes is garbage no worker will make sense of.
  it('reports a payload that opens but is not what is written as unreadable for good', async () => {
    const issued = await issue();
    const garbage = await cipher.seal(
      'DELIVERY_PAYLOAD',
      new TextEncoder().encode('{"not":"a payload"}'),
      deliveryPayloadContext({
        jobId: issued.job.id,
        kind: 'SETUP_GRANT',
        principal: issued.request.principal,
        redemption: { type: 'SETUP_GRANT', id: issued.request.redemption.id },
      }),
    );
    await arrange(
      `update credential_delivery_job set payload_ciphertext = $2, payload_nonce = $3,
              payload_key_version = $4, payload_envelope_version = $5 where id = $1`,
      [
        issued.job.id,
        Buffer.from(garbage.ciphertext),
        Buffer.from(garbage.nonce),
        garbage.keyVersion,
        garbage.envelopeVersion,
      ],
    );

    const error = await queue.claim('dw-garbage', 30_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnreadableClaimError);
    expect((error as UnreadableClaimError).reason).toBe('UNREADABLE');
    await clearJobs();
  });

  // Break caught: a payload written by a newer build, that this one cannot read for want of its layout, being destroyed.
  it('reports a payload in a layout from a newer writer as one it cannot open yet', async () => {
    const issued = await issue();
    const newer = await cipher.seal(
      'DELIVERY_PAYLOAD',
      new TextEncoder().encode('{"v":2,"destination":"a@b.test","link":"https://x.test/"}'),
      deliveryPayloadContext({
        jobId: issued.job.id,
        kind: 'SETUP_GRANT',
        principal: issued.request.principal,
        redemption: { type: 'SETUP_GRANT', id: issued.request.redemption.id },
      }),
    );
    await arrange(
      `update credential_delivery_job set payload_ciphertext = $2, payload_nonce = $3,
              payload_key_version = $4, payload_envelope_version = $5 where id = $1`,
      [
        issued.job.id,
        Buffer.from(newer.ciphertext),
        Buffer.from(newer.nonce),
        newer.keyVersion,
        newer.envelopeVersion,
      ],
    );

    const error = await queue.claim('dw-newer', 30_000).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(UnreadableClaimError);
    expect((error as UnreadableClaimError).reason).toBe('NOT_HELD');
    await clearJobs();
  });

  // Break caught: a job claimed after its sixth attempt that is sent for again, once for each lease that ends, until the credential
  // expires; or ended as something other than the end of the schedule; or ended with its payload kept.
  it('ends a job at the end of the schedule without a send, whatever the attempt, and erases its payload', async () => {
    const issued = await issue({ expiresAt: inMinutes(60 * 24) });
    await arrange(
      `update credential_delivery_job set state = 'LEASED', attempt_count = 6, lease_version = 6, lease_owner = 'dw-crashed',
              lease_expires_at = clock_timestamp() - interval '1 second', outcome_class = 'UNKNOWN' where id = $1`,
      [issued.job.id],
    );

    const seventh = await claimOne('dw-seventh');
    expect(seventh).toMatchObject({ attempt: 7, leaseVersion: 7, reclaimed: true });
    const end = await queue.recordOutcome(seventh, { outcome: 'SCHEDULE_EXHAUSTED' });

    expect(end).toEqual({ state: 'FAILED', outcomeClass: 'SCHEDULE_EXHAUSTED' });
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'FAILED',
      outcome_class: 'SCHEDULE_EXHAUSTED',
      attempt_count: 7,
      payload_ciphertext: null,
    });
    expect((await rowOf(issued.job.id)).payload_erased_at).toBeInstanceOf(Date);
    await clearJobs();
  });

  // Break caught: the schedule's end recorded as a failure of the schedule for a credential that had already expired.
  it('ends it as expired when the redemption record has ended by then', async () => {
    const issued = await issue();
    const claimed = await claimOne();
    await arrange(
      `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
              created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
      [issued.job.id],
    );

    const end = await queue.recordOutcome(claimed, { outcome: 'SCHEDULE_EXHAUSTED' });

    expect(end).toEqual({ state: 'EXPIRED', outcomeClass: 'EXPIRED' });
    await clearJobs();
  });

  // Break caught: the worker (which counts a terminal failure by the state the job reached) being told something other than what
  // the table now holds, or nothing at all: the answer is the row the outcome produced.
  it.each([
    ['accepted', { outcome: 'ACCEPTED', providerMessageRef: 'r' }, 'ACCEPTED', 'ACCEPTED'],
    ['rejected', { outcome: 'REJECTED', outcomeClass: 'REJECTED' }, 'FAILED', 'REJECTED'],
    [
      'rejected for the destination',
      { outcome: 'REJECTED', outcomeClass: 'DESTINATION_NOT_ALLOWED' },
      'FAILED',
      'DESTINATION_NOT_ALLOWED',
    ],
    ['unknown', { outcome: 'UNKNOWN' }, 'RETRYABLE', 'UNKNOWN'],
    ['unconfirmed', { outcome: 'REDEMPTION_UNCONFIRMED' }, 'RETRYABLE', 'REDEMPTION_UNCONFIRMED'],
    ['closed', { outcome: 'REDEMPTION_CLOSED' }, 'CANCELLED', 'CANCELLED'],
    ['unreadable', { outcome: 'PAYLOAD_UNREADABLE' }, 'FAILED', 'PAYLOAD_UNREADABLE'],
    [
      'at the end of its schedule',
      { outcome: 'SCHEDULE_EXHAUSTED' },
      'FAILED',
      'SCHEDULE_EXHAUSTED',
    ],
    ['relinquished', { outcome: 'RELINQUISHED' }, 'RETRYABLE', 'RELINQUISHED'],
  ] as const)(
    'tells the caller where the job stands after an outcome that is %s',
    async (_label, outcome, state, outcomeClass) => {
      const issued = await issue();
      const claimed = await claimOne();

      const end = await queue.recordOutcome(claimed, outcome);

      expect(end).toEqual({ state, outcomeClass });
      expect(await rowOf(issued.job.id)).toMatchObject({
        state,
        outcome_class: outcomeClass,
      });
      await clearJobs();
    },
  );

  // Break caught: an outcome recorded twice for one lease changing a job that has moved on. The version changes only at a claim, so
  // after a retryable outcome the worker still holds the job's version: the fence must compare the state as well, and the second
  // outcome is refused as a lost lease, not as a failure of the database.
  it.each([
    ['an unknown outcome', { outcome: 'UNKNOWN' }],
    ['a relinquished job', { outcome: 'RELINQUISHED' }],
    ['an accepted job', { outcome: 'ACCEPTED', providerMessageRef: 'r' }],
  ] as const)(
    'refuses a second outcome for the same lease after %s, and changes nothing',
    async (_label, first) => {
      const issued = await issue();
      const claimed = await claimOne();
      await queue.recordOutcome(claimed, first);
      const after = await rowOf(issued.job.id);

      await expect(queue.recordOutcome(claimed, { outcome: 'UNKNOWN' })).rejects.toBeInstanceOf(
        LeaseLostError,
      );
      expect(await rowOf(issued.job.id)).toEqual(after);
      await clearJobs();
    },
  );
});

describe('the guard of the state machine (state-machines.md section 22)', () => {
  /** A change made by the worker's capability, by hand, so that the table and not the adapter is what refuses it. */
  const asWorker = (statement: ReturnType<typeof sql>) => attempt(work, WORKER, statement);
  const asIssuer = (statement: ReturnType<typeof sql>) => attempt(api, ISSUER, statement);

  // Break caught: a job that has ended being changed, however the update is phrased (a finished job is history).
  it.each(['ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED'] as const)(
    'refuses any change of a job that is %s',
    async (finalState) => {
      const issued = await issue();
      const claimed = await claimOne();
      if (finalState === 'ACCEPTED') {
        await queue.recordOutcome(claimed, { outcome: 'ACCEPTED', providerMessageRef: 'r' });
      } else if (finalState === 'FAILED') {
        await queue.recordOutcome(claimed, { outcome: 'REJECTED', outcomeClass: 'REJECTED' });
      } else if (finalState === 'CANCELLED') {
        await queue.recordOutcome(claimed, { outcome: 'REDEMPTION_CLOSED' });
      } else {
        await arrange(
          `update credential_delivery_job set expires_at = clock_timestamp() - interval '1 second',
                  created_at = clock_timestamp() - interval '2 seconds' where id = $1`,
          [issued.job.id],
        );
        await queue.recordOutcome(claimed, { outcome: 'REDEMPTION_CLOSED' });
      }
      expect((await rowOf(issued.job.id)).state).toBe(finalState);

      // No capability's policy reaches a job that has ended: the update finds no row.
      const rows = await withHandle(work.service, WORKER, async (_handle, tx) => {
        const result = await tx.execute(
          sql`update credential_delivery_job set outcome_class = outcome_class where id = ${issued.job.id}`,
        );
        return result.rowCount;
      });
      expect(rows).toBe(0);
      // And the table itself refuses it to a login that the policy does not bind (the administrator bypasses row-level security).
      // The change is one that no constraint objects to, so it is the guard's rule for a job that has ended that refuses it, and its
      // words say so.
      await expect(
        admin.query(
          `update credential_delivery_job set lease_owner = 'someone-else' where id = $1`,
          [issued.job.id],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        message: expect.stringContaining('has ended') as unknown,
      });
      await clearJobs();
    },
  );

  // Break caught: a job's identity, its record, its principal, its channel, its end or its provider identity being rewritten. The
  // update is otherwise a correct claim, so nothing else objects and the guard's own rule is what refuses it, in its own words (the
  // column privileges already withhold these columns from the API and the worker; the guard holds for any login).
  it.each([
    ['its kind', "kind = 'DEVICE_GRANT'"],
    ['its record type', "redemption_record_type = 'RECOVERY_REQUEST'"],
    ['its record', `redemption_record_id = '${randomUUID()}'`],
    ['its principal type', "principal_type = 'VENDOR'"],
    ['its principal', `principal_id = '${PRINCIPAL_2}'`],
    ['its channel', "channel = 'SMS'"],
    ['its end', "expires_at = expires_at + interval '1 day'"],
    ['its provider identity', `provider_dedupe_id = '${randomUUID()}'`],
    ['its time of making', "created_at = created_at - interval '1 day'"],
    ['its identity', `id = '${randomUUID()}'`],
  ])('refuses a change of %s, even in an otherwise correct claim', async (_label, assignment) => {
    const issued = await issue();

    await expect(
      admin.query(
        `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1, lease_owner = 'dw-by-hand',
                lease_expires_at = clock_timestamp() + interval '1 minute', ${assignment} where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('keeps its identity') as unknown,
    });
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: a transition the state machine does not have, taken by hand with a capability's rights.
  it.each([
    [
      'QUEUED to ACCEPTED, with nothing sent',
      "state = 'ACCEPTED', accepted_at = clock_timestamp(), outcome_class = 'ACCEPTED', payload_ciphertext = null, payload_nonce = null, payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()",
    ],
    ['QUEUED to RETRYABLE', "state = 'RETRYABLE', outcome_class = 'UNKNOWN'"],
    [
      'QUEUED to FAILED',
      "state = 'FAILED', outcome_class = 'REJECTED', payload_ciphertext = null, payload_nonce = null, payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()",
    ],
    [
      'QUEUED to EXPIRED while the end is ahead',
      "state = 'EXPIRED', outcome_class = 'EXPIRED', payload_ciphertext = null, payload_nonce = null, payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()",
    ],
  ])('refuses %s', async (_label, assignment) => {
    const issued = await issue();

    expect(
      await asWorker(
        sql.raw(`update credential_delivery_job set ${assignment} where id = '${issued.job.id}'`),
      ),
    ).toBe('23514');
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: a claim that does not count the attempt or raise the version, one that is not due, or one that leaves a lease in
  // the past; an outcome that changes who holds the lease or how many attempts were made.
  it('refuses a claim that skips the count, one that is not due and a lease in the past; and an outcome that touches the lease', async () => {
    const issued = await issue();
    const lease =
      "lease_owner = 'dw-by-hand', lease_expires_at = clock_timestamp() + interval '1 minute'";

    expect(
      await asWorker(
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 0, lease_version = 1, ${lease} where id = '${issued.job.id}'`,
        ),
      ),
    ).toBe('23514');
    expect(
      await asWorker(
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 2, ${lease} where id = '${issued.job.id}'`,
        ),
      ),
    ).toBe('23514');
    expect(
      await asWorker(
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1, lease_owner = 'dw-by-hand', lease_expires_at = clock_timestamp() - interval '1 minute' where id = '${issued.job.id}'`,
        ),
      ),
    ).toBe('23514');
    // The same claim, made correctly, is allowed: the refusals above were about the count, the version and the lease.
    expect(
      await asWorker(
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1, ${lease} where id = '${issued.job.id}'`,
        ),
      ),
    ).toBeUndefined();

    // An outcome leaves the version, the count and the holder as they were: each is tried alone, and it is the guard's own rule that
    // refuses it, in its own words (a rule for two of the three leaves the third open).
    for (const change of ['lease_version = 2', 'attempt_count = 5', "lease_owner = 'dw-other'"]) {
      expect(
        await refusalOf(
          work,
          WORKER,
          sql.raw(
            `update credential_delivery_job set state = 'RETRYABLE', outcome_class = 'UNKNOWN', lease_expires_at = null, ${change} where id = '${issued.job.id}'`,
          ),
        ),
        change,
      ).toMatchObject({
        code: '23514',
        message: expect.stringContaining('does not touch the lease owner') as unknown,
      });
    }
    await clearJobs();
  });

  // Break caught: a lease that runs for years (a job stranded for as long), asked for by hand: the application asks for at most an
  // hour, and the table says the same.
  it('refuses a lease of more than an hour, and allows one of an hour', async () => {
    const issued = await issue();
    const claim = (interval: string) =>
      refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1, lease_owner = 'dw-by-hand',
                  lease_expires_at = clock_timestamp() + interval '${interval}' where id = '${issued.job.id}'`,
        ),
      );

    expect(await claim('2 hours')).toMatchObject({
      code: '23514',
      message: expect.stringContaining('at most an hour') as unknown,
    });
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    expect(await claim('59 minutes')).toBeUndefined();
    await clearJobs();
  });

  // Break caught: a payload replaced instead of erased by an outcome that is otherwise a correct one (the retry keeps the payload, so
  // a replacement would be what is sent next), by the worker's capability or by the API once it asserts that capability's label (the
  // label is the application's to refuse, so the table has to as well).
  it('refuses to replace any part of a payload, whoever writes and whatever the transition', async () => {
    const issued = await issue();
    await claimOne('dw-replacer');
    for (const replacement of [
      "payload_ciphertext = decode('00', 'hex')",
      "payload_nonce = decode('00', 'hex')",
      'payload_key_version = 99',
      'payload_envelope_version = 9',
    ]) {
      const outcome = sql.raw(
        `update credential_delivery_job set state = 'RETRYABLE', outcome_class = 'UNKNOWN', ${replacement}
          where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = '${issued.request.redemption.id}'`,
      );
      expect(await refusalOf(work, WORKER, outcome), replacement).toMatchObject({
        code: '23514',
        message: expect.stringContaining('erased and never replaced') as unknown,
      });
      expect(await refusalAsForgedWorker(outcome), replacement).toMatchObject({
        code: '23514',
        message: expect.stringContaining('erased and never replaced') as unknown,
      });
    }
    expect((await rowOf(issued.job.id)).state).toBe('LEASED');
    await clearJobs();
  });

  // Break caught: the worker's capability cancelling jobs it never leased (the whole queue, with one statement): its policy admits any
  // live job, and the guard is what keeps a cancellation to a job the worker holds the lease of. The operation that consumed the
  // record (the authentication capability) cancels a queued one.
  it('lets the worker end only a job it holds the lease of, and the issuing capability cancel a queued one', async () => {
    const leased = await issue();
    await claimOne('dw-holder');
    const queued = await issue();
    expect((await rowOf(leased.job.id)).state).toBe('LEASED');
    const cancel = (job: Issued) =>
      sql.raw(
        `update credential_delivery_job set state = 'CANCELLED', outcome_class = 'CANCELLED', ${eraseSealedSql}
          where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = '${job.request.redemption.id}'`,
      );

    expect(await refusalOf(work, WORKER, cancel(queued))).toMatchObject({
      code: '23514',
      message: expect.stringContaining('only a job it holds the lease of') as unknown,
    });
    expect((await rowOf(queued.job.id)).state).toBe('QUEUED');
    // The job it holds is another matter: it ends it when it finds the record closed.
    expect(await refusalOf(work, WORKER, cancel(leased))).toBeUndefined();
    expect((await rowOf(leased.job.id)).state).toBe('CANCELLED');
    // And the operation that consumed the record cancels a queued job.
    expect(await refusalOf(api, ISSUER, cancel(queued))).toBeUndefined();
    expect((await rowOf(queued.job.id)).state).toBe('CANCELLED');
    await clearJobs();
  });

  // Break caught: a job whose lease is still held being taken again, and a claim that rewrites the payload.
  it('refuses a second claim while the lease is held and a claim that touches the payload', async () => {
    const issued = await issue();
    await claimOne('dw-holder');

    expect(
      await asWorker(
        sql`update credential_delivery_job set attempt_count = 2, lease_version = 2, lease_owner = 'dw-thief',
              lease_expires_at = clock_timestamp() + interval '1 minute' where id = ${issued.job.id}`,
      ),
    ).toBe('23514');
    await endLease(issued.job.id);
    expect(
      await asWorker(
        sql`update credential_delivery_job set attempt_count = 2, lease_version = 2, lease_owner = 'dw-new',
              lease_expires_at = clock_timestamp() + interval '1 minute', payload_nonce = decode('00', 'hex')
            where id = ${issued.job.id}`,
      ),
    ).toBe('23514');
    await clearJobs();
  });

  // Break caught: a job claimed by hand before it is due, or after its redemption record has ended. The adapter's own query leaves
  // such a job alone, so only the guard stops a claim that is phrased otherwise; the same claim, made once it is due, is allowed.
  it('refuses a claim made by hand of a job that is not due, and of one whose record has ended', async () => {
    const lease =
      "lease_owner = 'dw-by-hand', lease_expires_at = clock_timestamp() + interval '1 minute'";
    const waiting = await issue();
    await queue.recordOutcome(await claimOne('dw-first'), { outcome: 'UNKNOWN' });
    expect((await rowOf(waiting.job.id)).state).toBe('RETRYABLE');
    const secondClaim = (id: string) =>
      refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 2, lease_version = 2, ${lease} where id = '${id}'`,
        ),
      );

    expect(await secondClaim(waiting.job.id)).toMatchObject({
      code: '23514',
      message: expect.stringContaining('when it is due') as unknown,
    });
    expect((await rowOf(waiting.job.id)).state).toBe('RETRYABLE');
    await makeDue(waiting.job.id);
    expect(await secondClaim(waiting.job.id)).toBeUndefined();
    await clearJobs();

    const ended = await issue();
    await makeOverdue(ended.job.id);
    expect(
      await refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1, ${lease} where id = '${ended.job.id}'`,
        ),
      ),
    ).toMatchObject({ code: '23514', message: expect.stringContaining('past the end') as unknown });
    expect((await rowOf(ended.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: a claim that counts more than one attempt or raises the version by more than one, and a claim that rewrites any
  // part of the sealed payload. The constraint on a leased job already refuses a count of zero, so these are the cases that only the
  // guard refuses; each part of the payload is tried, because a rule for one of them leaves the others open.
  it.each([
    ['two attempts at once', 'attempt_count = 2, lease_version = 1', 'counts one attempt'],
    ['a version that jumps', 'attempt_count = 1, lease_version = 3', 'counts one attempt'],
    [
      'a new ciphertext',
      "attempt_count = 1, lease_version = 1, payload_ciphertext = decode('00', 'hex')",
      'does not touch the payload',
    ],
    [
      'a new nonce',
      "attempt_count = 1, lease_version = 1, payload_nonce = decode('00', 'hex')",
      'does not touch the payload',
    ],
    [
      'a new key version',
      'attempt_count = 1, lease_version = 1, payload_key_version = 99',
      'does not touch the payload',
    ],
    [
      'a new envelope version',
      'attempt_count = 1, lease_version = 1, payload_envelope_version = 9',
      'does not touch the payload',
    ],
  ])('refuses a claim made by hand with %s', async (_label, assignment, words) => {
    const issued = await issue();

    await expect(
      admin.query(
        `update credential_delivery_job set state = 'LEASED', ${assignment}, lease_owner = 'dw-by-hand',
                lease_expires_at = clock_timestamp() + interval '1 minute' where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining(words) as unknown });
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught (G2-03): a claim handed back as free by anything but the recording of a deferral: a retry that says it was one, two
  // claims given back at once, a deferral that gives back an earlier claim, or a claim that takes one back. The sends so far are the
  // claims less the deferrals, so a rule that lets the column move any other way is a way to be sent more than six times, or fewer.
  it.each([
    [
      'an unknown outcome that gives its claim back',
      "outcome_class = 'UNKNOWN', deferred_claims = 1",
      'only by recording a deferral',
    ],
    [
      'a deferral that gives back two claims',
      "outcome_class = 'PAYLOAD_DEFERRED', deferred_claims = 2",
      'one at a time',
    ],
    [
      'a deferral that gives back none',
      "outcome_class = 'PAYLOAD_DEFERRED', deferred_claims = 0",
      'a deferral gives back its claim',
    ],
  ])('refuses %s', async (_label, assignment, words) => {
    const issued = await issue();
    await claimOne('dw-first');
    const attempt = refusalOf(
      work,
      WORKER,
      sql.raw(
        `update credential_delivery_job set state = 'RETRYABLE', ${assignment}, lease_expires_at = null,
                next_attempt_at = clock_timestamp() + interval '30 seconds' where id = '${issued.job.id}'`,
      ),
    );

    expect(await attempt).toMatchObject({
      code: '23514',
      message: expect.stringContaining(words) as unknown,
    });
    expect(await rowOf(issued.job.id)).toMatchObject({ state: 'LEASED', deferred_claims: 0 });
    await clearJobs();
  });

  // Break caught (G2-03): a deferral recorded by something that is not the lease holder's outcome (the other end states), or a
  // column the API's capability can move: it can cancel a job, and nothing about the count of its sends.
  it('lets the worker record a deferral once, and lets neither a cancellation nor the API move the count', async () => {
    const issued = await issue();
    await claimOne('dw-first');
    expect(
      await refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set state = 'FAILED', outcome_class = 'PAYLOAD_UNREADABLE', deferred_claims = 1,
                  payload_ciphertext = null, payload_nonce = null, payload_key_version = null, payload_envelope_version = null,
                  payload_erased_at = clock_timestamp() where id = '${issued.job.id}'`,
        ),
      ),
    ).toMatchObject({ code: '23514' });
    expect(
      await refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set state = 'RETRYABLE', outcome_class = 'PAYLOAD_DEFERRED', deferred_claims = 1,
                  lease_expires_at = null, next_attempt_at = clock_timestamp() + interval '30 seconds'
            where id = '${issued.job.id}'`,
        ),
      ),
    ).toBeUndefined();
    expect(await rowOf(issued.job.id)).toMatchObject({
      state: 'RETRYABLE',
      outcome_class: 'PAYLOAD_DEFERRED',
      attempt_count: 1,
      deferred_claims: 1,
    });
    // A deferral is recorded by the lease holder when it ends its claim: a job that is already waiting gives back no further claim,
    // however the update is phrased. (The transition rule refuses this change of state before the rule on the count is reached; the
    // rule on the count names the same conditions as defence in depth, and nothing observable separates the two.)
    expect(
      await refusalOf(
        work,
        WORKER,
        sql.raw(
          `update credential_delivery_job set outcome_class = 'REDEMPTION_UNCONFIRMED', deferred_claims = 2
            where id = '${issued.job.id}'`,
        ),
      ),
    ).toMatchObject({ code: '23514' });
    expect((await rowOf(issued.job.id)).deferred_claims).toBe(1);
    // The API's capability holds no privilege on the column, whatever it sets alongside.
    expect(
      await asIssuer(
        sql`update credential_delivery_job set state = 'CANCELLED', outcome_class = 'CANCELLED', deferred_claims = 0
             where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${issued.request.redemption.id}`,
      ),
    ).toBe('42501');
    await clearJobs();
  });

  // Break caught (G2-03): a count of deferrals that exceeds the claims made, which would give the job more sends than it has had
  // claims. The trigger is switched off for this, so that the constraint alone is what refuses it.
  it('refuses a count of deferrals above the claims made, and a negative one', async () => {
    const issued = await issue();

    await expect(
      arrange('update credential_delivery_job set deferred_claims = 1 where id = $1', [
        issued.job.id,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_deferrals_bounded',
    });
    await expect(
      arrange('update credential_delivery_job set deferred_claims = -1 where id = $1', [
        issued.job.id,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_deferrals_bounded',
    });
    await clearJobs();
  });

  // Break caught: the constraint that a live job holds its payload and an ended one holds none, held for the administrator as for
  // every login. (An expiry marked on a job whose end is ahead is refused by the guard: the table of transitions above.)
  it('refuses a finished job that keeps its payload and a live job without one', async () => {
    const issued = await issue();

    // The trigger is switched off for these two, so that the constraint alone is what refuses them.
    await expect(
      arrange(
        `update credential_delivery_job set state = 'ACCEPTED', accepted_at = clock_timestamp(), outcome_class = 'ACCEPTED',
                payload_erased_at = clock_timestamp() where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_payload_follows_state',
    });
    await expect(
      arrange(
        `update credential_delivery_job set payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
                payload_envelope_version = null, payload_erased_at = clock_timestamp() where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_payload_follows_state',
    });
    // A cancellation that leaves the payload behind is refused to the API by the same constraint.
    expect(
      await asIssuer(
        sql`update credential_delivery_job set state = 'CANCELLED', outcome_class = 'CANCELLED'
             where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${issued.request.redemption.id}`,
      ),
    ).toBe('23514');
    await clearJobs();
  });

  // Break caught: the issuing capability doing more than cancelling (leasing, accepting, or changing the lease) through its column
  // privileges and its policy.
  it('lets the issuing capability cancel and nothing else', async () => {
    const issued = await issue();

    // The job is found by its record's key, which is what the API can read, so that what refuses is what the statement sets.
    const found = sql`where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${issued.request.redemption.id}`;
    // Whichever refuses first: the guard of the table (a claim that is not one) or the policy (the API may only cancel).
    expect(['23514', '42501']).toContain(
      await asIssuer(sql`update credential_delivery_job set state = 'LEASED' ${found}`),
    );
    expect(
      await asIssuer(sql`update credential_delivery_job set lease_owner = 'api' ${found}`),
    ).toBe('42501');
    expect(await asIssuer(sql`update credential_delivery_job set attempt_count = 9 ${found}`)).toBe(
      '42501',
    );
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });

  // Break caught: nobody removing a job: no policy and no grant allows it, for either capability, and the truncation the policy does
  // not govern is refused by the privilege.
  it('refuses to delete or truncate a job to the API, the worker and the capability roles', async () => {
    const issued = await issue();

    for (const [service, context] of [
      [api, ISSUER],
      [work, WORKER],
    ] as const) {
      expect(
        await attempt(
          service,
          context,
          sql`delete from credential_delivery_job
               where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${issued.request.redemption.id}`,
        ),
      ).toBe('42501');
      expect(await attempt(service, context, sql`truncate credential_delivery_job`)).toBe('42501');
    }
    expect(await observer.count('credential_delivery_job', { id: issued.job.id })).toBe(1);
    await clearJobs();
  });

  // Break caught: a business principal reading a job (a destination and a token), or the worker's capability reading it when it
  // is opened by anyone but the worker's login.
  it('shows a staff member, a vendor and a rider nothing, and the other capabilities nothing', async () => {
    const issued = await issue();

    const seenAs = (service: BuiltService, context: SecurityContext) =>
      withHandle(service.service, context, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select count(*)::int as n from credential_delivery_job`,
        );
        return (result.rows[0] as { n: number }).n;
      });
    for (const service of [api, work]) {
      for (const context of [
        staffContext([HUB_A], 'ALL'),
        vendorContext(VENDOR_1),
        riderContext(RIDER_1),
      ]) {
        expect(await seenAs(service, context), context.principalType).toBe(0);
      }
    }
    // The limiter's capability may be opened over the API's connection, and its policy reaches nothing of a job.
    expect(await seenAs(api, systemContext('rate_limit'))).toBe(0);
    // The control: the capability that is meant to read the table does.
    expect(await seenAs(work, WORKER)).toBe(1);
    expect(await observer.count('credential_delivery_job', { id: issued.job.id })).toBe(1);
    await clearJobs();
  });
});

describe('the policies of the table, apart from the grants and the guard', () => {
  /**
   * Sets a column to a constant with no WHERE. The statement reads no column of the table, so no SELECT policy is consulted and only
   * the policies of the update decide which rows it may change. (Reading one, even `set state = state`, brings the SELECT policies
   * in, and those would hide the row from every other capability and show nothing of the update policy.)
   */
  const touchAll = sql`update credential_delivery_job set outcome_class = null`;
  const eraseSealed = `payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
          payload_envelope_version = null, payload_erased_at = clock_timestamp()`;
  const rowsChanged = (
    service: BuiltService,
    context: SecurityContext,
    statement: ReturnType<typeof sql>,
  ) =>
    withHandle(
      service.service,
      context,
      async (_handle, tx) => (await tx.execute(statement)).rowCount,
    );

  // Break caught: a context that is neither the issuing nor the working capability reaching a job to change it. Its policies must
  // find no row, which is no error and no change; a policy that admitted any SYSTEM context would be refused later, by the new row.
  it('lets no business principal and no other capability reach a job to change it', async () => {
    await issue();

    for (const service of [api, work]) {
      for (const context of [
        staffContext([HUB_A], 'ALL'),
        vendorContext(VENDOR_1),
        riderContext(RIDER_1),
      ]) {
        expect(await rowsChanged(service, context, touchAll), context.principalType).toBe(0);
      }
    }
    expect(await rowsChanged(api, systemContext('rate_limit'), touchAll)).toBe(0);
    await clearJobs();
  });

  // Break caught: the issuing capability changing a job into anything but CANCELLED. Here the job is leased, so a terminal failure
  // written by the API would pass the guard (a lease may end in a failure) and only the policy stops it.
  it('lets the issuing capability change a job only into CANCELLED', async () => {
    const issued = await issue();
    await claimOne('dw-in-flight');

    expect(
      await refusalOf(
        api,
        ISSUER,
        sql.raw(
          `update credential_delivery_job set state = 'FAILED', outcome_class = 'REJECTED', ${eraseSealed} where id = '${issued.job.id}'`,
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect((await rowOf(issued.job.id)).state).toBe('LEASED');
    await clearJobs();
  });

  // Break caught: the issuing capability reaching a job that has ended. The guard would refuse the change, so only the policy shows
  // that the job is not there for it: nothing is changed and nothing is raised.
  it('shows the issuing capability no job that has ended', async () => {
    const issued = await issue();
    await queue.recordOutcome(await claimOne(), { outcome: 'ACCEPTED', providerMessageRef: 'r' });

    const rows = await rowsChanged(
      api,
      ISSUER,
      sql`update credential_delivery_job set state = 'CANCELLED', outcome_class = 'CANCELLED', payload_erased_at = clock_timestamp()`,
    );

    expect(rows).toBe(0);
    expect((await rowOf(issued.job.id)).state).toBe('ACCEPTED');
    await clearJobs();
  });

  // Break caught: the issuing capability marking an overdue job EXPIRED, which is the worker's act (and S0.19's cleanup); the guard
  // allows it once the end has passed, so only the policy refuses it.
  it('does not let the issuing capability expire a job', async () => {
    const issued = await issue();
    await makeOverdue(issued.job.id);

    expect(
      await refusalOf(
        api,
        ISSUER,
        sql.raw(
          `update credential_delivery_job set state = 'EXPIRED', outcome_class = 'EXPIRED', ${eraseSealed} where id = '${issued.job.id}'`,
        ),
      ),
    ).toMatchObject({ code: '42501' });
    expect((await rowOf(issued.job.id)).state).toBe('QUEUED');
    await clearJobs();
  });
});

describe('the constraints the table holds for any login (the guard is switched off, so that they alone refuse)', () => {
  const noPayload = `payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
          payload_envelope_version = null`;

  // Break caught: a job that is still to be sent losing its payload without being marked as erased.
  it('refuses a live job without its payload', async () => {
    const issued = await issue();

    await expect(
      arrange(`update credential_delivery_job set ${noPayload} where id = $1`, [issued.job.id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_payload_follows_state',
    });
    await clearJobs();
  });

  // Break caught: an envelope that is not whole: a ciphertext without its nonce, its key version or its envelope version, which
  // nothing could open and nothing could tell from an erased one.
  it.each(['payload_nonce', 'payload_key_version', 'payload_envelope_version'])(
    'refuses a payload that has its ciphertext and not its %s',
    async (column) => {
      const issued = await issue();

      await expect(
        arrange(`update credential_delivery_job set ${column} = null where id = $1`, [
          issued.job.id,
        ]),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'credential_delivery_job_payload_is_whole',
      });
      await clearJobs();
    },
  );

  // Break caught: a job that has not been claimed carrying an attempt, a lease version, a holder or a lease end.
  it.each([
    ['an attempt', 'attempt_count = 1'],
    ['a lease version', 'lease_version = 1'],
    ['a lease holder', "lease_owner = 'dw-x'"],
    ['a lease end', "lease_expires_at = clock_timestamp() + interval '1 minute'"],
  ])('refuses a queued job that has %s', async (_label, assignment) => {
    const issued = await issue();

    await expect(
      arrange(`update credential_delivery_job set ${assignment} where id = $1`, [issued.job.id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_queued_is_untouched',
    });
    await clearJobs();
  });

  // Break caught: a lease with no holder, which no one could be asked about and no takeover would name.
  it('refuses a leased job that has no holder', async () => {
    const issued = await issue();

    await expect(
      arrange(
        `update credential_delivery_job set state = 'LEASED', attempt_count = 1, lease_version = 1,
                lease_expires_at = clock_timestamp() + interval '1 minute' where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_lease_when_leased',
    });
    await clearJobs();
  });

  // Break caught: a recovery link serving a setup grant (or the reverse): a message for a record it cannot serve.
  it('refuses a kind that does not serve its redemption record', async () => {
    const issued = await issue();

    await expect(
      arrange(`update credential_delivery_job set kind = 'RECOVERY_LINK' where id = $1`, [
        issued.job.id,
      ]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_kind_serves_its_record',
    });
    await clearJobs();
  });

  // Break caught: a state that its outcome class cannot explain: a job that says it was accepted for an unknown outcome, or that
  // failed with the class of an acceptance.
  it.each([
    ['ACCEPTED', 'UNKNOWN', ', accepted_at = clock_timestamp()'],
    ['FAILED', 'ACCEPTED', ''],
    ['EXPIRED', 'CANCELLED', ''],
    ['CANCELLED', 'EXPIRED', ''],
  ])('refuses a job that is %s with the outcome class %s', async (state, outcomeClass, extra) => {
    const issued = await issue();

    await expect(
      arrange(
        `update credential_delivery_job set state = '${state}', outcome_class = '${outcomeClass}', ${noPayload},
                payload_erased_at = clock_timestamp()${extra} where id = $1`,
        [issued.job.id],
      ),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'credential_delivery_job_outcome_follows_state',
    });
    await clearJobs();
  });
});

describe('the queue built without a worker database', () => {
  // Break caught: the API's queue (which has no worker database) claiming or recording with a connection that is not the worker's.
  it('refuses to claim or to record, with an error that says so', async () => {
    const issuing = new PostgresDeliveryQueue({ cipher, clock });
    await expect(issuing.claim('dw-api', 30_000)).rejects.toBeInstanceOf(
      DeliveryWorkerSideUnavailableError,
    );
    await expect(
      issuing.recordOutcome(
        {
          job: { id: randomUUID(), providerDedupeId: 'x'.repeat(20) },
          leaseVersion: 1,
          attempt: 1,
          deferrals: 0,
          kind: 'SETUP_GRANT',
          channel: 'EMAIL',
        },
        { outcome: 'UNKNOWN' },
      ),
    ).rejects.toBeInstanceOf(DeliveryWorkerSideUnavailableError);
  });

  // Break caught: a claim that takes a lease length or a worker name outside what a row can hold.
  it.each([
    ['a lease of zero', 'dw-ok', 0],
    ['a lease of an hour and a second', 'dw-ok', 3_600_001],
    ['a lease that is not a number', 'dw-ok', Number.NaN],
    ['a worker named with a space', 'dw bad', 30_000],
    ['an empty worker name', '', 30_000],
  ])('refuses %s', async (_label, workerId, leaseMs) => {
    await expect(queue.claim(workerId, leaseMs)).rejects.toThrow(/lease|worker/i);
  });
});

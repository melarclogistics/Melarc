import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { AesGcmSecretCipher } from '../../src/platform/auth/crypto/aes-gcm.secret-cipher.adapter.js';
import { Sha256TokenService } from '../../src/platform/auth/crypto/sha256.token-service.adapter.js';
import type { PrincipalRef } from '../../src/platform/auth/ports/identity-directory.port.js';
import {
  RecoveryRequestStore,
  type IssueRecoveryRequest,
} from '../../src/platform/auth/recovery/recovery-request-store.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { WORKER_RUNTIME_ROLE } from '../../src/platform/database/technical-roles.js';
import { PostgresDeliveryQueue } from '../../src/platform/delivery/postgres.delivery-queue.adapter.js';
import { RecoveryRequestRedemptionReader } from '../../src/platform/delivery/worker/recovery-request-redemption-reader.js';
import { SettingsReader } from '../../src/platform/settings/settings-reader.js';
import { localKeys } from '../../src/test-support/key-config.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow } from './support/identities.js';
import { staffContext, systemContext, vendorContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { HUB_A } from './support/staff-routes.js';
import {
  clientFor,
  createTestDatabase,
  sqlState,
  type TestDatabase,
} from './support/test-database.js';
import { insertVendor, SOME_SECRET_HASH, vendorRow } from './support/vendors.js';

/**
 * S0.50, the recovery request as the table holds it (migration 0037), as `melarc_api_runtime` and `melarc_worker_runtime` against a real
 * PostgreSQL: the guards hold every writer to an eligible principal, its registered channel and the cap of two live links; the machine's
 * states; the row-level security that admits the authentication capability alone (and the worker to three columns); and the worker's
 * reader. The operations that use the table are tested through HTTP (`recovery-request-routes.db.test.ts`).
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let work: BuiltService;
const clock = new SystemClock();
const authentication = systemContext('authentication');
const store = new RecoveryRequestStore({
  tokens: new Sha256TokenService(),
  queue: new PostgresDeliveryQueue({ cipher: new AesGcmSecretCipher(localKeys()), clock }),
  settings: new SettingsReader(),
  clock,
});
let reader: RecoveryRequestRedemptionReader;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 4 });
  work = buildService(database, { poolMax: 2, login: WORKER_RUNTIME_ROLE });
  reader = new RecoveryRequestRedemptionReader({ database: work.service, clock });
}, 120_000);

afterAll(async () => {
  await admin.end();
  await api.close();
  await work.close();
  await database.drop();
});

const issue = (request: IssueRecoveryRequest, context: SecurityContext = authentication) =>
  withHandle(api.service, context, (handle) => store.issue(handle, request));

const stateOf = async (work: Promise<unknown>): Promise<string | undefined> => {
  try {
    await work;
    return undefined;
  } catch (error) {
    let cause: unknown = error;
    while (cause !== undefined && cause !== null) {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
      cause = (cause as { cause?: unknown }).cause;
    }
    throw error;
  }
};

async function staff(overrides = {}): Promise<PrincipalRef & { email: string }> {
  const row = await insertStaff(admin, staffRow(overrides));
  return { type: 'STAFF', id: row.id, email: row.workEmail };
}

async function vendor(
  overrides = {},
): Promise<PrincipalRef & { email: string; identifier: string }> {
  const row = await insertVendor(admin, vendorRow({ secretHash: SOME_SECRET_HASH, ...overrides }));
  return {
    type: 'VENDOR',
    id: row.accountId,
    email: row.recoveryEmail ?? '',
    identifier: row.accountIdentifier,
  };
}

const linkOf = (token: string) => `https://ops.example.test/recovery/complete#token=${token}`;
const byEmail = (
  principal: PrincipalRef & { email: string; identifier?: string },
): IssueRecoveryRequest => ({
  principal: { type: principal.type, id: principal.id },
  channel: 'EMAIL',
  destination: principal.email,
  link: linkOf,
  ...(principal.identifier === undefined ? {} : { accountIdentifier: principal.identifier }),
});

describe('the guard holds every writer to an eligible principal and its registered channel', () => {
  // Break caught: a link issued to a pending, terminal or credential-less identity by any writer, a defect of an operation included.
  it('refuses a request for a staff identity that may not recover', async () => {
    for (const overrides of [
      { status: 'PENDING_APPROVAL', approvedBy: null },
      { status: 'OFFBOARDED' },
      { status: 'REJECTED', credentialHash: null, credentialEstablishedAt: null },
      { credentialHash: null, credentialEstablishedAt: null },
    ]) {
      expect(await stateOf(issue(byEmail(await staff(overrides)))), JSON.stringify(overrides)).toBe(
        '23514',
      );
    }
    expect(await stateOf(issue(byEmail(await staff({ status: 'SUSPENDED' }))))).toBeUndefined();
    expect(
      await stateOf(
        issue({ ...byEmail(await staff()), principal: { type: 'STAFF', id: randomUUID() } }),
      ),
    ).toBe('23514');
  });

  it('refuses a vendor with no secret, of an organisation that is not ACTIVE or SUSPENDED, or reached by another channel', async () => {
    for (const overrides of [
      { secretHash: null },
      { organizationStatus: 'REJECTED' },
      { organizationStatus: 'TERMINATED' },
      { organizationStatus: 'CREATED_BY_OPS' },
    ]) {
      expect(
        await stateOf(issue(byEmail(await vendor(overrides)))),
        JSON.stringify(overrides),
      ).toBe('23514');
    }
    const phone = await vendor({ recoveryPhone: '+233201234567', deliveryChannel: 'PHONE' });
    expect(await stateOf(issue(byEmail(phone)))).toBe('23514');
    expect(
      await stateOf(issue({ ...byEmail(phone), channel: 'SMS', destination: '+233201234567' })),
    ).toBeUndefined();
    expect(
      await stateOf(
        issue(
          byEmail(await vendor({ accountStatus: 'SUSPENDED', organizationStatus: 'SUSPENDED' })),
        ),
      ),
    ).toBeUndefined();
  });

  // Break caught: a third live link written by a caller that skipped the cap, or a dead link (message FAILED) still counted.
  it('refuses a third live link of a credential, and does not count one whose message ended FAILED', async () => {
    const principal = await staff();
    const first = await issue(byEmail(principal));
    await issue(byEmail(principal));
    expect(await stateOf(issue(byEmail(principal)))).toBe('23514');
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `update credential_delivery_job set state = 'FAILED', outcome_class = 'REJECTED', payload_ciphertext = null, payload_nonce = null,
              payload_key_version = null, payload_envelope_version = null, payload_erased_at = clock_timestamp()
        where redemption_record_id = $1`,
      [first.request.id],
    );
    await admin.query('commit');
    expect(await stateOf(issue(byEmail(principal)))).toBeUndefined();
  });
});

describe('the machine of a recovery request', () => {
  // Break caught: a request brought back from a terminal state, consumed after its expiry, or rewritten in what it was issued as.
  it('changes nothing but its state and moment of consumption, and only from PENDING, on the database’s clock', async () => {
    const { request } = await issue(byEmail(await staff()));
    for (const assignment of [
      `issued_at = issued_at - interval '1 second'`,
      `expires_at = expires_at + interval '1 hour'`,
      `channel = 'SMS'`,
      `principal_id = gen_random_uuid()`,
      `initiated_by = gen_random_uuid()`,
      `token_hash = sha256('x')`,
    ]) {
      expect(
        await sqlState(admin, `update recovery_request set ${assignment} where id = $1`, [
          request.id,
        ]),
        assignment,
      ).toBe('23514');
    }
    // EXPIRED only once its time has passed, CONSUMED only before.
    expect(
      await sqlState(admin, `update recovery_request set state = 'EXPIRED' where id = $1`, [
        request.id,
      ]),
    ).toBe('23514');
    expect(
      await sqlState(
        admin,
        `update recovery_request set state = 'CONSUMED', consumed_at = clock_timestamp() where id = $1`,
        [request.id],
      ),
    ).toBeUndefined();
    expect(
      await sqlState(
        admin,
        `update recovery_request set state = 'SUPERSEDED', consumed_at = null where id = $1`,
        [request.id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(admin, `delete from recovery_request where id = $1`, [request.id]),
    ).toBeUndefined();
  });

  it('is consumed only while it has not expired', async () => {
    const { request } = await issue(byEmail(await staff()));
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `update recovery_request set issued_at = issued_at - interval '2 hours', expires_at = issued_at - interval '1 hour' where id = $1`,
      [request.id],
    );
    await admin.query('commit');
    expect(
      await sqlState(
        admin,
        `update recovery_request set state = 'CONSUMED', consumed_at = clock_timestamp() where id = $1`,
        [request.id],
      ),
    ).toBe('23514');
    expect(
      await sqlState(admin, `update recovery_request set state = 'EXPIRED' where id = $1`, [
        request.id,
      ]),
    ).toBeUndefined();
  });
});

describe('who reaches the table', () => {
  // Break caught: a staff member or a vendor reading or writing a request (a list of recovery links), or the authentication capability
  // writing an administrator's request without the arms that bind it.
  it('admits the authentication capability alone, and a self-service request alone', async () => {
    const principal = await staff();
    const { request } = await issue(byEmail(principal));
    const countAs = (context: SecurityContext) =>
      withHandle(api.service, context, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select count(*)::int as n from recovery_request where id = ${request.id}::uuid`,
        );
        return (result.rows[0] as { n: number }).n;
      });
    expect(await countAs(authentication)).toBe(1);
    expect(await countAs(staffContext([HUB_A], 'ALL'))).toBe(0);
    expect(await countAs(vendorContext(randomUUID()))).toBe(0);
    expect(await countAs(systemContext('rate_limit'))).toBe(0);

    // The store refuses a context it does not serve before anything is sent; the policies refuse the statement itself.
    await expect(issue(byEmail(await staff()), staffContext([HUB_A], 'ALL'))).rejects.toThrow(
      /context/,
    );
    const insertAs = async (context: SecurityContext, initiatedBy: string | null) => {
      const target = await staff();
      return withHandle(api.service, context, (_handle, tx) =>
        tx.execute(sql`insert into recovery_request (id, principal_type, principal_id, channel, token_hash, issued_at, expires_at, state,
                                                     initiated_by)
                       values (gen_random_uuid(), 'STAFF', ${target.id}::uuid, 'EMAIL', sha256(gen_random_uuid()::text::bytea),
                               clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', ${initiatedBy}::uuid)`),
      );
    };
    expect(await stateOf(insertAs(authentication, null))).toBeUndefined();
    expect(await stateOf(insertAs(authentication, randomUUID()))).toBe('42501');
    expect(await stateOf(insertAs(staffContext([HUB_A], 'ALL'), null))).toBe('42501');
    expect(await stateOf(insertAs(vendorContext(randomUUID()), null))).toBe('42501');
  });

  // Break caught: the worker given the hash, the principal or the channel, or any login given the means to remove a request.
  it('gives the worker the state and the expiry alone, and nobody DELETE or TRUNCATE', async () => {
    const { request } = await issue(byEmail(await staff()));
    const asWorker = (statement: ReturnType<typeof sql>) =>
      withHandle(work.service, systemContext('credential_delivery'), (_handle, tx) =>
        tx.execute(statement),
      );
    const seen = await asWorker(
      sql`select id, state, expires_at from recovery_request where id = ${request.id}::uuid`,
    );
    expect(seen.rows).toHaveLength(1);
    for (const column of ['token_hash', 'principal_id', 'channel', 'initiated_by']) {
      expect(
        await stateOf(asWorker(sql.raw(`select ${column} from recovery_request`))),
        column,
      ).toBe('42501');
    }
    for (const login of [
      'melarc_api_runtime',
      'melarc_worker_runtime',
      'melarc_worker_cap_credential_delivery',
    ]) {
      for (const privilege of ['DELETE', 'TRUNCATE']) {
        const held = await admin.query<{ held: boolean }>(
          `select has_table_privilege($1, 'public.recovery_request', $2) as held`,
          [login, privilege],
        );
        expect(held.rows[0]?.held, `${login} ${privilege}`).toBe(false);
      }
    }
  });
});

describe('an administrator’s arms (migration 0038)', () => {
  const recoverer: SecurityContext = {
    ...staffContext([HUB_A], 'ALL'),
    authorizationKey: 'staff.credential.recover',
  };
  const caller = recoverer.principalId;

  /** In one transaction of the recoverer: lock `locked` as the operation does, then insert a request for `target`, initiated by `by`. */
  const insertLocked = (
    locked: string,
    target: string,
    by: string,
    context: SecurityContext = recoverer,
  ) =>
    withHandle(api.service, context, async (_handle, tx) => {
      await tx.execute(sql`select * from melarc.staff_locked_facts(${locked}::uuid)`);
      await tx.execute(sql`insert into recovery_request (id, principal_type, principal_id, channel, token_hash, issued_at, expires_at, state,
                                                         initiated_by)
                           values (gen_random_uuid(), 'STAFF', ${target}::uuid, 'EMAIL', sha256(gen_random_uuid()::text::bytea),
                                   clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', ${by}::uuid)`);
    });

  // Break caught: the recovery key reaching a principal the operation did not lock, a request initiated in another person's name, a
  // request of the other type's key, or a change of a request.
  it('admits a request for the locked identity alone, initiated by the caller, and no change of any', async () => {
    const target = await staff();
    const other = await staff();
    expect(await stateOf(insertLocked(target.id, target.id, caller))).toBeUndefined();
    expect(await stateOf(insertLocked(target.id, other.id, caller))).toBe('42501');
    expect(await stateOf(insertLocked(target.id, target.id, randomUUID()))).toBe('42501');
    const vendorKey: SecurityContext = {
      ...recoverer,
      authorizationKey: 'vendor.credential.recover',
    };
    expect(
      await stateOf(insertLocked(target.id, target.id, caller, vendorKey)),
    ).not.toBeUndefined();
    // The other identity has a request of its own, which the recoverer of the target must not see.
    await issue(byEmail(other));

    const changed = await withHandle(api.service, recoverer, async (_handle, tx) => {
      await tx.execute(sql`select * from melarc.staff_locked_facts(${target.id}::uuid)`);
      const visible = await tx.execute(
        sql`select id from recovery_request where principal_id = ${target.id}::uuid`,
      );
      const otherVisible = await tx.execute(
        sql`select id from recovery_request where principal_id = ${other.id}::uuid`,
      );
      const updated = await tx.execute(
        sql`update recovery_request set state = 'SUPERSEDED' where principal_id = ${target.id}::uuid returning id`,
      );
      return {
        visible: visible.rows.length,
        otherVisible: otherVisible.rows.length,
        updated: updated.rows.length,
      };
    });
    expect(changed).toEqual({ visible: 1, otherVisible: 0, updated: 0 });
  });
});

describe('the standing of a recovery request, as the worker reads it (OB-119)', () => {
  // Break caught: a live link read as closed (a message never sent) or a closed or lapsed one as live (a message for a dead link).
  it('is PENDING while the request can be redeemed, CLOSED once it cannot, and UNCONFIRMED for what it cannot see', async () => {
    const live = await issue(byEmail(await staff()));
    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: live.request.id })).toBe(
      'PENDING',
    );

    const consumed = await issue(byEmail(await staff()));
    await admin.query(
      `update recovery_request set state = 'CONSUMED', consumed_at = clock_timestamp() where id = $1`,
      [consumed.request.id],
    );
    const superseded = await issue(byEmail(await staff()));
    await admin.query(`update recovery_request set state = 'SUPERSEDED' where id = $1`, [
      superseded.request.id,
    ]);
    const lapsed = await issue(byEmail(await staff()));
    await admin.query('begin');
    await admin.query('set local session_replication_role = replica');
    await admin.query(
      `update recovery_request set issued_at = issued_at - interval '2 hours', expires_at = issued_at - interval '1 hour'
                        where id = $1`,
      [lapsed.request.id],
    );
    await admin.query('commit');
    for (const id of [consumed.request.id, superseded.request.id, lapsed.request.id]) {
      expect(await reader.standing({ type: 'RECOVERY_REQUEST', id })).toBe('CLOSED');
    }
    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: randomUUID() })).toBe(
      'UNCONFIRMED',
    );
    expect(await reader.standing({ type: 'SETUP_GRANT', id: live.request.id })).toBe('UNCONFIRMED');
    expect(await reader.standing({ type: 'RECOVERY_REQUEST', id: 'not-an-id' })).toBe(
      'UNCONFIRMED',
    );
  });
});

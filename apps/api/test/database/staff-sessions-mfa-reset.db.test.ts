import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  activateFactor,
  factorRow,
  grantRow,
  insertFactor,
  insertGrant,
  setGrantState,
} from './support/credentials.js';
import {
  hashOf,
  insertSessionRow,
  insertStaff,
  sessionRow,
  staffRow,
  type StaffRow,
} from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.37 (migration 0030): what a Platform Admin who resets a second factor, and a staff member who lists or revokes the sessions of
 * another principal, may read and write, against a real PostgreSQL, as the API's login (`melarc_api_runtime`) in a STAFF context whose
 * authorization key is the key of the operation. The mechanism is the one of migration 0029 (`staff-maker-checker.db.test.ts`): the rows
 * only the `authentication` capability reached are admitted to the operation's own key, bound to a target the caller's scope shows and to
 * the exact shape of the act.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const RESET = 'staff.mfa.reset';
const REVOKE = 'staff.session.revoke';
const READ = 'staff.read';
const APPROVE = 'staff.identity.approve';

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  built = buildService(database, { poolMax: 3 });
  const original = built.service.transactionWithContext.bind(built.service);
  built.service.transactionWithContext = (async (...args: Parameters<typeof original>) => {
    try {
      return await original(...args);
    } catch (error) {
      const server = serverErrorIn(error);
      if (server === undefined) throw error;
      throw new Error(`SQLSTATE ${server.code ?? '?'}: ${server.message}`, { cause: error });
    }
  }) as typeof original;
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

interface Scope {
  readonly mode: 'SET' | 'ALL';
  readonly hubs?: readonly string[];
}
const OWN_A: Scope = { mode: 'SET', hubs: [HUB_A] };
const ALL: Scope = { mode: 'ALL' };

function acting(
  key: string | null,
  scope: Scope = ALL,
  principalId: string = randomUUID(),
): SecurityContext {
  return {
    principalType: 'STAFF',
    principalId,
    surface: 'OPS_PORTAL',
    correlationId: 'staff-sessions-mfa-reset-test',
    hubScopeMode: scope.mode,
    authorizedHubIds: scope.hubs ?? [],
    ...(key === null ? {} : { authorizationKey: key }),
  };
}

type Tx = Parameters<Parameters<BuiltService['service']['transactionWithContext']>[1]>[0];

async function codeOf(
  context: SecurityContext,
  work: (tx: Tx) => Promise<unknown>,
): Promise<string | undefined> {
  try {
    await built.service.transactionWithContext(context, work);
    return undefined;
  } catch (error) {
    const failure = serverErrorIn(error);
    if (failure?.code === undefined) throw error;
    return failure.code;
  }
}

const run = <T>(context: SecurityContext, work: (tx: Tx) => Promise<T>): Promise<T> =>
  built.service.transactionWithContext(context, work);

/**
 * Runs `work` after the identity has been locked as the reset locks it first (`melarc.staff_locked_facts`): the binding that the arms of
 * the setup grant and the delivery job name. An identity the caller's scope does not show is not locked and binds nothing.
 */
const locked =
  <T>(id: string, work: (tx: Tx) => Promise<T>) =>
  async (tx: Tx): Promise<T> => {
    await tx.execute(sql`select * from melarc.staff_locked_facts(${id}::uuid)`);
    return work(tx);
  };

/** Sets the binding directly, for a key the function itself refuses: it shows that the arm of a table names its key, whatever binds. */
const bound =
  <T>(id: string, work: (tx: Tx) => Promise<T>) =>
  async (tx: Tx): Promise<T> => {
    await tx.execute(sql`select set_config('melarc.locked_identity', ${id}, true)`);
    return work(tx);
  };

/** An approved privileged identity with an established password in the hub given: the identity a reset acts on. */
const privileged = (
  hub: string | null = HUB_A,
  overrides: Partial<StaffRow> = {},
): Promise<StaffRow> =>
  insertStaff(
    admin,
    staffRow({ roleBundleId: BUNDLE_IDS.seniorOps, primaryHubId: hub, ...overrides }),
  );

/** A Platform Admin that exists (the administrator named on a revocation is a row: the table holds a foreign key to it). */
const realResetter = async (scope: Scope = ALL): Promise<SecurityContext> =>
  acting(RESET, scope, (await privileged(null, { roleBundleId: BUNDLE_IDS.platformAdmin })).id);

const factorOf = async (target: StaffRow, activate = true) => {
  const factor = await insertFactor(admin, factorRow(target.id));
  if (activate) await activateFactor(admin, factor.id);
  return factor;
};

describe('the identity a reset acts on (staff.mfa.reset)', () => {
  const select = (id: string) => (tx: Tx) =>
    tx.execute(sql`select id from staff_identity where id = ${id}::uuid`);
  const lock = (id: string) => (tx: Tx) =>
    tx.execute(sql`select id from staff_identity where id = ${id}::uuid for no key update`);

  // Break caught: the scope not applying to the reset's read and lock, or the key not named.
  it('reads and locks the identities of its scope, and no other, under its own key alone', async () => {
    const here = await privileged(HUB_A);
    const there = await privileged(HUB_B);
    const scoped = acting(RESET, OWN_A);
    const everywhere = acting(RESET, ALL);

    for (const work of [select, lock]) {
      expect((await run(scoped, work(here.id))).rows).toHaveLength(1);
      expect((await run(scoped, work(there.id))).rows).toHaveLength(0);
      expect((await run(everywhere, work(there.id))).rows).toHaveLength(1);
    }
    // (`staff.session.revoke` reads the identities of its scope since migration 0033, for the trusted browsers an administrator removes.)
    for (const key of [CREATE_KEY, 'settings.reason.read', null]) {
      expect((await run(acting(key, ALL), select(there.id))).rows).toHaveLength(0);
    }
  });

  // Break caught: the reset's lock arm admitting a change: the reset acts on the factors and the sessions and never rewrites the identity.
  it('changes nothing of the identity', async () => {
    const target = await privileged(HUB_A);
    const noop = (tx: Tx) =>
      tx.execute(sql`update staff_identity set status = status where id = ${target.id}::uuid`);

    expect(await codeOf(acting(RESET, ALL), noop)).toBe('42501');
  });

  // Break caught (decision 6 of the audit of 26 October 2026; migration 0033): the lock that the administrator's trusted-browser operations
  // take on an identity becoming a permission to alter it. The key `staff.session.revoke` reads and locks the identities of its scope, as the
  // real runtime login, and changes none: its update arm admits the lock and its check is false.
  it('changes nothing of the identity under the key that ends standing access either', async () => {
    const target = await privileged(HUB_A);
    const noop = (tx: Tx) =>
      tx.execute(sql`update staff_identity set status = status where id = ${target.id}::uuid`);
    const rewrite = (tx: Tx) =>
      tx.execute(sql`update staff_identity set status = 'SUSPENDED' where id = ${target.id}::uuid`);
    const lock = (tx: Tx) =>
      tx.execute(
        sql`select id from staff_identity where id = ${target.id}::uuid for no key update`,
      );

    expect(await codeOf(acting(REVOKE, ALL), noop)).toBe('42501');
    expect(await codeOf(acting(REVOKE, ALL), rewrite)).toBe('42501');
    expect(await codeOf(acting(REVOKE, ALL), lock)).toBeUndefined();
  });
});

describe('the factors of the target', () => {
  const revoke =
    (
      factorId: string,
      by: string,
      overrides: { reason?: string | null; episode?: string | null; status?: string } = {},
    ) =>
    (tx: Tx) =>
      tx.execute(sql`
        update mfa_factor
           set status = ${overrides.status ?? 'REVOKED'}, revoked_at = clock_timestamp(), revoked_by = ${by}::uuid,
               revocation_reason_code = ${overrides.reason === undefined ? 'MFA_AUTHENTICATOR_UNAVAILABLE' : overrides.reason},
               revocation_episode_id = ${overrides.episode === undefined ? randomUUID() : overrides.episode}::uuid
         where id = ${factorId}::uuid`);

  // Break caught: the reset unable to see a factor of its scope, or seeing one of another.
  it('reads the factors of an identity of its scope and no other', async () => {
    const here = await privileged(HUB_A);
    const there = await privileged(HUB_B);
    const mine = await factorOf(here);
    const theirs = await factorOf(there);
    const sibling = await privileged(HUB_A);
    const siblings = await factorOf(sibling);
    const read = (tx: Tx) =>
      tx.execute(
        sql`select id from mfa_factor where id in (${mine.id}::uuid, ${theirs.id}::uuid, ${siblings.id}::uuid)`,
      );
    const idsRead = async (work: (tx: Tx) => Promise<{ rows: unknown[] }>) =>
      ((await run(acting(RESET, OWN_A), work)).rows as { id: string }[]).map((row) => row.id);

    // The locked identity's factors, and no other: not another identity of the same hub, not one of another hub, not with none locked.
    expect(await idsRead(locked(here.id, read))).toEqual([mine.id]);
    expect(await idsRead(locked(sibling.id, read))).toEqual([siblings.id]);
    expect(await idsRead(locked(there.id, read))).toEqual([]);
    expect(await idsRead(read)).toEqual([]);
    expect((await run(acting(APPROVE, ALL), bound(here.id, read))).rows).toHaveLength(0);
    expect((await run(acting(READ, ALL), bound(here.id, read))).rows).toHaveLength(0);
  });

  // Break caught (GBT-B14): the administrative revocation not admitted as the table writes it: the status, the administrator, the reason
  // and the episode together.
  it('revokes a live factor administratively, with the administrator, the reason and the episode', async () => {
    const target = await privileged(HUB_A);
    const factor = await factorOf(target);
    const resetter = await realResetter();
    // The episode is carried by a grant of the identity, which the database checks at commit.
    const episode = randomUUID();

    const result = await run(
      resetter,
      locked(target.id, async (tx) => {
        await tx.execute(sql`
        insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by, episode_id)
        values (${randomUUID()}::uuid, 'STAFF', ${target.id}::uuid, 'MFA_REENROLMENT', ${hashOf(randomUUID())}, clock_timestamp(),
                clock_timestamp() + interval '30 minutes', 'PENDING', ${resetter.principalId}::uuid, ${episode}::uuid)`);
        return revoke(factor.id, resetter.principalId, { episode })(tx);
      }),
    );

    expect(result.rowCount).toBe(1);
    expect(
      (await admin.query('select status, revoked_by from mfa_factor where id = $1', [factor.id]))
        .rows[0],
    ).toMatchObject({ status: 'REVOKED', revoked_by: resetter.principalId });
  });

  // Break caught: a revocation without a reason or an episode, in another administrator's name, to another status, or of an identity
  // outside the scope: each an arm the policy must not have.
  it.each([
    ['without a reason', { reason: null }],
    ['without an episode', { episode: null }],
  ] as const)('refuses a revocation %s', async (_name, overrides) => {
    const target = await privileged(HUB_A);
    const factor = await factorOf(target);
    const resetter = await realResetter();

    expect(
      await codeOf(resetter, locked(target.id, revoke(factor.id, resetter.principalId, overrides))),
    ).toBeDefined();
    expect(
      (await admin.query('select status from mfa_factor where id = $1', [factor.id])).rows[0],
    ).toMatchObject({ status: 'ACTIVE' });
  });

  it('refuses a revocation in another administrator’s name, and leaves an identity outside its scope alone', async () => {
    const target = await privileged(HUB_A);
    const elsewhere = await privileged(HUB_B);
    const factor = await factorOf(target);
    const foreign = await factorOf(elsewhere);

    expect(
      await codeOf(await realResetter(), locked(target.id, revoke(factor.id, randomUUID()))),
    ).toBe('42501');
    const scoped = await realResetter(OWN_A);
    expect(
      (await run(scoped, locked(elsewhere.id, revoke(foreign.id, scoped.principalId)))).rowCount,
    ).toBe(0);
    // With no identity locked the factor is not seen at all: nothing is updated, and nothing is refused.
    expect((await run(scoped, revoke(factor.id, scoped.principalId))).rowCount).toBe(0);
    // Under another key the factor is not seen at all either.
    expect(
      (await run(acting(APPROVE, ALL), bound(target.id, revoke(factor.id, randomUUID())))).rowCount,
    ).toBe(0);
  });

  // Break caught: the reset able to create a factor, or to write the secret, the type or the lineage of one.
  it('cannot create a factor or rewrite one’s lineage', async () => {
    const target = await privileged(HUB_A);
    const factor = await factorOf(target);
    const resetter = acting(RESET, ALL);

    expect(
      await codeOf(resetter, (tx) =>
        tx.execute(sql`
          insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version,
                                  secret_envelope_version, created_by_purpose)
          values (${randomUUID()}::uuid, ${target.id}::uuid, 'TOTP', 'PENDING', ${Buffer.alloc(40, 7)}, ${Buffer.alloc(12, 3)}, 1, 1, 'MFA_REENROLMENT')`),
      ),
    ).toBe('42501');
    for (const column of [
      'staff_identity_id',
      'created_by_purpose',
      'created_episode_id',
      'secret_ciphertext',
    ]) {
      expect(
        await codeOf(resetter, (tx) =>
          tx.execute(
            sql.raw(`update mfa_factor set ${column} = ${column} where id = '${factor.id}'`),
          ),
        ),
      ).toBe('42501');
    }
  });
});

describe('the grants and the message of a reset', () => {
  const issue =
    (
      target: StaffRow,
      by: string,
      overrides: { purpose?: string; episode?: string | null; type?: string } = {},
    ) =>
    (tx: Tx) =>
      tx.execute(sql`
        insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by, episode_id)
        values (${randomUUID()}::uuid, ${overrides.type ?? 'STAFF'}, ${target.id}::uuid, ${overrides.purpose ?? 'MFA_REENROLMENT'}, ${hashOf(randomUUID())},
                clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', ${by}::uuid,
                ${overrides.episode === undefined ? randomUUID() : overrides.episode}::uuid)`);

  // Break caught: no arm to issue the re-enrolment grant, or one that admits a grant to an identity a reset cannot reach.
  it('issues an MFA_REENROLMENT grant of an episode to a privileged identity with a password in its scope', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, ALL);

    expect(
      (await run(resetter, locked(target.id, issue(target, resetter.principalId)))).rowCount,
    ).toBe(1);
  });

  // Break caught (the adversarial review of 23 October 2026): a Platform Admin locking its own identity and issuing itself a re-enrolment
  // grant. The application refuses a reset of one's own factor; the database refuses the grant that would serve it.
  it('refuses a re-enrolment grant to the Platform Admin who asks for it', async () => {
    const self = await privileged(null, { roleBundleId: BUNDLE_IDS.platformAdmin });
    const resetter = acting(RESET, ALL, self.id);

    expect(await codeOf(resetter, locked(self.id, issue(self, resetter.principalId)))).toBe(
      '42501',
    );
    const other = await privileged(HUB_A);
    expect(
      (await run(resetter, locked(other.id, issue(other, resetter.principalId)))).rowCount,
    ).toBe(1);
  });

  // Break caught: an arm that binds nothing to the operation: a grant for an identity the reset never locked, or for another than the
  // one it locked.
  it('refuses a re-enrolment grant for an identity the reset did not lock, or for another than the one it locked', async () => {
    const target = await privileged(HUB_A);
    const other = await privileged(HUB_A);
    const resetter = acting(RESET, ALL);

    expect(await codeOf(resetter, issue(target, resetter.principalId))).toBe('42501');
    expect(await codeOf(resetter, locked(other.id, issue(target, resetter.principalId)))).toBe(
      '42501',
    );
  });

  it.each([
    [
      'an identity that is not privileged',
      () => privileged(HUB_A, { roleBundleId: BUNDLE_IDS.opsStaff }),
    ],
    [
      'an identity with no password',
      () => privileged(HUB_A, { credentialHash: null, credentialEstablishedAt: null }),
    ],
    [
      'a profile still pending',
      () => privileged(HUB_A, { status: 'PENDING_APPROVAL', approvedBy: null }),
    ],
    [
      'a rejected profile',
      () => privileged(HUB_A, { status: 'REJECTED', approvedBy: randomUUID() }),
    ],
    ['an identity in another hub', () => privileged(HUB_B)],
  ] as const)('refuses a re-enrolment grant to %s', async (_name, arrange) => {
    const target = await arrange();
    const resetter = acting(RESET, OWN_A);
    expect(await codeOf(resetter, locked(target.id, issue(target, resetter.principalId)))).toBe(
      '42501',
    );
  });

  // Break caught: the arm admitting any purpose, an episode-less grant, or a grant in another's name.
  it.each([
    ['a STAFF_CREDENTIAL_SETUP grant', { purpose: 'STAFF_CREDENTIAL_SETUP', episode: null }],
    ['an MFA_ENROLMENT grant', { purpose: 'MFA_ENROLMENT' }],
    ['a BOOTSTRAP_SETUP grant', { purpose: 'BOOTSTRAP_SETUP', episode: null }],
    ['a grant with no episode', { episode: null }],
  ] as const)('refuses %s', async (_name, overrides) => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, ALL);
    expect(
      await codeOf(resetter, locked(target.id, issue(target, resetter.principalId, overrides))),
    ).toBeDefined();
  });

  it('refuses a grant in another issuer’s name, and under any other key', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, ALL);
    expect(await codeOf(resetter, locked(target.id, issue(target, randomUUID())))).toBe('42501');
    for (const key of [APPROVE, READ, REVOKE, null]) {
      const context = acting(key, ALL);
      expect(await codeOf(context, bound(target.id, issue(target, context.principalId)))).toBe(
        '42501',
      );
    }
  });

  // Break caught: the reset reading a grant it has no business with, or ending one that is not pending or not of its purposes.
  it('reads and ends the pending enrolment and re-enrolment grants of its scope, and no other grant', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, OWN_A);
    const reenrolment = await insertGrant(
      admin,
      grantRow({ principalId: target.id, purpose: 'MFA_REENROLMENT', episodeId: randomUUID() }),
    );
    const enrolment = await insertGrant(
      admin,
      grantRow({ principalId: target.id, purpose: 'MFA_ENROLMENT' }),
    );
    const setup = await insertGrant(
      admin,
      grantRow({ principalId: target.id, purpose: 'STAFF_CREDENTIAL_SETUP' }),
    );
    const elsewhere = await privileged(HUB_B);
    const foreign = await insertGrant(
      admin,
      grantRow({ principalId: elsewhere.id, purpose: 'MFA_REENROLMENT', episodeId: randomUUID() }),
    );
    const ids = [reenrolment.id, enrolment.id, setup.id, foreign.id];
    const end = (id: string, state: string) => (tx: Tx) =>
      tx.execute(sql`update setup_grant set state = ${state} where id = ${id}::uuid`);

    const read = (tx: Tx) =>
      tx.execute(sql`select id from setup_grant where id = any(${`{${ids.join(',')}}`}::uuid[])`);
    const visible = await run(resetter, locked(target.id, read));
    expect((visible.rows as { id: string }[]).map((row) => row.id).toSorted()).toEqual(
      [reenrolment.id, enrolment.id].toSorted(),
    );
    // Not bound: with no identity locked, or one of another hub that the scope does not show, no grant is found.
    expect((await run(resetter, read)).rows).toEqual([]);
    expect((await run(resetter, locked(elsewhere.id, read))).rows).toEqual([]);
    expect(
      (await run(resetter, locked(target.id, end(reenrolment.id, 'SUPERSEDED')))).rowCount,
    ).toBe(1);
    expect((await run(resetter, locked(target.id, end(setup.id, 'SUPERSEDED')))).rowCount).toBe(0);
    expect((await run(resetter, locked(target.id, end(foreign.id, 'SUPERSEDED')))).rowCount).toBe(
      0,
    );
    expect(await codeOf(resetter, locked(target.id, end(enrolment.id, 'CONSUMED')))).toBe('42501');
    await setGrantState(admin, enrolment.id, 'SUPERSEDED');
  });

  const queue =
    (target: StaffRow, grantId: string, overrides: { kind?: string } = {}) =>
    (tx: Tx) =>
      tx.execute(sql`
      insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel, state,
                                           next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext, payload_nonce, payload_key_version,
                                           payload_envelope_version)
      values (${randomUUID()}::uuid, ${overrides.kind ?? 'MFA_REENROLMENT'}, 'SETUP_GRANT', ${grantId}::uuid, 'STAFF', ${target.id}::uuid, 'EMAIL', 'QUEUED',
              clock_timestamp(), clock_timestamp() + interval '30 minutes', ${randomUUID()}, ${Buffer.alloc(40, 7)}, ${Buffer.alloc(12, 3)}, 1, 1)`);

  // Break caught: no arm to queue the message, or one that queues a message of another kind or for a grant the reset did not issue.
  it('queues an MFA_REENROLMENT message for a grant it issued, and for no other kind or grant', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, ALL);
    const mine = await insertGrant(
      admin,
      grantRow({
        principalId: target.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: randomUUID(),
        issuedBy: resetter.principalId,
      }),
    );
    const other = await privileged(HUB_A);
    const theirs = await insertGrant(
      admin,
      grantRow({
        principalId: other.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: randomUUID(),
        issuedBy: randomUUID(),
      }),
    );

    expect(await codeOf(resetter, queue(target, mine.id))).toBe('42501');
    expect((await run(resetter, locked(target.id, queue(target, mine.id)))).rowCount).toBe(1);
    expect(await codeOf(resetter, locked(other.id, queue(other, theirs.id)))).toBe('42501');
    expect(
      await codeOf(resetter, locked(target.id, queue(target, mine.id, { kind: 'SETUP_GRANT' }))),
    ).toBe('42501');
    expect(
      await codeOf(
        acting(APPROVE, ALL, resetter.principalId),
        bound(target.id, queue(target, mine.id)),
      ),
    ).toBe('42501');
  });

  // Break caught: the read arm of the job not bound to the locked identity: the reset reading the messages of identities it never locked.
  it('reads the re-enrolment message of the locked identity and no other, and none with no identity locked', async () => {
    const resetter = acting(RESET, ALL);
    const first = await privileged(HUB_A);
    const second = await privileged(HUB_A);
    const grants: string[] = [];
    for (const target of [first, second]) {
      const grant = await insertGrant(
        admin,
        grantRow({
          principalId: target.id,
          purpose: 'MFA_REENROLMENT',
          episodeId: randomUUID(),
          issuedBy: resetter.principalId,
        }),
      );
      await run(resetter, locked(target.id, queue(target, grant.id)));
      grants.push(grant.id);
    }
    const read = (tx: Tx) =>
      tx.execute(
        sql`select principal_id from credential_delivery_job where redemption_record_id = any(${`{${grants.join(',')}}`}::uuid[])`,
      );
    const principals = async (work: (tx: Tx) => Promise<{ rows: unknown[] }>) =>
      ((await run(resetter, work)).rows as { principal_id: string }[]).map(
        (row) => row.principal_id,
      );

    expect(await principals(locked(first.id, read))).toEqual([first.id]);
    expect(await principals(locked(second.id, read))).toEqual([second.id]);
    expect(await principals(read)).toEqual([]);
  });

  it('cancels the live message of a re-enrolment grant of its scope, and no other job', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, OWN_A);
    const grant = await insertGrant(
      admin,
      grantRow({
        principalId: target.id,
        purpose: 'MFA_REENROLMENT',
        episodeId: randomUUID(),
        issuedBy: resetter.principalId,
      }),
    );
    await run(resetter, locked(target.id, queue(target, grant.id)));
    const setupTarget = await privileged(HUB_A);
    const setupGrant = await insertGrant(
      admin,
      grantRow({ principalId: setupTarget.id, purpose: 'STAFF_CREDENTIAL_SETUP' }),
    );
    await admin.query(
      `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel, state,
                                            next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext, payload_nonce, payload_key_version, payload_envelope_version)
       values (gen_random_uuid(), 'SETUP_GRANT', 'SETUP_GRANT', $1, 'STAFF', $2, 'EMAIL', 'QUEUED', clock_timestamp(), clock_timestamp() + interval '30 minutes',
               gen_random_uuid()::text, $3, $4, 1, 1)`,
      [setupGrant.id, setupTarget.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
    );
    const cancel = (grantId: string) => (tx: Tx) =>
      tx.execute(sql`
        update credential_delivery_job
           set state = 'CANCELLED', outcome_class = 'CANCELLED', payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
               payload_envelope_version = null, payload_erased_at = clock_timestamp()
         where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${grantId}::uuid and state in ('QUEUED', 'LEASED', 'RETRYABLE')`);

    // Not bound: with no identity locked the live message is not the reset's to end (this runs first, so that the job is still live).
    expect((await run(resetter, cancel(grant.id))).rowCount).toBe(0);
    expect((await run(resetter, locked(target.id, cancel(grant.id)))).rowCount).toBe(1);
    expect((await run(resetter, locked(setupTarget.id, cancel(setupGrant.id)))).rowCount).toBe(0);
  });
});

describe('the sessions of another principal', () => {
  /** A live session of the principal, with the hubs it was issued for. */
  const live = (
    type: 'STAFF' | 'VENDOR' | 'RIDER',
    hubs: readonly string[],
    principalId: string = randomUUID(),
  ) =>
    insertSessionRow(
      admin,
      sessionRow({
        principalType: type,
        principalId,
        authorizedHubIds: hubs,
        ...(type === 'STAFF' ? {} : { registeredDeviceId: randomUUID(), policyRevision: 1 }),
      }),
    );
  const read = (ids: readonly string[]) => (tx: Tx) =>
    tx.execute(sql`select id from session where id = any(${`{${ids.join(',')}}`}::uuid[])`);
  const idsOf = (result: { rows: unknown[] }) =>
    (result.rows as { id: string }[]).map((row) => row.id).toSorted();
  const end =
    (id: string, reason = 'ADMIN_REVOKED') =>
    (tx: Tx) =>
      tx.execute(
        sql`update session set terminated_at = clock_timestamp(), termination_reason = ${reason} where id = ${id}::uuid`,
      );

  // Break caught: the scope of a session not applying, or the keys of a read and a revocation not named.
  it('shows the list and the revocation the sessions their scope reaches: shared hubs, every hub under the all-hub scope, a vendor’s always', async () => {
    const here = await live('STAFF', [HUB_A]);
    const there = await live('STAFF', [HUB_B]);
    const rider = await live('RIDER', [HUB_A]);
    const vendor = await live('VENDOR', []);
    const ids = [here.id, there.id, rider.id, vendor.id];

    for (const key of [READ, REVOKE]) {
      expect(idsOf(await run(acting(key, OWN_A), read(ids)))).toEqual(
        [here.id, rider.id, vendor.id].toSorted(),
      );
      expect(idsOf(await run(acting(key, ALL), read(ids)))).toEqual(ids.toSorted());
      expect(idsOf(await run(acting(key, { mode: 'SET', hubs: [] }), read(ids)))).toEqual([
        vendor.id,
      ]);
    }
    for (const key of [APPROVE, CREATE_KEY, null]) {
      expect(idsOf(await run(acting(key, ALL), read(ids)))).toEqual([]);
    }
  });

  // Break caught: the revocation ending a session with a reason an administrator does not give, un-ending one, or ending one it cannot reach.
  it('ends a session of its scope with ADMIN_REVOKED and no other reason, and ends none outside it', async () => {
    const revoker = acting(REVOKE, OWN_A);
    const own = await live('RIDER', [HUB_A]);
    const elsewhere = await live('RIDER', [HUB_B]);

    expect(await codeOf(revoker, end(own.id, 'MFA_RESET'))).toBe('42501');
    expect(await codeOf(revoker, end(own.id, 'SIGNED_OUT'))).toBe('42501');
    expect((await run(revoker, end(elsewhere.id))).rowCount).toBe(0);
    expect((await run(revoker, end(own.id))).rowCount).toBe(1);
    expect((await run(revoker, end(own.id))).rowCount).toBe(0);
    expect(
      (await admin.query('select termination_reason from session where id = $1', [own.id])).rows[0],
    ).toMatchObject({ termination_reason: 'ADMIN_REVOKED' });
    expect(
      (await admin.query('select terminated_at from session where id = $1', [elsewhere.id]))
        .rows[0],
    ).toMatchObject({ terminated_at: null });
  });

  it('is held to the revocation key: the list’s key and every other end nothing', async () => {
    const target = await live('STAFF', [HUB_A]);
    for (const key of [READ, RESET, APPROVE, null]) {
      const context = acting(key, ALL);
      const result = await codeOf(context, end(target.id));
      expect(result === '42501' || result === undefined).toBe(true);
    }
    expect(
      (await admin.query('select terminated_at from session where id = $1', [target.id])).rows[0],
    ).toMatchObject({ terminated_at: null });
  });

  // Break caught: the activity moved by the revocation (the system's write alone), or a session created by an administrator.
  it('records no activity with a revocation and creates no session', async () => {
    const revoker = acting(REVOKE, ALL);
    const target = await live('STAFF', [HUB_A]);

    expect(
      await codeOf(revoker, (tx) =>
        tx.execute(
          sql`update session set terminated_at = clock_timestamp(), termination_reason = 'ADMIN_REVOKED', last_activity_at = last_activity_at + interval '1 minute' where id = ${target.id}::uuid`,
        ),
      ),
    ).toBe('23514');
    expect(
      await codeOf(revoker, (tx) =>
        tx.execute(sql`
          insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids, token_hash, csrf_token_hash,
                               issued_at, expires_at, last_activity_at)
          values (${randomUUID()}::uuid, 'STAFF', ${target.principalId}::uuid, '{"format":1}'::jsonb, ${BUNDLE_IDS.opsStaff}::uuid, 1, '{}', ${hashOf(randomUUID())}, ${hashOf(randomUUID())},
                  clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour', clock_timestamp() - interval '1 minute')`),
      ),
    ).toBe('42501');
  });

  // Break caught: the reset reaching a session of a vendor or a rider, or of an identity outside its scope, or ending one with another reason.
  it('lets the reset end the live sessions of a staff identity of its scope with MFA_RESET, and no other session', async () => {
    const target = await privileged(HUB_A);
    const resetter = acting(RESET, OWN_A);
    const mine = await live('STAFF', [HUB_A], target.id);
    const other = await privileged(HUB_B);
    const foreign = await live('STAFF', [HUB_B], other.id);
    const rider = await live('RIDER', [HUB_A]);
    const reset =
      (id: string, reason = 'MFA_RESET') =>
      (tx: Tx) =>
        tx.execute(
          sql`update session set terminated_at = clock_timestamp(), termination_reason = ${reason} where id = ${id}::uuid`,
        );

    const sibling = await privileged(HUB_A);
    const siblings = await live('STAFF', [HUB_A], sibling.id);
    const all = [mine.id, foreign.id, rider.id, siblings.id];

    // The sessions of the identity the reset has locked, and no other: not a sibling of the same hub, not another hub's, not a rider's.
    expect(idsOf(await run(resetter, locked(target.id, read(all))))).toEqual([mine.id]);
    expect(idsOf(await run(resetter, read(all)))).toEqual([]);
    expect(idsOf(await run(resetter, locked(other.id, read(all))))).toEqual([]);
    expect(await codeOf(resetter, locked(target.id, reset(mine.id, 'ADMIN_REVOKED')))).toBe(
      '42501',
    );
    expect((await run(resetter, locked(target.id, reset(foreign.id)))).rowCount).toBe(0);
    expect((await run(resetter, locked(target.id, reset(rider.id)))).rowCount).toBe(0);
    expect((await run(resetter, locked(target.id, reset(siblings.id)))).rowCount).toBe(0);
    expect((await run(resetter, reset(mine.id))).rowCount).toBe(0);
    expect((await run(resetter, locked(target.id, reset(mine.id)))).rowCount).toBe(1);
  });
});

const CREATE_KEY = 'staff.identity.create';

describe('melarc.staff_locked_facts under staff.mfa.reset', () => {
  const FACTS = (id: string | null) => (tx: Tx) =>
    tx.execute(sql`select * from melarc.staff_locked_facts(${id}::uuid)`);

  // Break caught: the reset's key not admitted to the function, or the function opened to a key the operations do not hold.
  it('answers to staff.mfa.reset as to staff.identity.approve, and to no other key', async () => {
    const target = await privileged(HUB_A);
    await factorOf(target);

    for (const key of [RESET, APPROVE]) {
      const answer = await run(acting(key, ALL), FACTS(target.id));
      expect(answer.rows).toHaveLength(1);
      expect(answer.rows[0]).toMatchObject({ identity_id: target.id, has_active_factor: true });
    }
    for (const key of [READ, CREATE_KEY, null]) {
      expect(await codeOf(acting(key, ALL), FACTS(target.id))).toBe('42501');
    }
    // The key that ends standing access is admitted since migration 0033 (the trusted browsers of an identity are removed under its lock).
    expect(await codeOf(acting(REVOKE, ALL), FACTS(target.id))).toBeUndefined();
  });

  it('applies the reset’s scope and says nothing of an identity outside it', async () => {
    const there = await privileged(HUB_B);

    expect((await run(acting(RESET, OWN_A), FACTS(there.id))).rows).toEqual([]);
    expect((await run(acting(RESET, ALL), FACTS(there.id))).rows).toHaveLength(1);
  });
});

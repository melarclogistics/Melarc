import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { TransactionOptions } from '../../src/platform/database/database.service.js';
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
import { hashOf, insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.36 (migration 0029): what a staff member who makes, approves or re-issues may write, against a real PostgreSQL, as the API's login
 * (`melarc_api_runtime`) in a STAFF context whose authorization key is the key of the operation. The statement of the mechanism is the
 * header of the migration: the rows only the `authentication` capability reached are admitted to the operation's own key, bound to
 * a target the caller's scope shows and to the exact shape of the act, and the facts the mutation needs under the identity's lock come
 * from one function that refuses anything but that key at READ COMMITTED.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const CREATE = 'staff.identity.create';
const APPROVE = 'staff.identity.approve';
const COMMITTED = 'read committed';
const RR: TransactionOptions = { isolation: 'REPEATABLE READ' };

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
  // A refusal the test did not expect should say what the server said: the error keeps the server's text, and its cause.
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

/** A staff member's context for the operation whose key is given, as the guard builds it from the grant that authorizes it. */
function acting(
  key: string | null,
  scope: Scope = OWN_A,
  principalId: string = randomUUID(),
): SecurityContext {
  return {
    principalType: 'STAFF',
    principalId,
    surface: 'OPS_PORTAL',
    correlationId: 'staff-maker-checker-test',
    hubScopeMode: scope.mode,
    authorizedHubIds: scope.hubs ?? [],
    ...(key === null ? {} : { authorizationKey: key }),
  };
}

/** The SQLSTATE the server refused the work with (and the constraint, where it names one), or `undefined` when it did not refuse. */
async function refusal(
  context: SecurityContext,
  work: (
    tx: Parameters<Parameters<BuiltService['service']['transactionWithContext']>[1]>[0],
  ) => Promise<unknown>,
  options?: TransactionOptions,
): Promise<{ readonly code: string; readonly constraint: string | undefined } | undefined> {
  try {
    await built.service.transactionWithContext(context, work, options);
    return undefined;
  } catch (error) {
    const failure = serverErrorIn(error);
    if (failure?.code === undefined) throw error;
    return { code: failure.code, constraint: failure.constraint };
  }
}

const codeOf = async (
  context: SecurityContext,
  work: Parameters<typeof refusal>[1],
  options?: TransactionOptions,
): Promise<string | undefined> => (await refusal(context, work, options))?.code;

type Work = Parameters<typeof refusal>[1];
type Tx = Parameters<Work>[0];

/**
 * Runs `work` after the identity has been locked as every operation locks it first (`melarc.staff_locked_facts`): the binding that the
 * arms of the setup grant and the delivery job name. An identity the caller's scope does not show is not locked and binds nothing.
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

let sequence = 0;

/** What the maker writes: a pending profile of the shape `createStaffIdentity` always makes. */
interface Profile {
  readonly id: string;
  readonly email: string;
  readonly status: string;
  readonly origin: string;
  readonly approvedBy: string | null;
  readonly createdBy: string;
  readonly hub: string | null;
  readonly bundle: string;
}
function profile(maker: SecurityContext, overrides: Partial<Profile> = {}): Profile {
  sequence += 1;
  const email = `maker-${String(sequence)}-${randomUUID().slice(0, 8)}@example.test`;
  return {
    id: randomUUID(),
    email,
    status: 'PENDING_APPROVAL',
    origin: 'MAKER_CHECKER',
    approvedBy: null,
    createdBy: maker.principalId,
    hub: HUB_A,
    bundle: BUNDLE_IDS.opsStaff,
    ...overrides,
  };
}

/**
 * The statement the maker sends. It never names `approved_by` (the maker has no INSERT on the column); a test that gives the profile a
 * checker sends the column all the same, to show that the maker cannot.
 */
const insertProfile =
  (p: Profile, returning = false) =>
  (tx: Parameters<Parameters<typeof refusal>[1]>[0]) => {
    // Without RETURNING, the policy of the insert is the only one asked: with it the new row must also be one the maker may read, which
    // would refuse a row of the wrong shape for a second reason and hide a policy that had lost its own check.
    const give = returning ? sql`returning id, version` : sql``;
    return p.approvedBy === null
      ? tx.execute(sql`
          insert into staff_identity (id, work_email, work_email_canonical, full_name, phone, status, role_bundle_id, primary_hub_id,
                                      created_by, origin)
          values (${p.id}::uuid, ${p.email}, ${p.email}, 'Kofi Boateng', null, ${p.status}, ${p.bundle}::uuid, ${p.hub}::uuid,
                  ${p.createdBy}::uuid, ${p.origin}) ${give}`)
      : tx.execute(sql`
          insert into staff_identity (id, work_email, work_email_canonical, full_name, phone, status, role_bundle_id, primary_hub_id,
                                      created_by, approved_by, origin)
          values (${p.id}::uuid, ${p.email}, ${p.email}, 'Kofi Boateng', null, ${p.status}, ${p.bundle}::uuid, ${p.hub}::uuid,
                  ${p.createdBy}::uuid, ${p.approvedBy}::uuid, ${p.origin}) ${give}`);
  };

/** A pending profile arranged as the administrator, in the hub given, by a maker who is not the caller. */
async function pending(
  hub: string | null = HUB_A,
  overrides: Partial<StaffRow> = {},
): Promise<StaffRow> {
  return insertStaff(
    admin,
    staffRow({
      status: 'PENDING_APPROVAL',
      approvedBy: null,
      credentialHash: null,
      credentialEstablishedAt: null,
      primaryHubId: hub,
      roleBundleId: BUNDLE_IDS.opsStaff,
      ...overrides,
    }),
  );
}

/** An `ACTIVE` profile that has been approved and holds no credential yet: the identity a setup grant is issued to. */
const onboarding = (
  hub: string | null = HUB_A,
  overrides: Partial<StaffRow> = {},
): Promise<StaffRow> => pending(hub, { status: 'ACTIVE', approvedBy: randomUUID(), ...overrides });

const storedStatus = async (
  id: string,
): Promise<{ status: string; approved_by: string | null; version: number }> =>
  (
    await admin.query<{ status: string; approved_by: string | null; version: number }>(
      'select status, approved_by, version from staff_identity where id = $1',
      [id],
    )
  ).rows[0] ?? { status: '', approved_by: null, version: 0 };

describe('the maker (staff.identity.create)', () => {
  // Break caught: no arm admitting the maker's insert, so that createStaffIdentity could not commit; or the maker unable to be given
  // back the row it just made (the RETURNING that carries the version).
  it('inserts a pending profile of its own shape in its own hub and is given the row back', async () => {
    const maker = acting(CREATE);
    const written = profile(maker);

    const result = await built.service.transactionWithContext(maker, insertProfile(written, true));

    expect(result.rows).toEqual([{ id: written.id, version: 1 }]);
    expect(await storedStatus(written.id)).toMatchObject({
      status: 'PENDING_APPROVAL',
      approved_by: null,
    });
  });

  // Break caught: the arm not naming the key, so that any staff context (a read, an approval, a reset) could create a profile.
  it('is refused under any other key, and under none', async () => {
    for (const key of [APPROVE, 'staff.read', 'staff.mfa.reset', 'staff.session.revoke', null]) {
      const context = acting(key);
      expect(await codeOf(context, insertProfile(profile(context)))).toBe('42501');
    }
  });

  // Break caught: the arm admitting a shape the maker never makes: a profile already decided, a seeded administrator, a stated checker.
  it.each([
    ['an ACTIVE profile', { status: 'ACTIVE', approvedBy: randomUUID() }],
    ['a REJECTED profile', { status: 'REJECTED', approvedBy: randomUUID() }],
    ['a profile of origin BOOTSTRAP', { origin: 'BOOTSTRAP' }],
    ['a pending profile with a checker named', { approvedBy: randomUUID() }],
    ['a profile made in another maker’s name', { createdBy: randomUUID() }],
  ] as const)('refuses %s', async (_name, overrides) => {
    const maker = acting(CREATE);
    expect(await codeOf(maker, insertProfile(profile(maker, overrides)))).toBe('42501');
  });

  // Break caught: the hub test missing or inverted: a maker placing a profile in a hub it does not act in, or a scoped maker making a
  // profile that no hub-scoped colleague could ever approve (no hub).
  it('places a profile only in a hub of its scope, and leaves the hub out only under the all-hub scope', async () => {
    const scoped = acting(CREATE, OWN_A);
    const everywhere = acting(CREATE, ALL);

    expect(await codeOf(scoped, insertProfile(profile(scoped, { hub: HUB_B })))).toBe('42501');
    expect(await codeOf(scoped, insertProfile(profile(scoped, { hub: null })))).toBe('42501');
    expect(
      await codeOf(acting(CREATE, { mode: 'SET', hubs: [] }), insertProfile(profile(scoped))),
    ).toBe('42501');

    expect(
      await codeOf(everywhere, insertProfile(profile(everywhere, { hub: HUB_B }))),
    ).toBeUndefined();
    expect(
      await codeOf(everywhere, insertProfile(profile(everywhere, { hub: null }))),
    ).toBeUndefined();
  });

  // Break caught: a bundle of a Rider or a Vendor named for a human staff profile.
  it('refuses a bundle that is not a staff bundle', async () => {
    const maker = acting(CREATE);
    for (const bundle of [BUNDLE_IDS.rider, BUNDLE_IDS.vendor, randomUUID()]) {
      expect(await codeOf(maker, insertProfile(profile(maker, { bundle })))).toBeDefined();
    }
    for (const bundle of [
      BUNDLE_IDS.opsStaff,
      BUNDLE_IDS.seniorOps,
      BUNDLE_IDS.platformAdmin,
      BUNDLE_IDS.finance,
    ]) {
      expect(await codeOf(maker, insertProfile(profile(maker, { bundle })))).toBeUndefined();
    }
  });

  // Break caught: the INSERT grant covering the credential, the generation or the failed-attempt columns, so that the maker could
  // supply a credential (AC-SLICE-000-33 says the maker never does).
  it('cannot write a credential column, whatever the policy says', async () => {
    const maker = acting(CREATE);
    const written = profile(maker);
    for (const column of [
      'credential_hash',
      'credential_established_at',
      'credential_generation',
      'failed_attempt_count',
      'version',
    ]) {
      expect(
        await codeOf(maker, (tx) =>
          tx.execute(
            sql.raw(
              `insert into staff_identity (id, work_email, work_email_canonical, full_name, status, role_bundle_id, primary_hub_id, created_by, origin, ${column})
               values (gen_random_uuid(), 'x-${randomUUID().slice(0, 8)}@example.test', 'x-${randomUUID().slice(0, 8)}@example.test', 'X', 'PENDING_APPROVAL',
                       '${written.bundle}', '${HUB_A}', '${maker.principalId}', 'MAKER_CHECKER', ${column === 'credential_hash' ? "'h'" : column === 'credential_established_at' ? 'now()' : '5'})`,
            ),
          ),
        ),
      ).toBe('42501');
    }
  });

  // Break caught: a second profile on a live address, or the address of a REJECTED profile held for ever.
  it('is held to one live profile for a work email, and a rejected profile releases its address', async () => {
    const maker = acting(CREATE);
    const first = profile(maker);
    await built.service.transactionWithContext(maker, insertProfile(first));

    const again = await refusal(maker, insertProfile(profile(maker, { email: first.email })));
    expect(again).toEqual({ code: '23505', constraint: 'staff_identity_work_email_live_key' });

    await admin.query(
      `update staff_identity set status = 'REJECTED', approved_by = $2 where id = $1`,
      [first.id, randomUUID()],
    );
    expect(
      await codeOf(maker, insertProfile(profile(maker, { email: first.email }))),
    ).toBeUndefined();
  });

  // Break caught: the maker reading anyone else's profile, or its own after it was decided, or a read under another operation's key.
  it('reads back only a pending profile it made, and only while making it', async () => {
    const maker = acting(CREATE);
    const mine = profile(maker);
    await built.service.transactionWithContext(maker, insertProfile(mine));
    const theirs = await pending(HUB_A);
    const select = (id: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`select id from staff_identity where id = ${id}::uuid`);

    expect((await built.service.transactionWithContext(maker, select(mine.id))).rows).toHaveLength(
      1,
    );
    expect(
      (await built.service.transactionWithContext(maker, select(theirs.id))).rows,
    ).toHaveLength(0);
    expect(
      (
        await built.service.transactionWithContext(
          acting('staff.read', ALL, maker.principalId),
          select(mine.id),
        )
      ).rows,
    ).toHaveLength(1);

    await admin.query(
      `update staff_identity set status = 'ACTIVE', approved_by = $2 where id = $1`,
      [mine.id, randomUUID()],
    );
    expect((await built.service.transactionWithContext(maker, select(mine.id))).rows).toHaveLength(
      0,
    );
  });

  // Break caught: a Vendor, a Rider or the system inserting a staff profile of the maker's shape.
  it('admits no principal that is not a staff member under the operation’s key', async () => {
    const written = profile(acting(CREATE));
    const insert = insertProfile(written);
    for (const context of [
      {
        principalType: 'VENDOR',
        principalId: randomUUID(),
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
        correlationId: 'x',
      },
      {
        principalType: 'RIDER',
        principalId: randomUUID(),
        surface: 'RIDER_ANDROID',
        riderId: randomUUID(),
        correlationId: 'x',
      },
      {
        principalType: 'SYSTEM',
        principalId: randomUUID(),
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'x',
      },
    ] as SecurityContext[]) {
      expect(await codeOf(context, insert)).toBe('42501');
    }
  });
});

describe('the approver (staff.identity.approve): reading and locking', () => {
  const select = (id: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
    tx.execute(sql`select id from staff_identity where id = ${id}::uuid`);
  const lock = (id: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
    tx.execute(sql`select id from staff_identity where id = ${id}::uuid for no key update`);

  // Break caught: the approver reading outside its scope, or the arm not applying the grant's scope at all.
  it('reads and locks the identities of its own scope, and none of another hub', async () => {
    const here = await pending(HUB_A);
    const there = await pending(HUB_B);
    const hubless = await pending(null);
    const scoped = acting(APPROVE, OWN_A);
    const everywhere = acting(APPROVE, ALL);

    for (const work of [select, lock]) {
      expect((await built.service.transactionWithContext(scoped, work(here.id))).rows).toHaveLength(
        1,
      );
      expect(
        (await built.service.transactionWithContext(scoped, work(there.id))).rows,
      ).toHaveLength(0);
      expect(
        (await built.service.transactionWithContext(scoped, work(hubless.id))).rows,
      ).toHaveLength(0);
      for (const target of [here, there, hubless]) {
        expect(
          (await built.service.transactionWithContext(everywhere, work(target.id))).rows,
        ).toHaveLength(1);
      }
    }
  });

  // Break caught: the arm applying to every key, so that any staff operation reads the people it was never meant to see. (The key
  // `staff.mfa.reset` has an arm of its own since migration 0030: staff-sessions-mfa-reset.db.test.ts reads and refuses with it.)
  it('reads nothing of another hub under another key, and nothing under none', async () => {
    const there = await pending(HUB_B);
    // (`staff.session.revoke` has an arm of its own since migration 0033, for the trusted browsers of an identity an administrator
    // removes: it reads and locks the identities of its scope, tested below and in staff-trusted-browser.db.test.ts.)
    for (const key of [CREATE, 'settings.reason.read', null]) {
      expect(
        (await built.service.transactionWithContext(acting(key, ALL), select(there.id))).rows,
      ).toHaveLength(0);
    }
  });

  // Break caught: the administrator's key for trusted browsers reading or locking an identity outside its scope, or opening the lock to
  // an identity it may not see (migration 0033: the same read and lock arms as the resetter's, for a second key).
  it('reads and locks the identities of its scope under staff.session.revoke, and no other', async () => {
    const here = await pending(HUB_A);
    const there = await pending(HUB_B);
    const scoped = acting('staff.session.revoke', OWN_A);
    const everywhere = acting('staff.session.revoke', ALL);

    for (const work of [select, lock]) {
      expect((await built.service.transactionWithContext(scoped, work(here.id))).rows).toHaveLength(
        1,
      );
      expect(
        (await built.service.transactionWithContext(scoped, work(there.id))).rows,
      ).toHaveLength(0);
      expect(
        (await built.service.transactionWithContext(everywhere, work(there.id))).rows,
      ).toHaveLength(1);
    }
  });
});

describe('the decision of an approver', () => {
  const decide =
    (id: string, status: string, approvedBy: string) =>
    (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(
        sql`update staff_identity set status = ${status}, approved_by = ${approvedBy}::uuid where id = ${id}::uuid returning id, version`,
      );

  // Break caught: no arm admitting the decision, or the version not moving with it (an ETag taken before would still match).
  it.each([['ACTIVE'], ['REJECTED']])(
    'moves a pending profile of its scope to %s, naming itself the checker, and the version moves',
    async (status) => {
      const target = await pending(HUB_A);
      const approver = acting(APPROVE);

      const before = await storedStatus(target.id);
      const result = await built.service.transactionWithContext(
        approver,
        decide(target.id, status, approver.principalId),
      );

      expect(result.rows).toHaveLength(1);
      expect(await storedStatus(target.id)).toMatchObject({
        status,
        approved_by: approver.principalId,
      });
      expect((await storedStatus(target.id)).version).toBe(before.version + 1);
    },
  );

  // Break caught: a checker named other than the one acting; a status other than the two a decision makes.
  it('refuses a decision that names another checker, or a status a decision never makes', async () => {
    const approver = acting(APPROVE);
    const target = await pending(HUB_A);

    // The new row names a checker who is not the caller: the policy's check refuses it. A status a decision never makes is refused
    // first, by the machine of the table (a BEFORE trigger answers before a policy's WITH CHECK).
    expect(await codeOf(approver, decide(target.id, 'ACTIVE', randomUUID()))).toBe('42501');
    for (const status of ['SUSPENDED', 'OFFBOARDED', 'PENDING_APPROVAL']) {
      expect(await codeOf(approver, decide(target.id, status, approver.principalId))).toBe('23514');
    }
    expect(await storedStatus(target.id)).toMatchObject({
      status: 'PENDING_APPROVAL',
      approved_by: null,
    });
  });

  // Break caught: the scope not applying to the write, so that an approver decides a profile of a hub it does not act in.
  it('changes nothing of an identity outside its scope', async () => {
    const approver = acting(APPROVE);
    const there = await pending(HUB_B);

    const result = await built.service.transactionWithContext(
      approver,
      decide(there.id, 'ACTIVE', approver.principalId),
    );

    expect(result.rows).toHaveLength(0);
    expect((await storedStatus(there.id)).status).toBe('PENDING_APPROVAL');
  });

  // Break caught: the key not named, so that a reader (staff.read) or a resetter decides a profile.
  it('is refused under any other key', async () => {
    const target = await pending(HUB_A);
    for (const key of ['staff.read', CREATE, 'staff.mfa.reset', null]) {
      const context = acting(key, ALL);
      const result = await refusal(context, decide(target.id, 'ACTIVE', context.principalId));
      // Either the policy refuses the new row or no row is visible to change: nothing is decided either way.
      expect(result?.code === '42501' || result === undefined).toBe(true);
    }
    expect((await storedStatus(target.id)).status).toBe('PENDING_APPROVAL');
  });

  // Break caught: a decided profile reopened or flipped (an ACTIVE one rejected, a REJECTED one approved): terminal states, and the
  // checker recorded once.
  it('does not change a decided profile, and cannot rename its checker', async () => {
    const approver = acting(APPROVE);
    const active = await onboarding(HUB_A);
    const rejected = await pending(HUB_A, { status: 'REJECTED', approvedBy: randomUUID() });

    expect(await codeOf(approver, decide(active.id, 'REJECTED', approver.principalId))).toBe(
      '23514',
    );
    expect(await codeOf(approver, decide(rejected.id, 'ACTIVE', approver.principalId))).toBe(
      '23514',
    );
    expect(await codeOf(approver, decide(active.id, 'ACTIVE', approver.principalId))).toBe('23514');
  });

  // Break caught: the policy's own list of statuses (the machine lets an active identity be suspended, which is the offboarding slice's act
  // and not an approver's), and the machine's own refusal of the other changes of an active identity with the checker left as it is.
  // Break caught (the adversarial review of 23 October 2026): the approval key writing the credential or the lockout of an identity it
  // approved (the API login holds UPDATE on those columns for the authentication capability, and the policy of the approval names only the
  // status and the checker): a password the approver knows, or a lock cleared. A STAFF context never writes these columns.
  it('cannot write a credential or a lockout column, of an identity it approved or while deciding one', async () => {
    const approver = acting(APPROVE);
    const approved = await onboarding(HUB_A, { approvedBy: approver.principalId });
    const waiting = await pending(HUB_A);
    const KNOWN = '$argon2id$v=19$m=19456,t=2,p=1$a25vd25zYWx0$a25vd25oYXNo';
    const write = (sets: string, id: string) => (tx: Tx) =>
      tx.execute(sql.raw(`update staff_identity set ${sets} where id = '${id}'`));

    const takeover = `credential_hash = '${KNOWN}', credential_established_at = now(), credential_generation = credential_generation + 1`;
    expect(await codeOf(approver, locked(approved.id, write(takeover, approved.id)))).toBe('42501');
    // A rewrite of the hash alone, on an identity that holds a credential: the table allows a rehash (the cost of the derivation raised,
    // the generation untouched), so nothing but the guard stops a staff member from setting a hash it knows the password of.
    const credentialed = await onboarding(HUB_A, {
      approvedBy: approver.principalId,
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
      credentialEstablishedAt: new Date(),
      credentialGeneration: 1,
    });
    expect(
      await codeOf(
        approver,
        locked(credentialed.id, write(`credential_hash = '${KNOWN}'`, credentialed.id)),
      ),
    ).toBe('42501');
    expect(
      (
        await admin.query('select credential_hash from staff_identity where id = $1', [
          credentialed.id,
        ])
      ).rows[0],
    ).toEqual({ credential_hash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA' });
    // Each column of the lockout alone (a change of either is a lock set or cleared by a staff member).
    for (const sets of ['failed_attempt_count = 3', "locked_until = now() + interval '1 hour'"]) {
      expect(await codeOf(approver, locked(approved.id, write(sets, approved.id))), sets).toBe(
        '42501',
      );
    }
    expect(
      await codeOf(
        approver,
        locked(
          waiting.id,
          write(
            `status = 'ACTIVE', approved_by = '${approver.principalId}', ${takeover}`,
            waiting.id,
          ),
        ),
      ),
    ).toBe('42501');

    const after = await admin.query<{
      credential_hash: string | null;
      credential_generation: string;
      failed_attempt_count: number;
      status: string;
    }>(
      'select credential_hash, credential_generation, failed_attempt_count, status from staff_identity where id = any($1::uuid[]) order by status',
      [[approved.id, waiting.id]],
    );
    expect(
      after.rows.map((row) => [row.status, row.credential_hash, Number(row.credential_generation)]),
    ).toEqual([
      ['ACTIVE', approved.credentialHash, approved.credentialGeneration],
      ['PENDING_APPROVAL', null, 0],
    ]);
  });

  // Break caught (the same review): the `authentication` label deciding a profile or naming its checker. Before S0.36 the API login had no
  // UPDATE on `status` or `approved_by`; the grant of 0029 gave it to every context of the login, and the policy of the capability has no
  // shape. Only the key of the approval may decide a pending profile.
  it('is not decided or re-attributed by the authentication capability, nor by any context but the approval’s', async () => {
    const authentication = {
      principalType: 'SYSTEM',
      principalId: randomUUID(),
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId: 'staff-maker-checker-test',
    } as SecurityContext;
    const waiting = await pending(HUB_A);
    const active = await onboarding(HUB_A);
    const decide = (tx: Tx) =>
      tx.execute(
        sql`update staff_identity set status = 'ACTIVE', approved_by = ${randomUUID()}::uuid where id = ${waiting.id}::uuid`,
      );
    const offboard = (tx: Tx) =>
      tx.execute(
        sql`update staff_identity set status = 'OFFBOARDED' where id = ${active.id}::uuid`,
      );
    const reattribute = (tx: Tx) =>
      tx.execute(
        sql`update staff_identity set approved_by = ${randomUUID()}::uuid where id = ${active.id}::uuid`,
      );

    // The label of the capability with the key of the approval presented beside it: a context that is not a staff member's is not the
    // approval, whatever key it carries.
    const forged = { ...authentication, authorizationKey: APPROVE } as SecurityContext;
    const decideAsItself = (tx: Tx) =>
      tx.execute(
        sql`update staff_identity set status = 'ACTIVE', approved_by = ${forged.principalId}::uuid where id = ${waiting.id}::uuid`,
      );
    expect(await codeOf(forged, decide)).toBeDefined();
    expect(await codeOf(forged, decideAsItself)).toBeDefined();
    expect((await storedStatus(waiting.id)).status).toBe('PENDING_APPROVAL');
    expect(await codeOf(authentication, decide)).toBeDefined();
    expect(await codeOf(authentication, offboard)).toBeDefined();
    expect(await codeOf(authentication, reattribute)).toBeDefined();
    expect((await storedStatus(waiting.id)).status).toBe('PENDING_APPROVAL');
    expect((await storedStatus(active.id)).status).toBe('ACTIVE');
  });

  // Break caught: the approver's arm, whose USING must admit an ACTIVE or SUSPENDED row (the identity lock needs it) and whose CHECK admits
  // `ACTIVE`, reactivating a suspended identity it once approved (the machine allows SUSPENDED to ACTIVE for the offboarding slice's own
  // writer, not for this key; the checker is unchanged, so the checker-once clause does not stop it).
  it('does not reactivate a suspended identity, not even one the approver once approved', async () => {
    const approver = acting(APPROVE);
    const suspended = await pending(HUB_A, {
      status: 'SUSPENDED',
      approvedBy: approver.principalId,
    });
    const reactivate = (tx: Tx) =>
      tx.execute(
        sql`update staff_identity set status = 'ACTIVE', approved_by = ${approver.principalId}::uuid where id = ${suspended.id}::uuid`,
      );

    expect(await codeOf(approver, reactivate)).toBeDefined();
    expect((await storedStatus(suspended.id)).status).toBe('SUSPENDED');
  });

  it('does not suspend, offboard or reject an active identity, whatever the machine allows or refuses', async () => {
    const approver = acting(APPROVE);
    // The approver is the recorded checker, so that the policy's clause on the checker is satisfied and only its list of statuses is asked.
    const active = await onboarding(HUB_A, { approvedBy: approver.principalId });
    const set = (status: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`update staff_identity set status = ${status} where id = ${active.id}::uuid`);

    expect(await codeOf(approver, set('SUSPENDED'))).toBe('42501');
    expect(await codeOf(approver, set('OFFBOARDED'))).toBe('42501');
    expect(await codeOf(approver, set('REJECTED'))).toBe('23514');
    expect((await storedStatus(active.id)).status).toBe('ACTIVE');
  });

  // Break caught: a checker rewritten together with a change the machine allows (a reactivation by someone else).
  it('does not rename the checker of a profile that has one, even with a change of status the machine allows', async () => {
    const approver = acting(APPROVE);
    const suspended = await onboarding(HUB_A);
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.id,
    ]);

    expect(
      await codeOf(approver, (tx) =>
        tx.execute(
          sql`update staff_identity set status = 'ACTIVE', approved_by = ${approver.principalId}::uuid where id = ${suspended.id}::uuid`,
        ),
      ),
    ).toBe('23514');
    expect((await storedStatus(suspended.id)).status).toBe('SUSPENDED');
  });

  // Break caught: the origin of a profile not read by the machine: a pending profile of origin BOOTSTRAP is a row the constraints do not
  // exclude, and no maker-checker path may decide it.
  it('does not decide a pending profile of origin BOOTSTRAP', async () => {
    const approver = acting(APPROVE, ALL);
    const odd = await pending(null, {
      origin: 'BOOTSTRAP',
      roleBundleId: BUNDLE_IDS.platformAdmin,
    });

    expect(await codeOf(approver, decide(odd.id, 'ACTIVE', approver.principalId))).toBe('23514');
  });

  // The database's own backstop of the maker-checker rule (migration 0032): a profile is decided by someone other than its maker, unless
  // the maker is a Platform Admin, that is, unless the bundle the maker holds grants `staff.identity.approve` at tier P. A rule
  // that the application states first and the table holds for every writer.
  describe('a checker who is also the maker', () => {
    const REFUSED = { code: '23514', constraint: 'staff_identity_checker_is_not_maker' };
    const maker = (bundle: string) =>
      insertStaff(admin, staffRow({ roleBundleId: bundle, primaryHubId: null }));

    // Break caught: the checker allowed to be the maker whatever the maker holds (the rule of 0016, kept for everyone but a Platform Admin).
    it.each([
      ['Senior Ops (the approval at tier S)', BUNDLE_IDS.seniorOps],
      ['Ops Staff (no approval at all)', BUNDLE_IDS.opsStaff],
      ['Finance (no approval of a profile)', BUNDLE_IDS.finance],
    ])('is refused when the maker is %s', async (_name, bundle) => {
      const who = await maker(bundle);
      const approver = acting(APPROVE, ALL, who.id);
      const own = await pending(HUB_A, { createdBy: who.id });

      for (const status of ['ACTIVE', 'REJECTED']) {
        expect(await refusal(approver, decide(own.id, status, who.id))).toEqual(REFUSED);
      }
      expect(await storedStatus(own.id)).toMatchObject({
        status: 'PENDING_APPROVAL',
        approved_by: null,
      });
    });

    // Break caught: a maker the table cannot find standing for a Platform Admin (an id that is no identity, so that the rule fails open).
    it('is refused when the maker is no identity the table holds', async () => {
      const approver = acting(APPROVE, ALL);
      const own = await pending(HUB_A, { createdBy: approver.principalId });

      expect(await refusal(approver, decide(own.id, 'ACTIVE', approver.principalId))).toEqual(
        REFUSED,
      );
    });

    // Break caught: the table keeping the rule for a Platform Admin too, so that the first administrator could not approve what they made.
    it.each([['ACTIVE'], ['REJECTED']])(
      'is allowed when the maker is a Platform Admin: %s, with the maker as the checker',
      async (status) => {
        const who = await maker(BUNDLE_IDS.platformAdmin);
        const approver = acting(APPROVE, ALL, who.id);
        for (const bundle of [BUNDLE_IDS.opsStaff, BUNDLE_IDS.platformAdmin]) {
          const own = await pending(HUB_A, { createdBy: who.id, roleBundleId: bundle });

          const result = await built.service.transactionWithContext(
            approver,
            decide(own.id, status, who.id),
          );

          expect(result.rows).toHaveLength(1);
          expect(await storedStatus(own.id)).toMatchObject({ status, approved_by: who.id });
        }
      },
    );

    // Break caught: the table reading a tier of some other grant of the maker's bundle (the create key is held at P too), or a role's name.
    it('reads the tier of the approval and no other grant of the maker’s bundle', async () => {
      const who = await maker(BUNDLE_IDS.platformAdmin);
      const approver = acting(APPROVE, ALL, who.id);
      const lowered = async (tier: string): Promise<void> => {
        await admin.query(
          `update role_bundle_grant set tier = $2 where bundle_id = $1 and permission_key = $3`,
          [BUNDLE_IDS.platformAdmin, tier, APPROVE],
        );
      };
      await lowered('S');
      try {
        const own = await pending(HUB_A, { createdBy: who.id });
        expect(await refusal(approver, decide(own.id, 'ACTIVE', who.id))).toEqual(REFUSED);
      } finally {
        await lowered('P');
      }
      const again = await pending(HUB_A, { createdBy: who.id });
      expect(
        (await built.service.transactionWithContext(approver, decide(again.id, 'ACTIVE', who.id)))
          .rows,
      ).toHaveLength(1);
    });

    // Break caught: the rule held for the API's own statement and not for a row written another way (the check of 0016 held for inserts too).
    it('holds for a row written directly as well: a decided profile made and checked by one Senior Ops member', async () => {
      const senior = await maker(BUNDLE_IDS.seniorOps);
      const admins = await maker(BUNDLE_IDS.platformAdmin);

      await expect(
        insertStaff(admin, staffRow({ createdBy: senior.id, approvedBy: senior.id })),
      ).rejects.toMatchObject({ code: '23514', constraint: 'staff_identity_checker_is_not_maker' });
      await expect(
        insertStaff(admin, staffRow({ createdBy: admins.id, approvedBy: admins.id })),
      ).resolves.toBeDefined();
    });
  });

  // Break caught: the UPDATE grant covering more than the two columns of a decision (the bundle swapped at approval, the hub moved).
  it.each([
    ['role_bundle_id', `'${BUNDLE_IDS.platformAdmin}'`],
    ['full_name', "'Someone Else'"],
    ['primary_hub_id', 'null'],
    ['work_email', "'other@example.test'"],
    ['origin', "'BOOTSTRAP'"],
    ['created_by', 'gen_random_uuid()'],
  ])('cannot update %s', async (column, value) => {
    const approver = acting(APPROVE);
    const target = await pending(HUB_A);
    expect(
      await codeOf(approver, (tx) =>
        tx.execute(
          sql.raw(`update staff_identity set ${column} = ${value} where id = '${target.id}'`),
        ),
      ),
    ).toBe('42501');
  });

  // Break caught: a seeded administrator (never pending) being moved by the maker-checker path.
  it('does not touch a seeded administrator', async () => {
    const approver = acting(APPROVE, ALL);
    const seeded = await pending(null, {
      status: 'ACTIVE',
      origin: 'BOOTSTRAP',
      approvedBy: randomUUID(),
      roleBundleId: BUNDLE_IDS.platformAdmin,
    });

    expect(await codeOf(approver, decide(seeded.id, 'REJECTED', approver.principalId))).toBe(
      '23514',
    );
  });
});

describe('the setup grant an approver issues', () => {
  const issue =
    (
      identityId: string,
      issuedBy: string,
      overrides: {
        purpose?: string;
        principalType?: string;
        episode?: string | null;
        continued?: string | null;
        supersedes?: string | null;
      } = {},
    ) =>
    (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`
        insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state, issued_by, episode_id,
                                 supersedes_grant_id, continued_from_grant_id)
        values (${randomUUID()}::uuid, ${overrides.principalType ?? 'STAFF'}, ${identityId}::uuid, ${overrides.purpose ?? 'STAFF_CREDENTIAL_SETUP'},
                ${hashOf(randomUUID())}, clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING', ${issuedBy}::uuid,
                ${overrides.episode ?? null}::uuid, ${overrides.supersedes ?? null}::uuid, ${overrides.continued ?? null}::uuid)`);

  // Break caught: no arm for the approver, so that approveStaffIdentity could not issue the grant its criterion says it issues.
  it('issues a STAFF_CREDENTIAL_SETUP grant to an approved identity of its scope that holds no credential', async () => {
    const approver = acting(APPROVE);
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });

    const result = await built.service.transactionWithContext(
      approver,
      locked(target.id, issue(target.id, approver.principalId)),
    );

    expect(result.rowCount).toBe(1);
  });

  // Break caught: an arm that binds nothing to the operation: a grant for an identity the transaction never locked, or for another than
  // the one it locked (the binding is what stands in for the scope, which the lock decided).
  it('refuses a grant for an identity the operation did not lock, or for another than the one it locked', async () => {
    const approver = acting(APPROVE);
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    const other = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });

    expect(await codeOf(approver, issue(target.id, approver.principalId))).toBe('42501');
    expect(await codeOf(approver, locked(other.id, issue(target.id, approver.principalId)))).toBe(
      '42501',
    );
    expect(
      await codeOf(
        approver,
        bound('not-an-identity-at-all', issue(target.id, approver.principalId)),
      ),
    ).toBeDefined();
  });

  // Break caught: the arm judging nothing about the target: a grant to an identity that is not approved, that has a credential, that is
  // a seeded administrator or that lies outside the approver's scope.
  it.each([
    ['one that is still pending', () => pending(HUB_A)],
    [
      'one that was rejected',
      () => pending(HUB_A, { status: 'REJECTED', approvedBy: randomUUID() }),
    ],
    [
      'one that already holds a credential',
      () =>
        onboarding(HUB_A, {
          credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA',
          credentialEstablishedAt: new Date(),
          credentialGeneration: 1,
        }),
    ],
    [
      'a seeded administrator',
      () => onboarding(null, { origin: 'BOOTSTRAP', roleBundleId: BUNDLE_IDS.platformAdmin }),
    ],
    ['one in another hub', () => onboarding(HUB_B)],
  ] as const)('refuses a grant to %s', async (_name, arrange) => {
    const approver = acting(APPROVE);
    const target = await arrange();
    expect(await codeOf(approver, locked(target.id, issue(target.id, approver.principalId)))).toBe(
      '42501',
    );
  });

  // Break caught: the arm admitting any purpose, any principal type or any lineage: the approver issuing a re-enrolment, a bootstrap
  // secret, a vendor's grant or a continuation of a grant it did not make.
  it.each([
    ['an MFA_REENROLMENT grant', { purpose: 'MFA_REENROLMENT' }],
    ['an MFA_ENROLMENT grant', { purpose: 'MFA_ENROLMENT' }],
    ['a BOOTSTRAP_SETUP grant', { purpose: 'BOOTSTRAP_SETUP' }],
    [
      'a grant for a vendor account',
      { principalType: 'VENDOR', purpose: 'VENDOR_CREDENTIAL_SETUP' },
    ],
    ['a grant that carries an episode', { episode: randomUUID() }],
  ] as const)('refuses %s', async (_name, overrides) => {
    const approver = acting(APPROVE);
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    expect(
      await codeOf(approver, locked(target.id, issue(target.id, approver.principalId, overrides))),
    ).toBeDefined();
  });

  // Break caught: a grant issued in another approver's name, or in nobody's.
  it('refuses a grant that names another issuer, or none', async () => {
    const approver = acting(APPROVE);
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    expect(await codeOf(approver, locked(target.id, issue(target.id, randomUUID())))).toBe('42501');
    expect(
      await codeOf(
        approver,
        locked(target.id, (tx) =>
          tx.execute(sql`
      insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
      values (${randomUUID()}::uuid, 'STAFF', ${target.id}::uuid, 'STAFF_CREDENTIAL_SETUP', ${hashOf(randomUUID())}, clock_timestamp(),
              clock_timestamp() + interval '30 minutes', 'PENDING')`),
        ),
      ),
    ).toBe('42501');
  });

  // Break caught: the arm not naming the key.
  it('is refused under any other key', async () => {
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    for (const key of [CREATE, 'staff.read', 'staff.session.revoke', null]) {
      const context = acting(key, ALL);
      expect(await codeOf(context, bound(target.id, issue(target.id, context.principalId)))).toBe(
        '42501',
      );
    }
  });

  // Break caught: the approver reading grants it did not issue, of another purpose, or of an identity outside its scope.
  it('reads the staff credential-setup grants of its scope and no other grant', async () => {
    const approver = acting(APPROVE);
    const mine = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    const there = await onboarding(HUB_B, { credentialHash: null, credentialEstablishedAt: null });
    const own = await insertGrant(admin, grantRow({ principalId: mine.id }));
    const foreign = await insertGrant(admin, grantRow({ principalId: there.id }));
    const mfa = await insertGrant(
      admin,
      grantRow({ principalId: mine.id, purpose: 'MFA_ENROLMENT' }),
    );

    const read = (tx: Parameters<Work>[0]) =>
      tx.execute(
        sql`select id from setup_grant where id in (${own.id}::uuid, ${foreign.id}::uuid, ${mfa.id}::uuid)`,
      );
    const visible = await built.service.transactionWithContext(approver, locked(mine.id, read));
    // An identity of another hub is not locked, so the grant of it is not bound; and with no identity locked nothing is.
    const elsewhere = await built.service.transactionWithContext(approver, locked(there.id, read));
    const unlocked = await built.service.transactionWithContext(approver, read);

    expect((visible.rows as { id: string }[]).map((row) => row.id)).toEqual([own.id]);
    expect(elsewhere.rows).toEqual([]);
    expect(unlocked.rows).toEqual([]);
  });

  // Break caught: the update arm letting an approver consume a grant, rewrite a terminal one, or end a grant of another purpose.
  it('ends a pending grant of its scope by superseding or expiring it, and by no other change', async () => {
    const approver = acting(APPROVE);
    const target = await onboarding(HUB_A, { credentialHash: null, credentialEstablishedAt: null });
    const lapsed = await insertGrant(
      admin,
      grantRow({
        principalId: target.id,
        issuedAt: new Date(Date.now() - 3_600_000),
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    const end = (id: string, state: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`update setup_grant set state = ${state} where id = ${id}::uuid returning id`);

    const ending = (id: string, state: string, of: string = target.id) =>
      built.service.transactionWithContext(approver, locked(of, end(id, state)));
    expect((await ending(lapsed.id, 'EXPIRED')).rows).toHaveLength(1);
    const live = await insertGrant(admin, grantRow({ principalId: target.id }));
    expect(await codeOf(approver, locked(target.id, end(live.id, 'CONSUMED')))).toBe('42501');
    // Not bound: with no identity locked, or another than the grant's, nothing is found to end.
    expect(
      (await built.service.transactionWithContext(approver, end(live.id, 'SUPERSEDED'))).rows,
    ).toHaveLength(0);
    const stranger = await onboarding(HUB_A, {
      credentialHash: null,
      credentialEstablishedAt: null,
    });
    expect((await ending(live.id, 'SUPERSEDED', stranger.id)).rows).toHaveLength(0);
    expect((await ending(live.id, 'SUPERSEDED')).rows).toHaveLength(1);

    const reenrolment = await insertGrant(
      admin,
      grantRow({ principalId: target.id, purpose: 'MFA_REENROLMENT' }),
    );
    expect((await ending(reenrolment.id, 'SUPERSEDED')).rows).toHaveLength(0);
    const other = await onboarding(HUB_B, { credentialHash: null, credentialEstablishedAt: null });
    const theirs = await insertGrant(admin, grantRow({ principalId: other.id }));
    expect((await ending(theirs.id, 'SUPERSEDED', other.id)).rows).toHaveLength(0);
    const again = await insertGrant(admin, grantRow({ principalId: target.id }));
    for (const column of ['token_hash', 'purpose', 'expires_at', 'principal_id', 'issued_by']) {
      expect(
        await codeOf(
          approver,
          locked(target.id, (tx) =>
            tx.execute(
              sql.raw(`update setup_grant set ${column} = ${column} where id = '${again.id}'`),
            ),
          ),
        ),
      ).toBe('42501');
    }
    // Ending a grant is not consuming it: the moment of consumption is the person's, and no ending carries it (the table ties the two).
    expect(
      await codeOf(
        approver,
        locked(target.id, (tx) =>
          tx.execute(
            sql`update setup_grant set state = 'SUPERSEDED', consumed_at = clock_timestamp() where id = ${again.id}::uuid`,
          ),
        ),
      ),
    ).toBeDefined();
    expect(
      (await admin.query('select state, consumed_at from setup_grant where id = $1', [again.id]))
        .rows[0],
    ).toEqual({ state: 'PENDING', consumed_at: null });
  });
});

describe('the message an approver queues', () => {
  async function grantOf(
    approver: SecurityContext,
    hub: string | null = HUB_A,
    overrides: Partial<StaffRow> = {},
  ) {
    const target = await onboarding(hub, {
      credentialHash: null,
      credentialEstablishedAt: null,
      ...overrides,
    });
    const grant = await insertGrant(
      admin,
      grantRow({ principalId: target.id, issuedBy: approver.principalId }),
    );
    return { target, grant };
  }

  const queue =
    (
      target: StaffRow,
      grantId: string,
      overrides: { kind?: string; recordType?: string; state?: string; attempts?: number } = {},
    ) =>
    (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`
        insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel,
                                             state, attempt_count, next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext,
                                             payload_nonce, payload_key_version, payload_envelope_version)
        values (${randomUUID()}::uuid, ${overrides.kind ?? 'SETUP_GRANT'}, ${overrides.recordType ?? 'SETUP_GRANT'}, ${grantId}::uuid, 'STAFF',
                ${target.id}::uuid, 'EMAIL', ${overrides.state ?? 'QUEUED'}, ${overrides.attempts ?? 0}, clock_timestamp(),
                clock_timestamp() + interval '30 minutes', ${randomUUID()}, ${Buffer.alloc(40, 7)}, ${Buffer.alloc(12, 3)}, 1, 1)`);

  // Break caught: no arm for the approver, so that the message of the grant could not be queued in the act's own transaction.
  it('queues a SETUP_GRANT message for a grant it issued to an identity of its scope', async () => {
    const approver = acting(APPROVE);
    const { target, grant } = await grantOf(approver);

    const result = await built.service.transactionWithContext(
      approver,
      locked(target.id, queue(target, grant.id)),
    );

    expect(result.rowCount).toBe(1);
  });

  // Break caught: an arm that binds nothing, so that a message could be queued for an identity the operation never locked, or for another
  // than the one it locked.
  it('refuses a message for an identity the operation did not lock, or for another than the one it locked', async () => {
    const approver = acting(APPROVE);
    const { target, grant } = await grantOf(approver);
    const other = await grantOf(approver);

    expect(await codeOf(approver, queue(target, grant.id))).toBe('42501');
    expect(await codeOf(approver, locked(other.target.id, queue(target, grant.id)))).toBe('42501');
  });

  // Break caught: the arm admitting a message for a grant the approver did not issue, one that is not pending, another kind, a job that
  // does not start untouched, or a grant of another purpose.
  it('refuses a message for a grant it did not issue, of another purpose, or that is no longer pending; another kind; a job already begun', async () => {
    const approver = acting(APPROVE);
    const { target, grant } = await grantOf(approver);
    const stranger = await onboarding(HUB_A, {
      credentialHash: null,
      credentialEstablishedAt: null,
    });
    const foreign = await insertGrant(
      admin,
      grantRow({ principalId: stranger.id, issuedBy: randomUUID() }),
    );
    const reenrolment = await insertGrant(
      admin,
      grantRow({
        principalId: target.id,
        purpose: 'MFA_REENROLMENT',
        issuedBy: approver.principalId,
      }),
    );

    const queueing = (
      who: StaffRow,
      grantId: string,
      overrides: Parameters<typeof queue>[2] = {},
    ) => codeOf(approver, locked(who.id, queue(who, grantId, overrides)));

    expect(await queueing(stranger, foreign.id)).toBe('42501');
    expect(await queueing(target, reenrolment.id)).toBe('42501');
    expect(await queueing(target, grant.id, { kind: 'MFA_REENROLMENT' })).toBe('42501');
    expect(await queueing(target, grant.id, { state: 'LEASED' })).toBeDefined();
    expect(await queueing(target, grant.id, { attempts: 1 })).toBeDefined();
    await setGrantState(admin, grant.id, 'SUPERSEDED');
    expect(await queueing(target, grant.id)).toBe('42501');
  });

  // Break caught: the arm applying to an identity outside the approver's scope, and to any other key.
  it('refuses a message for an identity outside its scope, and under any other key', async () => {
    const approver = acting(APPROVE);
    const { target, grant } = await grantOf(approver, HUB_B);
    expect(await codeOf(approver, locked(target.id, queue(target, grant.id)))).toBe('42501');
    const own = await grantOf(approver, HUB_A);
    for (const key of [CREATE, 'staff.read', null]) {
      expect(
        await codeOf(
          acting(key, ALL, approver.principalId),
          bound(own.target.id, queue(own.target, own.grant.id)),
        ),
      ).toBe('42501');
    }
  });

  // Break caught: the read arm of the job not bound to the locked identity: the approver reading the setup messages of identities the
  // operation never locked (and, with it, the cancel arm's view of them).
  it('reads the message of the locked identity and no other, and none with no identity locked', async () => {
    const approver = acting(APPROVE);
    const mine = await grantOf(approver);
    const other = await grantOf(approver);
    for (const each of [mine, other]) {
      await built.service.transactionWithContext(
        approver,
        locked(each.target.id, queue(each.target, each.grant.id)),
      );
    }
    const read = (tx: Tx) =>
      tx.execute(
        sql`select principal_id from credential_delivery_job where redemption_record_id in (${mine.grant.id}::uuid, ${other.grant.id}::uuid)`,
      );
    const principals = async (work: (tx: Tx) => Promise<{ rows: unknown[] }>) =>
      (
        (await built.service.transactionWithContext(approver, work)).rows as {
          principal_id: string;
        }[]
      ).map((row) => row.principal_id);

    expect(await principals(locked(mine.target.id, read))).toEqual([mine.target.id]);
    expect(await principals(locked(other.target.id, read))).toEqual([other.target.id]);
    expect(await principals(read)).toEqual([]);
  });

  // Break caught: the approver unable to end the message of a grant it supersedes, or able to end any queued job.
  it('cancels the live message of a staff credential-setup grant of its scope, and no other job', async () => {
    const approver = acting(APPROVE);
    const mine = await grantOf(approver);
    await built.service.transactionWithContext(
      approver,
      locked(mine.target.id, queue(mine.target, mine.grant.id)),
    );
    const other = await grantOf(approver, HUB_B);
    await admin.query(
      `insert into credential_delivery_job (id, kind, redemption_record_type, redemption_record_id, principal_type, principal_id, channel, state,
                                            next_attempt_at, expires_at, provider_dedupe_id, payload_ciphertext, payload_nonce, payload_key_version, payload_envelope_version)
       values (gen_random_uuid(), 'SETUP_GRANT', 'SETUP_GRANT', $1, 'STAFF', $2, 'EMAIL', 'QUEUED', clock_timestamp(), clock_timestamp() + interval '30 minutes',
               gen_random_uuid()::text, $3, $4, 1, 1)`,
      [other.grant.id, other.target.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
    );
    const cancel = (grantId: string) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
      tx.execute(sql`
        update credential_delivery_job
           set state = 'CANCELLED', outcome_class = 'CANCELLED', payload_ciphertext = null, payload_nonce = null, payload_key_version = null,
               payload_envelope_version = null, payload_erased_at = clock_timestamp()
         where redemption_record_type = 'SETUP_GRANT' and redemption_record_id = ${grantId}::uuid and state in ('QUEUED', 'LEASED', 'RETRYABLE')`);

    // Not bound: with no identity locked the live message is not the approver's to end (this runs first, so that the job is still live).
    const unlocked = await built.service.transactionWithContext(approver, cancel(mine.grant.id));
    const ended = await built.service.transactionWithContext(
      approver,
      locked(mine.target.id, cancel(mine.grant.id)),
    );
    const foreign = await built.service.transactionWithContext(
      approver,
      locked(other.target.id, cancel(other.grant.id)),
    );

    expect(unlocked.rowCount).toBe(0);
    expect(ended.rowCount).toBe(1);
    expect(foreign.rowCount).toBe(0);
  });
});

describe('melarc.staff_locked_facts (the facts a mutation reads under the identity’s lock)', () => {
  const FACTS = (id: string | null) => (tx: Parameters<Parameters<typeof refusal>[1]>[0]) =>
    tx.execute(sql`select * from melarc.staff_locked_facts(${id}::uuid)`);

  // Break caught: the function open to any staff context, to the wrong operations' keys, or to a caller that is not staff at all.
  it('answers to a staff context under staff.identity.approve (and, since migrations 0030 and 0033, staff.mfa.reset and staff.session.revoke) and to nothing else', async () => {
    const target = await onboarding(HUB_A);
    for (const context of [
      acting('staff.read', ALL),
      acting(CREATE, ALL),
      acting(null, ALL),
      {
        principalType: 'SYSTEM',
        principalId: randomUUID(),
        surface: 'SYSTEM',
        taskCapability: 'authentication',
        correlationId: 'x',
      } as SecurityContext,
      {
        principalType: 'VENDOR',
        principalId: randomUUID(),
        surface: 'VENDOR_PWA',
        vendorOrganizationId: randomUUID(),
        correlationId: 'x',
      } as SecurityContext,
      {
        principalType: 'RIDER',
        principalId: randomUUID(),
        surface: 'RIDER_ANDROID',
        riderId: randomUUID(),
        correlationId: 'x',
      } as SecurityContext,
    ]) {
      expect(await codeOf(context, FACTS(target.id))).toBe('42501');
    }
    expect(await codeOf(acting(APPROVE, ALL), FACTS(target.id))).toBeUndefined();
    expect(await codeOf(acting('staff.session.revoke', ALL), FACTS(target.id))).toBeUndefined();
  });

  // Break caught: a mutation reading its facts in one snapshot older than its locks (each statement of a mutation sees what is committed
  // when it begins), or the read path using a function made for the mutation.
  it('refuses any isolation but READ COMMITTED', async () => {
    const target = await onboarding(HUB_A);
    // The service opens a transaction at the database's default (read committed) or at repeatable read, and no other.
    expect(await codeOf(acting(APPROVE, ALL), FACTS(target.id), RR)).toBe('25000');
    expect(await codeOf(acting(APPROVE, ALL), FACTS(target.id))).toBeUndefined();
  });

  it('is asked for one identity', async () => {
    expect(await codeOf(acting(APPROVE, ALL), FACTS(null))).toBe('22023');
  });

  // Break caught: the function answering for an identity outside the caller's scope, or confirming one that does not exist.
  it('answers for an identity of the caller’s scope and says nothing of one outside it, or that does not exist', async () => {
    const here = await onboarding(HUB_A);
    const there = await onboarding(HUB_B);
    const scoped = acting(APPROVE, OWN_A);

    const own = await built.service.transactionWithContext(scoped, FACTS(here.id));
    const outside = await built.service.transactionWithContext(scoped, FACTS(there.id));
    const nothing = await built.service.transactionWithContext(scoped, FACTS(randomUUID()));

    expect((own.rows as { identity_id: string }[]).map((row) => row.identity_id)).toEqual([
      here.id,
    ]);
    expect(outside.rows).toEqual([]);
    expect(nothing.rows).toEqual([]);
  });

  // Break caught: the facts read without the identity's lock, so that a comparison of the ETag made after the call could be overtaken.
  it('takes the identity’s lock, and holds it until the transaction ends', async () => {
    const target = await onboarding(HUB_A);
    let competing: string | undefined;

    await built.service.transactionWithContext(acting(APPROVE, ALL), async (tx) => {
      await FACTS(target.id)(tx);
      try {
        await admin.query('begin');
        await admin.query(`set local lock_timeout = '300ms'`);
        await admin.query('select 1 from staff_identity where id = $1 for no key update', [
          target.id,
        ]);
      } catch (error) {
        competing = (error as { code?: string }).code;
      } finally {
        await admin.query('rollback');
      }
    });

    expect(competing).toBe('55P03');
  });

  // Break caught: the function leaving the caller in the system context, or the capability, once it has read.
  it('puts the caller’s context back: a factor, a grant and a job stay out of its reach afterwards', async () => {
    const target = await onboarding(HUB_A);
    const factor = await insertFactor(admin, factorRow(target.id));
    await activateFactor(admin, factor.id);
    await insertGrant(admin, grantRow({ principalId: target.id, purpose: 'MFA_ENROLMENT' }));

    const afterwards = await built.service.transactionWithContext(
      acting(APPROVE, ALL),
      async (tx) => {
        await FACTS(target.id)(tx);
        const factors = await tx.execute(sql`select id from mfa_factor`);
        const grants = await tx.execute(
          sql`select id from setup_grant where purpose = 'MFA_ENROLMENT'`,
        );
        const principal = await tx.execute(
          sql`select melarc.principal_type() as type, current_setting('melarc.task_capability', true) as capability`,
        );
        return {
          factors: factors.rows.length,
          grants: grants.rows.length,
          principal: principal.rows[0],
        };
      },
    );

    expect(afterwards.factors).toBe(0);
    expect(afterwards.grants).toBe(0);
    expect(afterwards.principal).toMatchObject({ type: 'STAFF' });
  });

  // Break caught: the binding of the grant and job arms not recorded (every grant write refused), recorded for an identity the scope does
  // not show (a grant of another hub bound), left over from an earlier call of the transaction, or kept past the transaction.
  it('records the identity it locked for the transaction, none for one the scope does not show, and clears it first', async () => {
    const here = await onboarding(HUB_A);
    const there = await onboarding(HUB_B);
    const binding = (tx: Parameters<Work>[0]) =>
      tx.execute(
        sql`select coalesce(current_setting('melarc.locked_identity', true), '') as bound`,
      );
    const bounds = await built.service.transactionWithContext(acting(APPROVE), async (tx) => {
      const before = ((await binding(tx)).rows[0] as { bound: string }).bound;
      await FACTS(here.id)(tx);
      const first = ((await binding(tx)).rows[0] as { bound: string }).bound;
      await FACTS(there.id)(tx);
      const second = ((await binding(tx)).rows[0] as { bound: string }).bound;
      return { before, first, second };
    });
    const after = await built.service.transactionWithContext(
      acting(APPROVE),
      async (tx) => ((await binding(tx)).rows[0] as { bound: string }).bound,
    );

    expect(bounds).toEqual({ before: '', first: here.id, second: '' });
    expect(after).toBe('');
  });

  // Break caught: the facts of the mutation differing from the facts the read shows for the same history (the ETag of a read would then
  // never match the one recomputed under the lock).
  it('answers the facts the read function answers for the same history', async () => {
    const proven = await onboarding(HUB_A, { roleBundleId: BUNDLE_IDS.seniorOps });
    const factor = await insertFactor(admin, factorRow(proven.id));
    await activateFactor(admin, factor.id);
    const stranded = await onboarding(HUB_A, { roleBundleId: BUNDLE_IDS.seniorOps });
    await insertFactor(admin, factorRow(stranded.id));
    await insertGrant(admin, grantRow({ principalId: stranded.id, purpose: 'MFA_ENROLMENT' }));
    const fresh = await pending(HUB_A, { roleBundleId: BUNDLE_IDS.platformAdmin });

    for (const target of [proven, stranded, fresh]) {
      const locked = await built.service.transactionWithContext(
        acting(APPROVE, ALL),
        FACTS(target.id),
      );
      const read = await built.service.transactionWithContext(
        acting('staff.read', ALL),
        (tx) =>
          tx.execute(sql`select * from melarc.staff_reset_facts(${`{${target.id}}`}::uuid[])`),
        RR,
      );
      expect(locked.rows).toEqual(read.rows);
      expect(locked.rows).toHaveLength(1);
    }
    expect(COMMITTED).toBe('read committed');
  });
});

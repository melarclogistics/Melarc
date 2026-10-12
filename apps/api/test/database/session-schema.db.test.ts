import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  CHECKER_ID,
  MAKER_ID,
  hashOf,
  insertSessionRow,
  insertStaff,
  sessionRow,
  staffRow,
  type SessionRow,
  type StaffRow,
} from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { withHandle } from './support/handle.js';
import {
  createTestDatabase,
  clientFor,
  sqlState,
  type TestDatabase,
} from './support/test-database.js';
import { HUB_A } from './support/rls-fixture.js';

/**
 * S0.24, the two tables (migration 0016): `staff_identity` and `session`, against a real PostgreSQL. What the schema itself refuses
 * (the constraints and the guard triggers, tried as the administrator so that nothing but the schema is in the way), and what the
 * API's login reaches under each context (row-level security, the column grants, the lock the issue protocol takes). The behaviour
 * built on them (the store, the issue protocol, the authenticator) has its own files.
 */
let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const context = (
  principalType: 'STAFF' | 'VENDOR' | 'RIDER' | 'SYSTEM',
  principalId: string,
  capability?: 'authentication' | 'rate_limit',
): SecurityContext => {
  const base = { principalId, correlationId: 'session-schema-test' } as const;
  switch (principalType) {
    case 'STAFF':
      return { ...base, principalType, surface: 'OPS_PORTAL' };
    case 'VENDOR':
      return { ...base, principalType, surface: 'VENDOR_PWA', vendorOrganizationId: randomUUID() };
    case 'RIDER':
      return { ...base, principalType, surface: 'RIDER_ANDROID', riderId: principalId };
    case 'SYSTEM':
      return {
        ...base,
        principalType,
        surface: 'SYSTEM',
        taskCapability: capability ?? 'authentication',
      };
  }
};

async function refusal(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  }
}

const staff = async (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const session = async (overrides: Partial<SessionRow> = {}): Promise<SessionRow> =>
  insertSessionRow(admin, sessionRow(overrides));

const refusedWhen = (statement: string, values: unknown[] = []): Promise<string | undefined> =>
  sqlState(admin, statement, values);

describe('a staff identity is held to the rules of the domain model', () => {
  // Break caught: a profile in a status the machine does not have.
  it('has one of the five statuses, and one of the two origins', async () => {
    expect(await refusal(() => staff({ status: 'RETIRED' }))).toBe('23514');
    expect(await refusal(() => staff({ origin: 'IMPORTED' }))).toBe('23514');
  });

  // Break caught (domain-model.md §6.8): an approved profile with no checker, or a pending one with one.
  it('has a checker exactly when it has left PENDING_APPROVAL', async () => {
    expect(await refusal(() => staff({ status: 'ACTIVE', approvedBy: null }))).toBe('23514');
    expect(await refusal(() => staff({ status: 'PENDING_APPROVAL', approvedBy: CHECKER_ID }))).toBe(
      '23514',
    );
    await staff({
      status: 'PENDING_APPROVAL',
      approvedBy: null,
      credentialHash: null,
      credentialEstablishedAt: null,
    });
    for (const status of ['ACTIVE', 'REJECTED', 'SUSPENDED', 'OFFBOARDED']) {
      await staff({ status });
    }
  });

  // Break caught (§30.8): the creator approving their own profile, which an approval that bypassed the call would leave.
  it('refuses a checker who is the maker, but for the two seeded bootstrap identities', async () => {
    expect(await refusal(() => staff({ createdBy: MAKER_ID, approvedBy: MAKER_ID }))).toBe('23514');
    await staff({ origin: 'BOOTSTRAP', createdBy: MAKER_ID, approvedBy: MAKER_ID });
  });

  // Break caught: a hash with no moment it was established, or a moment with no hash, or a generation that disagrees with both, so
  // "established" would mean two things.
  it('has a credential hash, the moment it was established and its generation together, or none of them', async () => {
    expect(await refusal(() => staff({ credentialHash: null }))).toBe('23514');
    expect(await refusal(() => staff({ credentialEstablishedAt: null }))).toBe('23514');
    expect(await refusal(() => staff({ credentialGeneration: 0 }))).toBe('23514');
    expect(
      await refusal(() =>
        staff({ credentialHash: null, credentialEstablishedAt: null, credentialGeneration: 1 }),
      ),
    ).toBe('23514');
    expect(await refusal(() => staff({ credentialGeneration: -1 }))).toBe('23514');
    await staff({ credentialHash: null, credentialEstablishedAt: null });
  });

  // Break caught: two identities sharing a work email, which would make a sign-in ambiguous, or a rejected profile keeping its
  // address for ever (§6.8: a REJECTED profile releases its work email).
  it('has a canonical work email that is unique among identities that are not REJECTED', async () => {
    const taken = `unique-${randomUUID().slice(0, 8)}@example.test`;
    await staff({ workEmail: taken, workEmailCanonical: taken });

    expect(await refusal(() => staff({ workEmail: taken, workEmailCanonical: taken }))).toBe(
      '23505',
    );
    await admin.query(
      `update staff_identity set status = 'REJECTED' where work_email_canonical = $1`,
      [taken],
    );
    await staff({ workEmail: taken, workEmailCanonical: taken });
  });

  it('refuses an address that is not trimmed or that is too short or too long', async () => {
    const address = (text: string): Promise<StaffRow> =>
      staff({ workEmail: text, workEmailCanonical: text });
    expect(await refusal(() => address(' padded@example.test'))).toBe('23514');
    expect(await refusal(() => address('a@'))).toBe('23514');
    expect(await refusal(() => address(`${'a'.repeat(320)}@example.test`))).toBe('23514');
  });

  // Break caught: a bundle or a hub removed from under an identity that refers to it.
  it('refers to a bundle and a hub that exist, and a bundle cannot be removed under it', async () => {
    expect(await refusal(() => staff({ roleBundleId: randomUUID() }))).toBe('23503');
    expect(await refusal(() => staff({ primaryHubId: randomUUID() }))).toBe('23503');
    const row = await staff();
    // RESTRICT is reported as restrict_violation (23001), not as the foreign key violation of an insert.
    expect(await refusedWhen(`delete from role_bundle where id = $1`, [row.roleBundleId])).toBe(
      '23001',
    );
  });

  it('has a name', async () => {
    expect(await refusal(() => staff({ fullName: '   ' }))).toBe('23514');
  });
});

describe('a staff identity keeps what was set at its creation, whoever updates it', () => {
  // Break caught (domain-model.md §6.8): the origin changed, so that a rule that reads it treats a maker-checker identity as a
  // bootstrap one. The guard holds the administrator too, which is what "a constraint refuses any change" means.
  it.each([
    ['origin', `origin = 'BOOTSTRAP'`],
    ['id', `id = gen_random_uuid()`],
    ['created_by', `created_by = gen_random_uuid()`],
    ['created_at', `created_at = created_at - interval '1 day'`],
  ])('refuses a change of %s', async (_column, assignment) => {
    const row = await staff();

    expect(
      await refusedWhen(`update staff_identity set ${assignment} where id = $1`, [row.id]),
    ).toBe('23514');
  });

  it('lets the credential, the status and the bundle change', async () => {
    const row = await staff();

    expect(
      await refusedWhen(
        `update staff_identity set credential_hash = 'x', status = 'SUSPENDED', role_bundle_id = $2 where id = $1`,
        [row.id, BUNDLE_IDS.finance],
      ),
    ).toBeUndefined();
  });
});

describe('the generation of a credential moves only with a replacement, whoever updates it', () => {
  const replace = (id: string, assignment: string) =>
    refusedWhen(`update staff_identity set ${assignment} where id = $1`, [id]);

  // Break caught (the audit of 11 October 2026): a replacement that does not raise the generation, so that a sign-in that verified
  // the old credential is taken to have verified the new one, or a generation raised with no replacement behind it.
  it('raises the generation by one when a credential is replaced, with the moment it was replaced at', async () => {
    const row = await staff();

    expect(
      await replace(
        row.id,
        `credential_hash = 'replaced', credential_established_at = now(), credential_generation = 2`,
      ),
    ).toBeUndefined();
    expect(
      await replace(
        row.id,
        `credential_hash = 'replaced again', credential_established_at = now() + interval '1 second', credential_generation = 3`,
      ),
    ).toBeUndefined();
  });

  // Break caught (the review of the corrections): a replacement refused because it happened at the very instant of the credential it
  // replaced. The generation is what tells credentials apart, so a new one may carry any moment, the same one included; making the
  // moment differ would be a uniqueness workaround that records a time that is not true.
  it('lets a replacement carry the very instant of the credential it replaced', async () => {
    const row = await staff();

    expect(
      await replace(row.id, `credential_hash = 'replaced', credential_generation = 2`),
    ).toBeUndefined();
    expect(
      await replace(
        row.id,
        `credential_hash = 'again', credential_established_at = credential_established_at, credential_generation = 3`,
      ),
    ).toBeUndefined();
  });

  it('establishes a first credential at generation one, with its moment', async () => {
    const row = await staff({ credentialHash: null, credentialEstablishedAt: null });

    expect(
      await replace(
        row.id,
        `credential_hash = 'first', credential_established_at = now(), credential_generation = 1`,
      ),
    ).toBeUndefined();
  });

  // Break caught: a rehash taken for a replacement, which would end the sessions of a person who merely signed in.
  it('lets the hash be rewritten at a new cost with neither the moment nor the generation changed', async () => {
    const row = await staff();

    expect(await replace(row.id, `credential_hash = 'rehashed'`)).toBeUndefined();
  });

  it.each([
    [
      'a replacement that leaves the generation',
      `credential_hash = 'replaced', credential_established_at = now()`,
    ],
    ['a moment changed with no new generation', `credential_established_at = now()`],
    [
      'a moment moved back with no new generation',
      `credential_established_at = credential_established_at - interval '1 day'`,
    ],
    [
      'a generation raised by two',
      `credential_hash = 'replaced', credential_established_at = now(), credential_generation = 3`,
    ],
    [
      'a generation that moves back',
      `credential_hash = 'replaced', credential_established_at = now(), credential_generation = 0`,
    ],
    [
      'a credential cleared',
      `credential_hash = null, credential_established_at = null, credential_generation = 0`,
    ],
  ])('refuses %s', async (_label, assignment) => {
    const row = await staff();

    expect(await replace(row.id, assignment)).toBe('23514');
  });
});

describe('a session is held to the rules of the domain model', () => {
  const principal = randomUUID();

  // Break caught: a token stored in some other form than its SHA-256 (the displayed text, a longer value).
  it('stores a token hash of 32 bytes, and no two sessions share one', async () => {
    expect(await refusal(() => session({ tokenHash: Buffer.alloc(31, 1) }))).toBe('23514');
    expect(await refusal(() => session({ tokenHash: Buffer.alloc(33, 1) }))).toBe('23514');
    const shared = hashOf('shared');
    await session({ tokenHash: shared });

    expect(await refusal(() => session({ tokenHash: shared }))).toBe('23505');
  });

  // Break caught (§6.8): a staff session carrying a fixed-policy revision, or a vendor or rider session without one.
  it('records a policy revision for a vendor and a rider only', async () => {
    expect(await refusal(() => session({ policyRevision: 1 }))).toBe('23514');
    const device = randomUUID();
    expect(
      await refusal(() =>
        session({ principalType: 'VENDOR', registeredDeviceId: device, policyRevision: null }),
      ),
    ).toBe('23514');
    expect(
      await refusal(() =>
        session({ principalType: 'RIDER', registeredDeviceId: device, policyRevision: 0 }),
      ),
    ).toBe('23514');
    await session({ principalType: 'VENDOR', registeredDeviceId: device, policyRevision: 1 });
    await session({ principalType: 'RIDER', registeredDeviceId: device, policyRevision: 1 });
  });

  // Break caught: a registered device on a staff session, or a vendor or rider session with none.
  it('has a registered device for a vendor and a rider and for no staff session', async () => {
    expect(await refusal(() => session({ registeredDeviceId: randomUUID() }))).toBe('23514');
    expect(
      await refusal(() =>
        session({ principalType: 'VENDOR', registeredDeviceId: null, policyRevision: 1 }),
      ),
    ).toBe('23514');
  });

  // Break caught: the root signal on a session that is not a rider's (a risk signal about a handset), or a value outside the three.
  it('records the client root signal for a rider only, from the three values', async () => {
    const device = randomUUID();
    expect(await refusal(() => session({ clientRootSignal: 'DETECTED' }))).toBe('23514');
    expect(
      await refusal(() =>
        session({
          principalType: 'RIDER',
          registeredDeviceId: device,
          policyRevision: 1,
          clientRootSignal: 'ROOTED',
        }),
      ),
    ).toBe('23514');
    await session({
      principalType: 'RIDER',
      registeredDeviceId: device,
      policyRevision: 1,
      clientRootSignal: 'UNKNOWN',
    });
  });

  // Break caught: a synchronizer token on a bearer session, which has nothing to ride on and so no use for one; and a browser
  // session without one, which the CSRF check of S0.25 could not compare the echoed token with.
  it('holds the hash of a synchronizer token (32 bytes) for a browser session, and none for a rider', async () => {
    const device = randomUUID();
    expect(await refusal(() => session({ csrfTokenHash: Buffer.alloc(8, 1) }))).toBe('23514');
    expect(await refusal(() => session({ csrfTokenHash: null }))).toBe('23514');
    expect(
      await refusal(() =>
        session({
          principalType: 'VENDOR',
          registeredDeviceId: device,
          policyRevision: 1,
          csrfTokenHash: null,
        }),
      ),
    ).toBe('23514');
    expect(
      await refusal(() =>
        session({
          principalType: 'RIDER',
          registeredDeviceId: device,
          policyRevision: 1,
          csrfTokenHash: hashOf('csrf'),
        }),
      ),
    ).toBe('23514');
    await session({ csrfTokenHash: hashOf('csrf') });
    await session({
      principalType: 'RIDER',
      registeredDeviceId: device,
      policyRevision: 1,
      csrfTokenHash: null,
    });
  });

  it('refers to a bundle that exists, and records a positive revision of it', async () => {
    expect(await refusal(() => session({ bundleId: randomUUID() }))).toBe('23503');
    expect(await refusal(() => session({ bundleRevision: 0 }))).toBe('23514');
  });

  // Break caught: a session that ends before it began, or whose activity precedes its issue.
  it('ends after it was issued, and its activity does not precede its issue', async () => {
    const issuedAt = new Date(Date.now() - 60_000);
    expect(await refusal(() => session({ issuedAt, expiresAt: issuedAt }))).toBe('23514');
    expect(
      await refusal(() => session({ issuedAt, lastActivityAt: new Date(issuedAt.getTime() - 1) })),
    ).toBe('23514');
  });

  // Break caught: a session said to be ended with no reason, or a reason without the time, or a reason the contract does not have.
  it('is ended with a time and one of the thirteen reasons together, or not at all', async () => {
    const at = new Date();
    expect(await refusal(() => session({ terminatedAt: at, terminationReason: null }))).toBe(
      '23514',
    );
    expect(await refusal(() => session({ terminatedAt: null, terminationReason: 'EXPIRED' }))).toBe(
      '23514',
    );
    expect(
      await refusal(() => session({ terminatedAt: at, terminationReason: 'LOGGED_OUT' })),
    ).toBe('23514');
    await session({ terminatedAt: at, terminationReason: 'ADMIN_REVOKED' });
  });

  it('holds a list of hubs with no null in it, and a snapshot that is an object', async () => {
    expect(
      await refusedWhen(
        `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                              token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
         values (gen_random_uuid(), 'STAFF', $1, '{}'::jsonb, $2, 1, array[null]::uuid[], $3, $4, now(), now() + interval '1 hour', now())`,
        [principal, BUNDLE_IDS.opsStaff, hashOf(randomUUID()), hashOf(randomUUID())],
      ),
    ).toBe('23514');
    expect(
      await refusedWhen(
        `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                              token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
         values (gen_random_uuid(), 'STAFF', $1, '[]'::jsonb, $2, 1, '{}', $3, $4, now(), now() + interval '1 hour', now())`,
        [principal, BUNDLE_IDS.opsStaff, hashOf(randomUUID()), hashOf(randomUUID())],
      ),
    ).toBe('23514');
  });

  // Break caught (§6.8): a vendor account with two live sessions, or a rider with two. The earlier is ended before the new is
  // inserted, and the database refuses the second whatever the application does. A staff member may hold several.
  it('allows one live session to a vendor account and to a rider, and several to a staff member', async () => {
    const device = randomUUID();
    const vendor = randomUUID();
    const rider = randomUUID();
    const as = (principalType: 'VENDOR' | 'RIDER', principalId: string): Partial<SessionRow> => ({
      principalType,
      principalId,
      registeredDeviceId: device,
      policyRevision: 1,
    });

    await session(as('VENDOR', vendor));
    expect(await refusal(() => session(as('VENDOR', vendor)))).toBe('23505');
    await session(as('RIDER', rider));
    expect(await refusal(() => session(as('RIDER', rider)))).toBe('23505');
    await admin.query(
      `update session set terminated_at = now(), termination_reason = 'SUPERSEDED_BY_NEW_LOGIN' where principal_id = $1`,
      [vendor],
    );
    await session(as('VENDOR', vendor));
    await session({ principalId: principal });
    await session({ principalId: principal });
  });
});

describe('a session keeps its identity, its token, its authority and its expiry, whoever updates it', () => {
  // Break caught: a column that makes a session what it is rewritten, so that a token, an authority or an expiry is changed after
  // the fact. The guard holds the administrator too.
  it.each([
    ['id', `id = gen_random_uuid()`],
    ['principal_type', `principal_type = 'VENDOR'`],
    ['principal_id', `principal_id = gen_random_uuid()`],
    ['bundle_snapshot', `bundle_snapshot = '{"format":1}'::jsonb`],
    ['bundle_id', `bundle_id = '${BUNDLE_IDS.finance}'`],
    ['bundle_revision', `bundle_revision = bundle_revision + 1`],
    ['authorized_hub_ids', `authorized_hub_ids = array['${HUB_A}']::uuid[]`],
    ['token_hash', `token_hash = decode(repeat('ab', 32), 'hex')`],
    ['csrf_token_hash', `csrf_token_hash = decode(repeat('cd', 32), 'hex')`],
    ['issued_at', `issued_at = issued_at - interval '1 minute'`],
    ['expires_at', `expires_at = expires_at + interval '1 day'`],
  ])('refuses a change of %s', async (_column, assignment) => {
    const row = await session();

    expect(await refusedWhen(`update session set ${assignment} where id = $1`, [row.id])).toBe(
      '23514',
    );
  });

  // Break caught: activity recorded as earlier than what was recorded, which would let an idle session look fresher or staler.
  it('never moves its activity back, and moves it forward', async () => {
    const row = await session();

    expect(
      await refusedWhen(
        `update session set last_activity_at = last_activity_at - interval '1 second' where id = $1`,
        [row.id],
      ),
    ).toBe('23514');
    expect(
      await refusedWhen(
        `update session set last_activity_at = last_activity_at + interval '1 second' where id = $1`,
        [row.id],
      ),
    ).toBeUndefined();
  });

  // Break caught: activity recorded far in the future, which the idle rule reads as "not idle" for as long as the instant lasts, so one
  // bad write would switch idle expiry off for the session. A few minutes ahead of the database clock are tolerated (a clock that
  // stepped), hours are not. A change that leaves the activity alone (ending the session) is not judged by it.
  it('refuses activity more than five minutes ahead of the database clock, and not an end that leaves it alone', async () => {
    const row = await session();
    const ahead = (interval: string): Promise<string | undefined> =>
      refusedWhen(
        `update session set last_activity_at = clock_timestamp() + $2::interval where id = $1`,
        [row.id, interval],
      );

    expect(await ahead('6 minutes')).toBe('23514');
    expect(await ahead('1 hour')).toBe('23514');
    expect(await ahead('4 minutes')).toBeUndefined();
    expect(
      await refusedWhen(
        `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = $1`,
        [row.id],
      ),
    ).toBeUndefined();
  });

  // Break caught: an ended session brought back, or given another reason, so that the record of why a request was refused changes.
  it('stays as it ended: no new reason, no new time, no activity, and not live again', async () => {
    const row = await session();
    await admin.query(
      `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = $1`,
      [row.id],
    );

    for (const assignment of [
      `termination_reason = 'EXPIRED'`,
      `terminated_at = terminated_at + interval '1 second'`,
      `terminated_at = null, termination_reason = null`,
      `last_activity_at = last_activity_at + interval '1 second'`,
    ]) {
      expect(await refusedWhen(`update session set ${assignment} where id = $1`, [row.id])).toBe(
        '23514',
      );
    }
  });
});

describe('what the API login reaches, by context', () => {
  const owner = randomUUID();
  const other = randomUUID();
  let ownerStaff: StaffRow;
  let otherStaff: StaffRow;
  let ownerSession: SessionRow;
  let otherSession: SessionRow;
  let vendorSession: SessionRow;
  let riderSession: SessionRow;

  beforeAll(async () => {
    ownerStaff = await staff({ id: owner });
    otherStaff = await staff({ id: other });
    ownerSession = await session({ principalId: owner });
    otherSession = await session({ principalId: other });
    vendorSession = await session({
      principalType: 'VENDOR',
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
    });
    riderSession = await session({
      principalType: 'RIDER',
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
    });
  });

  const idsOf = async (
    ctx: SecurityContext,
    table: 'session' | 'staff_identity',
  ): Promise<string[]> =>
    withHandle(built.service, ctx, async (_handle, tx) => {
      const result = await tx.execute(
        sql.raw(
          `select id from ${table} where id in ('${ownerStaff.id}', '${otherStaff.id}', '${ownerSession.id}', '${otherSession.id}', '${vendorSession.id}', '${riderSession.id}') order by id`,
        ),
      );
      return (result.rows as { id: string }[]).map((row) => row.id);
    });

  // Break caught: the pre-authentication path unable to find a session or an identity, or another capability finding them.
  it('lets the authentication capability, and no other, read both tables', async () => {
    const sessions = await idsOf(context('SYSTEM', randomUUID()), 'session');
    const identities = await idsOf(context('SYSTEM', randomUUID()), 'staff_identity');

    expect(sessions).toEqual(
      [ownerSession.id, otherSession.id, vendorSession.id, riderSession.id].toSorted(),
    );
    expect(identities).toEqual([ownerStaff.id, otherStaff.id].toSorted());
    expect(await idsOf(context('SYSTEM', randomUUID(), 'rate_limit'), 'session')).toEqual([]);
    expect(await idsOf(context('SYSTEM', randomUUID(), 'rate_limit'), 'staff_identity')).toEqual(
      [],
    );
  });

  // Break caught: a staff member reading another's identity or session, or a vendor or rider reading a staff row.
  it('lets a principal read its own sessions, and a staff member its own identity, and nothing else', async () => {
    expect(await idsOf(context('STAFF', owner), 'session')).toEqual([ownerSession.id]);
    expect(await idsOf(context('STAFF', owner), 'staff_identity')).toEqual([ownerStaff.id]);
    expect(await idsOf(context('VENDOR', vendorSession.principalId), 'session')).toEqual([
      vendorSession.id,
    ]);
    expect(await idsOf(context('RIDER', riderSession.principalId), 'session')).toEqual([
      riderSession.id,
    ]);
    expect(await idsOf(context('VENDOR', vendorSession.principalId), 'staff_identity')).toEqual([]);
    expect(await idsOf(context('RIDER', riderSession.principalId), 'staff_identity')).toEqual([]);
  });

  // Break caught: a vendor whose id equals a staff session's principal id reading it: the type is part of the identity.
  it('keys a principal’s sessions on its type as well as its id', async () => {
    const same = randomUUID();
    const sameStaff = await session({ principalId: same });

    expect(await idsOf(context('VENDOR', same), 'session')).not.toContain(sameStaff.id);
    expect(await idsOf(context('STAFF', same), 'session')).toEqual([]);
  });

  // Break caught: a human principal inserting or ending a session, which only the authentication capability may do.
  it('refuses a session to a human principal, whether it inserts one or ends one', async () => {
    const insert = (ctx: SecurityContext): Promise<string | undefined> =>
      refusal(() =>
        withHandle(built.service, ctx, async (_handle, tx) => {
          await tx.execute(sql`
            insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                                 token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
            values (gen_random_uuid(), 'STAFF', ${owner}, '{"format":1}'::jsonb, ${BUNDLE_IDS.opsStaff}, 1, '{}',
                    ${hashOf(randomUUID())}, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`);
        }),
      );
    const end = (ctx: SecurityContext): Promise<number> =>
      withHandle(built.service, ctx, async (_handle, tx) => {
        const result = await tx.execute(sql`
          update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = ${ownerSession.id}`);
        return result.rowCount ?? 0;
      });

    expect(await insert(context('STAFF', owner))).toBe('42501');
    expect(await end(context('STAFF', owner))).toBe(0);
    expect(await end(context('VENDOR', randomUUID()))).toBe(0);
    expect(await end(context('SYSTEM', randomUUID(), 'rate_limit'))).toBe(0);
  });

  // Break caught: the authentication capability unable to issue, or to end, a session.
  it('lets the authentication capability insert a session and end it', async () => {
    const id = randomUUID();
    await withHandle(built.service, context('SYSTEM', randomUUID()), async (_handle, tx) => {
      await tx.execute(sql`
        insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                             token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
        values (${id}, 'STAFF', ${owner}, '{"format":1}'::jsonb, ${BUNDLE_IDS.opsStaff}, 1, '{}',
                ${hashOf(randomUUID())}, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`);
      await tx.execute(
        sql`update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = ${id}`,
      );
    });

    const stored = await admin.query<{ termination_reason: string }>(
      `select termination_reason from session where id = $1`,
      [id],
    );
    expect(stored.rows[0]?.termination_reason).toBe('SIGNED_OUT');
  });

  // Break caught: the API's login able to rewrite what makes a session what it is, or to delete a session or an identity.
  it('holds an UPDATE of exactly the three columns of a session’s life, and of the three credential columns, and no DELETE', async () => {
    const columns = async (table: string): Promise<{ column: string; update: boolean }[]> => {
      const result = await admin.query<{ column: string; update: boolean }>(
        `select a.attname as column, has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'UPDATE') as update
           from pg_attribute a join pg_class c on c.oid = a.attrelid
          where c.relname = $1 and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
        [table],
      );
      return result.rows;
    };
    const updatable = (rows: { column: string; update: boolean }[]): string[] =>
      rows.filter((row) => row.update).map((row) => row.column);

    expect(updatable(await columns('session'))).toEqual([
      'last_activity_at',
      'terminated_at',
      'termination_reason',
    ]);
    expect(updatable(await columns('staff_identity'))).toEqual([
      'credential_hash',
      'credential_established_at',
      'credential_generation',
    ]);
    for (const table of ['session', 'staff_identity']) {
      const privileges = await admin.query<{
        delete: boolean;
        truncate: boolean;
        table_update: boolean;
      }>(
        `select has_table_privilege('melarc_api_runtime', $1, 'DELETE') as delete,
                has_table_privilege('melarc_api_runtime', $1, 'TRUNCATE') as truncate,
                has_table_privilege('melarc_api_runtime', $1, 'UPDATE') as table_update`,
        [table],
      );
      expect(privileges.rows[0]).toEqual({ delete: false, truncate: false, table_update: false });
    }
    const insertOnIdentity = await admin.query<{ insert: boolean }>(
      `select has_table_privilege('melarc_api_runtime', 'staff_identity', 'INSERT') as insert`,
    );
    expect(insertOnIdentity.rows[0]?.insert).toBe(false);
  });

  // Break caught: a request writing the token, the authority or the origin, past the guard, through a column grant it should not have.
  it('refuses the API login an update of any other column, with the privilege error and not the guard’s', async () => {
    const attempt = (statement: ReturnType<typeof sql>): Promise<string | undefined> =>
      refusal(() =>
        withHandle(built.service, context('SYSTEM', randomUUID()), async (_handle, tx) => {
          await tx.execute(statement);
        }),
      );

    expect(
      await attempt(
        sql`update session set expires_at = expires_at + interval '1 day' where id = ${ownerSession.id}`,
      ),
    ).toBe('42501');
    expect(
      await attempt(
        sql`update session set token_hash = ${hashOf('x')} where id = ${ownerSession.id}`,
      ),
    ).toBe('42501');
    expect(
      await attempt(sql`update staff_identity set status = 'SUSPENDED' where id = ${owner}`),
    ).toBe('42501');
    expect(
      await attempt(sql`update staff_identity set origin = 'BOOTSTRAP' where id = ${owner}`),
    ).toBe('42501');
    expect(await attempt(sql`delete from session where id = ${ownerSession.id}`)).toBe('42501');
  });

  // Break caught (SECURITY_DESIGN.md §13.10a): the identity lock unavailable to the issue protocol, which PostgreSQL gives only to a
  // role holding UPDATE on a column, and given to a context the policy should not admit.
  it('lets the authentication capability take the identity row lock, and no other context', async () => {
    const lock = (ctx: SecurityContext): Promise<number> =>
      withHandle(built.service, ctx, async (_handle, tx) => {
        const result = await tx.execute(
          sql`select id from staff_identity where id = ${owner} for no key update`,
        );
        return result.rows.length;
      });

    expect(await lock(context('SYSTEM', randomUUID()))).toBe(1);
    expect(await lock(context('SYSTEM', randomUUID(), 'rate_limit'))).toBe(0);
    expect(await lock(context('STAFF', owner))).toBe(0);
    expect(await lock(context('VENDOR', randomUUID()))).toBe(0);
  });

  // Break caught: an identity lock that is not exclusive, so that two issues for one identity could interleave.
  it('holds the identity lock of one transaction against the same lock in another until it ends', async () => {
    const order: string[] = [];
    const first = withHandle(
      built.service,
      context('SYSTEM', randomUUID()),
      async (_handle, tx) => {
        await tx.execute(sql`select id from staff_identity where id = ${owner} for no key update`);
        order.push('first holds');
        await new Promise((resolve) => setTimeout(resolve, 250));
        order.push('first ends');
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = withHandle(
      built.service,
      context('SYSTEM', randomUUID()),
      async (_handle, tx) => {
        await tx.execute(sql`select id from staff_identity where id = ${owner} for no key update`);
        order.push('second holds');
      },
    );

    await Promise.all([first, second]);

    expect(order).toEqual(['first holds', 'first ends', 'second holds']);
  });
});

describe('the credential hash is read through one function and one capability (the audit of 11 October 2026)', () => {
  let identity: StaffRow;
  const other = randomUUID();

  beforeAll(async () => {
    identity = await staff({
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$Zm9vYmFy',
    });
  });

  const asContext = <T>(
    ctx: SecurityContext,
    statement: ReturnType<typeof sql>,
    pick: (rows: Record<string, unknown>[]) => T,
  ): Promise<T> =>
    withHandle(built.service, ctx, async (_handle, tx) => {
      const result = await tx.execute(statement);
      return pick(result.rows);
    });

  // Break caught: the runtime login holding SELECT on the hash column, so that a staff member reading their own row (which the
  // policy admits), or any statement that says `*`, returns the credential. The grant is by column and the column is not on it.
  it('refuses a statement that names the hash, or says *, in every context', async () => {
    const select = (ctx: SecurityContext, columns: string): Promise<string | undefined> =>
      refusal(() =>
        withHandle(built.service, ctx, async (_handle, tx) => {
          await tx.execute(
            sql.raw(`select ${columns} from staff_identity where id = '${identity.id}'`),
          );
        }),
      );

    for (const ctx of [
      context('STAFF', identity.id),
      context('SYSTEM', randomUUID()),
      context('SYSTEM', randomUUID(), 'rate_limit'),
      context('VENDOR', randomUUID()),
    ]) {
      expect(await select(ctx, 'credential_hash')).toBe('42501');
      expect(await select(ctx, '*')).toBe('42501');
      expect(await select(ctx, 'id, credential_hash')).toBe('42501');
      expect(await select(ctx, `length(credential_hash)`)).toBe('42501');
    }
    // And the columns it may read are readable, the generation and the moment among them.
    expect(
      await asContext(
        context('STAFF', identity.id),
        sql`select id, status, credential_established_at, credential_generation from staff_identity where id = ${identity.id}`,
        (rows) => rows.length,
      ),
    ).toBe(1);
  });

  it('lists every column but the hash among those the runtime may select', async () => {
    const result = await admin.query<{ column: string }>(
      `select a.attname as column
         from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relname = 'staff_identity' and c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          and not has_column_privilege('melarc_api_runtime', c.oid, a.attnum, 'SELECT')`,
    );
    expect(result.rows.map((row) => row.column)).toEqual(['credential_hash']);
  });

  // Break caught: a function that returns the hash to the context that asks, whatever it is: the staff member whose credential it is
  // included. It answers the authentication capability alone, and says so to everything else with the privilege error.
  it('returns the hash to the authentication capability, and refuses every other context', async () => {
    const call = (ctx: SecurityContext, id: string): Promise<string | undefined> =>
      refusal(() =>
        withHandle(built.service, ctx, async (_handle, tx) => {
          await tx.execute(sql`select melarc.staff_credential_hash(${id}::uuid)`);
        }),
      );

    expect(
      await asContext(
        context('SYSTEM', randomUUID()),
        sql`select melarc.staff_credential_hash(${identity.id}::uuid) as hash`,
        (rows) => rows[0]?.hash,
      ),
    ).toBe(identity.credentialHash);
    expect(await call(context('STAFF', identity.id), identity.id)).toBe('42501');
    expect(await call(context('VENDOR', randomUUID()), identity.id)).toBe('42501');
    expect(await call(context('RIDER', randomUUID()), identity.id)).toBe('42501');
    expect(await call(context('SYSTEM', randomUUID(), 'rate_limit'), identity.id)).toBe('42501');
  });

  it('answers null for an identity that does not exist, and for one with no credential', async () => {
    const without = await staff({ credentialHash: null, credentialEstablishedAt: null });
    const hashOfId = (id: string) =>
      asContext(
        context('SYSTEM', randomUUID()),
        sql`select melarc.staff_credential_hash(${id}::uuid) as hash`,
        (rows) => rows[0]?.hash,
      );

    expect(await hashOfId(other)).toBeNull();
    expect(await hashOfId(without.id)).toBeNull();
  });

  // Break caught: the function open to a login that should not run it (EXECUTE left to PUBLIC), or owned by a role with more reach.
  it('is executable by the API runtime alone, owned by the owner role, with its search path fixed', async () => {
    const result = await admin.query<{
      owner: string;
      definer: boolean;
      search_path: string | null;
      public_execute: boolean;
      runtime_execute: boolean;
      worker_execute: boolean;
      provisioning_execute: boolean;
    }>(
      `select pg_get_userbyid(p.proowner) as owner, p.prosecdef as definer,
              (select option_value from pg_options_to_table(p.proconfig) where option_name = 'search_path') as search_path,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_execute,
              has_function_privilege('melarc_api_runtime', p.oid, 'EXECUTE') as runtime_execute,
              has_function_privilege('melarc_worker_runtime', p.oid, 'EXECUTE') as worker_execute,
              has_function_privilege('melarc_provisioning', p.oid, 'EXECUTE') as provisioning_execute
         from pg_proc p where p.oid = 'melarc.staff_credential_hash(uuid)'::regprocedure`,
    );
    expect(result.rows[0]).toEqual({
      owner: 'melarc_owner',
      definer: true,
      search_path: 'pg_catalog, pg_temp',
      public_execute: false,
      runtime_execute: true,
      worker_execute: false,
      provisioning_execute: false,
    });
  });
});

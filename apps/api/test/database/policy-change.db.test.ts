import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { endForAuthority } from '../../src/platform/auth/sessions/session-authority.js';
import { AUTHENTICATION_PRINCIPAL_ID } from '../../src/platform/auth/sessions/session-parameters.js';
import {
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  bundleLockKey,
  fixedLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import {
  changeFixedPolicy,
  changeRoleBundle,
  PolicyChangeError,
} from '../../src/platform/authorization/policy-change/policy-change.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertSessionRow, sessionRow, OPS_STAFF_SNAPSHOT } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { assemble, type Machinery } from './support/personas.js';
import {
  grant,
  newBundle as makeBundle,
  READ_DISPATCH,
  READ_STAFF,
  READ_VENDOR,
  type Grant,
} from './support/policy-fixtures.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import {
  clientFor,
  createTestDatabase,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.27, the bundle-change primitive of SECURITY_DESIGN.md section 13.10a on a real PostgreSQL (migration 0017): who may execute it,
 * what it decides is a reduction and what is not, what a reduction ends and records, and that it is one transaction. Called as the
 * migration login, the one identity that may; arranged and observed as the administrator, who bypasses row-level security.
 *
 * The races (a reduction against a sign-in and against a state-changing request, both orders, a lock timeout) are
 * `policy-change-races.db.test.ts`. The tests here use bundles they create, so the seeded bundles are never changed.
 */
let database: TestDatabase;
let admin: pg.Client;
let migration: pg.Client;
let observer: Observer;
let built: BuiltService;
let machinery: Machinery;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  machinery = assemble(built);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  migration = clientFor(database.urlFor(MIGRATION_ROLE));
  await migration.connect();
  observer = await observe(database);
});

afterAll(async () => {
  await built.close();
  await migration.end();
  await admin.end();
  await observer.close();
  await database.drop();
});

/** A bundle of its own with the grants given, at revision 1 and floor 1, as the seed would have made it. */
const newBundle = (grants: readonly Grant[] = [], audience = 'STAFF'): Promise<string> =>
  makeBundle(admin, grants, audience);

const bundleRow = (id: string) =>
  observer.one<{ name: string; revision: number; reduction_floor: number }>(
    `select name, revision, reduction_floor from role_bundle where id = $1`,
    [id],
  );
const grantRows = (id: string) =>
  observer.rows<{
    permission_key: string;
    hub_scope: string;
    ownership_scope: string;
    tier: string | null;
  }>(
    `select permission_key, hub_scope, ownership_scope, tier from role_bundle_grant where bundle_id = $1 order by permission_key collate "C"`,
    [id],
  );

/** A live staff session recorded against a bundle at a revision. */
async function sessionAt(bundleId: string, bundleRevision: number): Promise<string> {
  const row = await insertSessionRow(
    admin,
    sessionRow({ bundleId, bundleRevision, snapshot: OPS_STAFF_SNAPSHOT }),
  );
  return row.id;
}
const sessionState = (id: string) =>
  observer.one<{ terminated_at: Date | null; termination_reason: string | null }>(
    `select terminated_at, termination_reason from session where id = $1`,
    [id],
  );
const revocationsOf = (sessionIds: readonly string[]) =>
  observer.rows<{
    object_id: string;
    event_code: string;
    enhanced: boolean;
    outcome: string;
    actor_type: string;
    actor_id: string | null;
    surface_context: string;
    reason_code: string | null;
    reason_label: string | null;
    related_ids: Record<string, unknown>;
    before_after: Record<string, unknown>;
    correlation_id: string;
  }>(
    `select object_id, event_code, enhanced, outcome, actor_type, actor_id, surface_context, reason_code, reason_label, related_ids,
            before_after, correlation_id
       from audit_event where event_code = 'auth.session.authority_revoked' and object_id = any($1::uuid[]) order by object_id`,
    [sessionIds],
  );

const change = (
  bundleId: string,
  change: { name?: string; grants?: readonly Grant[] },
  correlationId = 'policy-change-test',
) => changeRoleBundle(migration, { bundleId, correlationId, ...change });

describe('who may execute the primitive (SECURITY_DESIGN.md section 13.10a, obligation 1; registry section 5.2, policy_change)', () => {
  const POLICY_TABLES = ['role_bundle', 'role_bundle_grant', 'fixed_permission_policy'] as const;
  const LOGINS = [API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE, PROVISIONING_ROLE] as const;

  // Break caught: EXECUTE on a change function reaching a runtime login, which would let code running as the API, the worker or the
  // provisioning login change a bundle, raise its own floor or end other people's sessions.
  it.each([
    'melarc.change_role_bundle(uuid, text, jsonb, text)',
    'melarc.change_fixed_policy(text, boolean, text)',
  ])('lets the migration login execute %s and no technical login', async (signature) => {
    for (const login of LOGINS) {
      const { rows } = await admin.query<{ held: boolean }>(
        `select has_function_privilege($1, $2, 'EXECUTE') as held`,
        [login, signature],
      );
      expect(rows[0]?.held, `${login} on ${signature}`).toBe(false);
    }
    const { rows } = await admin.query<{ held: boolean }>(
      `select has_function_privilege($1, $2, 'EXECUTE') as held`,
      [MIGRATION_ROLE, signature],
    );
    expect(rows[0]?.held).toBe(true);
  });

  // Break caught: a helper of the primitive callable by a login that was meant to reach the primitive only through its door. Only the
  // lock function of the seed is open to the provisioning login (and to the migration login), and nothing to the runtime or the worker.
  it('opens the lock function to the provisioning and migration logins only, and the rest of the helpers to nobody', async () => {
    const helpers = [
      'melarc.policy_bundle_lock_key(uuid)',
      'melarc.policy_fixed_lock_key(text)',
      'melarc.lock_policy_bundle(uuid)',
      'melarc.lock_policy_fixed(text)',
      'melarc.grant_attribute_change(text, text, text)',
    ];
    for (const signature of helpers) {
      for (const login of LOGINS) {
        const { rows } = await admin.query<{ held: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as held`,
          [login, signature],
        );
        expect(rows[0]?.held, `${login} on ${signature}`).toBe(false);
      }
    }
    const lock = 'melarc.lock_policy_keys(uuid[], text[])';
    const held = async (login: string) =>
      (
        await admin.query<{ held: boolean }>(
          `select has_function_privilege($1, $2, 'EXECUTE') as held`,
          [login, lock],
        )
      ).rows[0]?.held;
    expect(await held(PROVISIONING_ROLE)).toBe(true);
    expect(await held(MIGRATION_ROLE)).toBe(true);
    expect(await held(API_RUNTIME_ROLE)).toBe(false);
    expect(await held(WORKER_RUNTIME_ROLE)).toBe(false);
  });

  // Break caught: the refusals being the grant catalogue's and not the server's. A statement from each login is run, and what the
  // server answers is the result.
  it.each(LOGINS)(
    'refuses %s the change functions with permission denied, whatever it asserts first',
    async (login) => {
      const bundle = await newBundle([grant(READ_STAFF)]);
      await withClient(database.urlFor(login), async (client) => {
        const asserted = [
          `select set_config('melarc.principal_type', 'SYSTEM', false), set_config('melarc.task_capability', 'policy_change', false)`,
        ];
        for (const statement of asserted) await client.query(statement);
        expect(
          await sqlState(client, `select melarc.change_role_bundle($1, null, '[]'::jsonb, 'x')`, [
            bundle,
          ]),
        ).toBe('42501');
        expect(
          await sqlState(client, `select melarc.change_fixed_policy('VENDOR', true, 'x')`),
        ).toBe('42501');
      });
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
      expect(await grantRows(bundle)).toHaveLength(1);
    },
  );

  // Break caught (obligation 1): an UPDATE, INSERT, DELETE or row lock on a policy table reaching a runtime login, with or without
  // the label asserted. The runtime holds SELECT and no more, and the capability's policies are no privilege.
  it.each(LOGINS)(
    'refuses %s every write and row lock on the three policy tables, with the capability asserted',
    async (login) => {
      const bundle = await newBundle([grant(READ_STAFF)]);
      await withClient(database.urlFor(login), async (client) => {
        await client.query(`select set_config('melarc.principal_type', 'SYSTEM', false)`);
        await client.query(`select set_config('melarc.task_capability', 'policy_change', false)`);
        const statements = [
          `update role_bundle set revision = revision + 1 where id = '${bundle}'`,
          `update role_bundle_grant set tier = 'P' where bundle_id = '${bundle}'`,
          `update fixed_permission_policy set revision = revision + 1`,
          `delete from role_bundle_grant where bundle_id = '${bundle}'`,
          `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier) values ('${bundle}', '${READ_VENDOR}', 'own', 'any', 'A')`,
          `select id from role_bundle where id = '${bundle}' for share`,
          `select id from role_bundle where id = '${bundle}' for update`,
          `select 1 from fixed_permission_policy for key share`,
        ];
        for (const statement of statements) {
          expect(await sqlState(client, statement), `${login}: ${statement}`).toBe('42501');
        }
      });
      expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    },
  );

  // Break caught (obligation 1, the catalogue half): an UPDATE, INSERT, DELETE or TRUNCATE grant on a policy table to any technical
  // login. The registry's grant check holds this for every table; it is said here for the three the primitive exists for.
  it('shows no write grant on the policy tables to any technical login', async () => {
    for (const table of POLICY_TABLES) {
      for (const login of LOGINS) {
        for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
          const { rows } = await admin.query<{ held: boolean }>(
            `select has_table_privilege($1, $2, $3) as held`,
            [login, `public.${table}`, privilege],
          );
          expect(rows[0]?.held, `${login} ${privilege} on ${table}`).toBe(false);
        }
      }
    }
  });

  // Break caught: the migration login changing a bundle by a plain UPDATE, which would bypass the lock, the floor and the ending of
  // the sessions. The tables are forced to row-level security and the owner is held to the policies: with no label, no row is
  // visible to update, and the statement changes nothing.
  it('changes nothing when the migration login updates a policy table directly: no policy admits it', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);

    const attempt = async (statement: string): Promise<number | string> => {
      try {
        return (await migration.query(statement, [bundle])).rowCount ?? -1;
      } catch (error) {
        return (error as { code?: string }).code ?? 'error';
      }
    };
    const updated = await attempt(
      `update role_bundle set revision = revision + 1, reduction_floor = revision + 1 where id = $1`,
    );
    const removed = await attempt(`delete from role_bundle_grant where bundle_id = $1`);

    // Either no row is visible to the statement (the owner is held to the policies) or the login holds no privilege at all.
    expect([0, '42501']).toContain(updated);
    expect([0, '42501']).toContain(removed);
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    expect(await grantRows(bundle)).toHaveLength(1);
  });
});

describe('no lock is left behind (SECURITY_DESIGN.md section 13.10a, obligation 7)', () => {
  const held = async () =>
    (
      await migration.query<{ n: number }>(
        `select count(*)::int as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
      )
    ).rows[0]?.n;

  // Break caught: a lock taken with the session-level function, which a pooled connection would carry into the next request. After a
  // change that committed, one that was refused and one that gave up, the connection holds no advisory lock at all.
  it('holds no advisory lock on the connection after a change that committed, was refused, or ran out of time', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    expect(await held()).toBe(0);

    await change(bundle, { grants: [grant(READ_STAFF)] });
    expect(await held()).toBe(0);

    await change(randomUUID(), { grants: [] }).catch(() => undefined);
    expect(await held()).toBe(0);

    await changeFixedPolicy(migration, {
      principalType: 'VENDOR',
      reduction: false,
      correlationId: 'no-lock-left',
    });
    expect(await held()).toBe(0);

    const blocker = clientFor(database.urlFor('postgres'));
    await blocker.connect();
    await blocker.query('begin');
    await blocker.query(`select pg_advisory_xact_lock($1::int4, $2::int4)`, [
      AUTH_POLICY_BUNDLE,
      bundleLockKey(bundle),
    ]);
    try {
      const failure = await changeRoleBundle(
        migration,
        { bundleId: bundle, grants: [], correlationId: 'no-lock-left' },
        { lockTimeoutMs: 200 },
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ failure: 'LOCK_TIMEOUT' });
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    expect(await held()).toBe(0);
  });
});

describe('what is a reduction and what is not (SECURITY_DESIGN.md section 13.10a; domain-model.md section 6.9)', () => {
  const HUB: Grant['hubScope'][] = ['none', 'own', 'all'];
  const OWNERSHIP: Grant['ownershipScope'][] = ['own', 'assigned', 'any'];
  const TIER: Grant['tier'][] = [null, 'A', 'S', 'P'];

  /** The expectation, written out in full and not derived from an order: the table the Product Owner reads. */
  const HUB_EXPECTED: Record<string, string> = {
    'none>none': 'NONE',
    'none>own': 'ADDITION',
    'none>all': 'ADDITION',
    'own>none': 'REDUCTION',
    'own>own': 'NONE',
    'own>all': 'ADDITION',
    'all>none': 'REDUCTION',
    'all>own': 'REDUCTION',
    'all>all': 'NONE',
  };
  const OWNERSHIP_EXPECTED: Record<string, string> = {
    'own>own': 'NONE',
    // Not ordered between themselves: a change that cannot be shown to be a widening is a reduction.
    'own>assigned': 'REDUCTION',
    'own>any': 'ADDITION',
    'assigned>own': 'REDUCTION',
    'assigned>assigned': 'NONE',
    'assigned>any': 'ADDITION',
    'any>own': 'REDUCTION',
    'any>assigned': 'REDUCTION',
    'any>any': 'NONE',
  };
  const TIER_EXPECTED: Record<string, string> = {
    'null>null': 'NONE',
    'null>A': 'ADDITION',
    'null>S': 'ADDITION',
    'null>P': 'ADDITION',
    'A>null': 'REDUCTION',
    'A>A': 'NONE',
    'A>S': 'ADDITION',
    'A>P': 'ADDITION',
    'S>null': 'REDUCTION',
    'S>A': 'REDUCTION',
    'S>S': 'NONE',
    'S>P': 'ADDITION',
    'P>null': 'REDUCTION',
    'P>A': 'REDUCTION',
    'P>S': 'REDUCTION',
    'P>P': 'NONE',
  };

  const cases = (
    values: readonly (string | null)[],
    expected: Record<string, string>,
    build: (from: string | null, to: string | null) => [Grant, Grant],
  ) =>
    values.flatMap((from) =>
      values.map((to) => {
        const key = `${String(from)}>${String(to)}`;
        return [key, expected[key] ?? 'MISSING', ...build(from, to)] as const;
      }),
    );

  // Break caught: a narrowing of the hub scope read as a widening, so that a session keeps the wider reach it was issued with after
  // the bundle no longer allows it. Every pair of the three scopes, written out.
  it.each(
    cases(HUB, HUB_EXPECTED, (from, to) => [
      grant(READ_STAFF, from as Grant['hubScope']),
      grant(READ_STAFF, to as Grant['hubScope']),
    ]),
  )('hub scope %s is %s', async (_pair, expected, before, after) => {
    const bundle = await newBundle([before]);

    const result = await change(bundle, { grants: [after] });

    expect(result.kind).toBe(expected);
    expect(await bundleRow(bundle)).toMatchObject({
      revision: expected === 'NONE' ? 1 : 2,
      reduction_floor: expected === 'REDUCTION' ? 2 : 1,
    });
  });

  it.each(
    cases(OWNERSHIP, OWNERSHIP_EXPECTED, (from, to) => [
      grant(READ_STAFF, 'own', from as Grant['ownershipScope']),
      grant(READ_STAFF, 'own', to as Grant['ownershipScope']),
    ]),
  )('ownership scope %s is %s', async (_pair, expected, before, after) => {
    const bundle = await newBundle([before]);

    const result = await change(bundle, { grants: [after] });

    expect(result.kind).toBe(expected);
    expect(await bundleRow(bundle)).toMatchObject({
      revision: expected === 'NONE' ? 1 : 2,
      reduction_floor: expected === 'REDUCTION' ? 2 : 1,
    });
  });

  // Break caught (OB-75): a null tier coerced into a ranked tier, so that a grant with no tier and a grant with the lowest tier are the
  // same, or a null is read as above them. Null is "not applicable": it ranks below every tier, equals only itself, and a move to it
  // from a tier is a narrowing.
  it.each(
    cases(TIER, TIER_EXPECTED, (from, to) => [
      grant(READ_STAFF, 'own', 'any', from as Grant['tier']),
      grant(READ_STAFF, 'own', 'any', to as Grant['tier']),
    ]),
  )('tier %s is %s', async (_pair, expected, before, after) => {
    const bundle = await newBundle([before]);

    const result = await change(bundle, { grants: [after] });

    expect(result.kind).toBe(expected);
    expect(await bundleRow(bundle)).toMatchObject({
      revision: expected === 'NONE' ? 1 : 2,
      reduction_floor: expected === 'REDUCTION' ? 2 : 1,
    });
  });

  // Break caught: a change that widens one attribute and narrows another read as a widening (the narrowing is lost), or a change that
  // adds a grant and removes another read as an addition.
  it.each([
    [
      'widens the hub scope and narrows the tier of one grant',
      [grant(READ_STAFF, 'own', 'any', 'P')],
      [grant(READ_STAFF, 'all', 'any', 'S')],
      'REDUCTION',
    ],
    [
      'widens one grant and narrows another',
      [grant(READ_STAFF, 'own', 'any', 'A'), grant(READ_VENDOR, 'all', 'any', 'A')],
      [grant(READ_STAFF, 'all', 'any', 'A'), grant(READ_VENDOR, 'own', 'any', 'A')],
      'REDUCTION',
    ],
    [
      'adds a grant and removes another',
      [grant(READ_STAFF), grant(READ_VENDOR)],
      [grant(READ_STAFF), grant(READ_DISPATCH)],
      'REDUCTION',
    ],
    [
      'replaces the permission key of a grant',
      [grant(READ_STAFF)],
      [grant(READ_VENDOR)],
      'REDUCTION',
    ],
    ['removes a grant', [grant(READ_STAFF), grant(READ_VENDOR)], [grant(READ_STAFF)], 'REDUCTION'],
    ['removes every grant', [grant(READ_STAFF)], [], 'REDUCTION'],
    ['adds a grant', [grant(READ_STAFF)], [grant(READ_STAFF), grant(READ_VENDOR)], 'ADDITION'],
    ['adds a grant to an empty bundle', [], [grant(READ_STAFF)], 'ADDITION'],
    [
      'widens every attribute of a grant at once',
      [grant(READ_STAFF, 'none', 'own', null)],
      [grant(READ_STAFF, 'all', 'any', 'P')],
      'ADDITION',
    ],
    [
      'sets the same grants again, in another order',
      [grant(READ_STAFF), grant(READ_VENDOR)],
      [grant(READ_VENDOR), grant(READ_STAFF)],
      'NONE',
    ],
    ['sets an empty bundle empty', [], [], 'NONE'],
  ] as const)('%s', async (_label, before, after, expected) => {
    const bundle = await newBundle(before);

    const result = await change(bundle, { grants: after });

    expect(result.kind).toBe(expected);
    expect(await bundleRow(bundle)).toMatchObject({
      revision: expected === 'NONE' ? 1 : 2,
      reduction_floor: expected === 'REDUCTION' ? 2 : 1,
    });
    // Whatever the kind, the bundle ends holding exactly the grants it was given.
    expect(await grantRows(bundle)).toEqual(
      [...after]
        .map((each) => ({
          permission_key: each.permissionKey,
          hub_scope: each.hubScope,
          ownership_scope: each.ownershipScope,
          tier: each.tier,
        }))
        .toSorted((left, right) => (left.permission_key < right.permission_key ? -1 : 1)),
    );
  });

  // Break caught: a change of the name alone raising the revision or the floor, so that renaming a bundle signs everybody out
  // (SECURITY_DESIGN.md section 13.10a: "A change to a name alone raises nothing").
  it('raises nothing for a change of the name alone, and ends no session', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    const live = await sessionAt(bundle, 1);

    const result = await change(bundle, { name: `Renamed ${bundle}` });

    expect(result).toMatchObject({ kind: 'NAME_ONLY', revision: 1, floor: 1, endedSessionIds: [] });
    expect(await bundleRow(bundle)).toEqual({
      name: `Renamed ${bundle}`,
      revision: 1,
      reduction_floor: 1,
    });
    expect((await sessionState(live))?.terminated_at).toBeNull();
    expect(await grantRows(bundle)).toHaveLength(1);
  });

  it('changes nothing for the same name and the same grants', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    const before = await bundleRow(bundle);

    const result = await change(bundle, { name: before?.name ?? '', grants: [grant(READ_STAFF)] });

    expect(result).toMatchObject({ kind: 'NONE', revision: 1, floor: 1, endedSessionIds: [] });
    expect(await bundleRow(bundle)).toEqual(before);
  });

  it('renames a bundle in the same change that adds or removes grants, and the kind is the grants’', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);

    const result = await change(bundle, {
      name: `Narrower ${bundle}`,
      grants: [grant(READ_STAFF)],
    });

    expect(result.kind).toBe('REDUCTION');
    expect(await bundleRow(bundle)).toEqual({
      name: `Narrower ${bundle}`,
      revision: 2,
      reduction_floor: 2,
    });
  });
});

describe('what a reduction ends and records, and what an addition leaves alone (obligation 4, GBT-B13)', () => {
  // Break caught: a reduction that ends some of the sessions below the floor and not others, ends sessions of another bundle, or ends
  // one twice. It ends every live session of the bundle recorded below the new floor, in the same transaction, once.
  it('ends every live session of the bundle recorded below the new floor, with AUTHORITY_CHANGED, and no other', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const elsewhere = await newBundle([grant(READ_STAFF)]);
    const first = await sessionAt(bundle, 1);
    const second = await sessionAt(bundle, 1);
    const otherBundle = await sessionAt(elsewhere, 1);
    const alreadyEnded = await sessionAt(bundle, 1);
    await admin.query(
      `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = $1`,
      [alreadyEnded],
    );
    const endedBefore = await sessionState(alreadyEnded);

    const result = await change(bundle, { grants: [grant(READ_STAFF)] }, 'release-2026-10');

    expect(result.kind).toBe('REDUCTION');
    expect([...result.endedSessionIds].toSorted()).toEqual([first, second].toSorted());
    for (const id of [first, second]) {
      expect(await sessionState(id)).toMatchObject({ termination_reason: 'AUTHORITY_CHANGED' });
      expect((await sessionState(id))?.terminated_at).not.toBeNull();
    }
    expect((await sessionState(otherBundle))?.terminated_at).toBeNull();
    expect(await sessionState(alreadyEnded)).toEqual(endedBefore);
    // One enhanced event each, for the two it ended and for no other.
    expect(await revocationsOf([first, second, otherBundle, alreadyEnded])).toHaveLength(2);
  });

  // Break caught (audit.md section 5.4): an event that names the wrong bundle, revision or floor, is not enhanced, is attributed to a
  // person, or carries no before and after.
  it('records one enhanced auth.session.authority_revoked for each session, naming the bundle, the revision and the floor', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const live = await sessionAt(bundle, 1);

    await change(bundle, { grants: [grant(READ_STAFF)] }, 'release-2026-10-b');

    const events = await revocationsOf([live]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      object_id: live,
      event_code: 'auth.session.authority_revoked',
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor_type: 'SYSTEM',
      actor_id: null,
      surface_context: 'SYSTEM',
      reason_code: 'AUTHORITY_CHANGED',
      reason_label: 'Authority changed',
      related_ids: { bundle_id: bundle, revision: 2, reduction_floor: 2 },
      before_after: { session: 'ACTIVE_TO_TERMINATED' },
      correlation_id: 'release-2026-10-b',
    });
  });

  // Break caught (obligation 4): an addition ending a session, or raising the floor, so that granting a permission signs people out.
  it('raises the revision and ends no session for an addition, and writes no event', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    const live = await sessionAt(bundle, 1);

    const result = await change(bundle, { grants: [grant(READ_STAFF), grant(READ_VENDOR)] });

    expect(result).toMatchObject({ kind: 'ADDITION', revision: 2, floor: 1, endedSessionIds: [] });
    expect((await sessionState(live))?.terminated_at).toBeNull();
    expect(await revocationsOf([live])).toEqual([]);
  });

  // Break caught (GBT-B13): the floor remembered as "the revision before the addition", so that a reduction after an addition ends
  // only the sessions older than the addition and leaves the ones issued after it. A reduction raises the floor to the new revision
  // and ends every session below it, those issued after the addition included.
  it('retains snapshots through an addition, and a later reduction ends every session below its floor, those issued after the addition included', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    const beforeAddition = await sessionAt(bundle, 1);

    const added = await change(bundle, { grants: [grant(READ_STAFF), grant(READ_VENDOR)] });
    const afterAddition = await sessionAt(bundle, added.revision);
    expect((await sessionState(beforeAddition))?.terminated_at).toBeNull();
    expect((await sessionState(afterAddition))?.terminated_at).toBeNull();

    const reduced = await change(bundle, { grants: [grant(READ_STAFF)] });

    expect(reduced).toMatchObject({ kind: 'REDUCTION', revision: 3, floor: 3 });
    expect([...reduced.endedSessionIds].toSorted()).toEqual(
      [beforeAddition, afterAddition].toSorted(),
    );
    // A session issued at the floor is not below it.
    const atFloor = await sessionAt(bundle, reduced.revision);
    expect((await sessionState(atFloor))?.terminated_at).toBeNull();
    // A second reduction ends it, and only it.
    const again = await change(bundle, { grants: [] });
    expect(again).toMatchObject({ kind: 'REDUCTION', revision: 4, floor: 4 });
    expect(again.endedSessionIds).toEqual([atFloor]);
  });

  // Break caught: a reduction of a bundle that no session holds failing, or leaving the floor where it was.
  it('raises the floor of a bundle that has no sessions, and ends nothing', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);

    const result = await change(bundle, { grants: [] });

    expect(result).toMatchObject({ kind: 'REDUCTION', revision: 2, floor: 2, endedSessionIds: [] });
  });
});

describe('one transaction, whole or not at all (GBT-B12, obligation 6)', () => {
  // Break caught: a change whose writes commit and whose sessions are ended by a statement that runs apart from it, so that a failure
  // in the middle leaves a bundle reduced and the sessions running, or the other way round.
  it('leaves nothing of a reduction when the caller’s transaction is rolled back', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const live = await sessionAt(bundle, 1);

    await migration.query('begin');
    const rows = await migration.query<{ result: { kind: string } }>(
      `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'rolled-back') as result`,
      [
        bundle,
        JSON.stringify([
          { permission_key: READ_STAFF, hub_scope: 'own', ownership_scope: 'any', tier: 'A' },
        ]),
      ],
    );
    expect(rows.rows[0]?.result.kind).toBe('REDUCTION');
    await migration.query('rollback');

    expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    expect(await grantRows(bundle)).toHaveLength(2);
    expect((await sessionState(live))?.terminated_at).toBeNull();
    expect(await revocationsOf([live])).toEqual([]);
  });

  // Break caught: the labels the function sets staying set after it returns, so that the rest of the caller's transaction runs as
  // SYSTEM under a capability, or the caller's own labels lost.
  it('puts back the labels the caller had set, and leaves none behind when it had none', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    // An unset label and an empty one are the same to every policy ("no principal"); the function puts back an empty one.
    const read = async () => {
      const row = (
        await migration.query(
          `select current_setting('melarc.principal_type', true) as principal,
                  current_setting('melarc.task_capability', true) as capability`,
        )
      ).rows[0] as { principal: string | null; capability: string | null };
      return { principal: row.principal ?? '', capability: row.capability ?? '' };
    };
    const payload = JSON.stringify([
      { permission_key: READ_STAFF, hub_scope: 'own', ownership_scope: 'any', tier: 'A' },
      { permission_key: READ_VENDOR, hub_scope: 'own', ownership_scope: 'any', tier: 'A' },
    ]);

    await migration.query('begin');
    const none = await read();
    await migration.query(`select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'labels')`, [
      bundle,
      payload,
    ]);
    const afterNone = await read();
    await migration.query(`select set_config('melarc.principal_type', 'STAFF', true)`);
    await migration.query(`select set_config('melarc.task_capability', 'none-of-them', true)`);
    await migration.query(`select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'labels')`, [
      bundle,
      JSON.stringify([]),
    ]);
    const afterSet = await read();
    await migration.query('rollback');

    expect(afterNone).toEqual(none);
    expect(afterSet).toEqual({ principal: 'STAFF', capability: 'none-of-them' });
  });

  // Break caught (section 13.10a, "Reads follow acquisition"): a change run at a stricter isolation level, whose snapshot could
  // predate the lock it waited for.
  it.each(['repeatable read', 'serializable'])('refuses a transaction at %s', async (level) => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    await migration.query(`begin isolation level ${level}`);
    const state = await sqlState(
      migration,
      `select melarc.change_role_bundle($1::uuid, null, '[]'::jsonb, 'isolation')`,
      [bundle],
    );
    await migration.query('rollback');

    expect(state).toBe('25000');
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1 });
  });

  // Break caught: a malformed change applied in part. Every one is refused before anything is read or written, and the bundle is
  // exactly as it was.
  it.each([
    ['a grants value that is not an array', `'{"permission_key": "staff.read"}'::jsonb`],
    ['a grant that is not an object', `'["staff.read"]'::jsonb`],
    [
      'a grant with a key it should not have',
      `'[{"permission_key":"staff.read","hub_scope":"own","ownership_scope":"any","tier":"A","extra":1}]'::jsonb`,
    ],
    [
      'a grant with a misspelled key, which would read as no tier',
      `'[{"permission_key":"staff.read","hub_scope":"own","ownership_scope":"any","tire":"A"}]'::jsonb`,
    ],
    [
      'an unknown hub scope',
      `'[{"permission_key":"staff.read","hub_scope":"everywhere","ownership_scope":"any","tier":"A"}]'::jsonb`,
    ],
    [
      'an unknown ownership scope',
      `'[{"permission_key":"staff.read","hub_scope":"own","ownership_scope":"mine","tier":"A"}]'::jsonb`,
    ],
    [
      'an unknown tier',
      `'[{"permission_key":"staff.read","hub_scope":"own","ownership_scope":"any","tier":"X"}]'::jsonb`,
    ],
    [
      'the same permission twice',
      `'[{"permission_key":"staff.read","hub_scope":"own","ownership_scope":"any","tier":"A"},{"permission_key":"staff.read","hub_scope":"all","ownership_scope":"any","tier":"A"}]'::jsonb`,
    ],
  ])('refuses %s and changes nothing', async (_label, payload) => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const live = await sessionAt(bundle, 1);

    const state = await sqlState(
      migration,
      `select melarc.change_role_bundle($1::uuid, null, ${payload}, 'malformed')`,
      [bundle],
    );

    expect(state).toBe('22023');
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    expect(await grantRows(bundle)).toHaveLength(2);
    expect((await sessionState(live))?.terminated_at).toBeNull();
  });

  it('refuses a permission the catalogue does not hold, and a bundle that does not exist, and changes nothing', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);

    const unknownPermission = await change(bundle, { grants: [grant('no.such.permission')] }).catch(
      (error: unknown) => error,
    );
    const unknownBundle = await change(randomUUID(), { grants: [] }).catch(
      (error: unknown) => error,
    );

    // A key the catalogue does not hold is refused by the foreign key, and the database error reaches the caller as it is.
    expect(unknownPermission).toMatchObject({ code: '23503' });
    expect(unknownBundle).toBeInstanceOf(PolicyChangeError);
    expect(unknownBundle).toMatchObject({ failure: 'NOT_FOUND' });
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    expect(await grantRows(bundle)).toHaveLength(1);
  });

  // Break caught: free text reaching the append-only ledger through the one field a caller of the primitive chooses. It names a
  // release step or an operation: letters, digits and . _ : / # -, 1 to 128 of them, starting with a letter or a digit. Both functions.
  it.each([
    ['a correlation id of 129 characters', 'x'.repeat(129)],
    ['an empty correlation id', ''],
    ['a correlation id with a space', 'release step'],
    ['a correlation id that is an address', 'ama@example.test'],
    ['a correlation id with a line break', 'release\nstep'],
    ['a correlation id that starts with a symbol', '-release'],
  ])('refuses %s, in both functions', async (_label, correlation) => {
    const bundle = await newBundle([grant(READ_STAFF)]);

    const forBundle = await sqlState(
      migration,
      `select melarc.change_role_bundle($1::uuid, null, '[]'::jsonb, $2)`,
      [bundle, correlation],
    );
    const forFixed = await sqlState(
      migration,
      `select melarc.change_fixed_policy('VENDOR', false, $1)`,
      [correlation],
    );

    expect(forBundle).toBe('22023');
    expect(forFixed).toBe('22023');
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1 });
  });

  it('accepts a correlation id of 128 characters, and the characters a release step is named with', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);

    const long = await change(bundle, { grants: [grant(READ_STAFF)] }, `a${'b'.repeat(127)}`);
    const named = await change(
      bundle,
      { grants: [grant(READ_STAFF)] },
      'release/2026-10_b:step#3.1',
    );

    expect(long.kind).toBe('NONE');
    expect(named.kind).toBe('NONE');
  });

  it('refuses a name that is empty, and a name another bundle holds, and changes nothing', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    const other = await newBundle([]);
    const otherName = (await bundleRow(other))?.name ?? '';

    const empty = await sqlState(
      migration,
      `select melarc.change_role_bundle($1::uuid, '   ', null, 'name')`,
      [bundle],
    );
    const taken = await change(bundle, { name: otherName, grants: [] }).catch(
      (error: unknown) => error,
    );

    expect(empty).toBe('22023');
    expect(taken).toMatchObject({ code: '23505' });
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1, reduction_floor: 1 });
    expect(await grantRows(bundle)).toHaveLength(1);
  });
});

describe('the fixed policy of the Vendor and the Rider (SECURITY_DESIGN.md section 13.10, part 3)', () => {
  const fixedRow = (type: string) =>
    observer.one<{ revision: number; minimum_revision: number }>(
      `select revision, minimum_revision from fixed_permission_policy where principal_type = $1`,
      [type],
    );
  const fixedSession = async (type: 'VENDOR' | 'RIDER', policyRevision: number | null) => {
    const row = await insertSessionRow(
      admin,
      sessionRow({
        principalType: type,
        principalId: randomUUID(),
        registeredDeviceId: randomUUID(),
        policyRevision,
        bundleId: type === 'RIDER' ? BUNDLE_IDS.rider : BUNDLE_IDS.vendor,
        snapshot: { format: 1, name: type, audience: type, privileged: false, grants: [] },
      }),
    );
    return row.id;
  };

  // Break caught: a compiled-policy release that adds a rule ending sessions, or one that reduces it and leaves them running.
  it('raises the revision and ends nothing for an addition, and raises the floor and ends the sessions below it for a reduction', async () => {
    const before = await fixedRow('VENDOR');
    const old = await fixedSession('VENDOR', before?.revision ?? 1);

    const added = await changeFixedPolicy(migration, {
      principalType: 'VENDOR',
      reduction: false,
      correlationId: 'release-vendor-add',
    });
    expect(added).toMatchObject({
      kind: 'ADDITION',
      revision: (before?.revision ?? 0) + 1,
      floor: before?.minimum_revision,
      endedSessionIds: [],
    });
    expect((await sessionState(old))?.terminated_at).toBeNull();

    const middle = await fixedSession('VENDOR', added.revision);
    const reduced = await changeFixedPolicy(migration, {
      principalType: 'VENDOR',
      reduction: true,
      correlationId: 'release-vendor-reduce',
    });

    expect(reduced).toMatchObject({
      kind: 'REDUCTION',
      revision: added.revision + 1,
      floor: added.revision + 1,
    });
    expect([...reduced.endedSessionIds].toSorted()).toEqual([old, middle].toSorted());
    expect(await fixedRow('VENDOR')).toEqual({
      revision: added.revision + 1,
      minimum_revision: added.revision + 1,
    });
    const events = await revocationsOf([old, middle]);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      enhanced: true,
      actor_type: 'SYSTEM',
      reason_code: 'AUTHORITY_CHANGED',
      related_ids: { principal_type: 'VENDOR', minimum_revision: reduced.revision },
      before_after: { session: 'ACTIVE_TO_TERMINATED' },
      correlation_id: 'release-vendor-reduce',
    });
  });

  // Break caught: a Rider reduction ending a Vendor's sessions, or the other way round; and a session recorded under no policy
  // revision (which cannot be trusted) surviving a reduction because NULL is not less than anything.
  it('ends the sessions of its own audience only, and one that records no revision with them', async () => {
    const rider = await fixedSession('RIDER', 1);
    const vendor = await fixedSession('VENDOR', (await fixedRow('VENDOR'))?.revision ?? 1);
    const unrecorded = await insertSessionRow(
      admin,
      sessionRow({
        principalType: 'RIDER',
        principalId: randomUUID(),
        registeredDeviceId: randomUUID(),
        policyRevision: null,
        bundleId: BUNDLE_IDS.rider,
        snapshot: { format: 1, name: 'RIDER', audience: 'RIDER', privileged: false, grants: [] },
      }),
    ).catch(() => undefined);

    const reduced = await changeFixedPolicy(migration, {
      principalType: 'RIDER',
      reduction: true,
      correlationId: 'release-rider-reduce',
    });

    expect(reduced.endedSessionIds).toContain(rider);
    expect(reduced.endedSessionIds).not.toContain(vendor);
    expect((await sessionState(vendor))?.terminated_at).toBeNull();
    // The table may refuse a Rider session with no policy revision; if it does not, the reduction ends it.
    if (unrecorded !== undefined) expect(reduced.endedSessionIds).toContain(unrecorded.id);
  });

  it('refuses an audience with no fixed policy, and a missing flag, and changes nothing', async () => {
    const staff = await sqlState(
      migration,
      `select melarc.change_fixed_policy('STAFF', true, 'x')`,
    );
    const missing = await sqlState(
      migration,
      `select melarc.change_fixed_policy('VENDOR', null, 'x')`,
    );

    expect(staff).toBe('22023');
    expect(missing).toBe('22023');
  });
});

describe('the lock keys are the toolkit’s (SECURITY_DESIGN.md section 13.10a; lock-keys.ts)', () => {
  interface Held {
    readonly class: number;
    readonly key: number;
    readonly mode: string;
    readonly granted: boolean;
  }
  const asHeld = (row: { class: string; key: string; mode: string; granted: boolean }): Held => ({
    class: Number(row.class),
    // pg_locks shows the second integer unsigned: read it back as the signed integer it was given as.
    key: Number(row.key) | 0,
    mode: row.mode,
    granted: row.granted,
  });
  /** The advisory locks of one backend, as the server reports them: held, then waited for. */
  const locksOfPid = async (
    client: Pick<pg.Client, 'query'>,
    pid: number | null,
  ): Promise<Held[]> =>
    (
      await client.query<{ class: string; key: string; mode: string; granted: boolean }>(
        `select classid::bigint as class, objid::bigint as key, mode, granted
           from pg_locks where locktype = 'advisory' and pid = coalesce($1::int, pg_backend_pid())
          order by granted desc, classid, objid::bigint`,
        [pid],
      )
    ).rows.map(asHeld);
  const lockKeysSql = `select melarc.lock_policy_keys($1::uuid[], $2::text[])`;
  const literal = (values: readonly string[]) => `{${values.join(',')}}`;
  const keyOf = async (id: string) =>
    Number(
      (
        await admin.query<{ key: number }>(
          `select melarc.policy_bundle_lock_key($1::uuid) as key`,
          [id],
        )
      ).rows[0]?.key,
    );
  /** Two bundles of their own, the one with the lower lock key first. */
  async function twoBundlesByKey(): Promise<[string, string]> {
    const first = await newBundle([grant(READ_STAFF)]);
    const second = await newBundle([grant(READ_STAFF)]);
    return bundleLockKey(first) <= bundleLockKey(second) ? [first, second] : [second, first];
  }
  const rollbackQuietly = () => migration.query('rollback').catch(() => undefined);

  // Break caught: the writer's digest or class differing from the reader's by one byte, so that a sign-in's shared lock and a
  // reduction's exclusive lock are different locks and exclude nothing. The numbers are written twice, in TypeScript and in SQL;
  // this holds the two to each other, over ids of every shape.
  it('derives the same key for a bundle id in SQL as the toolkit does, for ids of every shape', async () => {
    const ids = [
      ...Object.values(BUNDLE_IDS),
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '7fffffff-ffff-4fff-bfff-ffffffffffff',
      ...Array.from({ length: 300 }, () => randomUUID()),
    ];
    for (const id of ids) {
      expect(await keyOf(id), id).toBe(bundleLockKey(id));
    }
    // The toolkit canonicalizes case; a uuid has one text form in PostgreSQL, so an upper-case input is the same key.
    expect(await keyOf(BUNDLE_IDS.opsStaff.toUpperCase())).toBe(bundleLockKey(BUNDLE_IDS.opsStaff));
  });

  it('derives the same key for the two fixed policies as the toolkit does, and none for another audience', async () => {
    for (const type of ['VENDOR', 'RIDER'] as const) {
      const row = await admin.query<{ key: number }>(
        `select melarc.policy_fixed_lock_key($1) as key`,
        [type],
      );
      expect(Number(row.rows[0]?.key)).toBe(fixedLockKey(type));
    }
    const none = await admin.query<{ key: number | null }>(
      `select melarc.policy_fixed_lock_key('STAFF') as key`,
    );
    expect(none.rows[0]?.key).toBeNull();
  });

  // Break caught: the class constants differing, or the writer taking a lock of the right key in the wrong class. The server's own
  // report of what the primitive holds is compared with what the toolkit would take.
  it('takes, in the toolkit’s classes and with its keys, an exclusive lock on each bundle and each fixed policy it is given', async () => {
    const bundles = [randomUUID(), randomUUID(), BUNDLE_IDS.platformAdmin];
    await migration.query('begin');
    try {
      await migration.query(lockKeysSql, [literal(bundles), literal(['RIDER', 'VENDOR'])]);
      const held = await locksOfPid(migration, null);

      expect(held.every((each) => each.granted && each.mode === 'ExclusiveLock')).toBe(true);
      expect(
        held
          .filter((each) => each.class === AUTH_POLICY_BUNDLE)
          .map((each) => each.key)
          .toSorted((a, b) => a - b),
      ).toEqual(bundles.map((id) => bundleLockKey(id)).toSorted((a, b) => a - b));
      expect(
        held
          .filter((each) => each.class === AUTH_POLICY_FIXED)
          .map((each) => each.key)
          .toSorted((a, b) => a - b),
      ).toEqual([fixedLockKey('VENDOR'), fixedLockKey('RIDER')]);
      expect(held).toHaveLength(bundles.length + 2);
    } finally {
      await rollbackQuietly();
    }
    expect(await locksOfPid(migration, null)).toEqual([]);
  });

  it('takes the lock a change takes in the toolkit’s class and key, for the bundle it changes and for the fixed policy it changes', async () => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    await migration.query('begin');
    try {
      await migration.query(
        `select melarc.change_role_bundle($1::uuid, null, '[]'::jsonb, 'held')`,
        [bundle],
      );
      await migration.query(`select melarc.change_fixed_policy('RIDER', false, 'held')`);

      expect(await locksOfPid(migration, null)).toEqual([
        {
          class: AUTH_POLICY_BUNDLE,
          key: bundleLockKey(bundle),
          mode: 'ExclusiveLock',
          granted: true,
        },
        {
          class: AUTH_POLICY_FIXED,
          key: fixedLockKey('RIDER'),
          mode: 'ExclusiveLock',
          granted: true,
        },
      ]);
    } finally {
      await rollbackQuietly();
    }
  });

  // Break caught: two bundles whose keys collide taking two locks (or a plan that skips one), or a repeated id taking the lock twice
  // and a fixed policy listed twice failing. A collision costs waiting and never admits an interleaving the exact key excluded.
  it('merges two bundle ids whose keys collide, and a repeated id or audience, into one lock each', async () => {
    const pair = (
      await admin.query<{ a: string; b: string }>(
        // Grouped, not self-joined: the planner takes a nested loop over the two scans of a generated set, which is 400000 squared.
        `select (array_agg(id order by id))[1] as a, (array_agg(id order by id))[2] as b
           from (select id, melarc.policy_bundle_lock_key(id) as key
                   from (select gen_random_uuid() as id from generate_series(1, 400000)) generated) keyed
          group by key having count(*) > 1 limit 1`,
      )
    ).rows[0];
    expect(pair, 'no two of 400000 ids shared a key: widen the search').toBeDefined();
    const [a, b] = [pair?.a ?? '', pair?.b ?? ''];
    expect(bundleLockKey(a)).toBe(bundleLockKey(b));

    await migration.query('begin');
    try {
      await migration.query(lockKeysSql, [literal([a, b, a]), literal(['VENDOR', 'VENDOR'])]);
      const held = await locksOfPid(migration, null);
      expect(held.filter((each) => each.class === AUTH_POLICY_BUNDLE)).toHaveLength(1);
      expect(held.filter((each) => each.class === AUTH_POLICY_FIXED)).toHaveLength(1);
    } finally {
      await rollbackQuietly();
    }
  }, 60_000);

  /**
   * What the caller holds while it waits, when another connection already holds `blocking`: the proof of an order. A caller that
   * takes its locks in the order the function claims holds the earlier ones (granted) while it waits for the one the blocker holds;
   * taken in another order it would hold nothing while it waited.
   */
  async function heldWhileWaitingFor(
    blocking: { class: number; key: number },
    call: () => Promise<unknown>,
  ): Promise<Held[]> {
    const blocker = clientFor(database.urlFor('postgres'));
    await blocker.connect();
    await blocker.query('begin');
    await blocker.query(`select pg_advisory_xact_lock($1::int4, $2::int4)`, [
      blocking.class,
      blocking.key,
    ]);
    const pending = call();
    let waiter: Held[];
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await admin.query<{ pid: number }>(
          `select pid from pg_stat_activity
            where datname = $1 and usename = $2 and wait_event_type = 'Lock' and wait_event = 'advisory'`,
          [database.name, MIGRATION_ROLE],
        );
        const pid = rows[0]?.pid;
        if (pid !== undefined) {
          waiter = await locksOfPid(admin, pid);
          break;
        }
        if (Date.now() > deadline) throw new Error('the caller never waited for the lock');
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    } finally {
      await blocker.query('rollback');
      await blocker.end();
    }
    await pending;
    return waiter;
  }

  // Break caught (obligation 12): the locks of one call taken in the order the caller listed them, so that two callers with the same
  // set in opposite orders wait for each other for ever. The bundles are taken by key ascending, then the fixed policies by ordinal.
  it('takes bundle locks by key ascending, whatever order it is given them', async () => {
    const [low, high] = await twoBundlesByKey();
    await migration.query('begin');
    try {
      const held = await heldWhileWaitingFor(
        { class: AUTH_POLICY_BUNDLE, key: bundleLockKey(high) },
        // Given the highest first: it must take the lowest first, and so hold it while it waits for the highest.
        () => migration.query(lockKeysSql, [literal([high, low]), literal([])]),
      );

      expect(held).toEqual([
        {
          class: AUTH_POLICY_BUNDLE,
          key: bundleLockKey(low),
          mode: 'ExclusiveLock',
          granted: true,
        },
        {
          class: AUTH_POLICY_BUNDLE,
          key: bundleLockKey(high),
          mode: 'ExclusiveLock',
          granted: false,
        },
      ]);
    } finally {
      await rollbackQuietly();
    }
  });

  it('takes the fixed policies by ordinal, whatever order it is given them', async () => {
    await migration.query('begin');
    try {
      const held = await heldWhileWaitingFor(
        { class: AUTH_POLICY_FIXED, key: fixedLockKey('RIDER') },
        () => migration.query(lockKeysSql, [literal([]), literal(['RIDER', 'VENDOR'])]),
      );

      expect(held).toEqual([
        {
          class: AUTH_POLICY_FIXED,
          key: fixedLockKey('VENDOR'),
          mode: 'ExclusiveLock',
          granted: true,
        },
        {
          class: AUTH_POLICY_FIXED,
          key: fixedLockKey('RIDER'),
          mode: 'ExclusiveLock',
          granted: false,
        },
      ]);
    } finally {
      await rollbackQuietly();
    }
  });

  it('takes the bundles before the fixed policies', async () => {
    const bundle = randomUUID();
    await migration.query('begin');
    try {
      const held = await heldWhileWaitingFor(
        { class: AUTH_POLICY_FIXED, key: fixedLockKey('VENDOR') },
        () => migration.query(lockKeysSql, [literal([bundle]), literal(['VENDOR'])]),
      );

      expect(held).toEqual([
        {
          class: AUTH_POLICY_BUNDLE,
          key: bundleLockKey(bundle),
          mode: 'ExclusiveLock',
          granted: true,
        },
        {
          class: AUTH_POLICY_FIXED,
          key: fixedLockKey('VENDOR'),
          mode: 'ExclusiveLock',
          granted: false,
        },
      ]);
    } finally {
      await rollbackQuietly();
    }
  });

  // Break caught: a release step that changes a bundle and a fixed policy failing, or taking the locks in an order that another step
  // taking them canonically could deadlock with (section 13.10a: the fixed key "after the bundle key if the same step changes a bundle").
  it('lets one transaction change a bundle and then a fixed policy, after taking both keys together', async () => {
    const bundle = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const live = await sessionAt(bundle, 1);

    await migration.query('begin');
    try {
      await migration.query(lockKeysSql, [literal([bundle]), literal(['VENDOR'])]);
      const reduced = await migration.query<{ result: { kind: string } }>(
        `select melarc.change_role_bundle($1::uuid, null, $2::jsonb, 'step') as result`,
        [
          bundle,
          JSON.stringify([
            { permission_key: READ_STAFF, hub_scope: 'own', ownership_scope: 'any', tier: 'A' },
          ]),
        ],
      );
      const fixed = await migration.query<{ result: { kind: string } }>(
        `select melarc.change_fixed_policy('VENDOR', false, 'step') as result`,
      );
      await migration.query('commit');

      expect(reduced.rows[0]?.result.kind).toBe('REDUCTION');
      expect(fixed.rows[0]?.result.kind).toBe('ADDITION');
    } finally {
      await rollbackQuietly();
    }
    expect((await sessionState(live))?.termination_reason).toBe('AUTHORITY_CHANGED');
  });

  // Break caught (obligation 12, "no code path takes a key exclusive while holding it shared"): the primitive upgrading a shared lock
  // its own transaction holds. Advisory locks do not conflict with their holder, so the database would grant it, and two holders that
  // both tried would wait for each other for ever.
  it.each([
    [
      'a bundle lock, in a change',
      (bundle: string) => [
        `select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_BUNDLE)}::int4, ${String(bundleLockKey(bundle))}::int4)`,
        `select melarc.change_role_bundle('${bundle}'::uuid, null, '[]'::jsonb, 'upgrade')`,
      ],
    ],
    [
      'a bundle lock, through the lock function',
      (bundle: string) => [
        `select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_BUNDLE)}::int4, ${String(bundleLockKey(bundle))}::int4)`,
        `select melarc.lock_policy_keys('{${bundle}}'::uuid[], '{}'::text[])`,
      ],
    ],
    [
      'a fixed-policy lock, in a change',
      () => [
        `select pg_advisory_xact_lock_shared(${String(AUTH_POLICY_FIXED)}::int4, ${String(fixedLockKey('VENDOR'))}::int4)`,
        `select melarc.change_fixed_policy('VENDOR', false, 'upgrade')`,
      ],
    ],
  ])('refuses to upgrade %s that its transaction holds shared', async (_label, statements) => {
    const bundle = await newBundle([grant(READ_STAFF)]);
    await migration.query('begin');
    let failure: { code?: string; detail?: string } | undefined;
    try {
      for (const statement of statements(bundle)) await migration.query(statement);
    } catch (error) {
      failure = error as { code?: string; detail?: string };
    } finally {
      await rollbackQuietly();
    }

    expect(failure).toMatchObject({ code: '55000', detail: 'lock_upgrade' });
    expect(await bundleRow(bundle)).toMatchObject({ revision: 1 });
  });

  // Break caught (obligation 12): the canonical order broken by a caller, which a concurrent caller taking it canonically could
  // deadlock with. The primitive refuses at once, naming the order, instead of leaving two holders to wait for each other.
  it.each([
    [
      'a bundle after a fixed policy',
      (_low: string, high: string) => [
        `select melarc.change_fixed_policy('VENDOR', false, 'order')`,
        `select melarc.change_role_bundle('${high}'::uuid, null, '[]'::jsonb, 'order')`,
      ],
    ],
    [
      'a bundle with a lower key after one with a higher key',
      (low: string, high: string) => [
        `select melarc.change_role_bundle('${high}'::uuid, null, '[]'::jsonb, 'order')`,
        `select melarc.change_role_bundle('${low}'::uuid, null, '[]'::jsonb, 'order')`,
      ],
    ],
    [
      'the Vendor policy after the Rider policy',
      () => [
        `select melarc.change_fixed_policy('RIDER', false, 'order')`,
        `select melarc.change_fixed_policy('VENDOR', false, 'order')`,
      ],
    ],
  ])('refuses %s, naming the order', async (_label, statements) => {
    const [low, high] = await twoBundlesByKey();
    await migration.query('begin');
    let failure: { code?: string; detail?: string } | undefined;
    try {
      for (const statement of statements(low, high)) await migration.query(statement);
    } catch (error) {
      failure = error as { code?: string; detail?: string };
    } finally {
      await rollbackQuietly();
    }

    expect(failure).toMatchObject({ code: '55000', detail: 'lock_order' });
  });

  it('refuses the lock functions at a stricter isolation level, and an audience with no fixed policy', async () => {
    await migration.query('begin isolation level repeatable read');
    const stricter = await sqlState(migration, lockKeysSql, [literal([randomUUID()]), literal([])]);
    await rollbackQuietly();
    const staff = await sqlState(migration, lockKeysSql, [literal([]), literal(['STAFF'])]);

    expect(stricter).toBe('25000');
    expect(staff).toBe('22023');
  });
});

describe('the audit event is the one the TypeScript path writes (audit.md section 5.4; session-authority.ts)', () => {
  const COLUMNS = `event_code, actor_type, actor_id, actor_bundle, surface_context, device_context, vendor_organization_id,
                   responsible_hub_id, object_type, previous_state, resulting_state, reason_code, reason_label, note, approval_id,
                   before_after, related_ids, detail, outcome, enhanced, serialisation_version`;
  /** Every column of the event but its identity, its two instants and its correlation, with an id in the facts replaced. */
  const eventOf = async (sessionId: string, replace: Record<string, string>) => {
    const rows = (
      await admin.query(
        `select ${COLUMNS}, id, occurred_at, recorded_at, correlation_id from audit_event
          where event_code = 'auth.session.authority_revoked' and object_id = $1`,
        [sessionId],
      )
    ).rows as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    const { id, occurred_at, recorded_at, correlation_id, ...rest } = rows[0] ?? {};
    // A UUIDv7 in both cases, and the two instants are the database's.
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(occurred_at).toBeInstanceOf(Date);
    expect(recorded_at).toBeInstanceOf(Date);
    expect(typeof correlation_id).toBe('string');
    let text = JSON.stringify(rest);
    for (const [from, to] of Object.entries(replace)) text = text.replaceAll(from, to);
    return JSON.parse(text) as Record<string, unknown>;
  };
  const authenticationContext = {
    principalType: 'SYSTEM',
    principalId: AUTHENTICATION_PRINCIPAL_ID,
    surface: 'SYSTEM',
    taskCapability: 'authentication',
    correlationId: 'conformance',
  } as const;

  // Break caught: a second implementation of the event that drifts from the first (a column, a spelling, the actor, the flag), so that
  // the ledger holds two shapes of one fact and a reader or the integrity chain reads one of them wrongly.
  it('records, for a bundle reduction, exactly what endForAuthority records for the same session and floor', async () => {
    const viaSql = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const viaTs = await newBundle([grant(READ_STAFF), grant(READ_VENDOR)]);
    const sqlSession = await sessionAt(viaSql, 1);
    const tsSession = await sessionAt(viaTs, 1);

    await change(viaSql, { grants: [grant(READ_STAFF)] }, 'conformance');
    await admin.query(`update role_bundle set revision = 2, reduction_floor = 2 where id = $1`, [
      viaTs,
    ]);
    const ended = await machinery.unitOfWork.run(authenticationContext, (handle) =>
      endForAuthority(handle, { sessions: machinery.sessions, audit: machinery.audit }, tsSession, {
        kind: 'BUNDLE',
        bundleId: viaTs,
        revision: 2,
        reductionFloor: 2,
      }),
    );

    expect(ended).toBe(true);
    expect(await eventOf(sqlSession, { [viaSql]: 'BUNDLE' })).toEqual(
      await eventOf(tsSession, { [viaTs]: 'BUNDLE' }),
    );
    expect(await sessionState(sqlSession)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
    expect(await sessionState(tsSession)).toMatchObject({
      termination_reason: 'AUTHORITY_CHANGED',
    });
  });

  it('records, for a fixed-policy reduction, exactly what endForAuthority records for the same session and floor', async () => {
    const policy = await admin.query<{ revision: number }>(
      `select revision from fixed_permission_policy where principal_type = 'VENDOR'`,
    );
    const revision = Number(policy.rows[0]?.revision);
    const vendorSession = async () =>
      (
        await insertSessionRow(
          admin,
          sessionRow({
            principalType: 'VENDOR',
            principalId: randomUUID(),
            registeredDeviceId: randomUUID(),
            policyRevision: revision,
            bundleId: BUNDLE_IDS.vendor,
            snapshot: {
              format: 1,
              name: 'VENDOR',
              audience: 'VENDOR',
              privileged: false,
              grants: [],
            },
          }),
        )
      ).id;
    const viaSql = await vendorSession();
    const viaTs = await vendorSession();

    // The SQL function ends every session below the new floor, so the TypeScript path ends `viaTs` first, with the floor the
    // reduction is about to set, and the function then ends the one that is left.
    const floor = revision + 1;
    const ended = await machinery.unitOfWork.run(authenticationContext, (handle) =>
      endForAuthority(handle, { sessions: machinery.sessions, audit: machinery.audit }, viaTs, {
        kind: 'FIXED',
        principalType: 'VENDOR',
        minimumRevision: floor,
      }),
    );
    expect(ended).toBe(true);
    const reduced = await changeFixedPolicy(migration, {
      principalType: 'VENDOR',
      reduction: true,
      correlationId: 'conformance',
    });

    expect(reduced.floor).toBe(floor);
    expect(reduced.endedSessionIds).toContain(viaSql);
    expect(reduced.endedSessionIds).not.toContain(viaTs);
    expect(await eventOf(viaSql, {})).toEqual(await eventOf(viaTs, {}));
  });
});

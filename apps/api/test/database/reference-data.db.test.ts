import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import { acquirePolicyLocks } from '../../src/platform/database/policy-lock/acquire.js';
import {
  bundleLock,
  fixedLock,
  planPolicyLocks,
} from '../../src/platform/database/policy-lock/plan.js';
import {
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from '../../src/platform/database/technical-roles.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  HUB_A,
  RIDER_1,
  VENDOR_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import {
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.8 against a real PostgreSQL: the reference-data tables (hub, permission, role_bundle, role_bundle_grant,
 * fixed_permission_policy, setting, reason_code), read as `melarc_api_runtime` under each principal type and written, where a
 * constraint is under test, as the cluster administrator (a constraint binds a superuser too; row-level security does not).
 * Security test matrix Families F, K and S; SECURITY_DESIGN.md §13.10a, obligation 1, on the real tables.
 */

const TABLES = [
  'hub',
  'permission',
  'role_bundle',
  'role_bundle_grant',
  'fixed_permission_policy',
  'setting',
  'reason_code',
] as const;
/** The three tables whose content only a seed, a migration and the SLICE-009 edit change, under the exclusive policy lock. */
const POLICY_TABLES = ['role_bundle', 'role_bundle_grant', 'fixed_permission_policy'] as const;

const BUNDLE = '0b1b2c3d-0000-4000-8000-000000000001';
const BUNDLE_2 = '0b1b2c3d-0000-4000-8000-000000000002';
const HUB_ROW = '0a0a0a0a-0000-4000-8000-000000000001';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await withClient(database.urlFor('postgres'), async (admin) => {
    await admin.query(`insert into hub (id, name) values ('${HUB_ROW}', 'Test hub')`);
    await admin.query(
      `insert into permission (key, domain) values ('pickup.request.create', 'pickup'), ('pickup.read', 'pickup')`,
    );
    await admin.query(
      `insert into role_bundle (id, name, audience, privileged) values ('${BUNDLE}', 'Ops Staff', 'STAFF', false)`,
    );
    await admin.query(
      `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
       values ('${BUNDLE}', 'pickup.read', 'own', 'any', 'A')`,
    );
    await admin.query(`insert into fixed_permission_policy (principal_type) values ('VENDOR')`);
    await admin.query(
      `insert into setting (key, scope, value_type, value, unit, description)
       values ('transaction_currency', 'COMPANY', 'string', '"GHS"', 'ISO 4217', 'The launch currency')`,
    );
    await admin.query(
      `insert into reason_code (code, domain, label, attribution, permitted_operations)
       values ('SESSION_SECURITY_CONCERN', 'SESSION_REVOCATION', 'Session security concern', 'MELARC', array['revokeSession'])`,
    );
  });
});

afterAll(async () => {
  await database.drop();
});

const countOf = async (tx: DatabaseTransaction, table: string): Promise<number> =>
  Number((await tx.execute(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n);

/** The SQLSTATE a statement ends with inside a transaction of the runtime login under `context`, or `undefined` if it ran. */
async function runtimeState(
  context: SecurityContext,
  statement: string,
): Promise<string | undefined> {
  const { service, close } = buildService(database);
  try {
    await service.transactionWithContext(context, async (tx) => {
      await tx.execute(sql.raw(statement));
    });
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code;
  } finally {
    await close();
  }
}

describe('who reads the reference tables (data-scope-registry.md §4.1; Family S)', () => {
  const contexts: [string, SecurityContext, number][] = [
    ['a staff principal (global)', staffContext([HUB_A]), 1],
    ['the authentication capability', systemContext('authentication'), 1],
    ['a vendor (DENY)', vendorContext(VENDOR_1), 0],
    ['a rider (DENY)', riderContext(RIDER_1), 0],
    ['a SYSTEM context under another capability', systemContext('rate_limit'), 0],
  ];

  // Break caught: a table readable to a principal the registry denies (a Vendor reading the permission catalogue or a bundle), or
  // unreadable to one it admits (the authentication capability building a session snapshot), or a policy that reads `SYSTEM` alone.
  it.each(contexts)('%s reads each table', async (_label, context, expected) => {
    const { service, close } = buildService(database);
    try {
      const seen = await service.transactionWithContext(context, async (tx) => {
        const counts: Record<string, number> = {};
        for (const table of TABLES) counts[table] = await countOf(tx, table);
        return counts;
      });
      // The permission table holds two rows; every other table one.
      for (const table of TABLES) {
        expect(seen[table], table).toBe(expected === 0 ? 0 : table === 'permission' ? 2 : 1);
      }
    } finally {
      await close();
    }
  });

  // Break caught: a policy that answers a request with no context. The transaction has no principal, so every branch is false.
  it('reads nothing with no context at all', async () => {
    const { Client } = await import('pg');
    const { postgresConnectionSettings } =
      await import('../../src/platform/database/postgres-url.js');
    const client = new Client({ ...postgresConnectionSettings(database.urlFor(API_RUNTIME_ROLE)) });
    client.on('error', () => undefined);
    await client.connect();
    try {
      for (const table of TABLES) {
        expect(await scalar<number>(client, `select count(*)::int from ${table}`), table).toBe(0);
      }
    } finally {
      await client.end();
    }
  });
});

describe('who writes them: nobody yet (grants arrive with the first operation that writes a table)', () => {
  const statements: Record<
    (typeof TABLES)[number],
    { insert: string; update: string; remove: string }
  > = {
    hub: {
      insert: `insert into hub (id, name) values (gen_random_uuid(), 'Another')`,
      update: `update hub set name = 'Renamed'`,
      remove: 'delete from hub',
    },
    permission: {
      insert: `insert into permission (key, domain) values ('pickup.cancel', 'pickup')`,
      update: `update permission set domain = 'pickup'`,
      remove: 'delete from permission',
    },
    role_bundle: {
      insert: `insert into role_bundle (id, name, audience, privileged) values (gen_random_uuid(), 'X', 'STAFF', false)`,
      update: 'update role_bundle set revision = revision + 1',
      remove: 'delete from role_bundle',
    },
    role_bundle_grant: {
      insert: `insert into role_bundle_grant values ('${BUNDLE}', 'pickup.request.create', 'own', 'any', 'A')`,
      update: `update role_bundle_grant set tier = 'P'`,
      remove: 'delete from role_bundle_grant',
    },
    fixed_permission_policy: {
      insert: `insert into fixed_permission_policy (principal_type) values ('RIDER')`,
      update: 'update fixed_permission_policy set revision = revision + 1',
      remove: 'delete from fixed_permission_policy',
    },
    setting: {
      insert: `insert into setting (key, scope, value_type, value, unit, description) values ('k', 'PLATFORM', 'integer', '1', 'minutes', 'd')`,
      update: `update setting set value = '2'`,
      remove: 'delete from setting',
    },
    reason_code: {
      insert: `insert into reason_code (code, domain, label, attribution, permitted_operations) values ('X', 'STAFF_MFA_RESET', 'X', 'MELARC', array['resetStaffMfa'])`,
      update: `update reason_code set active = false`,
      remove: 'delete from reason_code',
    },
  };

  // Break caught: a grant that lets the API write a seed-only table (so that no context, the authentication capability included, reaches it).
  // The refusal is the database's, at the privilege: "permission denied" (42501), whatever the row-level policy says.
  it.each(
    TABLES.flatMap((table) =>
      (['insert', 'update', 'remove'] as const).map((verb) => [table, verb] as const),
    ),
  )(
    'refuses %s %s as the runtime login, under a staff context and under the authentication capability',
    async (table, verb) => {
      const statement = statements[table][verb];
      expect(await runtimeState(staffContext([HUB_A], 'ALL'), statement)).toBe('42501');
      expect(await runtimeState(systemContext('authentication'), statement)).toBe('42501');
    },
  );

  // Break caught (obligation 1, §13.10a): a row lock on a policy table, which PostgreSQL grants only with UPDATE.
  it.each(POLICY_TABLES)(
    'refuses a row lock on %s: FOR SHARE, FOR KEY SHARE, FOR UPDATE',
    async (table) => {
      for (const lock of ['for share', 'for key share', 'for update', 'for no key update']) {
        expect(
          await runtimeState(staffContext([HUB_A]), `select * from ${table} ${lock}`),
          `${table} ${lock}`,
        ).toBe('42501');
      }
    },
  );

  // S0.9 gave the provisioning login SELECT and INSERT on the seven tables (migration 0004); correction F02 took both back (migration
  // 0005): it reaches the tables only by the two seed functions, which run as the owner. Break caught: any privilege given back to it,
  // UPDATE, DELETE, TRUNCATE, REFERENCES or TRIGGER included, and any write given to the runtime or the base worker, at table or
  // column level.
  it('holds no write privilege on any of them for the runtime or worker, and the provisioning login no privilege at all, in the catalogue', async () => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      for (const role of [API_RUNTIME_ROLE, WORKER_RUNTIME_ROLE, PROVISIONING_ROLE]) {
        for (const table of TABLES) {
          for (const privilege of [
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'REFERENCES',
            'TRIGGER',
          ]) {
            expect(
              await scalar<boolean>(
                admin,
                `select has_table_privilege('${role}', 'public.${table}', '${privilege}')`,
              ),
              `${role} ${privilege} ${table}`,
            ).toBe(false);
            expect(
              await scalar<boolean>(
                admin,
                `select has_any_column_privilege('${role}', 'public.${table}', '${privilege === 'INSERT' ? 'INSERT' : 'UPDATE'}')`,
              ),
              `${role} column ${privilege} ${table}`,
            ).toBe(false);
          }
        }
      }
      // What the logins do hold: SELECT, on each of the seven, for the runtime (the API reads) and nobody else: the provisioning
      // login counts inside the initialization function and reads nothing, and the base worker reads none of them.
      for (const table of TABLES) {
        for (const [role, held] of [
          [API_RUNTIME_ROLE, true],
          [PROVISIONING_ROLE, false],
          [WORKER_RUNTIME_ROLE, false],
        ] as const) {
          expect(
            await scalar<boolean>(
              admin,
              `select has_table_privilege('${role}', 'public.${table}', 'SELECT')`,
            ),
            `${role} ${table}`,
          ).toBe(held);
        }
      }
    });
  });
});

describe('the advisory locks work beside the real policy tables (obligation 1, §13.10a)', () => {
  // Break caught: the toolkit unusable because a policy table needs a privilege the runtime does not hold. The locks are taken
  // first, then the policy rows are read, as a sign-in does.
  it('takes the bundle and fixed locks, then reads the content they protect', async () => {
    const { service, close } = buildService(database);
    try {
      const read = await service.transactionWithContext(
        systemContext('authentication'),
        async (tx) => {
          await acquirePolicyLocks(
            tx,
            planPolicyLocks([bundleLock(BUNDLE, 'shared'), fixedLock('VENDOR', 'shared')]),
          );
          return {
            revision: Number(
              (await tx.execute(sql`select revision from role_bundle where id = ${BUNDLE}`)).rows[0]
                ?.revision,
            ),
            grants: await countOf(tx, 'role_bundle_grant'),
            fixed: Number(
              (
                await tx.execute(
                  sql`select revision from fixed_permission_policy where principal_type = 'VENDOR'`,
                )
              ).rows[0]?.revision,
            ),
          };
        },
      );
      expect(read).toEqual({ revision: 1, grants: 1, fixed: 1 });
    } finally {
      await close();
    }
  });
});

describe('the constraints of the tables (Family F: the database refuses what the code must also refuse)', () => {
  const refused = async (statement: string): Promise<string | undefined> =>
    withClient(database.urlFor('postgres'), (admin) => sqlState(admin, statement));

  describe('role_bundle', () => {
    it.each([
      [
        'an audience that is not STAFF, RIDER or VENDOR',
        `insert into role_bundle (id, name, audience, privileged) values (gen_random_uuid(), 'a', 'ADMIN', false)`,
        '23514',
      ],
      [
        'a revision below 1',
        `insert into role_bundle (id, name, audience, privileged, revision) values (gen_random_uuid(), 'b', 'STAFF', false, 0)`,
        '23514',
      ],
      [
        'a floor above the revision',
        `insert into role_bundle (id, name, audience, privileged, revision, reduction_floor) values (gen_random_uuid(), 'c', 'STAFF', false, 1, 2)`,
        '23514',
      ],
      [
        'a floor below 1',
        `insert into role_bundle (id, name, audience, privileged, reduction_floor) values (gen_random_uuid(), 'd', 'STAFF', false, 0)`,
        '23514',
      ],
      [
        'a name already used',
        `insert into role_bundle (id, name, audience, privileged) values (gen_random_uuid(), 'Ops Staff', 'STAFF', false)`,
        '23505',
      ],
      [
        'no privileged flag',
        `insert into role_bundle (id, name, audience, privileged) values (gen_random_uuid(), 'e', 'STAFF', null)`,
        '23502',
      ],
      [
        'an empty name',
        `insert into role_bundle (id, name, audience, privileged) values (gen_random_uuid(), '', 'STAFF', false)`,
        '23514',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });

    it('starts a new bundle at revision 1 and floor 1', async () => {
      await withClient(database.urlFor('postgres'), async (admin) => {
        await admin.query(
          `insert into role_bundle (id, name, audience, privileged) values ('${BUNDLE_2}', 'Starts at one', 'STAFF', false)`,
        );
        const { rows } = await admin.query(
          `select revision, reduction_floor from role_bundle where id = '${BUNDLE_2}'`,
        );
        expect(rows[0]).toEqual({ revision: 1, reduction_floor: 1 });
      });
    });

    // Break caught: a counter written the way the contract forbids ("Revisions only increase, by one"; the floor moves only with a
    // reduction, and then to the new revision), by a login the grants do not stop: the owner, a migration, a mistaken seed. Each
    // case starts from a bundle of its own at the revision and floor named.
    describe('the two counters', () => {
      const bundles: number[] = [];
      const update = async (
        revision: number,
        floor: number,
        set: string,
      ): Promise<string | undefined> => {
        const id = `0b1b2c3d-0000-4000-8000-${String(100 + bundles.length).padStart(12, '0')}`;
        bundles.push(bundles.length);
        await withClient(database.urlFor('postgres'), (admin) =>
          admin.query(
            `insert into role_bundle (id, name, audience, privileged, revision, reduction_floor)
             values ('${id}', 'Counter ${id}', 'STAFF', false, ${String(revision)}, ${String(floor)})`,
          ),
        );
        return refused(`update role_bundle set ${set} where id = '${id}'`);
      };

      it('lets the revision rise by one, with the floor unchanged (an addition)', async () => {
        expect(await update(1, 1, 'revision = revision + 1')).toBeUndefined();
        expect(await update(4, 2, 'revision = revision + 1')).toBeUndefined();
      });

      it('lets the floor rise to the new revision together with it (a reduction)', async () => {
        expect(
          await update(1, 1, 'revision = revision + 1, reduction_floor = revision + 1'),
        ).toBeUndefined();
        expect(
          await update(5, 2, 'revision = revision + 1, reduction_floor = revision + 1'),
        ).toBeUndefined();
      });

      it.each([
        ['the revision by two', 1, 1, 'revision = revision + 2'],
        ['the revision down', 3, 1, 'revision = revision - 1'],
        ['the floor with no revision raise', 3, 1, 'reduction_floor = reduction_floor + 1'],
        [
          'the floor to a value below the new revision',
          3,
          1,
          'revision = revision + 1, reduction_floor = reduction_floor + 1',
        ],
        ['the floor down', 3, 3, 'reduction_floor = reduction_floor - 1'],
      ])('refuses %s', async (_label, revision, floor, set) => {
        expect(await update(revision, floor, set)).toBe('23514');
      });

      it('lets a name change with the counters alone', async () => {
        expect(await update(2, 1, `name = 'Renamed bundle'`)).toBeUndefined();
      });

      it('refuses a change of audience: a bundle is never moved between audiences', async () => {
        expect(await update(1, 1, `audience = 'RIDER'`)).toBe('23514');
      });

      // Break caught: the privileged flag, which decides who may approve (permissions.md section 5), changed with the revision
      // where it was: authorization content that changes without the primitive that raises the revision and ends nothing. A bundle's
      // id is the key of its policy lock and what a staff record refers to: it never changes.
      it('refuses a change of the privileged flag that does not raise the revision, and lets one that does', async () => {
        expect(await update(2, 1, 'privileged = not privileged')).toBe('23514');
        expect(
          await update(2, 1, 'privileged = not privileged, revision = revision + 1'),
        ).toBeUndefined();
      });

      it('refuses a change of the id of a bundle', async () => {
        expect(await update(1, 1, `id = '0b1b2c3d-0000-4000-8000-ffffffffffff'`)).toBe('23514');
      });
    });
  });

  describe('role_bundle_grant', () => {
    const grant = (columns: string) =>
      `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier) values (${columns})`;

    it.each([
      [
        'a hub scope that is not none, own or all',
        grant(`'${BUNDLE}', 'pickup.request.create', 'some', 'any', 'A'`),
        '23514',
      ],
      [
        'an ownership scope that is not own, assigned or any',
        grant(`'${BUNDLE}', 'pickup.request.create', 'own', 'mine', 'A'`),
        '23514',
      ],
      [
        'a tier that is not A, S or P',
        grant(`'${BUNDLE}', 'pickup.request.create', 'own', 'any', 'X'`),
        '23514',
      ],
      [
        'a bundle that does not exist',
        grant(`gen_random_uuid(), 'pickup.request.create', 'own', 'any', 'A'`),
        '23503',
      ],
      [
        'a permission that is not in the catalogue',
        grant(`'${BUNDLE}', 'pickup.invented', 'own', 'any', 'A'`),
        '23503',
      ],
      [
        'the same permission twice in one bundle',
        grant(`'${BUNDLE}', 'pickup.read', 'all', 'any', 'S'`),
        '23505',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });

    // Break caught: a bundle removed under its grants (cascade), which would silently drop authority and history.
    it('refuses to remove a bundle that has grants, and a permission that a grant uses', async () => {
      // RESTRICT is reported as restrict_violation (23001), where NO ACTION would be a foreign-key violation (23503).
      expect(await refused(`delete from role_bundle where id = '${BUNDLE}'`)).toBe('23001');
      expect(await refused(`delete from permission where key = 'pickup.read'`)).toBe('23001');
    });
  });

  describe('fixed_permission_policy', () => {
    it.each([
      [
        'a principal type other than VENDOR and RIDER',
        `insert into fixed_permission_policy (principal_type) values ('STAFF')`,
        '23514',
      ],
      [
        'a minimum above the revision',
        `insert into fixed_permission_policy (principal_type, revision, minimum_revision) values ('RIDER', 1, 2)`,
        '23514',
      ],
      [
        'a revision below 1',
        `insert into fixed_permission_policy (principal_type, revision) values ('RIDER', 0)`,
        '23514',
      ],
      [
        'a second row for a type',
        `insert into fixed_permission_policy (principal_type) values ('VENDOR')`,
        '23505',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });

    it('guards the revision and the minimum like a bundle’s revision and floor', async () => {
      expect(await refused(`update fixed_permission_policy set revision = revision + 2`)).toBe(
        '23514',
      );
      expect(
        await refused(`update fixed_permission_policy set minimum_revision = minimum_revision + 1`),
      ).toBe('23514');
      expect(
        await refused(
          `update fixed_permission_policy set revision = revision + 1, minimum_revision = revision + 1`,
        ),
      ).toBeUndefined();
    });
  });

  describe('permission', () => {
    it.each([
      [
        'a key in capitals',
        `insert into permission (key, domain) values ('Pickup.Create', 'pickup')`,
        '23514',
      ],
      [
        'a key with one part',
        `insert into permission (key, domain) values ('pickup', 'pickup')`,
        '23514',
      ],
      [
        'a key with four parts',
        `insert into permission (key, domain) values ('pickup.a.b.c', 'pickup')`,
        '23514',
      ],
      [
        'a domain that is not in the closed list',
        `insert into permission (key, domain) values ('widget.make', 'widget')`,
        '23514',
      ],
      [
        'a domain that is not the key’s first part',
        `insert into permission (key, domain) values ('hub.read', 'pickup')`,
        '23514',
      ],
      [
        'a key already in the catalogue',
        `insert into permission (key, domain) values ('pickup.read', 'pickup')`,
        '23505',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });
  });

  describe('reason_code', () => {
    const reason = (columns: string, values: string) =>
      `insert into reason_code (${columns}) values (${values})`;
    const base = `label, attribution`;

    it.each([
      [
        'a domain that is not one of the ten',
        reason(`code, domain, ${base}`, `'C1', 'OTHER', 'x', 'MELARC'`),
        '23514',
      ],
      [
        'an attribution that is not CUSTOMER, MELARC or EXTERNAL',
        reason(`code, domain, ${base}`, `'C2', 'DELIVERY_FAILURE', 'x', 'NOBODY'`),
        '23514',
      ],
      [
        'a recipient-contact reason with no checkpoints',
        reason(`code, domain, ${base}`, `'C3', 'RECIPIENT_CONTACT', 'x', 'CUSTOMER'`),
        '23514',
      ],
      [
        'a recipient-contact reason with an empty checkpoint list',
        reason(
          `code, domain, ${base}, valid_checkpoints`,
          `'C4', 'RECIPIENT_CONTACT', 'x', 'CUSTOMER', array[]::text[]`,
        ),
        '23514',
      ],
      [
        'a checkpoint that is not PRE_DISPATCH, NEXT_STOP or DOORSTEP',
        reason(
          `code, domain, ${base}, valid_checkpoints`,
          `'C5', 'RECIPIENT_CONTACT', 'x', 'CUSTOMER', array['LATER']`,
        ),
        '23514',
      ],
      [
        'checkpoints on a reason of another domain',
        reason(
          `code, domain, ${base}, valid_checkpoints`,
          `'C6', 'DELIVERY_FAILURE', 'x', 'CUSTOMER', array['DOORSTEP']`,
        ),
        '23514',
      ],
      [
        'an identity reason with no permitted operations',
        reason(`code, domain, ${base}`, `'C7', 'SESSION_REVOCATION', 'x', 'MELARC'`),
        '23514',
      ],
      [
        'an identity reason whose permitted operations hold a NULL',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C7B', 'SESSION_REVOCATION', 'x', 'MELARC', array['revokeSession', null]`,
        ),
        '23514',
      ],
      [
        'an identity reason with an empty list of permitted operations',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C8', 'SESSION_REVOCATION', 'x', 'MELARC', array[]::text[]`,
        ),
        '23514',
      ],
      [
        'permitted operations on a workflow reason',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C9', 'DELIVERY_FAILURE', 'x', 'CUSTOMER', array['revokeSession']`,
        ),
        '23514',
      ],
      [
        'a permitted operation that is not an operation id or an operation id with a branch',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C10', 'SESSION_REVOCATION', 'x', 'MELARC', array['revoke session']`,
        ),
        '23514',
      ],
      [
        'a branch in lower case',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C11', 'SESSION_REVOCATION', 'x', 'MELARC', array['revokeSession#branch']`,
        ),
        '23514',
      ],
      [
        'a code that is already used',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'SESSION_SECURITY_CONCERN', 'SESSION_REVOCATION', 'x', 'MELARC', array['revokeSession']`,
        ),
        '23505',
      ],
      [
        'an empty label',
        reason(
          `code, domain, ${base}, permitted_operations`,
          `'C12', 'SESSION_REVOCATION', '', 'MELARC', array['revokeSession']`,
        ),
        '23514',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });

    it('accepts a branch-qualified permitted operation and a recipient-contact reason with its checkpoints', async () => {
      expect(
        await refused(
          reason(
            `code, domain, ${base}, permitted_operations`,
            `'STAFF_DETAILS_INCORRECT', 'STAFF_PROFILE_REJECTION', 'x', 'MELARC', array['approveStaffIdentity#APPROVAL_REJECTED']`,
          ),
        ),
      ).toBeUndefined();
      expect(
        await refused(
          reason(
            `code, domain, ${base}, valid_checkpoints`,
            `'NO_ANSWER', 'RECIPIENT_CONTACT', 'No answer', 'CUSTOMER', array['PRE_DISPATCH','DOORSTEP']`,
          ),
        ),
      ).toBeUndefined();
    });

    it('defaults the flags the way the contract does: active, and nothing required', async () => {
      await withClient(database.urlFor('postgres'), async (admin) => {
        const { rows } = await admin.query(
          `select active, requires_note, requires_photo, requires_contact_attempt, requires_approval, consumes_delivery_attempt,
                  requires_ops_review, requires_escalation
             from reason_code where code = 'SESSION_SECURITY_CONCERN'`,
        );
        expect(rows[0]).toEqual({
          active: true,
          requires_note: false,
          requires_photo: false,
          requires_contact_attempt: false,
          requires_approval: false,
          consumes_delivery_attempt: false,
          requires_ops_review: false,
          requires_escalation: false,
        });
      });
    });
  });

  describe('setting and hub', () => {
    it.each([
      [
        'a setting scope other than COMPANY and PLATFORM',
        `insert into setting (key, scope, value_type, value, unit, description) values ('s1', 'HUB', 'integer', '1', 'u', 'd')`,
        '23514',
      ],
      [
        'a value type that is not known',
        `insert into setting (key, scope, value_type, value, unit, description) values ('s2', 'PLATFORM', 'blob', '1', 'u', 'd')`,
        '23514',
      ],
      [
        'a setting with no value (an unset value is not a seeded one)',
        `insert into setting (key, scope, value_type, value, unit, description) values ('s3', 'PLATFORM', 'integer', null, 'u', 'd')`,
        '23502',
      ],
      [
        'a setting key with a space in it',
        `insert into setting (key, scope, value_type, value, unit, description) values ('bad key', 'PLATFORM', 'integer', '1', 'u', 'd')`,
        '23514',
      ],
      [
        'a setting key twice',
        `insert into setting (key, scope, value_type, value, unit, description) values ('transaction_currency', 'COMPANY', 'string', '"GHS"', 'u', 'd')`,
        '23505',
      ],
      ['a hub with no name', `insert into hub (id, name) values (gen_random_uuid(), '')`, '23514'],
      [
        'a hub name already used',
        `insert into hub (id, name) values (gen_random_uuid(), 'Test hub')`,
        '23505',
      ],
    ])('refuses %s', async (_label, statement, state) => {
      expect(await refused(statement)).toBe(state);
    });
  });
});

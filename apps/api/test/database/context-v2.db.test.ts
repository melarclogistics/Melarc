import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { createPool } from '../../src/platform/database/database.module.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../src/platform/database/database.service.js';
import {
  SecurityContextError,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import { catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { lintMigrationSql } from '../../src/tools/database/migration-lint.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  applyContextFixture,
  applyFixture,
  HUB_A,
  PRINCIPAL_1,
  riderContext,
  RIDER_1,
  seedContextRecords,
  seedNotes,
  staffContext,
  systemContext,
  vendorContext,
  VENDOR_1,
} from './support/rls-fixture.js';
import { databaseRuntime } from './support/runtime.js';
import {
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/** SQLSTATE 42501: insufficient_privilege, which is also what a row-level-security violation raises. */
const REFUSED = '42501';
/** SQLSTATE 22P02: invalid_text_representation, which a malformed uuid raises when it is cast. */
const MALFORMED = '22P02';

let database: TestDatabase;
let pool: pg.Pool;
let service: DatabaseService;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  await seedNotes(database);
  await seedContextRecords(database);
  pool = createPool({
    url: database.urlFor(API_RUNTIME_ROLE),
    poolMax: 1,
    deadlines: INERT_DEADLINES,
  });
  service = new DatabaseService(
    pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    databaseRuntime(database.urlFor(API_RUNTIME_ROLE), 1),
  );
});

afterAll(async () => {
  await service.close();
  await database.drop();
});

/**
 * A direct connection as the runtime login, with settings made for the whole session by hand: what an attacker
 * running as the API, or a test that corrupts a setting, does. It bypasses the application's validation on purpose.
 */
async function direct<T>(
  settings: Readonly<Record<string, string>>,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(database.urlFor(API_RUNTIME_ROLE), async (client) => {
    for (const [name, value] of Object.entries(settings)) {
      await client.query('select set_config($1, $2, false)', [name, value]);
    }
    return work(client);
  });
}

const rowsOf = async (client: pg.Client, statement: string): Promise<unknown[]> =>
  (await client.query(statement)).rows as unknown[];

describe('the accessors of SecurityContext v2, read as the runtime login', () => {
  // Control for everything below: a missing setting is a denying value and not an error (SECURITY_DESIGN.md
  // §14.4: `current_setting(name, true)` returns NULL instead of raising).
  it('answers a denying value when the setting was never made', async () => {
    await direct({}, async (client) => {
      expect(await scalar(client, 'select melarc.task_capability()')).toBe('NONE');
      expect(await scalar(client, 'select melarc.scope_probe_id()')).toBeNull();
      expect(await scalar(client, 'select melarc.current_principal_id()')).toBeNull();
    });
  });

  // Break caught: an empty setting, which is what a reverted transaction-local one reads as, being taken for a
  // value. It must read as unset.
  it('reads an empty setting as unset', async () => {
    await direct(
      {
        'melarc.task_capability': '',
        'melarc.scope_probe_id': '',
        'melarc.principal_id': '',
      },
      async (client) => {
        expect(await scalar(client, 'select melarc.task_capability()')).toBe('NONE');
        expect(await scalar(client, 'select melarc.scope_probe_id()')).toBeNull();
        expect(await scalar(client, 'select melarc.current_principal_id()')).toBeNull();
      },
    );
  });

  it('reads the setting it is given', async () => {
    await direct(
      {
        'melarc.task_capability': 'authentication',
        'melarc.scope_probe_id': HUB_A,
        'melarc.principal_id': PRINCIPAL_1,
      },
      async (client) => {
        expect(await scalar(client, 'select melarc.task_capability()')).toBe('authentication');
        expect(await scalar(client, 'select melarc.scope_probe_id()')).toBe(HUB_A);
        expect(await scalar(client, 'select melarc.current_principal_id()')).toBe(PRINCIPAL_1);
      },
    );
  });

  // Break caught: an accessor declared VOLATILE, which a planner may not fold and which costs a call per row, or
  // IMMUTABLE, which would freeze the first context seen in a cached plan.
  it('declares every accessor STABLE, owned by the owner role and callable only by named roles', async () => {
    const rows = await withClient(database.urlFor('postgres'), async (client) =>
      rowsOf(
        client,
        `select p.proname, p.provolatile, pg_get_userbyid(p.proowner) as owner,
                has_function_privilege('public', p.oid, 'EXECUTE') as public_can,
                has_function_privilege('${API_RUNTIME_ROLE}', p.oid, 'EXECUTE') as runtime_can
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'melarc'
            and p.proname in ('task_capability', 'scope_probe_id', 'current_principal_id')
          order by p.proname`,
      ),
    );
    expect(rows).toEqual([
      {
        proname: 'current_principal_id',
        provolatile: 's',
        owner: 'melarc_owner',
        public_can: false,
        runtime_can: true,
      },
      {
        proname: 'scope_probe_id',
        provolatile: 's',
        owner: 'melarc_owner',
        public_can: false,
        runtime_can: true,
      },
      {
        proname: 'task_capability',
        provolatile: 's',
        owner: 'melarc_owner',
        public_can: false,
        runtime_can: true,
      },
    ]);
  });
});

describe('a malformed setting made by hand on a direct connection (GBT-B11)', () => {
  // GBT-B11. Break caught: a malformed value being turned into a denial by a NULL, which hides that the policy
  // never ran on it; or into a row. The cast raises and the statement aborts: fail-closed by abort, which is a
  // different code path from a policy returning false (SECURITY_DESIGN.md §14.3 and §14.4a).
  it.each([
    [
      'principal id',
      { 'melarc.principal_type': 'STAFF', 'melarc.principal_id': 'not-a-uuid' },
      'owned_records',
    ],
    [
      'principal id, padded',
      { 'melarc.principal_type': 'STAFF', 'melarc.principal_id': ` ${PRINCIPAL_1}` },
      'owned_records',
    ],
    [
      'vendor organization id',
      { 'melarc.principal_type': 'VENDOR', 'melarc.vendor_organization_id': 'not-a-uuid' },
      'notes',
    ],
    ['rider id', { 'melarc.principal_type': 'RIDER', 'melarc.rider_id': 'not-a-uuid' }, 'notes'],
    [
      'hub set',
      {
        'melarc.principal_type': 'STAFF',
        'melarc.hub_scope_mode': 'SET',
        'melarc.authorized_hub_ids': `${HUB_A},not-a-uuid`,
      },
      'notes',
    ],
    [
      'scope probe id',
      {
        'melarc.principal_type': 'STAFF',
        'melarc.hub_scope_mode': 'SET',
        'melarc.authorized_hub_ids': HUB_A,
        'melarc.scope_probe_id': 'not-a-uuid',
      },
      'hub_records',
    ],
  ])(
    'discloses no row and aborts the statement for a malformed %s',
    async (_label, settings, table) => {
      await direct(settings, async (client) => {
        expect(await sqlState(client, `select * from rls_fixture.${table}`)).toBe(MALFORMED);
      });
    },
  );

  // Break caught: the control missing. An empty setting is the "missing" path: NULL, a denial, no error and no
  // row. It is the other code path of §14.4a, and the table has rows to show.
  it('answers an empty principal id with no row and no error, which is a different path', async () => {
    await direct(
      { 'melarc.principal_type': 'STAFF', 'melarc.principal_id': '' },
      async (client) => {
        expect(await rowsOf(client, 'select * from rls_fixture.owned_records')).toEqual([]);
      },
    );
  });

  it('shows the principal its own row when the setting is well formed', async () => {
    await direct(
      { 'melarc.principal_type': 'STAFF', 'melarc.principal_id': PRINCIPAL_1 },
      async (client) => {
        const rows = await rowsOf(client, 'select body from rls_fixture.owned_records');
        expect(rows).toEqual([{ body: 'owned by principal 1' }]);
      },
    );
  });
});

describe('a malformed principal id on the application path (GBT-B10)', () => {
  const malformed = (context: SecurityContext): SecurityContext => ({
    ...context,
    principalId: 'not-a-uuid',
  });

  // GBT-B10. Break caught: a context failing validation but still opening a transaction, or reaching the pool,
  // or reaching the work; or the refusal being a query that returned zero rows. Nothing is taken from the pool,
  // nothing is sent, the protected statement never runs, and the answer is an error.
  it.each([
    ['staff', staffContext([HUB_A])],
    ['vendor', vendorContext(VENDOR_1)],
    ['rider', riderContext(RIDER_1)],
    ['system', systemContext('authentication')],
  ])('refuses a %s context before any transaction opens', async (_label, context) => {
    const connect = vi.spyOn(pool, 'connect');
    const query = vi.spyOn(pool, 'query');
    const work = vi.fn((tx: DatabaseTransaction) =>
      tx.execute(sql`select * from rls_fixture.notes`),
    );
    try {
      const failure = await service
        .transactionWithContext(malformed(context), work)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SecurityContextError);
      expect((failure as SecurityContextError).fields).toEqual(['principalId']);
      expect(work).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      query.mockRestore();
    }
  });
});

describe('a SYSTEM context under a capability (Family E)', () => {
  const bodies = (rows: { rows: unknown[] }) =>
    (rows.rows as { body: string }[]).map((row) => row.body).sort();

  // Control for the denials below: the capability that a table's policy names does reach it, so a refusal of
  // another capability is the policy's and not a table nobody can read.
  it('reaches the table whose policy names its capability', async () => {
    const result = await service.transactionWithContext(systemContext('authentication'), (tx) =>
      tx.execute(sql`select body from rls_fixture.system_records`),
    );
    expect(bodies(result)).toEqual(['system record one', 'system record two']);
  });

  // GBT-E3. Break caught: a SYSTEM branch that tests SYSTEM and not the capability, so any task reads any
  // SYSTEM table. A capability the table does not name sees nothing and writes nothing.
  it('is refused by a table whose policy names another capability, for reads and for writes (GBT-E3)', async () => {
    const read = await service.transactionWithContext(systemContext('rate_limit'), (tx) =>
      tx.execute(sql`select body from rls_fixture.system_records`),
    );
    expect(read.rows).toEqual([]);

    const write = await service
      .transactionWithContext(systemContext('rate_limit'), (tx) =>
        tx.execute(sql`insert into rls_fixture.system_records (body) values ('smuggled')`),
      )
      .catch((error: unknown) => error as { cause?: { code?: string }; code?: string });
    expect((write as { cause?: { code?: string } }).cause?.code).toBe(REFUSED);
  });

  // GBT-E4. Break caught: SYSTEM with no capability being treated as all capabilities. The accessor answers
  // NONE and no SYSTEM branch is true. Reached directly, because the application refuses to build such a context.
  it('sees nothing when it holds no capability (GBT-E4)', async () => {
    await direct(
      { 'melarc.principal_type': 'SYSTEM', 'melarc.surface': 'SYSTEM' },
      async (client) => {
        expect(await rowsOf(client, 'select * from rls_fixture.system_records')).toEqual([]);
        expect(await rowsOf(client, 'select * from rls_fixture.seeded_records')).toEqual([]);
      },
    );
  });

  // GBT-E2. Break caught: a SYSTEM branch honouring the hub scope, so a task that sets ALL by hand reads across
  // hubs. SYSTEM has no staff ALL branch: the setting means nothing to it.
  it('gains nothing by setting an all-hub scope by hand (GBT-E2)', async () => {
    await direct(
      {
        'melarc.principal_type': 'SYSTEM',
        'melarc.surface': 'SYSTEM',
        'melarc.task_capability': 'authentication',
        'melarc.hub_scope_mode': 'ALL',
      },
      async (client) => {
        expect(await rowsOf(client, 'select * from rls_fixture.hub_records')).toEqual([]);
        expect(await rowsOf(client, 'select * from rls_fixture.notes')).toEqual([]);
      },
    );
  });

  // GBT-E5 (the row-level-security half). Break caught: the authentication capability reaching a business table.
  // None of the business-shaped fixtures has a branch for it, so each answers nothing.
  it('reads no business table under the authentication capability (GBT-E5)', async () => {
    const seen = await service.transactionWithContext(
      systemContext('authentication'),
      async (tx) => ({
        notes: (await tx.execute(sql`select * from rls_fixture.notes`)).rows,
        hubRecords: (await tx.execute(sql`select * from rls_fixture.hub_records`)).rows,
        owned: (await tx.execute(sql`select * from rls_fixture.owned_records`)).rows,
      }),
    );
    expect(seen).toEqual({ notes: [], hubRecords: [], owned: [] });
  });
});

/**
 * Why the capability test must be mandatory (review of S0.4 and S0.5). A policy whose SYSTEM arm only mentions the capability
 * admits a context under any other capability, and the database accepts it: nothing about the statement is wrong. The table
 * below is written as a migration might by mistake (the negation of the test), applied as the migration identity, and read under
 * the runtime login with a capability the arm does not name. The supported template, in `system_records`, refuses the same
 * context; the lint and the catalogue refuse the unsupported one.
 */
describe('a SYSTEM arm whose capability test is not mandatory', () => {
  const NEGATED = `
    CREATE TABLE rls_fixture.negated_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL);
    ALTER TABLE rls_fixture.negated_records OWNER TO melarc_owner;
    ALTER TABLE rls_fixture.negated_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_fixture.negated_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY negated_records_scope ON rls_fixture.negated_records
      USING (CASE melarc.principal_type() WHEN 'SYSTEM' THEN NOT (melarc.task_capability() = 'seed') ELSE false END);
    GRANT SELECT ON rls_fixture.negated_records TO melarc_api_runtime;
  `;

  // The second review: AND binds tighter than OR, so `(test AND false OR true) AND true` is true for every capability and the test
  // inside it is not mandatory. The expression is the one of the review, written as a migration might by mistake.
  const DISJUNCT = `
    CREATE TABLE rls_fixture.disjunct_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), body text NOT NULL);
    ALTER TABLE rls_fixture.disjunct_records OWNER TO melarc_owner;
    ALTER TABLE rls_fixture.disjunct_records ENABLE ROW LEVEL SECURITY;
    ALTER TABLE rls_fixture.disjunct_records FORCE ROW LEVEL SECURITY;
    CREATE POLICY disjunct_records_scope ON rls_fixture.disjunct_records
      USING (
        CASE melarc.principal_type()
          WHEN 'SYSTEM' THEN (melarc.task_capability() = 'seed' AND false OR true) AND true
          ELSE false
        END
      );
    GRANT SELECT ON rls_fixture.disjunct_records TO melarc_api_runtime;
  `;

  beforeAll(async () => {
    await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(NEGATED));
    await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(DISJUNCT));
    await withClient(database.urlFor('postgres'), async (client) => {
      await client.query("insert into rls_fixture.negated_records (body) values ('reached')");
      await client.query("insert into rls_fixture.disjunct_records (body) values ('reached too')");
    });
  });

  // The demonstration of the second review: every capability the API can open reads the table, though the policy names one
  // that the API cannot open at all. The expression looks like a capability test, and the database accepts it.
  it.each(['authentication', 'rate_limit'] as const)(
    'admits a context under %s to a table whose test is inside a disjunction that is true anyway',
    async (capability) => {
      const result = await service.transactionWithContext(systemContext(capability), (tx) =>
        tx.execute(sql`select body from rls_fixture.disjunct_records`),
      );
      expect(result.rows).toEqual([{ body: 'reached too' }]);
    },
  );

  it('refuses that policy in the migration lint, as the database prints it back, and in the catalogue', async () => {
    expect(lintMigrationSql(DISJUNCT)).toEqual([
      expect.stringContaining('does not require a positive capability test'),
    ]);
    const printed = await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<{ expr: string }>(
        "select pg_get_expr(polqual, polrelid) as expr from pg_policy where polname = 'disjunct_records_scope'",
      );
      return rows[0]?.expr ?? '';
    });
    // The database keeps the grouping it parsed: AND inside, then the OR, then the outer AND.
    expect(printed).toMatch(/\(\(melarc\.task_capability\(\) = 'seed'::text\) AND false\) OR true/);
    const violations = await withClient(database.urlFor('postgres'), (client) =>
      catalogViolations(client),
    );
    expect(violations).toContainEqual(
      expect.stringContaining('policy disjunct_records_scope on rls_fixture.disjunct_records'),
    );
  });

  // The demonstration: a context under `rate_limit`, which the policy was meant to refuse, reads the table.
  it('admits a context under a capability that the policy was meant to refuse', async () => {
    const result = await service.transactionWithContext(systemContext('rate_limit'), (tx) =>
      tx.execute(sql`select body from rls_fixture.negated_records`),
    );
    expect(result.rows).toEqual([{ body: 'reached' }]);
  });

  it('is refused by the migration lint and by the catalogue check, which see what the database holds', async () => {
    expect(lintMigrationSql(NEGATED)).toEqual([
      expect.stringContaining('does not require a positive capability test'),
    ]);
    const violations = await withClient(database.urlFor('postgres'), (client) =>
      catalogViolations(client),
    );
    expect(violations).toContainEqual(
      expect.stringContaining('policy negated_records_scope on rls_fixture.negated_records'),
    );
  });

  // Control: the supported structure refuses the same context, so the difference above is the policy's.
  it('is not what the supported template does with the same context', async () => {
    const result = await service.transactionWithContext(systemContext('rate_limit'), (tx) =>
      tx.execute(sql`select body from rls_fixture.system_records`),
    );
    expect(result.rows).toEqual([]);
  });
});

describe('a capability that belongs to another identity, opened over the API connection', () => {
  // Break caught: the API runtime opening the provisioning or the worker capability through the service. The label
  // is narrowed to the identity that holds its grants (SECURITY_DESIGN.md §14.1b), and the refusal comes from what
  // the database reports the connection to be, before the work runs.
  it.each(['seed', 'bootstrap', 'credential_delivery'] as const)(
    'refuses %s before the work runs, and leaves the connection usable',
    async (taskCapability) => {
      const work = vi.fn((tx: DatabaseTransaction) => tx.execute(sql`select 1`));

      const failure = await service
        .transactionWithContext(systemContext(taskCapability), work)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SecurityContextError);
      expect((failure as SecurityContextError).fields).toEqual(['taskCapability']);
      expect(work).not.toHaveBeenCalled();
      // The pool has one connection: it is back, and it answers the next request as that request's context.
      const next = await service.transactionWithContext(staffContext([HUB_A]), (tx) =>
        tx.execute(
          sql`select melarc.principal_type() as type, melarc.task_capability() as capability`,
        ),
      );
      expect(next.rows).toEqual([{ type: 'STAFF', capability: 'NONE' }]);
      expect(pool.totalCount).toBe(1);
    },
  );
});

describe('a table only a seed writes (GBT-E6)', () => {
  // The write grant is given to the real provisioning identity for the duration of one test, by the administrator, as
  // the migration that creates a real seed-only table will give it; the API runtime is given nothing.
  const grantInsertToProvisioning = (statement: 'grant' | 'revoke') =>
    withClient(database.urlFor('postgres'), async (client) => {
      // The schema of the fixture is granted to the runtime only, so the provisioning identity is given the use of it
      // together with the write, as a migration that creates a seed-only table would give both.
      if (statement === 'grant') {
        await client.query(`grant usage on schema rls_fixture to ${PROVISIONING_ROLE}`);
        await client.query(`grant insert on rls_fixture.seeded_records to ${PROVISIONING_ROLE}`);
      } else {
        await client.query(`revoke insert on rls_fixture.seeded_records from ${PROVISIONING_ROLE}`);
        await client.query(`revoke usage on schema rls_fixture from ${PROVISIONING_ROLE}`);
      }
    });

  const SEED_LABEL = {
    'melarc.principal_type': 'SYSTEM',
    'melarc.task_capability': 'seed',
  } as const;
  const INSERT = "insert into rls_fixture.seeded_records (body) values ('from the label')";

  // GBT-E6. Break caught: the label being the barrier. The runtime login sets the seed capability by hand, the
  // policy admits it, and the insert is still refused because the runtime holds no write grant on the table. The
  // message names the privilege, not a policy.
  it('refuses the API runtime that asserts the seed label, by grant and not by policy (GBT-E6)', async () => {
    await direct(SEED_LABEL, async (client) => {
      const failure = await client
        .query(INSERT)
        .catch((error: unknown) => error as pg.DatabaseError);
      expect((failure as pg.DatabaseError).code).toBe(REFUSED);
      expect((failure as pg.DatabaseError).message).toMatch(
        /permission denied for table seeded_records/,
      );
    });
    const count = await withClient(database.urlFor('postgres'), (client) =>
      scalar<string>(client, 'select count(*) from rls_fixture.seeded_records'),
    );
    expect(count).toBe('1');
  });

  // Control for the test above. The label is admitted by the policy: the runtime reads the seeded row under it.
  it('shows that the policy admits the label, so that the refusal above is the grant', async () => {
    await direct(SEED_LABEL, async (client) => {
      expect(await rowsOf(client, 'select body from rls_fixture.seeded_records')).toEqual([
        { body: 'seeded row' },
      ]);
    });
  });

  // Control: the identity that holds the write grant, the real provisioning login, writes under the same label.
  // Without it, the refusal could be a table nobody can write.
  it('lets the provisioning identity, once it holds the write grant, write under the same label', async () => {
    await grantInsertToProvisioning('grant');
    try {
      await withClient(database.urlFor(PROVISIONING_ROLE), async (client) => {
        expect(await scalar(client, 'select current_user')).toBe(PROVISIONING_ROLE);
        for (const [name, value] of Object.entries(SEED_LABEL)) {
          await client.query('select set_config($1, $2, false)', [name, value]);
        }
        expect(await sqlState(client, INSERT)).toBeUndefined();
      });
    } finally {
      await grantInsertToProvisioning('revoke');
      await withClient(database.urlFor('postgres'), (client) =>
        client.query("delete from rls_fixture.seeded_records where body = 'from the label'"),
      );
    }
  });
});

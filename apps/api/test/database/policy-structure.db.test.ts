import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import type { DatabaseService } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { catalogViolations } from '../../src/tools/database/catalog-invariants.js';
import { lintMigrationSql } from '../../src/tools/database/migration-lint.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  applyFixture,
  HUB_A,
  HUB_B,
  riderContext,
  RIDER_1,
  staffContext,
  systemContext,
  vendorContext,
  VENDOR_1,
} from './support/rls-fixture.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, withClient, type TestDatabase } from './support/test-database.js';

/**
 * What an ordinary policy is, shown against a real PostgreSQL (correction F03 of Stage 1). Three expressions that name no SYSTEM
 * admit a SYSTEM context under any capability, and the checks used to pass them as "not a SYSTEM branch". Here each is created as a
 * migration might by mistake and read under the runtime login: the context reaches the rows, and both the migration lint (on the
 * text) and the catalogue check (on what the database holds, as `pg_get_expr` prints it) refuse the policy. The principal CASE
 * that denies the same context is the control. The last group shows what a clause that is absent does, which is why an absent
 * clause is not a finding.
 */

const UNSAFE = [
  { table: 'open_true_records', expression: 'true' },
  { table: 'not_vendor_records', expression: "melarc.principal_type() <> 'VENDOR'" },
  { table: 'not_in_records', expression: "melarc.principal_type() NOT IN ('VENDOR', 'RIDER')" },
] as const;

const tableSql = (table: string, policy: string): string => `
  CREATE TABLE rls_fixture.${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), hub_id uuid, body text NOT NULL);
  ALTER TABLE rls_fixture.${table} OWNER TO melarc_owner;
  ALTER TABLE rls_fixture.${table} ENABLE ROW LEVEL SECURITY;
  ALTER TABLE rls_fixture.${table} FORCE ROW LEVEL SECURITY;
  ${policy}
  GRANT SELECT, INSERT ON rls_fixture.${table} TO melarc_api_runtime;
`;

const SAFE_POLICY = `CASE melarc.principal_type() WHEN 'STAFF' THEN true ELSE false END`;
const SAFE_SQL = tableSql(
  'safe_records',
  `CREATE POLICY safe_records_scope ON rls_fixture.safe_records USING (${SAFE_POLICY});`,
);
const UNSAFE_SQL = UNSAFE.map(({ table, expression }) =>
  tableSql(table, `CREATE POLICY ${table}_scope ON rls_fixture.${table} USING (${expression});`),
).join('\n');

let database: TestDatabase;
let built: BuiltService;
let service: DatabaseService;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(SAFE_SQL));
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(UNSAFE_SQL));
  await withClient(database.urlFor('postgres'), async (client) => {
    for (const table of ['safe_records', ...UNSAFE.map((each) => each.table)]) {
      await client.query(`insert into rls_fixture.${table} (body) values ('reached')`);
    }
  });
  built = buildService(database);
  service = built.service;
});

afterAll(async () => {
  await built.close();
  await database.drop();
});

const read = async (context: SecurityContext, table: string): Promise<number> =>
  (
    await service.transactionWithContext(context, (tx) =>
      tx.execute(sql.raw(`select body from rls_fixture.${table}`)),
    )
  ).rows.length;

describe('what the unsupported policies do (the demonstration)', () => {
  // The reproduction of F03 against the database. Under the capability the policy never mentioned (and under one that no policy
  // of the product names for the table), a SYSTEM context reads every row. These are the expressions the checks passed.
  it.each(UNSAFE.map((each) => [each.table, each.expression] as const))(
    'lets a SYSTEM context under any capability read %s (%s)',
    async (table) => {
      expect(await read(systemContext('authentication'), table)).toBe(1);
      expect(await read(systemContext('rate_limit'), table)).toBe(1);
    },
  );

  it('admits the other principals the expression does not exclude', async () => {
    expect(await read(staffContext([HUB_A]), 'open_true_records')).toBe(1);
    expect(await read(vendorContext(VENDOR_1), 'open_true_records')).toBe(1);
    expect(await read(riderContext(RIDER_1), 'open_true_records')).toBe(1);
    expect(await read(vendorContext(VENDOR_1), 'not_vendor_records')).toBe(0);
    expect(await read(riderContext(RIDER_1), 'not_vendor_records')).toBe(1);
    expect(await read(vendorContext(VENDOR_1), 'not_in_records')).toBe(0);
    expect(await read(riderContext(RIDER_1), 'not_in_records')).toBe(0);
    expect(await read(staffContext([HUB_A]), 'not_in_records')).toBe(1);
  });

  // The control: the principal CASE that names STAFF only denies the same contexts, so the difference above is the policy's.
  it('is not what the principal CASE does with the same contexts', async () => {
    expect(await read(staffContext([HUB_A]), 'safe_records')).toBe(1);
    expect(await read(systemContext('authentication'), 'safe_records')).toBe(0);
    expect(await read(systemContext('rate_limit'), 'safe_records')).toBe(0);
    expect(await read(vendorContext(VENDOR_1), 'safe_records')).toBe(0);
    expect(await read(riderContext(RIDER_1), 'safe_records')).toBe(0);
  });
});

describe('both checks refuse them', () => {
  // The database holds the expression in this form, which is the form the catalogue check reads.
  it('prints the expressions back as the catalogue check reads them', async () => {
    const printed = await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<{ polname: string; expr: string }>(
        `select polname, pg_get_expr(polqual, polrelid) as expr from pg_policy where polname like '%\\_records\\_scope' order by polname`,
      );
      return Object.fromEntries(rows.map((row) => [row.polname, row.expr]));
    });
    expect(printed).toMatchObject({
      open_true_records_scope: 'true',
      not_vendor_records_scope: "(melarc.principal_type() <> 'VENDOR'::text)",
      not_in_records_scope:
        "(melarc.principal_type() <> ALL (ARRAY['VENDOR'::text, 'RIDER'::text]))",
    });
  });

  it('refuses each in the migration lint, on the text, and accepts the principal CASE', () => {
    const problems = lintMigrationSql(UNSAFE_SQL);
    expect(problems).toHaveLength(UNSAFE.length);
    for (const { table } of UNSAFE) {
      expect(problems).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `policy ${table}_scope on rls_fixture\\.${table}: is not a supported policy expression`,
          ),
        ),
      );
    }
    expect(lintMigrationSql(SAFE_SQL)).toEqual([]);
  });

  it('refuses each in the catalogue check, on what the database holds, and not the principal CASE', async () => {
    const violations = await withClient(database.urlFor('postgres'), (client) =>
      catalogViolations(client),
    );
    for (const { table } of UNSAFE) {
      expect(violations).toContainEqual(
        expect.stringMatching(
          new RegExp(
            `policy ${table}_scope on rls_fixture\\.${table}: is not a supported policy expression`,
          ),
        ),
      );
    }
    expect(violations).toHaveLength(UNSAFE.length);
    expect(violations.join('\n')).not.toContain('safe_records');
  });
});

/**
 * Why a clause that is absent is not a finding. A policy with no expression for a command adds no permission (PostgreSQL ORs the
 * permissive policies' expressions, and one with none contributes nothing), and a policy for ALL or UPDATE with no WITH CHECK
 * checks the rows it writes with its USING. If either were otherwise the checks would have to judge the absent clause.
 */
describe('a clause that is absent', () => {
  const WRITE_CHECK = `CASE melarc.principal_type() WHEN 'STAFF' THEN hub_id = ANY (melarc.authorized_hub_ids()) ELSE false END`;

  beforeAll(async () => {
    await withClient(database.urlFor(MIGRATION_ROLE), async (client) => {
      await client.query(
        tableSql(
          'no_using_records',
          `CREATE POLICY no_using_scope ON rls_fixture.no_using_records FOR SELECT;`,
        ),
      );
      await client.query(
        tableSql(
          'no_clause_records',
          `CREATE POLICY no_clause_scope ON rls_fixture.no_clause_records;`,
        ),
      );
      await client.query(
        tableSql(
          'no_check_records',
          `CREATE POLICY no_check_scope ON rls_fixture.no_check_records USING (${WRITE_CHECK});`,
        ),
      );
    });
    await withClient(database.urlFor('postgres'), async (client) => {
      await client.query(
        `insert into rls_fixture.no_using_records (hub_id, body) values ('${HUB_A}', 'row')`,
      );
      await client.query(
        `insert into rls_fixture.no_clause_records (hub_id, body) values ('${HUB_A}', 'row')`,
      );
    });
  });

  it('admits nothing: a policy with no USING, or with no clause at all, is read by no one', async () => {
    for (const context of [
      staffContext([HUB_A]),
      staffContext([], 'ALL'),
      systemContext('authentication'),
      vendorContext(VENDOR_1),
    ]) {
      expect(await read(context, 'no_using_records')).toBe(0);
      expect(await read(context, 'no_clause_records')).toBe(0);
    }
  });

  it('checks the rows a write produces with its USING when it has no WITH CHECK', async () => {
    const insert = (hub: string) =>
      service.transactionWithContext(staffContext([HUB_A]), (tx) =>
        tx.execute(
          sql.raw(
            `insert into rls_fixture.no_check_records (hub_id, body) values ('${hub}', 'written')`,
          ),
        ),
      );

    await expect(insert(HUB_A)).resolves.toBeDefined();
    const refused = await insert(HUB_B).catch((error: unknown) => error);
    expect(serverErrorIn(refused)?.code).toBe('42501');
  });

  it('is not a finding of either check', async () => {
    const violations = await withClient(database.urlFor('postgres'), (client) =>
      catalogViolations(client),
    );
    const mine = violations.filter((line) =>
      /no_using_scope|no_clause_scope|no_check_scope/.test(line),
    );
    expect(mine).toEqual([]);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE, type DatabaseDeadlines } from '../../src/platform/config/load-config.js';
import {
  DatabaseDeadlineError,
  serverErrorIn,
} from '../../src/platform/database/database-failures.js';
import { bundleLock } from '../../src/platform/database/policy-lock/plan.js';
import { SecurityContextError } from '../../src/platform/database/transaction-context.js';
import { SeedRefusedError, runSeed } from '../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { policyExpressionProblems } from '../../src/tools/database/system-branch.js';
import {
  FIXTURE_CODE_PREFIX,
  FixturesRefusedError,
  REASON_FIXTURES,
  fixturePlan,
} from '../../src/tools/fixtures/fixtures.js';
import { runSeedCommand } from '../../src/tools/seed/seed-command.js';
import { BUNDLES, BUNDLE_IDS, FIXED_POLICIES, GRANTS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { IDENTITY_REASONS } from '../../src/tools/seed/reasons.js';
import { referenceSeedPlan } from '../../src/tools/seed/reference-seed.js';
import { SETTINGS } from '../../src/tools/seed/settings.js';
import {
  parseIdentityReasons,
  parsePermissionCatalogue,
  statedGrantableKeys,
} from '../../src/test-support/seed-documents.js';
import { DB_SEED, killAll, requireBuild, run } from '../support/api-process.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.9 against a real PostgreSQL: the seed helper and the reference seeds, run as the provisioning login (`melarc_provisioning`,
 * the one identity that may execute the seed functions of migration 0005), and the API runtime that asserts the same label
 * (`GBT-E6`). Security test matrix Families E (`GBT-E6`, `GBT-E7`), F, K, S and Z; MIGRATION_AND_SEEDING.md sections 4 and 5.1;
 * SECURITY_DESIGN.md section 13.10a (the seed follows the one lock protocol). What the database itself enforces about an
 * initialization (once, atomically, serialized, and nothing appended afterwards) is `seed-initialization.db.test.ts`'s; the
 * policies of 0004, which the functions meet as the table owner, are exercised here as that role.
 */

const ROOT = resolve(import.meta.dirname, '../../../..');
const read = (path: string): string =>
  readFileSync(resolve(ROOT, path), 'utf8').replaceAll('\r', '');

const TABLES = [
  'hub',
  'permission',
  'role_bundle',
  'role_bundle_grant',
  'fixed_permission_policy',
  'setting',
  'reason_code',
] as const;

/** One statement of the right shape for each table: the refusals below are the privilege or the policy, never a malformed insert. */
const INSERTS: Readonly<Record<(typeof TABLES)[number], string>> = {
  hub: "insert into hub (id, name) values ('5eed0100-0000-4000-8000-0000000000aa', 'Elsewhere')",
  permission: "insert into permission (key, domain) values ('pickup.invented', 'pickup')",
  role_bundle:
    "insert into role_bundle (id, name, audience, privileged) values ('5eed0001-0000-4000-8000-0000000000aa', 'Invented', 'STAFF', false)",
  role_bundle_grant: `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
     values ('${BUNDLE_IDS.opsStaff}', 'pickup.request.create', 'all', 'any', 'A')`,
  fixed_permission_policy: "insert into fixed_permission_policy (principal_type) values ('VENDOR')",
  setting: `insert into setting (key, scope, value_type, value, unit, description)
     values ('invented_setting', 'COMPANY', 'string', '"x"', 'text', 'Invented')`,
  reason_code: `insert into reason_code (code, domain, label, attribution)
     values ('INVENTED', 'DELIVERY_FAILURE', 'Invented', 'MELARC')`,
};

/** A column of each table, to name in an UPDATE whose refusal is the privilege (the new value is the old). */
const UPDATABLE_COLUMN: Readonly<Record<(typeof TABLES)[number], string>> = {
  hub: 'name',
  permission: 'domain',
  role_bundle: 'name',
  role_bundle_grant: 'hub_scope',
  fixed_permission_policy: 'revision',
  setting: 'unit',
  reason_code: 'label',
};

const SEED_LABEL = { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'seed' } as const;

/** Small bounds, so that a lock wait can be reached. */
const FAST: DatabaseDeadlines = {
  acquireTimeoutMs: 2_000,
  lockTimeoutMs: 400,
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 6_000,
  transactionTimeoutMs: 8_000,
  maxWaiters: 10,
};

let database: TestDatabase;
let other: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  other = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
  await other.drop();
});

/** A connection of `login` with the transaction-local settings of `settings` applied for the transaction `work` runs in. */
async function asLogin<T>(
  db: TestDatabase,
  login: Parameters<TestDatabase['urlFor']>[0],
  settings: Readonly<Record<string, string>>,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(db.urlFor(login), async (client) => {
    await client.query('begin');
    try {
      for (const [name, value] of Object.entries(settings)) {
        await client.query('select set_config($1, $2, true)', [name, value]);
      }
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  });
}

/**
 * The table owner, in a transaction, with the settings applied. It holds every privilege on the tables and is held to the policies
 * all the same (FORCE ROW LEVEL SECURITY), which is the position the seed functions run in: so what the seed policies of 0004 admit and
 * refuse is shown here, with no other role's privileges in the way.
 */
async function asOwner<T>(
  db: TestDatabase,
  settings: Readonly<Record<string, string>>,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  return withClient(db.urlFor('postgres'), async (client) => {
    await client.query('begin');
    try {
      await client.query('set local role melarc_owner');
      for (const [name, value] of Object.entries(settings)) {
        await client.query('select set_config($1, $2, true)', [name, value]);
      }
      return await work(client);
    } finally {
      await client.query('rollback');
    }
  });
}

type Counts = Record<(typeof TABLES)[number], number>;

const countAll = async (db: TestDatabase): Promise<Counts> =>
  withClient(db.urlFor('postgres'), async (client) => {
    const counts = {} as Counts;
    for (const table of TABLES) {
      counts[table] = Number(await scalar(client, `select count(*)::int from ${table}`));
    }
    return counts;
  });

const EMPTY = Object.fromEntries(TABLES.map((table) => [table, 0])) as Counts;

describe('the seed capability, before anything is seeded (GBT-E6, GBT-E7)', () => {
  // Control for the refusals below. The table owner, which the seed functions run as, can insert a row of the right shape into every
  // table under the seed label (in a transaction that is rolled back): without it, a refusal could be a statement that was never
  // valid. The provisioning login itself holds no privilege (seed-initialization.db.test.ts), so the policies are shown as the owner.
  it('admits the owner role to insert into every table under the seed label', async () => {
    await asOwner(database, SEED_LABEL, async (client) => {
      for (const statement of [
        INSERTS.hub,
        INSERTS.permission,
        INSERTS.role_bundle,
        // A grant of the bundle and the permission inserted just above.
        `insert into role_bundle_grant (bundle_id, permission_key, hub_scope, ownership_scope, tier)
         values ('5eed0001-0000-4000-8000-0000000000aa', 'pickup.invented', 'all', 'any', 'A')`,
        INSERTS.fixed_permission_policy,
        INSERTS.setting,
        INSERTS.reason_code,
      ]) {
        expect(await sqlState(client, statement), statement).toBeUndefined();
      }
    });
  });

  // GBT-E6 on the real seed tables. Break caught: the label being the barrier. The API runtime asserts the seed label by hand and
  // is refused on every table by the grant (it holds SELECT and nothing more), not by a policy.
  it('refuses the API runtime that asserts the seed label, on every table, by the privilege (GBT-E6)', async () => {
    for (const table of TABLES) {
      await asLogin(database, API_RUNTIME_ROLE, SEED_LABEL, async (client) => {
        const failure = await client
          .query(INSERTS[table])
          .catch((error: unknown) => error as pg.DatabaseError);
        expect((failure as pg.DatabaseError).code, table).toBe('42501');
        expect((failure as pg.DatabaseError).message, table).toMatch(/permission denied for table/);
      });
    }
  });

  // Break caught: the seed policy admitting a capability other than seed, or SYSTEM alone. The owner role holds every privilege and
  // is refused by the policy (a row-level security error, not a privilege one) under any other label, as staff, or with none.
  it.each([
    ['bootstrap', { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'bootstrap' }],
    [
      'authentication',
      { 'melarc.principal_type': 'SYSTEM', 'melarc.task_capability': 'authentication' },
    ],
    ['staff', { 'melarc.principal_type': 'STAFF', 'melarc.hub_scope_mode': 'ALL' }],
    ['vendor', { 'melarc.principal_type': 'VENDOR' }],
    ['no context', {}],
  ] as const)(
    'refuses the owner role under %s, by the row-level security policy of every table',
    async (_label, settings) => {
      for (const table of TABLES) {
        await asOwner(database, settings, async (client) => {
          const failure = await client
            .query(INSERTS[table])
            .catch((error: unknown) => error as pg.DatabaseError);
          expect((failure as pg.DatabaseError).code, table).toBe('42501');
          expect((failure as pg.DatabaseError).message, table).toMatch(/row-level security policy/);
        });
      }
    },
  );

  // Break caught: the seed starting a bundle or a fixed policy at a revision or a floor above the first, which would make a later
  // reduction look like it had already happened (MIGRATION_AND_SEEDING.md section 5.1: revision 1, floor 1).
  it('admits a bundle and a fixed policy at revision 1 and floor 1 only', async () => {
    await asOwner(database, SEED_LABEL, async (client) => {
      for (const statement of [
        "insert into role_bundle (id, name, audience, privileged, revision) values ('5eed0001-0000-4000-8000-0000000000c1', 'Raised', 'STAFF', false, 2)",
        "insert into role_bundle (id, name, audience, privileged, revision, reduction_floor) values ('5eed0001-0000-4000-8000-0000000000c2', 'Floored', 'STAFF', false, 2, 2)",
        "insert into fixed_permission_policy (principal_type, revision) values ('VENDOR', 2)",
        "insert into fixed_permission_policy (principal_type, revision, minimum_revision) values ('RIDER', 2, 2)",
      ]) {
        // Each failure aborts the transaction, so each runs in a savepoint.
        await client.query('savepoint attempt');
        expect(await sqlState(client, statement), statement).toBe('42501');
        await client.query('rollback to savepoint attempt');
      }
      expect(
        await sqlState(
          client,
          "insert into role_bundle (id, name, audience, privileged) values ('5eed0001-0000-4000-8000-0000000000c3', 'First', 'STAFF', false)",
        ),
      ).toBeUndefined();
    });
  });

  // Break caught: the provisioning login holding any privilege on a seed table. It holds none (it reaches the tables only by the seed
  // functions), so it can neither insert, read, change nor remove a row, under the seed label or not. The full matrix, before and
  // after an initialization, is seed-initialization.db.test.ts's; this is the seven tables and the statements, with the label set.
  it('gives the provisioning login no statement on any table, the seed label asserted', async () => {
    for (const table of TABLES) {
      await asLogin(database, PROVISIONING_ROLE, SEED_LABEL, async (client) => {
        for (const statement of [
          INSERTS[table],
          `select count(*) from ${table}`,
          `update ${table} set ${UPDATABLE_COLUMN[table]} = ${UPDATABLE_COLUMN[table]}`,
          `delete from ${table}`,
          `truncate ${table}`,
        ]) {
          await client.query('savepoint attempt');
          const state = await sqlState(client, statement);
          await client.query('rollback to savepoint attempt');
          expect(state, `${table}: ${statement}`).toBe('42501');
        }
      });
    }
  });

  // GBT-E7 on the real policies. Break caught: a seed branch that does not name its capability, or one that names two.
  it('names one capability in every SYSTEM branch of every seed policy (GBT-E7)', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<{
        tablename: string;
        policyname: string;
        cmd: string;
        qual: string | null;
        with_check: string | null;
      }>(
        `select tablename, policyname, cmd, qual, with_check from pg_policies
          where schemaname = 'public' and tablename = any($1) and policyname like '%\\_seed\\_%'
          order by tablename, policyname`,
        [[...TABLES]],
      );
      // One read and one insert policy for each of the seven tables, and nothing for UPDATE or DELETE.
      expect(rows.map((row) => `${row.tablename}:${row.cmd}`).toSorted()).toEqual(
        TABLES.flatMap((table) => [`${table}:INSERT`, `${table}:SELECT`]).toSorted(),
      );
      for (const row of rows) {
        const expression = row.cmd === 'INSERT' ? row.with_check : row.qual;
        expect(expression, row.policyname).not.toBeNull();
        expect(
          policyExpressionProblems(expression ?? '', {
            command: row.cmd === 'INSERT' ? 'insert' : 'select',
            clause: row.cmd === 'INSERT' ? 'check' : 'using',
          }),
          row.policyname,
        ).toEqual([]);
        expect(expression, row.policyname).toMatch(/task_capability\(\) = 'seed'/);
        expect(expression, row.policyname).not.toMatch(/'(authentication|bootstrap|rate_limit)'/);
      }
    });
  });
});

describe('the seed helper over the real database', () => {
  // Break caught: a seed run over the API runtime's connection, which would make the label an identity. The service refuses to open
  // the capability over any login but the provisioning one, and nothing is read or written.
  it('is refused over the API runtime login, before it reads or writes anything', async () => {
    const { service, close } = buildService(database, { login: API_RUNTIME_ROLE });
    try {
      await expect(runSeed(service, referenceSeedPlan())).rejects.toBeInstanceOf(
        SecurityContextError,
      );
    } finally {
      await close();
    }
    expect(await countAll(database)).toEqual(EMPTY);
  });

  // Break caught: a seed that takes a key shared, or does not wait for a sign-in's. A sign-in holds the bundle key shared; the seed
  // asks it exclusively, waits, is ended by lock_timeout with the lock deadline error, and has written nothing.
  it('waits for a key a reader holds shared, and is ended by the lock timeout with nothing written', async () => {
    const holder = await withHeldLock(database, BUNDLE_IDS.seniorOps);
    const { service, close } = buildService(database, {
      login: PROVISIONING_ROLE,
      deadlines: FAST,
    });
    try {
      const failure = await runSeed(service, referenceSeedPlan()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DatabaseDeadlineError);
      expect((failure as DatabaseDeadlineError).kind).toBe('lock');
    } finally {
      await holder.release();
      await close();
    }
    expect(await countAll(database)).toEqual(EMPTY);
  });

  // The seed itself, as the provisioning login. The report is what each table received, derived from the data.
  it('seeds an empty database in one transaction and reports what it inserted', async () => {
    const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
    try {
      const report = await runSeed(service, referenceSeedPlan());
      const plan = referenceSeedPlan();
      expect(report).toEqual(
        Object.fromEntries(
          Object.entries(plan.payload).map(([table, rows]) => [table, rows.length]),
        ),
      );
    } finally {
      await close();
    }
    const counts = await countAll(database);
    expect(counts.hub).toBe(HUBS.length);
    expect(counts.role_bundle).toBe(BUNDLES.length);
    expect(counts.role_bundle_grant).toBe(GRANTS.length);
    expect(counts.fixed_permission_policy).toBe(FIXED_POLICIES.length);
    expect(counts.setting).toBe(SETTINGS.length);
    expect(counts.reason_code).toBe(IDENTITY_REASONS.length);
  });

  // Break caught: a seed that adds to what is there, and a second run that "completes" a database. It refuses, names the first
  // table with rows, and the rows are as they were (it counts before it writes).
  it('refuses to seed twice, naming the table, and changes nothing', async () => {
    const before = await snapshot(database);
    const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
    try {
      const failure = await runSeed(service, referenceSeedPlan()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SeedRefusedError);
      expect((failure as SeedRefusedError).table).toBe('hub');
      expect((failure as SeedRefusedError).rows).toBe(HUBS.length);
    } finally {
      await close();
    }
    expect(await snapshot(database)).toEqual(before);
  });

  // Break caught: a partial database "completed" by a seed that skips the table it finds filled. One filled table refuses the whole
  // seed, after the others were counted and before any was written: they stay empty.
  it('refuses when only one table has rows, and writes nothing to the others', async () => {
    await withClient(other.urlFor('postgres'), (admin) =>
      admin.query(
        `insert into setting (key, scope, value_type, value, unit, description)
         values ('transaction_currency', 'COMPANY', 'string', '"GHS"', 'ISO 4217', 'Already here')`,
      ),
    );
    const { service, close } = buildService(other, { login: PROVISIONING_ROLE });
    try {
      const failure = await runSeed(service, referenceSeedPlan()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SeedRefusedError);
      expect((failure as SeedRefusedError).table).toBe('setting');
    } finally {
      await close();
    }
    expect(await countAll(other)).toEqual({ ...EMPTY, setting: 1 });
    await withClient(other.urlFor('postgres'), (admin) => admin.query('delete from setting'));
  });

  // Break caught: a transaction that keeps what it wrote before a later table fails. A row the last table refuses rolls back every
  // table before it, the failure is the database's own (a refusal of a row is not a refusal of a database that has rows), and the
  // database is empty again for the next run.
  it('rolls every table back when the last table refuses a row, and reports the database’s own error', async () => {
    const empty = other;
    const plan = referenceSeedPlan();
    const doctored = structuredClone(plan.payload) as Record<string, Record<string, unknown>[]>;
    const last = doctored.reason_code?.at(-1);
    if (last === undefined) throw new Error('the reference plan has no reason');
    last.domain = 'NOT_A_DOMAIN';
    const { service, close } = buildService(empty, { login: PROVISIONING_ROLE });
    try {
      const failure = await runSeed(service, { ...plan, payload: doctored }).catch(
        (error: unknown) => error,
      );
      expect(failure).not.toBeInstanceOf(SeedRefusedError);
      expect(serverErrorIn(failure)?.code).toBe('23514');
    } finally {
      await close();
    }
    expect(await countAll(empty)).toEqual(EMPTY);
  });
});

describe('the db:seed command over a real database', () => {
  const run = async (
    argv: string[],
    db: TestDatabase,
    appEnv: string,
    login: Parameters<TestDatabase['urlFor']>[0] = PROVISIONING_ROLE,
  ): Promise<string[]> => {
    const lines: string[] = [];
    await runSeedCommand(argv, { DATABASE_SEED_URL: db.urlFor(login), APP_ENV: appEnv }, (line) =>
      lines.push(line),
    );
    return lines;
  };

  // The command as a deployment runs it: the URL of the provisioning login and the environment, nothing else.
  it('seeds an empty database from the URL of the provisioning login and reports each table', async () => {
    const lines = await run([], other, 'staging');
    const plan = referenceSeedPlan();
    expect(lines).toEqual(
      Object.entries(plan.payload).map(
        ([table, rows]) =>
          `seeded ${table}: ${String(rows.length)} ${rows.length === 1 ? 'row' : 'rows'}`,
      ),
    );
    expect((await countAll(other)).permission).toBe(plan.payload.permission?.length);
  });

  it('refuses the same database a second time, and changes nothing', async () => {
    const before = await snapshot(other);
    await expect(run([], other, 'staging')).rejects.toBeInstanceOf(SeedRefusedError);
    expect(await snapshot(other)).toEqual(before);
  });

  // Break caught: a URL for a login that is not the provisioning one reaching the database, where the seed would be refused late
  // (or, for a login with more rights, succeed as something it should not be). The command refuses before it connects.
  it('refuses the API runtime login named in the URL before it connects', async () => {
    await expect(run([], other, 'staging', API_RUNTIME_ROLE)).rejects.toThrow(/provisioning login/);
  });

  // Break caught: the fixtures written in production through the command. The refusal is the environment's, before a connection
  // is made, and the reason table is as the seed left it.
  it('refuses --fixtures in production and writes nothing', async () => {
    const before = (await countAll(other)).reason_code;
    await expect(run(['--fixtures'], other, 'production')).rejects.toBeInstanceOf(
      FixturesRefusedError,
    );
    expect((await countAll(other)).reason_code).toBe(before);
  });

  it('writes the fixtures in staging, once, beside the seeded reasons', async () => {
    const before = (await countAll(other)).reason_code;
    const lines = await run(['--fixtures'], other, 'staging');
    expect(lines).toEqual([
      `seeded reason_code (fixtures): ${String(REASON_FIXTURES.length)} rows`,
    ]);
    expect((await countAll(other)).reason_code).toBe(before + REASON_FIXTURES.length);
    await expect(run(['--fixtures'], other, 'staging')).rejects.toBeInstanceOf(SeedRefusedError);
    expect((await countAll(other)).reason_code).toBe(before + REASON_FIXTURES.length);
  });
});

describe('the built db:seed tool, run as a process', () => {
  beforeAll(requireBuild);
  afterEach(killAll);

  // The tool as the package script runs it (dist/tools/db-seed.js): the exit codes, the lines, what goes to which stream, and
  // that the process ends by itself (a connection left open would keep it alive until the deadline).
  it('seeds, refuses a second run, and refuses the fixtures in production, ending each by itself and printing no secret', async () => {
    const cli = await createTestDatabase();
    try {
      const url = cli.urlFor(PROVISIONING_ROLE);
      const password = decodeURIComponent(new URL(url).password);
      const env = (appEnv: string) => ({ DATABASE_SEED_URL: url, APP_ENV: appEnv });

      const first = await run(DB_SEED, env('local'), [], 40_000);
      expect(first.code, first.stderr).toBe(0);
      expect(first.stdout).toContain('seeded hub: 1 row');
      expect(first.stdout).toMatch(/seeded permission: \d+ rows/);
      expect(first.stderr).toBe('');
      expect(await countAll(cli)).toMatchObject({ hub: 1 });

      const second = await run(DB_SEED, env('local'), [], 40_000);
      expect(second.code).toBe(1);
      expect(second.stdout).toBe('');
      expect(second.stderr).toMatch(/table hub is not empty/);

      const production = await run(DB_SEED, env('production'), ['--fixtures'], 40_000);
      expect(production.code).toBe(1);
      expect(production.stderr).toMatch(/fixtures/);

      const staging = await run(DB_SEED, env('staging'), ['--fixtures'], 40_000);
      expect(staging.code, staging.stderr).toBe(0);
      expect(staging.stdout).toContain('seeded reason_code (fixtures): 2 rows');

      for (const finished of [first, second, production, staging]) {
        expect(finished.stdout + finished.stderr).not.toContain(password);
        expect(finished.stdout + finished.stderr).not.toMatch(/postgres:\/\//);
      }
    } finally {
      await cli.drop();
    }
  }, 180_000);
});

describe('what was seeded, against the documents that own it (Family Z)', () => {
  const PERMISSIONS = read('contracts/permissions.md');
  const DOMAIN_MODEL = read('contracts/domain-model.md');

  // Evidence of S0.9: the seeded catalogue equals permissions.md. A derived comparison: the keys come from the document, and so does
  // the count it states.
  it('holds exactly the permission catalogue of permissions.md', async () => {
    const keys = await withClient(database.urlFor('postgres'), async (client) => {
      const { rows } = await client.query<{ key: string }>('select key from permission');
      return rows.map((row) => row.key).toSorted();
    });
    expect(keys).toEqual(
      parsePermissionCatalogue(PERMISSIONS)
        .map((row) => row.key)
        .toSorted(),
    );
    expect(keys).toHaveLength(statedGrantableKeys(PERMISSIONS));
  });

  it('holds the twelve identity reasons of domain-model.md, with their permitted operations', async () => {
    const rows = await withClient(database.urlFor('postgres'), async (client) => {
      const result = await client.query<{
        code: string;
        domain: string;
        label: string;
        permitted_operations: string[];
        valid_checkpoints: string[] | null;
        attribution: string;
        active: boolean;
      }>('select * from reason_code');
      return result.rows.toSorted((a, b) => (a.code < b.code ? -1 : 1));
    });
    const documented = parseIdentityReasons(DOMAIN_MODEL).toSorted((a, b) =>
      a.code < b.code ? -1 : 1,
    );
    expect(
      rows.map((row) => ({
        code: row.code,
        domain: row.domain,
        label: row.label,
        ops: row.permitted_operations,
      })),
    ).toEqual(
      documented.map((row) => ({
        code: row.code,
        domain: row.domain,
        label: row.label,
        ops: row.permittedOperations,
      })),
    );
    expect(
      rows.every(
        (row) => row.attribution === 'MELARC' && row.active && row.valid_checkpoints === null,
      ),
    ).toBe(true);
    // Four of the twelve carry a branch-qualified operation (plan S0.9).
    expect(
      rows.filter((row) => row.permitted_operations.some((entry) => entry.includes('#'))),
    ).toHaveLength(4);
  });

  it('holds the settings, each with the value, type, scope and unit of the data', async () => {
    const rows = await withClient(database.urlFor('postgres'), async (client) => {
      const result = await client.query<{
        key: string;
        scope: string;
        value_type: string;
        value: unknown;
        unit: string;
      }>('select key, scope, value_type, value, unit from setting');
      return result.rows.toSorted((a, b) => (a.key < b.key ? -1 : 1));
    });
    expect(rows).toEqual(
      SETTINGS.map((each) => ({
        key: each.key,
        scope: each.scope,
        value_type: each.valueType,
        value: each.value,
        unit: each.unit,
      })).toSorted((a, b) => (a.key < b.key ? -1 : 1)),
    );
  });

  it('holds the bundles at revision 1 and floor 1, the grants as written, and one fixed policy each for Vendor and Rider', async () => {
    await withClient(database.urlFor('postgres'), async (client) => {
      const bundles = await client.query<{ id: string }>(
        'select id, name, audience, privileged, revision, reduction_floor from role_bundle',
      );
      expect(bundles.rows.toSorted((a, b) => (a.id < b.id ? -1 : 1))).toEqual(
        BUNDLES.map((bundle) => ({ ...bundle, revision: 1, reduction_floor: 1 })).toSorted(
          (a, b) => (a.id < b.id ? -1 : 1),
        ),
      );
      const grants = await client.query<{
        bundle_id: string;
        permission_key: string;
        hub_scope: string;
        ownership_scope: string;
        tier: string | null;
      }>('select * from role_bundle_grant');
      expect(
        grants.rows
          .map(
            (row) =>
              `${row.bundle_id}|${row.permission_key}|${row.hub_scope}|${row.ownership_scope}|${row.tier ?? '-'}`,
          )
          .toSorted(),
      ).toEqual(
        GRANTS.map(
          (grant) =>
            `${grant.bundleId}|${grant.permissionKey}|${grant.hubScope}|${grant.ownershipScope}|${grant.tier ?? '-'}`,
        ).toSorted(),
      );
      const fixed = await client.query<{ principal_type: string }>(
        'select principal_type, revision, minimum_revision from fixed_permission_policy',
      );
      expect(fixed.rows.toSorted((a, b) => (a.principal_type < b.principal_type ? -1 : 1))).toEqual(
        FIXED_POLICIES.map((policy) => ({
          principal_type: policy.principalType,
          revision: 1,
          minimum_revision: 1,
        })).toSorted((a, b) => (a.principal_type < b.principal_type ? -1 : 1)),
      );
      const hubs = await client.query('select id, name from hub');
      expect(hubs.rows).toEqual(HUBS.map((each) => ({ ...each })));
    });
  });

  // Break caught: seeded rows the API cannot read through the paths it uses. The runtime login reads the catalogue as a staff
  // context, and the bundle and its grants as the authentication capability does when it builds a session snapshot.
  it('is read by the API runtime as a staff context and as the authentication capability', async () => {
    const { service, close } = buildService(database);
    try {
      const staff = await service.transactionWithContext(staffContext([]), async (tx) => {
        const permissions = await tx.execute(sql`select count(*)::int as n from permission`);
        const settings = await tx.execute(sql`select count(*)::int as n from setting`);
        return [permissions.rows[0]?.n, settings.rows[0]?.n];
      });
      expect(staff).toEqual([
        parsePermissionCatalogue(read('contracts/permissions.md')).length,
        SETTINGS.length,
      ]);

      const grants = await service.transactionWithContext(
        systemContext('authentication'),
        async (tx) => {
          const result = await tx.execute(
            sql`select count(*)::int as n from role_bundle_grant where bundle_id = ${BUNDLE_IDS.seniorOps}`,
          );
          return result.rows[0]?.n;
        },
      );
      expect(grants).toBe(GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.seniorOps).length);
    } finally {
      await close();
    }
  });
});

/** Every seeded row, as the administrator reads it, in a stable order: what a second seed must leave exactly as it was. */
async function snapshot(db: TestDatabase): Promise<Record<string, unknown[]>> {
  return withClient(db.urlFor('postgres'), async (client) => {
    const result: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      result[table] = (await client.query(`select * from ${table} order by 1, 2`)).rows;
    }
    return result;
  });
}

/** An administrator session holding the bundle key shared, as a sign-in does, until `release` is called. */
async function withHeldLock(db: TestDatabase, bundleId: string) {
  const holder = clientFor(db.urlFor('postgres'));
  holder.on('error', () => undefined);
  await holder.connect();
  const lock = bundleLock(bundleId, 'shared');
  await holder.query('select pg_advisory_lock_shared($1::int4, $2::int4)', [lock.class, lock.key]);
  return { release: () => holder.end() };
}

describe('the fixtures over the seeded database (the emptiness check counts fixtures, not the table)', () => {
  // Break caught: the fixture check counting the whole reason table (refusing after the seed, so no fixture could ever be added),
  // or counting an unescaped LIKE pattern, where an underscore matches any character: a code that merely begins FIXTURE and
  // continues with another character is not a fixture.
  it('adds the fixtures after the seed, and a code that only resembles the prefix is not one', async () => {
    await withClient(database.urlFor('postgres'), (admin) =>
      admin.query(
        `insert into reason_code (code, domain, label, attribution)
         values ('FIXTUREX_ODD', 'DELIVERY_FAILURE', 'Not a fixture', 'MELARC')`,
      ),
    );
    const { service, close } = buildService(database, { login: PROVISIONING_ROLE });
    try {
      const report = await runSeed(service, fixturePlan());
      expect(report).toEqual({ 'reason_code (fixtures)': REASON_FIXTURES.length });
      const failure = await runSeed(service, fixturePlan()).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SeedRefusedError);
      expect((failure as SeedRefusedError).rows).toBe(REASON_FIXTURES.length);
    } finally {
      await close();
    }
    const codes = await withClient(database.urlFor('postgres'), async (admin) => {
      const { rows } = await admin.query<{ code: string }>(
        'select code from reason_code where starts_with(code, $1)',
        [FIXTURE_CODE_PREFIX],
      );
      return rows.map((row) => row.code).toSorted();
    });
    expect(codes).toEqual(REASON_FIXTURES.map((fixture) => fixture.code).toSorted());
  });
});

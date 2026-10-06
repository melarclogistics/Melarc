import { randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { readLocalPostgres } from '../../src/tools/database/local-env.js';
import { buildDatabaseUrl, DISPOSABLE_MARKER } from '../../src/tools/database/provisioning.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import {
  DB_BOOTSTRAP,
  DB_MIGRATE,
  DB_RESET,
  killAll,
  requireBuild,
  run,
} from '../support/api-process.js';
import {
  clientFor,
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * The commands that drop and recreate databases, run for real against the local server. The refusals are
 * proven twice: by what the tool says, and by the data still being there afterwards. Every target is a
 * database this file made: `melarc_dev` is never named.
 */
const settings = readLocalPostgres();
const suffix = () => randomBytes(4).toString('hex');
const TOOL_DEADLINE_MS = 40_000;
const TEST_TIMEOUT_MS = 90_000;

const toolEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  MELARC_PG_HOST: settings.host,
  MELARC_PG_PORT: String(settings.port),
  MELARC_PG_ADMIN_PASSWORD: settings.adminPassword,
  MELARC_PG_MIGRATION_PASSWORD: settings.migrationPassword,
  MELARC_PG_RUNTIME_PASSWORD: settings.runtimePassword,
  ...extra,
});

const tool = (script: string, args: string[], extra: Record<string, string> = {}) =>
  run(script, toolEnv(extra), args, TOOL_DEADLINE_MS);

/** The cluster administrator, on any database. Used to inspect and to clean up, never to act for the tool. */
const adminUrl = (database: string) =>
  buildDatabaseUrl({
    host: settings.host,
    port: settings.port,
    user: 'postgres',
    password: settings.adminPassword,
    database,
  });

const made: TestDatabase[] = [];
/** Databases made without `createTestDatabase`, by name, so cleanup can find them. */
const rawNames: string[] = [];

const dropByName = (name: string) =>
  withClient(adminUrl('postgres'), (client) =>
    client.query(`drop database if exists "${name}" with (force)`),
  );

beforeAll(requireBuild);

afterEach(killAll);

afterAll(async () => {
  for (const name of rawNames) await dropByName(name);
  for (const database of made) await database.drop().catch(() => undefined);
});

async function fresh(): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate: false });
  made.push(database);
  return database;
}

/** A table with a row, made as the administrator: something a wrongful drop would destroy. */
const plant = (database: TestDatabase, table: string) =>
  withClient(database.urlFor('postgres'), async (client) => {
    await client.query(`create table ${table} (id integer)`);
    await client.query(`insert into ${table} values (1)`);
  });

const planted = (database: TestDatabase, table: string) =>
  withClient(database.urlFor('postgres'), async (client) =>
    Number(await scalar<string>(client, `select count(*) from ${table}`)),
  );

const databaseExists = (name: string) =>
  withClient(
    adminUrl('postgres'),
    async (client) =>
      Number(
        await scalar<string>(client, 'select count(*) from pg_database where datname = $1', [name]),
      ) === 1,
  );

describe('db-reset', () => {
  // Break caught: a reset that drops a database it did not create. The name looks disposable; nothing
  // else about it is, and the tool must say so and leave the data.
  it(
    'refuses a database that does not carry the marker, and leaves its data',
    async () => {
      const name = `melarc_test_unmarked${suffix()}`;
      rawNames.push(name);
      await withClient(adminUrl('postgres'), (client) => client.query(`create database "${name}"`));
      await withClient(adminUrl(name), async (client) => {
        await client.query('create table precious (id integer)');
        await client.query('insert into precious values (1)');
      });

      const result = await tool(DB_RESET, [name]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(DISPOSABLE_MARKER);
      expect(
        await withClient(adminUrl(name), async (client) =>
          Number(await scalar<string>(client, 'select count(*) from precious')),
        ),
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a destructive command running with a deployed environment in scope. The target is a
  // database it would otherwise happily reset, and its data is still there.
  it.each(['staging', 'production'])(
    'refuses with APP_ENV=%s, and drops nothing',
    async (appEnv) => {
      const database = await fresh();
      await plant(database, 'precious');

      const result = await tool(DB_RESET, [database.name], { APP_ENV: appEnv });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`APP_ENV=${appEnv}`);
      expect(await planted(database, 'precious')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a reset of the cluster's own databases or one named like a production database. The
  // server is real, so "refused" also means they are all still there.
  it.each(['postgres', 'template1', 'melarc', 'melarc_prod'])(
    'refuses %s',
    async (name) => {
      const before = await databaseExists(name);

      const result = await tool(DB_RESET, [name]);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('only melarc_dev and melarc_test databases are disposable');
      expect(await databaseExists(name)).toBe(before);
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a reset that does not reset, or one that reaches a neighbouring database. The target
  // loses its data and is migrated again, the bystander keeps everything, and the roles still work.
  it(
    'drops, recreates and migrates the target only',
    async () => {
      const target = await fresh();
      const bystander = await fresh();
      await plant(target, 'leftover');
      await plant(bystander, 'bystander');

      const result = await tool(DB_RESET, [target.name]);

      expect(result.stderr).toBe('');
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`database ${target.name} reset`);
      await withClient(target.urlFor('postgres'), async (client) => {
        expect(await scalar(client, "select to_regclass('public.leftover') is null")).toBe(true);
        expect(await scalar(client, "select to_regnamespace('melarc') is not null")).toBe(true);
        expect(
          await scalar(
            client,
            "select shobj_description(oid, 'pg_database') from pg_database where datname = $1",
            [target.name],
          ),
        ).toBe(DISPOSABLE_MARKER);
      });
      expect(await planted(bystander, 'bystander')).toBe(1);
      await withClient(target.urlFor(API_RUNTIME_ROLE), (client) => client.query('select 1'));
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a reset that cannot drop a database somebody is connected to, which is every day of
  // development.
  it(
    'resets a database that something is connected to',
    async () => {
      const target = await fresh();
      const session = clientFor(target.urlFor('postgres'));
      session.on('error', () => undefined);
      await session.connect();
      try {
        const result = await tool(DB_RESET, [target.name]);
        expect(result.code).toBe(0);
      } finally {
        await session.end().catch(() => undefined);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('db-bootstrap', () => {
  // Break caught: a bootstrap that fails the second time, so it cannot be run "just in case".
  it(
    'creates the database and is safe to run again',
    async () => {
      const name = `melarc_test_boot${suffix()}`;
      rawNames.push(name);

      const first = await tool(DB_BOOTSTRAP, [name]);
      const second = await tool(DB_BOOTSTRAP, [name]);

      expect([first.code, second.code]).toEqual([0, 0]);
      expect(first.stdout).toContain(`database ${name} ready`);
      expect(await databaseExists(name)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('db-migrate', () => {
  // Break caught: a migrate command that cannot be run twice, or that does not say what it did.
  it(
    'applies the migrations once and then reports that the database is current',
    async () => {
      const database = await fresh();
      const url = database.urlFor(MIGRATION_ROLE);

      const first = await tool(DB_MIGRATE, [], { DATABASE_MIGRATION_URL: url });
      const second = await tool(DB_MIGRATE, [], { DATABASE_MIGRATION_URL: url });

      expect(first.code).toBe(0);
      expect(first.stdout).toMatch(/applied \d+ migration/);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain('up to date');
    },
    TEST_TIMEOUT_MS,
  );

  // Break caught: a migration run as the runtime role. The server is real and reachable, so the only
  // thing that stops it is the refusal, and nothing may be created.
  it(
    'refuses the runtime role and creates nothing',
    async () => {
      const database = await fresh();

      const result = await tool(DB_MIGRATE, [], {
        DATABASE_MIGRATION_URL: database.urlFor(API_RUNTIME_ROLE),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('migrations run only as melarc_migration_elevated');
      expect(result.stderr).not.toContain(settings.runtimePassword);
      await withClient(database.urlFor('postgres'), async (client) => {
        expect(await scalar(client, "select to_regnamespace('melarc') is null")).toBe(true);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

import { randomBytes } from 'node:crypto';

import pg from 'pg';

import { API_RUNTIME_ROLE } from '../../../src/platform/config/load-config.js';
import { postgresConnectionSettings } from '../../../src/platform/database/postgres-url.js';
import { readLocalPostgres, type LocalPostgres } from '../../../src/tools/database/local-env.js';
import {
  buildDatabaseUrl,
  connectLocalAdmin,
  createDisposableDatabase,
  dropDisposableDatabase,
  provisionRoles,
  type SqlClient,
} from '../../../src/tools/database/provisioning.js';
import { runMigrations, type MigrationResult } from '../../../src/tools/database/run-migrations.js';
import { MIGRATION_ROLE } from '../../../src/tools/database/safety.js';

/** The identities a test connects as. `postgres` is the cluster administrator and is used to seed and inspect only. */
export type Login = 'postgres' | typeof MIGRATION_ROLE | typeof API_RUNTIME_ROLE;

/** A database made for one test file, with the roles provisioned and (by default) the migrations applied. */
export interface TestDatabase {
  readonly name: string;
  readonly settings: LocalPostgres;
  urlFor(login: Login): string;
  migrate(): Promise<MigrationResult>;
  drop(): Promise<void>;
}

/**
 * Provisions the roles and creates a database with a name nothing else uses. Fails, with the reason, when
 * the local PostgreSQL service is not running or not configured: a database test never skips itself.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const settings = readLocalPostgres();
  const name = `melarc_test_${randomBytes(4).toString('hex')}`;

  const admin = await connectLocalAdmin(settings);
  try {
    await provisionRoles(admin, settings);
    await createDisposableDatabase(admin, name);
  } finally {
    await admin.close();
  }

  const passwords: Record<Login, string> = {
    postgres: settings.adminPassword,
    [MIGRATION_ROLE]: settings.migrationPassword,
    [API_RUNTIME_ROLE]: settings.runtimePassword,
  };
  const database: TestDatabase = {
    name,
    settings,
    urlFor: (login) =>
      buildDatabaseUrl({
        host: settings.host,
        port: settings.port,
        user: login,
        password: passwords[login],
        database: name,
      }),
    migrate: () => runMigrations({ url: database.urlFor(MIGRATION_ROLE) }),
    drop: async () => {
      const dropper = await connectLocalAdmin(settings);
      try {
        await dropDisposableDatabase(dropper, name);
      } finally {
        await dropper.close();
      }
    },
  };

  try {
    if (options.migrate !== false) await database.migrate();
  } catch (error) {
    await database.drop();
    throw error;
  }
  return database;
}

/**
 * A client for a URL, made the way production code makes one: from the settings read out of the URL and
 * never from the URL itself, so the identity the test names is the identity that connects.
 */
export function clientFor(url: string, options: pg.ClientConfig = {}): pg.Client {
  return new pg.Client({ ...postgresConnectionSettings(url), ...options });
}

/** Runs `work` on a fresh connection and always closes it. */
export async function withClient<T>(
  url: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = clientFor(url, { connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

/**
 * The SQLSTATE of the error a statement raises, or `undefined` if it ran. The refusal is the result:
 * these tests assert what the database refuses, not what a role's attributes say it should refuse.
 */
export async function sqlState(
  client: SqlClient,
  statement: string,
  values: unknown[] = [],
): Promise<string | undefined> {
  try {
    await client.query(statement, values);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

/** One value from one row. */
export async function scalar<T = unknown>(
  client: SqlClient,
  statement: string,
  values: unknown[] = [],
): Promise<T> {
  const { rows } = await client.query(statement, values);
  return Object.values(rows[0] ?? {})[0] as T;
}

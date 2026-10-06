import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { postgresConnectionSettings } from '../../platform/database/postgres-url.js';
import { assertMigrationIdentity } from './safety.js';

/** The one canonical migration history (DEVELOPMENT_EXECUTION_PLAN.md section 5). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

const JOURNAL = 'drizzle.__drizzle_migrations';
const LOCK = "hashtextextended('melarc:migrations', 0)";

export interface MigrationResult {
  /** How many migrations this run applied. Zero when the database was already current. */
  readonly applied: number;
}

async function journalCount(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [JOURNAL],
  );
  if (rows[0]?.present !== true) return 0;
  const counted = await client.query<{ count: string }>(`select count(*) from ${JOURNAL}`);
  return Number(counted.rows[0]?.count ?? 0);
}

/**
 * Applies every migration not yet in the journal, in order, as the migration identity.
 *
 * Safe to repeat: applied migrations are skipped. Safe to run twice at once: a session advisory lock
 * makes a second run wait for the first and then find nothing to do. It never touches a database it was
 * not given, and it refuses any identity but `melarc_migration_elevated` before it connects, because who
 * runs a migration decides who owns what it creates. The identity that is checked is the identity that
 * connects: the client is built from the settings read out of the URL, never from the URL, so a query
 * string cannot rename the user. A URL with one is refused, as is anything else that is not plainly
 * `postgres://user:password@host:port/database`.
 */
export async function runMigrations(options: {
  readonly url: string;
  readonly folder?: string;
  /** How long a run waits for another run to finish. */
  readonly lockTimeoutMs?: number;
}): Promise<MigrationResult> {
  const settings = postgresConnectionSettings(options.url);
  assertMigrationIdentity(settings.user);

  // One connection, not a pool: the lock belongs to the session, and the migrator must run on it.
  const client = new pg.Client({
    ...settings,
    application_name: 'melarc-migrate',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const timeout = String(Math.trunc(options.lockTimeoutMs ?? 60_000));
    await client.query("select set_config('lock_timeout', $1, false)", [`${timeout}ms`]);
    await client.query(`select pg_advisory_lock(${LOCK})`);
    try {
      const before = await journalCount(client);
      await migrate(drizzle(client), { migrationsFolder: options.folder ?? MIGRATIONS_FOLDER });
      return { applied: (await journalCount(client)) - before };
    } finally {
      await client.query(`select pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    await client.end();
  }
}

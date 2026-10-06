import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

import { postgresConnectionSettings } from '../../platform/database/postgres-url.js';
import {
  checkAgainstApplied,
  MigrationHistoryError,
  readMigrationFolder,
  type AppliedMigration,
} from './migration-history.js';
import { assertMigrationIdentity } from './safety.js';

/** The one canonical migration history (DEVELOPMENT_EXECUTION_PLAN.md section 5). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

const JOURNAL = 'drizzle.__drizzle_migrations';
const LOCK = "hashtextextended('melarc:migrations', 0)";

export interface MigrationResult {
  /** How many migrations this run applied. Zero when the database was already current. */
  readonly applied: number;
}

/** What the journal table holds, oldest first; nothing when no migration has ever run. */
async function appliedMigrations(client: pg.Client): Promise<AppliedMigration[]> {
  const { rows } = await client.query<{ present: boolean }>(
    'select to_regclass($1) is not null as present',
    [JOURNAL],
  );
  if (rows[0]?.present !== true) return [];
  const applied = await client.query<{ hash: string; created_at: string }>(
    `select hash, created_at from ${JOURNAL} order by id`,
  );
  return applied.rows.map((row) => ({ hash: row.hash, createdAt: row.created_at }));
}

/**
 * Applies every migration not yet in the journal, in order, as the migration identity.
 *
 * Safe to repeat: applied migrations are skipped. Before anything is applied the folder is checked against the
 * journal (see migration-history.ts): an applied migration that was edited or removed, or a new one dated before
 * one that has run, stops the run, because the migrator would otherwise skip it without a word. The migrations
 * of one run are applied in one transaction, so a statement that cannot run in a transaction (CREATE INDEX
 * CONCURRENTLY, a new enum value used in the same run) cannot be part of a migration. Safe to run twice at once: a session advisory lock
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
      const folder = options.folder ?? MIGRATIONS_FOLDER;
      const files = readMigrationFolder(folder);
      const before = await appliedMigrations(client);
      const problems = [...files.problems, ...checkAgainstApplied(files.migrations, before)];
      if (problems.length > 0) throw new MigrationHistoryError(problems);

      await migrate(drizzle(client), { migrationsFolder: folder });
      return { applied: (await appliedMigrations(client)).length - before.length };
    } finally {
      await client.query(`select pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    await client.end();
  }
}

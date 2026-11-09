import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

import { ADVISORY_CLASSES } from '../../platform/database/policy-lock/lock-keys.js';
import { postgresConnectionSettings } from '../../platform/database/postgres-url.js';
import {
  checkAgainstApplied,
  MigrationHistoryError,
  readMigrationFolder,
  type AppliedMigration,
} from './migration-history.js';
import { MigrationLockOrderError, policyKeysOfRun, scanPolicyKeys } from './policy-keys.js';
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
 * Whether the primitive of the policy keys exists (`melarc.lock_policy_keys`, migration 0017). A database that does not have it yet has no policy tables and no
 * session, so nothing the application does can wait for the migrator: the run then has no key to take first.
 */
async function hasPolicyKeyPrimitive(client: pg.Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regprocedure('melarc.lock_policy_keys(uuid[],text[])') is not null as present",
  );
  return rows[0]?.present === true;
}

/** The policy keys this connection holds now, as `class:key` (the two-number form of an advisory lock; the migrator's own session lock has the other form). */
async function policyKeysHeld(client: pg.Client): Promise<Set<string>> {
  const { rows } = await client.query<{ held: string }>(
    `select l.classid::text || ':' || l.objid::text as held
       from pg_locks l
      where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 2
        and l.classid in ($1::oid, $2::oid)`,
    [ADVISORY_CLASSES.AUTH_POLICY_BUNDLE, ADVISORY_CLASSES.AUTH_POLICY_FIXED],
  );
  return new Set(rows.map((row) => row.held));
}

/**
 * Applies every migration not yet in the journal, in order, as the migration identity.
 *
 * Safe to repeat: applied migrations are skipped. Before anything is applied the folder is checked against the
 * journal (see migration-history.ts): an applied migration that was edited or removed, or a new one dated before
 * one that has run, stops the run, because the migrator would otherwise skip it without a word. The migrations
 * of one run are applied in one transaction, so a statement that cannot run in a transaction (CREATE INDEX
 * CONCURRENTLY, a new enum value used in the same run) cannot be part of a migration.
 *
 * **The policy keys come first** (run 4, Stage 1, item 3). The application takes a policy key (shared) and then writes
 * a table; a migration that takes a table lock (an index build, an `ALTER TABLE audit_event`) and then, in a later
 * file of the same run, asks for a key, waits for an application transaction that is waiting for the table: a
 * deadlock. So the first statement of the run's transaction takes every key that any of its files names
 * (`melarc.lock_policy_keys`, read from their text: `policy-keys.ts`), in the canonical order, and the files' own
 * calls then take them again, which waits for nobody. A file that names a key the runner cannot read refuses the run
 * before anything is applied, and a file that takes a key the run had not taken first takes the whole run back
 * (`MigrationLockOrderError`). A database that does not have the primitive yet (0017) has no session that could wait,
 * and the run has no key to take first.
 *
 * Safe to run twice at once: a session advisory lock makes a second run wait for the first and then find nothing to do. It never touches a database it was
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

      await applyPending(client, folder, files.migrations);
      return { applied: (await appliedMigrations(client)).length - before.length };
    } finally {
      await client.query(`select pg_advisory_unlock(${LOCK})`);
    }
  } finally {
    await client.end();
  }
}

/**
 * The migrator's own loop (the one of drizzle's `migrate()`, over the same files and the same journal table), so that the transaction is this module's and its
 * first statement can be the keys. A migration is pending when its `when` is later than the latest one the journal holds.
 */
async function applyPending(
  client: pg.Client,
  folder: string,
  named: readonly { readonly tag: string; readonly when: number }[],
): Promise<void> {
  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  );
  const latest = await client.query<{ created_at: string | null }>(
    'select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1',
  );
  const last = latest.rows[0]?.created_at;
  const pending = readMigrationFiles({ migrationsFolder: folder }).filter(
    (migration) => last === undefined || last === null || Number(last) < migration.folderMillis,
  );
  if (pending.length === 0) return;

  const tagOf = new Map(named.map((migration) => [migration.when, migration.tag]));
  const scans = pending.map((migration) => ({
    tag: tagOf.get(migration.folderMillis) ?? String(migration.folderMillis),
    scan: scanPolicyKeys(migration.sql),
  }));
  const unsaid = scans.flatMap(({ tag, scan }) => scan.unresolved.map((call) => `${tag}: ${call}`));
  if (unsaid.length > 0) throw new MigrationLockOrderError(unsaid);
  const keys = policyKeysOfRun(scans.map(({ scan }) => scan));

  await client.query('begin');
  try {
    // The first statements of the run: every key its files name, in the canonical order, before any file runs.
    const guarded = await hasPolicyKeyPrimitive(client);
    if (guarded && keys.bundleIds.length + keys.fixedTypes.length > 0) {
      await client.query('select melarc.lock_policy_keys($1::uuid[], $2::text[])', [
        keys.bundleIds,
        keys.fixedTypes,
      ]);
    }
    const taken = guarded ? await policyKeysHeld(client) : undefined;

    for (const [index, migration] of pending.entries()) {
      for (const statement of migration.sql) await client.query(statement);
      await client.query(
        'insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values($1, $2)',
        [migration.hash, migration.folderMillis],
      );
      if (taken === undefined) continue;
      const extra = [...(await policyKeysHeld(client))].filter((key) => !taken.has(key));
      if (extra.length > 0) {
        throw new MigrationLockOrderError([
          `${scans[index]?.tag ?? 'a migration'} took ${String(extra.length)} policy key(s) the run had not taken first (${extra.join(', ')})`,
        ]);
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

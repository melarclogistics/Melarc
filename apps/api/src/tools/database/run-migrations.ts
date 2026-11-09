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
import { MigrationLockOrderError, policyKeysOfFiles, type PolicyKeys } from './policy-keys.js';
import { assertMigrationIdentity } from './safety.js';

/** The one canonical migration history (DEVELOPMENT_EXECUTION_PLAN.md section 5). */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../../migrations', import.meta.url));

const JOURNAL = 'drizzle.__drizzle_migrations';
const LOCK = "hashtextextended('melarc:migrations', 0)";

export interface MigrationResult {
  /** How many migrations this run applied. Zero when the database was already current. */
  readonly applied: number;
  /** How long the whole run took, from the call to its end, on this process's monotonic clock. */
  readonly durationMs: number;
  /**
   * How long the run held the policy keys, from the moment it had all of them to its commit (or rollback): the time every sign-in and every mutation of the application
   * waited for it (run 5, Stage 1.3). Zero when the run took none: nothing to apply, or no file of it names a key.
   */
  readonly keysHeldMs: number;
  /** How many attempts the wait for the keys took; zero when it took none. */
  readonly keyAttempts: number;
}

/**
 * How the wait for the policy keys is bounded (run 5, Stage 1.3). The run needs every key its files name **exclusively**, so a transaction of the application that holds one
 * (shared) makes it wait, and what waits behind it waits too. Each attempt is a transaction of its own with a `lock_timeout` for the wait alone, so that a transaction that does not
 * end cannot hold the run, and the application behind it, for ever; the next attempt follows after a pause. Once the keys are held the run goes on under `runWaitMs`, which bounds
 * the waits of its own statements (a table lock).
 */
export interface KeyWaitSettings {
  /** How long one attempt waits for the keys, in milliseconds. */
  readonly waitMs: number;
  /** How many attempts are made before the run gives up. */
  readonly attempts: number;
  /** The pause between two attempts, in milliseconds. */
  readonly pauseMs: number;
  /** The `lock_timeout` the rest of the run works under once it holds the keys, in milliseconds. */
  readonly runWaitMs: number;
}

/** The defaults of the wait: three attempts of ten seconds, two seconds apart, so that a run that cannot take its keys stops after about thirty-four seconds. */
export const DEFAULT_KEY_WAIT = { waitMs: 10_000, attempts: 3, pauseMs: 2_000 } as const;

/** The run could not take the policy keys its files name, in as many attempts as it was allowed. Nothing of it was applied. */
export class MigrationKeyWaitError extends Error {
  constructor(
    readonly attempts: number,
    readonly waitMs: number,
    cause: unknown,
  ) {
    super(
      `The migration run could not take the policy keys its files name: ${String(attempts)} attempts of ${String(waitMs)} ms each ended on a lock timeout, because a transaction of the application (a sign-in, a mutation, a change of a bundle or of a fixed policy) holds one of them. Nothing was applied. Run it again; if it keeps happening, look for a transaction that does not end (select pid, state, xact_start, query from pg_stat_activity where state like 'idle in transaction%').`,
      { cause },
    );
    this.name = 'MigrationKeyWaitError';
  }
}

/**
 * The one line the tool tells for a run: what it applied, how long it took, and how long the application waited for the keys (the stall of a release, which is the
 * time they were held). The words `applied N migration(s)` and `up to date` are what the tests of the tool and of the upgrade read.
 */
export function describeRun(result: MigrationResult): string {
  if (result.applied === 0) return 'database is up to date, nothing applied';
  const seconds = (milliseconds: number): string => `${(milliseconds / 1000).toFixed(1)} s`;
  const applied = `applied ${String(result.applied)} migration${result.applied === 1 ? '' : 's'} in ${seconds(result.durationMs)}`;
  if (result.keysHeldMs === 0) return `${applied}; no policy key was taken`;
  const attempt = result.keyAttempts > 1 ? `, taken at attempt ${String(result.keyAttempts)}` : '';
  return `${applied}; the policy keys were held for ${seconds(result.keysHeldMs)}${attempt}, and every sign-in and mutation of the application waited that long`;
}

/** The part of a client that the wait for the keys needs: what is sent, and nothing it answers. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const pauseFor = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Whether the server ended a wait because `lock_timeout` passed (SQLSTATE 55P03, lock_not_available). */
const isLockTimeout = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '55P03';

/**
 * Begins the transaction of the run and takes in it the policy keys its files name, in the canonical order (`melarc.lock_policy_keys`), bounded and tried again as
 * `KeyWaitSettings` says. On success the transaction is **open** and holds the keys until it ends, and `takenAt` is the monotonic moment it had them; on failure nothing is
 * left open. A run with no key to take only begins. A failure that is not a lock timeout is not retried and is the caller's as it came. `pause` is the wait between two
 * attempts (the tests give one that does not wait).
 */
export async function beginAndTakeKeys(
  client: Queryable,
  keys: PolicyKeys,
  settings: KeyWaitSettings,
  pause: (milliseconds: number) => Promise<void> = pauseFor,
): Promise<{ readonly attempts: number; readonly takenAt: number | undefined }> {
  for (const [name, value, least] of [
    ['wait', settings.waitMs, 1],
    ['attempts', settings.attempts, 1],
    ['pause', settings.pauseMs, 0],
    ['run wait', settings.runWaitMs, 1],
  ] as const) {
    if (!Number.isInteger(value) || value < least) {
      throw new RangeError(
        `The ${name} of the policy key wait is a whole number of at least ${String(least)}, not ${String(value)}`,
      );
    }
  }
  if (keys.bundleIds.length + keys.fixedTypes.length === 0) {
    await client.query('begin');
    return { attempts: 0, takenAt: undefined };
  }
  for (let attempt = 1; ; attempt += 1) {
    await client.query('begin');
    try {
      // `SET LOCAL` takes no parameter: the figures are whole numbers checked above, never text from outside.
      await client.query(`set local lock_timeout = '${String(settings.waitMs)}ms'`);
      await client.query('select melarc.lock_policy_keys($1::uuid[], $2::text[])', [
        keys.bundleIds,
        keys.fixedTypes,
      ]);
      await client.query(`set local lock_timeout = '${String(settings.runWaitMs)}ms'`);
      return { attempts: attempt, takenAt: performance.now() };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (!isLockTimeout(error)) throw error;
      if (attempt >= settings.attempts) {
        throw new MigrationKeyWaitError(settings.attempts, settings.waitMs, error);
      }
      await pause(settings.pauseMs);
    }
  }
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
 * Whether the primitive of the policy keys exists (`melarc.lock_policy_keys`, migration 0017). The policy tables it takes keys for are older (migration 0003 made
 * `role_bundle`, `role_bundle_grant` and `fixed_permission_policy`), so a database below 0017 has the tables and not the primitive: the run has no key to take first
 * there, and no file of it can call a primitive that does not exist yet.
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
 * **What it costs, and how the wait is bounded** (run 5, Stage 1.3). The keys are exclusive and are held to the commit, so every sign-in and every mutation of the
 * application waits for the **whole duration of the run** (the result says how long: `keysHeldMs`), and a run with nothing to apply takes nothing. The wait for the keys is
 * bounded by a `lock_timeout` of its own, tried again in a new transaction a few times, and ends in `MigrationKeyWaitError` with nothing applied (`beginAndTakeKeys`).
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
  /** How long a run waits for another run to finish, and the `lock_timeout` of its own statements once it holds the policy keys. */
  readonly lockTimeoutMs?: number;
  /** How the wait for the policy keys is bounded and tried again; what is not given is `DEFAULT_KEY_WAIT`. */
  readonly keyWait?: Partial<Omit<KeyWaitSettings, 'runWaitMs'>>;
}): Promise<MigrationResult> {
  const started = performance.now();
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
    const runWaitMs = Math.trunc(options.lockTimeoutMs ?? 60_000);
    await client.query("select set_config('lock_timeout', $1, false)", [`${String(runWaitMs)}ms`]);
    await client.query(`select pg_advisory_lock(${LOCK})`);
    try {
      const folder = options.folder ?? MIGRATIONS_FOLDER;
      const files = readMigrationFolder(folder);
      const before = await appliedMigrations(client);
      const problems = [...files.problems, ...checkAgainstApplied(files.migrations, before)];
      if (problems.length > 0) throw new MigrationHistoryError(problems);

      const wait: KeyWaitSettings = { ...DEFAULT_KEY_WAIT, ...options.keyWait, runWaitMs };
      const { keysHeldMs, keyAttempts } = await applyPending(
        client,
        folder,
        files.migrations,
        wait,
      );
      return {
        applied: (await appliedMigrations(client)).length - before.length,
        durationMs: performance.now() - started,
        keysHeldMs,
        keyAttempts,
      };
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
  wait: KeyWaitSettings,
): Promise<{ readonly keysHeldMs: number; readonly keyAttempts: number }> {
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
  if (pending.length === 0) return { keysHeldMs: 0, keyAttempts: 0 };

  const tagOf = new Map(named.map((migration) => [migration.when, migration.tag]));
  const files = pending.map((migration) => ({
    tag: tagOf.get(migration.folderMillis) ?? String(migration.folderMillis),
    sql: migration.sql,
  }));
  // Fails closed: a mention of a policy key that the runner cannot place refuses the run, naming the file, before anything is applied.
  const keys = policyKeysOfFiles(files);

  // The first statements of the run: every key its files name, in the canonical order, before any file runs; bounded, and tried again a few times (`beginAndTakeKeys`). They
  // are held until the commit, and that is how long the application's sign-ins and mutations wait (`keysHeldMs`). A database below 0017 has no primitive and no session that
  // could wait: the run has no key to take first.
  const guarded = await hasPolicyKeyPrimitive(client);
  const { attempts, takenAt } = await beginAndTakeKeys(
    client,
    guarded ? keys : { bundleIds: [], fixedTypes: [] },
    wait,
  );
  try {
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
          `${files[index]?.tag ?? 'a migration'} took ${String(extra.length)} policy key(s) the run had not taken first (${extra.join(', ')})`,
        ]);
      }
    }
    await client.query('commit');
    return {
      keysHeldMs: takenAt === undefined ? 0 : performance.now() - takenAt,
      keyAttempts: attempts,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

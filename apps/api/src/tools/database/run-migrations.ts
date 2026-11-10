import { fileURLToPath } from 'node:url';

import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';

import { ENGINEERING_DEFAULTS, integerBetween } from '../../platform/config/config-settings.js';
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
   * How long the run held the policy keys, from the moment it had all of them to its commit (or rollback): the stall of the application's sign-ins and mutations that need one
   * (run 5, Stage 1.3). They wait for it, and fail with a retryable 503 once the application's lock timeout has passed (`applicationLockTimeoutMs`, run 6, Stage 1.1). Zero when
   * the run took none: nothing to apply, or no file of it names a key.
   */
  readonly keysHeldMs: number;
  /**
   * How long the run waited for the keys before it held them, from its first attempt to the moment it had them: the attempts that timed out and the pauses between them
   * included (run 6, Stage 1.1). What asks for one of the keys while the run waits queues behind the run, so this is a stall of the application as well. Zero when the run took none.
   */
  readonly keyWaitMs: number;
  /** How many attempts the wait for the keys took; zero when it took none. */
  readonly keyAttempts: number;
  /** The application's lock timeout the wait was kept shorter than (`DATABASE_LOCK_TIMEOUT_MS`), in milliseconds. */
  readonly applicationLockTimeoutMs: number;
}

/**
 * How the wait for the policy keys is bounded (run 5, Stage 1.3; run 6, Stage 1.1). The run needs every key its files name **exclusively**, so a transaction of the application
 * that holds one (shared) makes it wait, and what asks for the same key behind it queues behind it (a shared request waits behind a waiting exclusive one). The application takes
 * its shared key under its own `lock_timeout` (`applicationLockTimeoutMs`), and a lock timeout there is a retryable 503, not a retry: so each attempt is a transaction of its own
 * with a `lock_timeout` for the wait alone, **shorter than the application's**, that lets what queued behind it through before it times out, and is followed by a pause, then by the
 * next attempt. A transaction that does not end cannot hold the run, and the application behind it, for ever. Once the keys are held the run goes on under `runWaitMs`, which bounds
 * the waits of its own statements (a table lock).
 */
export interface KeyWaitSettings {
  /** The application's own `lock_timeout` for its policy keys (`DATABASE_LOCK_TIMEOUT_MS`), in milliseconds: every attempt waits for less. */
  readonly applicationLockTimeoutMs: number;
  /** How long one attempt waits for the keys, in milliseconds: less than `applicationLockTimeoutMs`. */
  readonly waitMs: number;
  /** How many attempts are made before the run gives up. */
  readonly attempts: number;
  /** The pause between two attempts, in milliseconds. */
  readonly pauseMs: number;
  /** The `lock_timeout` the rest of the run works under once it holds the keys, in milliseconds. */
  readonly runWaitMs: number;
}

/** What the application accepts for `DATABASE_LOCK_TIMEOUT_MS` (`config-settings.ts`): a whole number of milliseconds from 100 to 60000. */
const APPLICATION_LOCK_TIMEOUT = { least: 100, most: 60_000 } as const;

const isApplicationLockTimeout = (value: number): boolean =>
  Number.isInteger(value) &&
  value >= APPLICATION_LOCK_TIMEOUT.least &&
  value <= APPLICATION_LOCK_TIMEOUT.most;

/** About how long a run keeps trying for its keys before it gives up, the waits of its attempts and the pauses between them together. */
export const KEY_WAIT_PATIENCE_MS = 30_000;

/**
 * The wait for the keys that goes with an application's lock timeout: attempts of three quarters of it (1.5 s for the default of 2 s), a quarter of it apart (so that what queued
 * behind an attempt is served before the next begins), and as many as take about thirty seconds in all.
 */
export function keyWaitFor(applicationLockTimeoutMs: number): Omit<KeyWaitSettings, 'runWaitMs'> {
  if (!isApplicationLockTimeout(applicationLockTimeoutMs)) {
    throw new RangeError(
      `The application's lock timeout (DATABASE_LOCK_TIMEOUT_MS) is a whole number of milliseconds from ${String(APPLICATION_LOCK_TIMEOUT.least)} to ${String(APPLICATION_LOCK_TIMEOUT.most)}, not ${String(applicationLockTimeoutMs)}`,
    );
  }
  const waitMs = Math.floor((applicationLockTimeoutMs * 3) / 4);
  const pauseMs = Math.floor(applicationLockTimeoutMs / 4);
  return {
    applicationLockTimeoutMs,
    waitMs,
    pauseMs,
    attempts: Math.ceil(KEY_WAIT_PATIENCE_MS / (waitMs + pauseMs)),
  };
}

/** The wait for the keys when the application runs with its own default lock timeout: fifteen attempts of 1.5 s, 0.5 s apart. */
export const DEFAULT_KEY_WAIT = keyWaitFor(Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS));

/**
 * The application's lock timeout as the environment of the run gives it (`DATABASE_LOCK_TIMEOUT_MS`, the setting the application reads under the same name and the same rules),
 * or the application's own default when it gives none. The run keeps each attempt's wait shorter than it, so the environment of the release step carries the value the
 * application runs with. A value the application would refuse is refused here, naming the setting and never what it held.
 */
export function applicationLockTimeoutOf(
  environment: Readonly<Record<string, string | undefined>>,
): number {
  const given = environment.DATABASE_LOCK_TIMEOUT_MS;
  if (given === undefined || given === '')
    return Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS);
  const parsed = integerBetween(
    APPLICATION_LOCK_TIMEOUT.least,
    APPLICATION_LOCK_TIMEOUT.most,
  ).safeParse(given);
  if (!parsed.success) {
    throw new RangeError(
      `DATABASE_LOCK_TIMEOUT_MS is a whole number of milliseconds from ${String(APPLICATION_LOCK_TIMEOUT.least)} to ${String(APPLICATION_LOCK_TIMEOUT.most)}, as the application reads it: the migration run keeps its wait for the policy keys shorter than that`,
    );
  }
  return parsed.data;
}

/** The run could not take the policy keys its files name, in as many attempts as it was allowed. Nothing of it was applied. */
export class MigrationKeyWaitError extends Error {
  constructor(
    readonly attempts: number,
    readonly waitMs: number,
    readonly pauseMs: number,
    /** How long the run waited in all: its attempts, each timed out, and the pauses between them. */
    readonly waitedMs: number,
    cause: unknown,
  ) {
    super(
      `The migration run could not take the policy keys its files name: ${String(attempts)} attempts of ${String(waitMs)} ms each (${String(pauseMs)} ms apart) ended on a lock timeout, after waiting ${seconds(waitedMs)} in all, because a transaction of the application (a sign-in, a mutation, a change of a bundle or of a fixed policy) holds one of them. Nothing was applied. Run it again; if it keeps happening, look for a transaction that does not end (select pid, state, xact_start, query from pg_stat_activity where state like 'idle in transaction%').`,
      { cause },
    );
    this.name = 'MigrationKeyWaitError';
  }
}

/** Milliseconds as the tool's lines tell them: seconds, to a tenth. */
function seconds(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

/**
 * The one line the tool tells for a run: what it applied, how long it took, how long it waited for the keys and how long it held them (the stall of a release: a sign-in or a
 * mutation held up by the run waits, and fails with a retryable 503 once the application's lock timeout has passed). The words `applied N migration(s)` and `up to date` are what
 * the tests of the tool and of the upgrade read.
 */
export function describeRun(result: MigrationResult): string {
  if (result.applied === 0) return 'database is up to date, nothing applied';
  const applied = `applied ${String(result.applied)} migration${result.applied === 1 ? '' : 's'} in ${seconds(result.durationMs)}`;
  if (result.keysHeldMs === 0) return `${applied}; no policy key was taken`;
  const attempt = result.keyAttempts > 1 ? ` (taken at attempt ${String(result.keyAttempts)})` : '';
  return `${applied}; waited ${seconds(result.keyWaitMs)} for the policy keys${attempt} and held them for ${seconds(result.keysHeldMs)}; a sign-in or mutation held up by the run fails with a retryable 503 after the application's lock timeout of ${seconds(result.applicationLockTimeoutMs)}`;
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
 * `KeyWaitSettings` says. On success the transaction is **open** and holds the keys until it ends, `takenAt` is the monotonic moment it had them and `waitedMs` how long it
 * waited for them in all (the attempts that timed out and the pauses between them included); on failure nothing is left open. A run with no key to take only begins. A failure
 * that is not a lock timeout is not retried and is the caller's as it came. Every attempt waits for less than the application's own lock timeout, and settings that say
 * otherwise are refused before anything is sent. `pause` is the wait between two attempts and `now` the monotonic clock (the tests give one that does not wait, and one they hold).
 */
export async function beginAndTakeKeys(
  client: Queryable,
  keys: PolicyKeys,
  settings: KeyWaitSettings,
  pause: (milliseconds: number) => Promise<void> = pauseFor,
  now: () => number = () => performance.now(),
): Promise<{
  readonly attempts: number;
  readonly takenAt: number | undefined;
  readonly waitedMs: number;
}> {
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
  if (!isApplicationLockTimeout(settings.applicationLockTimeoutMs)) {
    throw new RangeError(
      `The application's lock timeout (DATABASE_LOCK_TIMEOUT_MS) is a whole number of milliseconds from ${String(APPLICATION_LOCK_TIMEOUT.least)} to ${String(APPLICATION_LOCK_TIMEOUT.most)}, not ${String(settings.applicationLockTimeoutMs)}`,
    );
  }
  if (settings.waitMs >= settings.applicationLockTimeoutMs) {
    throw new RangeError(
      `An attempt to take the policy keys waits for less than the application's lock timeout (${String(settings.applicationLockTimeoutMs)} ms), not ${String(settings.waitMs)} ms: a sign-in or a mutation that queues behind the run would be refused by its own timeout before the attempt ended`,
    );
  }
  if (keys.bundleIds.length + keys.fixedTypes.length === 0) {
    await client.query('begin');
    return { attempts: 0, takenAt: undefined, waitedMs: 0 };
  }
  const startedAt = now();
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
      const takenAt = now();
      return { attempts: attempt, takenAt, waitedMs: takenAt - startedAt };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      if (!isLockTimeout(error)) throw error;
      if (attempt >= settings.attempts) {
        throw new MigrationKeyWaitError(
          settings.attempts,
          settings.waitMs,
          settings.pauseMs,
          now() - startedAt,
          error,
        );
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
 * **What it costs, and how the wait is bounded** (run 5, Stage 1.3; run 6, Stage 1.1). The keys are exclusive and are held to the commit, so every sign-in and every mutation
 * of the application that needs one is held up for as long as the run holds them, and **fails with a retryable 503 once the application's lock timeout has passed** (it does not
 * wait for the run; `keysHeldMs` says how long the hold was), and a run with nothing to apply takes nothing. The run's own wait for the keys is a stall as well, since what asks for
 * a key queues behind a waiting exclusive request (`keyWaitMs`): each attempt waits for less than the application's lock timeout (`applicationLockTimeoutMs`), so that what queued
 * behind it is let through before it times out, then pauses and tries again in a new transaction a number of times, and ends in `MigrationKeyWaitError` with nothing applied and
 * the time it waited (`beginAndTakeKeys`).
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
  /**
   * The application's own lock timeout (`DATABASE_LOCK_TIMEOUT_MS`), which every attempt to take the policy keys waits for less than (`applicationLockTimeoutOf` reads it from an
   * environment); what is not given is the application's default, 2000.
   */
  readonly applicationLockTimeoutMs?: number;
  /** How the wait for the policy keys is bounded and tried again; what is not given follows from `applicationLockTimeoutMs` (`keyWaitFor`). */
  readonly keyWait?: Partial<Pick<KeyWaitSettings, 'waitMs' | 'attempts' | 'pauseMs'>>;
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

      const applicationLockTimeoutMs =
        options.applicationLockTimeoutMs ?? Number(ENGINEERING_DEFAULTS.DATABASE_LOCK_TIMEOUT_MS);
      const wait: KeyWaitSettings = {
        ...keyWaitFor(applicationLockTimeoutMs),
        ...options.keyWait,
        runWaitMs,
      };
      const { keysHeldMs, keyWaitMs, keyAttempts } = await applyPending(
        client,
        folder,
        files.migrations,
        wait,
      );
      return {
        applied: (await appliedMigrations(client)).length - before.length,
        durationMs: performance.now() - started,
        keysHeldMs,
        keyWaitMs,
        keyAttempts,
        applicationLockTimeoutMs,
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
): Promise<{
  readonly keysHeldMs: number;
  readonly keyWaitMs: number;
  readonly keyAttempts: number;
}> {
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
  if (pending.length === 0) return { keysHeldMs: 0, keyWaitMs: 0, keyAttempts: 0 };

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
  const { attempts, takenAt, waitedMs } = await beginAndTakeKeys(
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
      keyWaitMs: waitedMs,
      keyAttempts: attempts,
    };
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}

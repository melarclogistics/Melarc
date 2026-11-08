/**
 * The shard of the database tests a job runs (task CI.2). The whole database suite takes longer than a hosted job may last, so CI cuts it into N
 * shards that are N jobs: the job `i` of `N` sets `MELARC_DB_SHARD=i/N` and `vitest.config.ts` hands that to Vitest's own `shard`, which keeps the
 * test files whose place in its order falls in the shard, across both database projects (the shards together hold every file once, and
 * `src/database-test-isolation.test.ts` and `scripts/db-shards.test.ts` hold that). Everywhere else the variable is not set and every file runs:
 * the gate, a developer's run, `pnpm run test:affected`.
 *
 * Only the database job sets it: the unit and process projects are not cut by it, because only the database jobs of CI run with it set.
 */
export const DATABASE_SHARD_VARIABLE = 'MELARC_DB_SHARD';

/** The most shards a run may be cut into: a typo (`1/300`) is refused, not run as a run that holds almost nothing. */
export const MOST_DATABASE_SHARDS = 16;

/**
 * The shard the environment asks for, in Vitest's own form (`<index>/<count>`), or undefined when none is asked for. A value that is set and
 * is not a shard of the form `i/N` (whole numbers, 1 <= i <= N <= 16) is an error: a run that silently ran every file, or none, would pass for
 * the wrong reason.
 */
export function databaseShard(
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const value = environment[DATABASE_SHARD_VARIABLE];
  if (value === undefined || value === '') return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index > count || count > MOST_DATABASE_SHARDS) {
    throw new Error(
      `${DATABASE_SHARD_VARIABLE} is "${value}": use <shard>/<shards>, whole numbers with the shard from 1 to the number of shards and at most ${String(MOST_DATABASE_SHARDS)} shards, for example 2/4.`,
    );
  }
  return value;
}

/**
 * The setting of Vitest's configuration for the environment: `{ shard }` when a shard is asked for and nothing otherwise. Vitest's types list
 * `shard` among the options of its command line and not of `defineConfig`, but it reads it from the resolved configuration all the same (the
 * command line's flag lands in the same place), so the setting is spread into the configuration; `scripts/db-shards.test.ts` cuts the files with
 * Vitest's own sequencer on the configuration this gives, and fails if the variable does not reach it.
 */
export function databaseShardOption(environment: Readonly<Record<string, string | undefined>>): {
  shard?: string;
} {
  const shard = databaseShard(environment);
  return shard === undefined ? {} : { shard };
}

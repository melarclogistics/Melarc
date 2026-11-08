import { configDefaults, defineConfig } from 'vitest/config';

import { databaseShardOption } from './test/database-shard.js';
import { TIMING_SENSITIVE_TESTS, skipsTimingTests } from './test/timing-sensitive-tests.js';

/**
 * Four projects, run in this order:
 *
 *   unit            in-process tests; no database, no child process
 *   process         tests that start the built API as a child process, and the helpers that do it
 *   database        tests that need the local PostgreSQL service (`pnpm test:db`, not part of `pnpm test`), each file over a
 *                   database of its own, several files at a time
 *   database-alone  the database tests that change what every database of the server shares (roles, their passwords and
 *                   memberships, other databases, server settings) or watch the whole server, and those whose time bounds or
 *                   weight do not survive files beside them: one file at a time, and only once every file of `database` has
 *                   finished, so that nothing else runs beside them
 *
 * The process tests have absolute deadlines (test/support/api-process.ts) on a Node start that costs
 * seconds. Run beside the rest of the suite, they compete with every other file's imports and miss
 * those deadlines, so they run after the unit project, one file at a time. The deadlines guard against a
 * hang and leave room for a busy workstation (the owner's decision of 27 October 2026), so a test or a hook
 * of the projects that start processes or use the database may take a minute; a unit test keeps 20 seconds.
 *
 * A database test goes in `test/database/` unless it changes or reads state the whole server shares, or its bounds need the
 * machine to itself; then it goes in `test/database/alone/`, saying why. `src/database-test-isolation.test.ts` holds that. Each
 * database file also holds the server for its lifetime (test/database/support/server-hold.ts): shared beside the others, alone
 * in `database-alone`, so the separation does not rest on the scheduler alone.
 *
 * Workers: `MELARC_TEST_WORKERS` bounds the parallel projects (4 when it is not set: at Vitest's default this 16 GB workstation
 * runs out of memory) and `MELARC_DB_WORKERS` the `database` project (3). Never `VITEST_MAX_WORKERS`: Vitest applies it to every
 * project after its configuration, so it would run the one-at-a-time projects several at a time. This configuration refuses it.
 */
if (process.env.VITEST_MAX_WORKERS !== undefined && process.env.VITEST_MAX_WORKERS !== '') {
  throw new Error(
    'VITEST_MAX_WORKERS is set: Vitest would apply it to every project, so the API tests that must run one file at a time would run several at a time. Unset it; MELARC_TEST_WORKERS and MELARC_DB_WORKERS bound the workers.',
  );
}
const TEST_WORKERS = workers('MELARC_TEST_WORKERS', 4);
const DATABASE_WORKERS = workers('MELARC_DB_WORKERS', 3);
/** Vitest's limit for a test or a hook of the projects that start processes or use the database: room for the waits of api-process.ts. */
const PROCESS_TEST_TIMEOUT = 60_000;

export default defineConfig({
  test: {
    environment: 'node',
    // Node earlier than 24.19/24.20 on Windows can abort a forked worker (exit code 0xC0000409) while
    // it tears down, because of a libuv race fixed upstream in nodejs/node#61999. About 3% of runs
    // lost a worker. Threads do not hit it. Return to the default pool once the pinned Node has the fix.
    pool: 'threads',
    maxWorkers: TEST_WORKERS,
    passWithNoTests: false,
    // The database job of CI runs one shard of the database tests (`MELARC_DB_SHARD=<shard>/<shards>`, test/database-shard.ts): the whole
    // suite is longer than a job may last. Not set anywhere else, so every file runs in the gate and on a developer's machine.
    ...databaseShardOption(process.env),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'process',
          include: ['test/*.test.ts', 'test/support/**/*.test.ts'],
          fileParallelism: false,
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database',
          include: ['test/database/*.test.ts'],
          globalSetup: ['test/database/support/global-setup.ts'],
          // A failed test prints the evidence of the server errors its kit's clients saw (C03 of the closeout of 22 October 2026);
          // the file shares the server with the files beside it.
          setupFiles: [
            'test/database/support/failure-evidence-setup.ts',
            'test/database/support/hold-shared.ts',
          ],
          // Each file makes, uses and drops a database of its own, and touches nothing the server shares.
          fileParallelism: DATABASE_WORKERS > 1,
          maxWorkers: DATABASE_WORKERS,
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database-alone',
          include: ['test/database/alone/*.test.ts'],
          // The tests whose assertions are wall-clock time are left out of a pull request's run (`MELARC_SKIP_TIMING_TESTS=1`, set by the job of a pull request in
          // .github/workflows/ci.yml) and run on a push to main, in the nightly run, in a manual run and in the gate: test/timing-sensitive-tests.ts says why.
          exclude: skipsTimingTests(process.env)
            ? [...configDefaults.exclude, ...TIMING_SENSITIVE_TESTS]
            : configDefaults.exclude,
          globalSetup: ['test/database/support/global-setup.ts'],
          setupFiles: [
            'test/database/support/failure-evidence-setup.ts',
            'test/database/support/hold-alone.ts',
          ],
          // The roles are cluster-wide, and these tests change them and put them back, so they take turns, after every other file.
          fileParallelism: false,
          testTimeout: PROCESS_TEST_TIMEOUT,
          hookTimeout: PROCESS_TEST_TIMEOUT,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});

function workers(name: string, otherwise: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return otherwise;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error(`${name} is "${value}": a whole number from 1 to 16.`);
  }
  return count;
}

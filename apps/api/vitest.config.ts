import { defineConfig } from 'vitest/config';

/**
 * Three projects, run in this order:
 *
 *   unit      in-process tests; no database, no child process
 *   process   tests that start the built API as a child process, and the helpers that do it
 *   database  tests that need the local PostgreSQL service (`pnpm test:db`, not part of `pnpm test`)
 *
 * The process tests have absolute deadlines (test/support/api-process.ts) on a Node start that costs
 * seconds. Run beside the rest of the suite, they compete with every other file's imports and miss
 * those deadlines, so they run after the unit project, one file at a time. Nothing about them is looser.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // Node earlier than 24.19/24.20 on Windows can abort a forked worker (exit code 0xC0000409) while
    // it tears down, because of a libuv race fixed upstream in nodejs/node#61999. About 3% of runs
    // lost a worker. Threads do not hit it. Return to the default pool once the pinned Node has the fix.
    pool: 'threads',
    passWithNoTests: false,
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
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: 'database',
          include: ['test/database/**/*.test.ts'],
          globalSetup: ['test/database/support/global-setup.ts'],
          // The roles are cluster-wide, and some tests change them and put them back, so files take turns.
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

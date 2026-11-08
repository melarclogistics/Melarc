import { defineConfig } from 'vitest/config';

/** The harness's own tests. They need no database and no browser: the real stack is exercised by `pnpm run test:e2e`. */
export default defineConfig({
  test: {
    environment: 'node',
    // At Vitest's default the 16 GB workstation runs out of memory and loses tests that pass alone (DEVELOPMENT.md).
    maxWorkers: testWorkers(process.env.MELARC_TEST_WORKERS),
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['harness/**/*.test.ts'],
  },
});

/** `MELARC_TEST_WORKERS` bounds the workers, 4 when it is not set. */
function testWorkers(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 4;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new Error(`MELARC_TEST_WORKERS is "${value}": a whole number from 1 to 16.`);
  }
  return count;
}

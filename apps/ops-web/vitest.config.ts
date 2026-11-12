import { resolve } from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    // At Vitest's default the 16 GB workstation runs out of memory and loses tests that pass alone (DEVELOPMENT.md).
    maxWorkers: testWorkers(process.env.MELARC_TEST_WORKERS),
    passWithNoTests: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
          setupFiles: ['./test/setup-components.ts'],
        },
      },
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
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

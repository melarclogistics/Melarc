import { defineConfig } from 'vitest/config';

/** The harness's own tests. They need no database and no browser: the real stack is exercised by `pnpm run test:e2e`. */
export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['harness/**/*.test.ts'],
  },
});

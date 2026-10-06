import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: false,
    // The generator parses the whole 700 KB contract, and several tests start it in a child process.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});

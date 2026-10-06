import { defineConfig, devices } from '@playwright/test';

/**
 * The integrated harness: a real browser against the Ops build, the real API and a real, disposable PostgreSQL
 * database. Global setup starts them once; the specs share them and isolate themselves with deterministic data
 * of their own. It needs the built applications and the local PostgreSQL service (`pnpm run build` first, then
 * `pnpm run test:e2e`).
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One stack, one database: specs run one at a time, in a fixed order, so a failure is the same every time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: process.env.CI !== undefined,
  reporter: 'list',
  timeout: 60_000,
  outputDir: './test-results/artifacts',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // A service worker's own requests do not pass through the boundary on the browser context (harness/browser-guard.ts).
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium in its new headless mode, as the Ops smoke test uses it.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
});

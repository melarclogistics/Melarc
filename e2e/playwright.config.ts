import { defineConfig, devices } from '@playwright/test';

import { NO_EVIDENCE, withoutPageSnapshots } from './harness/evidence-policy.ts';

// Playwright writes a snapshot of the page, as text, into `error-context.md` for every failing test, whatever the recorders are set
// to, unless told not to. The runner and each worker load this file, so the variable is set in all of them
// (harness/evidence-policy.ts says why).
withoutPageSnapshots();

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
      // Every spec but the ones that show a secret. The full Chromium in its new headless mode, as the Ops smoke test uses it.
      testMatch: '**/*.spec.ts',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      // The specs that show a secret (`<name>.secret.test.ts`): the same browser with the trace, the video and the screenshots off
      // (harness/evidence-policy.ts). No other project matches them, and this one matches nothing else.
      name: 'chromium-secret',
      testMatch: '**/*.secret.test.ts',
      use: { ...devices['Desktop Chrome'], channel: 'chromium', ...NO_EVIDENCE },
    },
  ],
});

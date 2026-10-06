import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;

/**
 * Browser smoke test of the application shell, in a real browser against the production build served
 * the way a static host would serve it. It needs no API and no database: the shell calls neither. The
 * integrated browser, API and database harness is a later bootstrap task.
 */
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  reporter: 'list',
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      // The full Chromium in its new headless mode, not the separate stripped-down headless shell: it is
      // the browser engine users run, and `playwright install chromium` is all a machine needs.
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
  ],
  webServer: {
    // Always a fresh build, and never a server that was already running: that could be stale.
    command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: ORIGIN,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

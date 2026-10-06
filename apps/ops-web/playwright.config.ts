import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
const PREVIEW_ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}`;
const DEV_PORT = 5199;
const DEV_ORIGIN = `http://127.0.0.1:${String(DEV_PORT)}`;

const ENGINES = {
  // The full Chromium in its new headless mode, not the separate stripped-down headless shell: it is
  // the browser engine users run, and `playwright install chromium` is all a machine needs.
  chromium: { ...devices['Desktop Chrome'], channel: 'chromium' },
  firefox: { ...devices['Desktop Firefox'] },
  webkit: { ...devices['Desktop Safari'] },
} as const;

type Engine = keyof typeof ENGINES;

const isEngine = (name: string): name is Engine => Object.hasOwn(ENGINES, name);

/**
 * The engines to run: MELARC_BROWSERS, a comma-separated list of chromium, firefox and webkit. CI runs all three
 * (the supported browsers of surfaces/ops-portal.md section 11, by their engines). Without the variable only Chromium
 * runs, so a machine that has installed only Chromium works; the others need `playwright install firefox webkit`.
 */
function requestedEngines(value: string | undefined): Engine[] {
  // An empty value is "not set", as `MELARC_BROWSERS= command` leaves it in a POSIX shell.
  const names = (value === undefined || value.trim() === '' ? 'chromium' : value)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  if (names.length === 0) throw new Error('MELARC_BROWSERS names no browser.');
  return names.map((name) => {
    if (!isEngine(name)) {
      throw new Error(
        `MELARC_BROWSERS names "${name}", which is not a browser here. Use chromium, firefox or webkit.`,
      );
    }
    return name;
  });
}

/**
 * Browser tests of the application, in real browsers.
 *
 *   shell       the application shell, against the production build served the way a static host would serve it.
 *               It needs no API and no database: the shell calls neither.
 *   components  the real components in the development-only showcase, which the production build does not contain
 *               (test/build.test.ts proves that), so they run against the Vite development server.
 *
 * The integrated browser, API and database harness is the e2e workspace.
 */
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: process.env.CI !== undefined,
  // The component tests drive the unbundled development server, which serves every page's modules one request at a
  // time: with many pages open at once it starves and the tests time out. Two workers keep it responsive. No timeout
  // was raised and no check was loosened.
  workers: 2,
  reporter: 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: requestedEngines(process.env.MELARC_BROWSERS).flatMap((engine) => [
    {
      name: `shell-${engine}`,
      testMatch: 'shell.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      name: `components-${engine}`,
      testMatch: 'components.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
  ]),
  webServer: [
    {
      // Always a fresh build, and never a server that was already running: that could be stale.
      command: `pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port ${String(PREVIEW_PORT)} --strictPort`,
      url: PREVIEW_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite --host 127.0.0.1 --port ${String(DEV_PORT)} --strictPort`,
      url: DEV_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

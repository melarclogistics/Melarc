import { join } from 'node:path';

import { defineConfig, devices, type PlaywrightTestProject } from '@playwright/test';

import { planEngineTrust, trustRootOf, type Engine } from './harness/engine-trust.ts';
import { NO_EVIDENCE, withoutPageSnapshots } from './harness/evidence-policy.ts';
import { TLS_FILES, tlsDirectoryFrom } from './harness/tls-material.ts';

// Playwright writes a snapshot of the page, as text, into `error-context.md` for every failing test, whatever the recorders are set
// to, unless told not to. The runner and each worker load this file, so the variable is set in all of them
// (harness/evidence-policy.ts says why).
withoutPageSnapshots();

type Use = NonNullable<PlaywrightTestProject['use']>;

const DEVICES: Readonly<Record<Engine, Use>> = {
  chromium: { ...devices['Desktop Chrome'], channel: 'chromium' },
  firefox: devices['Desktop Firefox'],
  webkit: devices['Desktop Safari'],
};

/**
 * What a project of the trusted HTTPS origin (S0.23) uses: the engine's device, and the environment that engine's trust mechanism needs,
 * set in its launch options for the browser process alone (`harness/engine-trust.ts` plans it; global setup makes the stores; WebKit
 * needs none, its trust is the system store of a GitHub-hosted runner, `harness/system-trust.ts`). An engine with no disposable store
 * here (Windows, macOS) gets none and its specs fail to trust, which is the correct report. Without test certificates the specs are
 * skipped with the reason, or fail in CI (`harness/https-test.ts`), and are never green for not having run.
 */
function httpsUse(engine: Engine): Use {
  const directory = tlsDirectoryFrom(process.env);
  const plan =
    directory === undefined
      ? undefined
      : planEngineTrust(engine, {
          root: trustRootOf(directory),
          caPath: join(directory, TLS_FILES.ca),
        });
  return {
    ...DEVICES[engine],
    ...(plan?.supported === true
      ? { launchOptions: { env: { ...process.env, ...plan.trust.env } } }
      : {}),
  };
}

/**
 * The integrated harness: a real browser against the Ops build, the real API and a real, disposable PostgreSQL
 * database. Global setup starts them once; the specs share them and isolate themselves with deterministic data
 * of their own. It needs the built applications and the local PostgreSQL service (`pnpm run build` first, then
 * `pnpm run test:e2e`; the HTTPS projects are run by `pnpm run test:e2e:https`, which makes the test CA first).
 *
 * Every project is written out with its `name` and its `testMatch` (and `testIgnore`) as string literals, because
 * `scripts/test-inventory.ts` reads this file's text to prove that every spec is run by some project.
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
      // Every spec but the ones that show a secret and the ones of the HTTPS origin. The full Chromium in its new headless mode, as
      // the Ops smoke test uses it.
      testMatch: '**/*.spec.ts',
      testIgnore: '**/https-*',
      use: { ...devices['Desktop Chrome'], channel: 'chromium' },
    },
    {
      // The specs that show a secret (`<name>.secret.test.ts`): the same browser with the trace, the video and the screenshots off
      // (harness/evidence-policy.ts). No other project matches them, and this one matches nothing else.
      name: 'chromium-secret',
      testMatch: '**/*.secret.test.ts',
      testIgnore: '**/https-*',
      use: { ...devices['Desktop Chrome'], channel: 'chromium', ...NO_EVIDENCE },
    },
    // The trusted HTTPS origin, one ordinary and one secret project for each engine (tests/https-*.spec.ts and
    // tests/https-*.secret.test.ts; harness/https-run.ts runs them all).
    { name: 'https-chromium', testMatch: '**/https-*.spec.ts', use: httpsUse('chromium') },
    {
      name: 'https-chromium-secret',
      testMatch: '**/https-*.secret.test.ts',
      use: { ...httpsUse('chromium'), ...NO_EVIDENCE },
    },
    { name: 'https-firefox', testMatch: '**/https-*.spec.ts', use: httpsUse('firefox') },
    {
      name: 'https-firefox-secret',
      testMatch: '**/https-*.secret.test.ts',
      use: { ...httpsUse('firefox'), ...NO_EVIDENCE },
    },
    // WebKit has no trust to give one process (it reads the system store and nothing else), so its proofs are made in two stages
    // (harness/https-run.ts): `https-webkit-control` runs only the refusal, the test tagged `@untrusted-control`, while the system store
    // lacks the CA, and `https-webkit` runs every other spec once the CA is there. One tag and one pattern split the specs; a test
    // (harness/https-run.test.ts) holds the two projects and the tag together, so that the refusal is never run in both or in neither.
    {
      name: 'https-webkit-control',
      testMatch: '**/https-*.spec.ts',
      grep: /@untrusted-control/,
      use: httpsUse('webkit'),
    },
    {
      name: 'https-webkit',
      testMatch: '**/https-*.spec.ts',
      grepInvert: /@untrusted-control/,
      use: httpsUse('webkit'),
    },
    {
      name: 'https-webkit-secret',
      testMatch: '**/https-*.secret.test.ts',
      use: { ...httpsUse('webkit'), ...NO_EVIDENCE },
    },
    // Branded Chrome and Edge, for the owner's smoke check on a machine cleared for key material (e2e/README.md). They are Chromium, so
    // they trust the CA by the same mechanism and run the same specs; no command of the repository runs them and CI does not.
    {
      name: 'https-chrome',
      testMatch: '**/https-*.spec.ts',
      use: { ...httpsUse('chromium'), channel: 'chrome' },
    },
    {
      name: 'https-msedge',
      testMatch: '**/https-*.spec.ts',
      use: { ...httpsUse('chromium'), channel: 'msedge' },
    },
  ],
});

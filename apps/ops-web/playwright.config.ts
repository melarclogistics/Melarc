import { defineConfig, devices } from '@playwright/test';

const PREVIEW_PORT = 4173;
const PREVIEW_ORIGIN = `http://127.0.0.1:${String(PREVIEW_PORT)}`;
const DEV_PORT = 5199;
const DEV_ORIGIN = `http://127.0.0.1:${String(DEV_PORT)}`;
// The showcase built for production (`vite build --mode showcase`), served on a port of its own from a folder that is never the shell's.
const SHOWCASE_PORT = 4174;
const SHOWCASE_ORIGIN = `http://127.0.0.1:${String(SHOWCASE_PORT)}`;
const SHOWCASE_BUILD = 'node_modules/.showcase-build';

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
 * The engines to run: MELARC_BROWSERS, a comma-separated list of chromium, firefox and webkit. CI runs Chromium on every pull request
 * and all three on a push to main, every night and by hand, each engine in jobs of its own (the supported browsers of
 * surfaces/ops-portal.md section 11, by their engines; DEVELOPMENT.md, "What CI runs when"). Without the variable only Chromium
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
 * The part of the run to make: MELARC_BROWSER_SHARD, "current/total" counted from 1, which is Playwright's own `--shard`. CI runs each
 * engine as several jobs, one shard each, and the shards of an engine together run every test of it once (scripts/browser-shards.test.ts
 * proves that against this file and the workflow). Without the variable the whole run is made, which is what a developer and the gate
 * want, so a value that is not a shard is refused and not read as "no shard".
 */
function requestedShard(value: string | undefined): { current: number; total: number } | null {
  if (value === undefined || value.trim() === '') return null;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value.trim());
  const current = Number(match?.[1]);
  const total = Number(match?.[2]);
  if (match === null || current > total) {
    throw new Error(
      `MELARC_BROWSER_SHARD is "${value}", which is not a shard. Use current/total counted from 1, for example 2/7.`,
    );
  }
  return { current, total };
}

/**
 * Browser tests of the application, in real browsers.
 *
 *   shell       the application shell (the frame, the sidebar, the sheet of a narrow screen, sign-out), against the production build served
 *               the way a static host would serve it. It needs no database, and its API is a stand-in that answers who is signed in.
 *   components  the real components in the development-only showcase, which the production build does not contain
 *               (test/build.test.ts proves that), so they run against the Vite development server. The secrets and dialogs specs
 *               are the same showcase in files of their own.
 *   date-picker the date field of the showcase (COMPONENT_PATTERNS section 22a): the keyboard, reflow, enlarged text, forced colours and
 *               reduced motion, against the development server; and, in a project of its own, the same showcase built for production and
 *               served under the strict content-security policy (a build of its own, `--mode showcase`, that the shell build never holds).
 *   primitives  the shadcn/ui primitives of the showcase (`/__showcase/primitives`): an automated WCAG 2.2 scan in both themes with each overlay open,
 *               and every overlay by keyboard, against the development server; and, in a project of its own, the same page built for production
 *               and served under the strict content-security policy.
 *   logo        the logo in the banner of the sign-in screen (BRAND_FOUNDATION 4.7): the primary logo on a light ground and the all-white lockup on
 *               a dark one, read back from the pixels, against the production build under the strict policy.
 *   pre-sign-in the five screens a person reaches with no session, against the production build and, in a project of its own,
 *               the development server (strict mode), with a stand-in for the API.
 *   staff       the six signed-in identity screens (S0.44), the same two ways, with a stateful stand-in for the API.
 *   riders      the four rider screens (S0.60), the same two ways, with a stateful stand-in for the API.
 *   pickup      the four pickup screens (S1.19), the same two ways, with a stateful stand-in for the API.
 *   manifests   the four manifest screens (S1.25), the same two ways, with a stateful stand-in for the API (its custody half is written from
 *               the contract and answered by the stand-in).
 *   messages    the message log (S1.12e), the same two ways, with a stand-in for the API that plants a number, a text and a code in
 *               answers that never carry them.
 *   queue-summary the counts of the queues (task C1), the same two ways: the sidebar's counts, My work's cards, a failed read and the read again on
 *               a change of page, with a stand-in for the API that answers the summary the test gives it.
 *   top-bar     the top bar of the shell (redesign step R4), the same two ways: the hub switcher, the New menu, the account menu, the theme with its
 *               pre-paint script, and the search button.
 *   palette     the command palette (R4), the same two ways, with a stand-in for the search of records that plants wording, a link and a number
 *               in clear in answers that never carry them.
 *   my-work     My work, the landing (R4), the same two ways: its frame, its cards and each state of the read of the summary.
 *   request-rate the requests of a heavy officer's session (audit follow-up of 7 November 2026, B13) against the production build: a session of three
 *               minutes at a person's pace, counted by operation. It is skipped unless MELARC_MEASURE=1 (it takes about three and a half minutes).
 *   kit         the Melarc component kit of the showcase (`/__showcase/kit/<group>`, redesign step R5): WCAG 2.2 in both themes, sizes and looks, the keyboard,
 *               and what moves, against the development server; and, in a project of its own, the same pages built for production under the strict policy.
 *   frame-toaster the application's one toaster in the signed-in frame (the follow-up of 7 November 2026, afternoon), against the development server: a toast is
 *               raised through the module the application itself runs, which only the development server serves, so that no hook is put into the production build.
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
  shard: requestedShard(process.env.MELARC_BROWSER_SHARD),
  reporter: 'list',
  use: {
    // A trace keeps the requests and responses of a failed test. That is accepted here because every page these tests open is the
    // synthetic showcase or a stubbed shell: no real credential, token or seed is typed or received in them. It is not an authorization
    // for a test that does (S0.43's sign-in, a real seed): such a test turns tracing, screenshots and video off for its own context.
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
    {
      // The form components, the one-time secret and the QR code of the showcase (S0.39): the same server, their own spec.
      name: `secrets-${engine}`,
      testMatch: 'secrets.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The dialogs and the reason and confirmation workflow of the showcase (S0.41): what only a real browser can show of a modal.
      name: `dialogs-${engine}`,
      testMatch: 'dialogs.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The date field of the showcase (COMPONENT_PATTERNS section 22a): what only a real browser can show of a calendar.
      name: `date-picker-${engine}`,
      testMatch: 'date-picker.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The showcase as a production build under the strict content-security policy: the library's popovers, focus handling and the one style
      // it would insert must raise no violation, in every engine.
      name: `date-picker-policy-${engine}`,
      testMatch: 'date-picker-policy.spec.ts',
      use: { ...ENGINES[engine], baseURL: SHOWCASE_ORIGIN },
    },
    {
      // The shadcn/ui primitives of the showcase (DESIGN_SYSTEM section 29): WCAG 2.2 in both themes, and every overlay by keyboard, against the
      // development server.
      name: `primitives-${engine}`,
      testMatch: 'primitives.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The same page as a production build under the strict content-security policy: Radix UI and Sonner raise no violation in any engine, and the
      // styles they insert at run time are the only thing the policy was relaxed for.
      name: `primitives-policy-${engine}`,
      testMatch: 'primitives-policy.spec.ts',
      use: { ...ENGINES[engine], baseURL: SHOWCASE_ORIGIN },
    },
    {
      // The logo in the banner of the sign-in screen: the primary logo on a light ground, the all-white lockup on a dark one (BRAND_FOUNDATION 4.7),
      // against the production build under the strict policy.
      name: `logo-${engine}`,
      testMatch: 'logo.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The five pre-sign-in screens (S0.43) against the production build, with a stand-in for the API.
      name: `pre-sign-in-${engine}`,
      testMatch: 'pre-sign-in.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server, where React runs every effect twice: a page that reads a grant from a fragment is exactly
      // where that shows.
      name: `pre-sign-in-dev-${engine}`,
      testMatch: 'pre-sign-in.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The six signed-in identity screens (S0.44) against the production build, with a stateful stand-in for the API.
      name: `staff-${engine}`,
      testMatch: 'staff.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice).
      name: `staff-dev-${engine}`,
      testMatch: 'staff.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The two recovery screens and the two vendor screens (S0.52) against the production build, with stand-ins for the API.
      name: `recovery-${engine}`,
      testMatch: 'recovery.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server: the recovery link is read from a fragment, where strict mode shows.
      name: `recovery-dev-${engine}`,
      testMatch: 'recovery.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The four rider screens (S0.60) against the production build, with a stateful stand-in for the API: the enrolment code as the browser
      // painted it, and everywhere it could be left.
      name: `riders-${engine}`,
      testMatch: 'riders.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice, which a page that holds a credential must survive).
      name: `riders-dev-${engine}`,
      testMatch: 'riders.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The four pickup screens (S1.19) against the production build, with a stateful stand-in for the API that plants a price in answers
      // that never carry one.
      name: `pickup-${engine}`,
      testMatch: 'pickup.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice).
      name: `pickup-dev-${engine}`,
      testMatch: 'pickup.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The four manifest screens (S1.25) against the production build, with a stateful stand-in for the API. Its custody half is written from
      // the contract and answered by the stand-in: it plants a count of the hub's in every custody answer, which no screen may draw.
      name: `manifests-${engine}`,
      testMatch: 'manifests.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice).
      name: `manifests-dev-${engine}`,
      testMatch: 'manifests.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The message log (S1.12e) against the production build, with a stand-in for the API that plants a number in clear, a message's text
      // and a code in answers that never carry them.
      name: `messages-${engine}`,
      testMatch: 'messages.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice).
      name: `messages-dev-${engine}`,
      testMatch: 'messages.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The counts of the queues (task C1) against the production build, with a stand-in for the API that answers the summary a test gives it.
      name: `queue-summary-${engine}`,
      testMatch: 'queue-summary.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice, and the shell reads the summary from an effect).
      name: `queue-summary-dev-${engine}`,
      testMatch: 'queue-summary.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The requests of a heavy officer's session (B13) against the production build, with a stand-in for the API: three minutes at a person's pace,
      // counted by operation, with the busiest 60 seconds. It is skipped unless MELARC_MEASURE=1 is set: it takes about three and a half minutes.
      name: `request-rate-${engine}`,
      testMatch: 'request-rate.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The top bar of the signed-in shell (redesign step R4) against the production build, where the pre-paint script of the theme is the one
      // that ships.
      name: `top-bar-${engine}`,
      testMatch: 'top-bar.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice, and the menus and the theme are effects of the shell).
      name: `top-bar-dev-${engine}`,
      testMatch: 'top-bar.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The command palette (R4) against the production build, with a stand-in for the search of records.
      name: `palette-${engine}`,
      testMatch: 'palette.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice, and the search is made from an effect).
      name: `palette-dev-${engine}`,
      testMatch: 'palette.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // My work, the landing (R4), against the production build, with a stand-in for the summary of the queues.
      name: `my-work-${engine}`,
      testMatch: 'my-work.spec.ts',
      use: { ...ENGINES[engine], baseURL: PREVIEW_ORIGIN },
    },
    {
      // The same file against the development server (strict mode runs every effect twice, and the page reads the summary from an effect).
      name: `my-work-dev-${engine}`,
      testMatch: 'my-work.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The Melarc component kit of the showcase (redesign step R5): WCAG 2.2 in both themes, the sizes and looks only the stylesheet gives, the keyboard
      // and what moves under Motion and under reduced motion, against the development server.
      name: `kit-${engine}`,
      testMatch: 'kit.spec.ts',
      use: { ...ENGINES[engine], baseURL: DEV_ORIGIN },
    },
    {
      // The same pages built for production under the strict content-security policy: Motion and the libraries raise no violation in any engine.
      name: `kit-policy-${engine}`,
      testMatch: 'kit-policy.spec.ts',
      use: { ...ENGINES[engine], baseURL: SHOWCASE_ORIGIN },
    },
    {
      // The application's one toaster in the signed-in frame, against the development server (a toast is raised through the module that the application itself runs).
      name: `frame-toaster-${engine}`,
      testMatch: 'frame-toaster.spec.ts',
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
      // The showcase as a production build, for the strict-policy project only. It is built into a folder below node_modules (never dist, which
      // the shell's build empties at the same moment), and no deployed build contains it.
      command: `pnpm exec vite build --mode showcase --outDir ${SHOWCASE_BUILD} --emptyOutDir && pnpm exec vite preview --outDir ${SHOWCASE_BUILD} --host 127.0.0.1 --port ${String(SHOWCASE_PORT)} --strictPort`,
      url: SHOWCASE_ORIGIN,
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

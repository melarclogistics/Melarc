/**
 * The evidence policy for a browser test that puts a secret on a page (S0.23: "trace, video and screenshots off for any step that
 * shows a secret"; the audit of 11 October 2026, F06). A trace records the page's DOM and its network; a screenshot or a video records
 * what is drawn; and Playwright 1.63 writes `error-context.md` for a failing test, with a snapshot of the page **in text**, whatever
 * the three recorders are set to. A bootstrap password being typed, an MFA seed or a recovery link on screen, kept in a file that is
 * attached to a report and archived, is a secret in a second place.
 *
 * The policy is enforced by configuration, and checked on what is resolved, not on what a file says:
 *
 * - **A project of its own.** A spec that shows a secret is named `<name>.secret.test.ts`. `playwright.config.ts` runs those, and
 *   only those, in `chromium-secret`, whose options turn the three recorders off, and runs everything else in `chromium`, which
 *   does not match them. A secret spec cannot run with the recorders on because no project that records matches it.
 * - **The page snapshot is off for every test.** Playwright takes it unless `PLAYWRIGHT_NO_COPY_PROMPT` is set; the configuration
 *   sets it, in every process that loads it (the runner and each worker).
 * - **A fixture checks the resolved options.** `secret-test.ts` is the `test` a secret spec imports; its automatic fixture fails the
 *   test before it begins if a recorder is on after every `test.use` has been applied.
 * - **A check of the sources** (`secret-evidence.ts`) refuses what the configuration cannot see: a secret spec that does not import
 *   that `test`, calls `test.use`, or attaches or records anything by hand; and a file that declares a secret and is not named as one.
 *
 * What none of this can do: keep a secret out of an assertion's message. A failing `expect(...).toHaveText(secret)` prints what it
 * received, into `error-context.md` and the terminal. A secret spec compares hashes, lengths or booleans.
 */
export const NO_EVIDENCE = Object.freeze({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
} as const);

/** The marker a spec file carries (in a comment or a test title) when a step of it puts a secret on a page. */
export const SHOWS_SECRET = '@shows-secret';

/** The glob of the specs that show a secret, as `playwright.config.ts` spells it (a test compares the two). */
export const SECRET_SPECS = '**/*.secret.test.ts';

/** Whether a path is the path of a secret spec. */
export const isSecretSpec = (path: string): boolean => path.endsWith('.secret.test.ts');

/**
 * Playwright takes a snapshot of the page when a test fails and writes it into `error-context.md`, unless this variable is set.
 * Called by the configuration, so that the runner and every worker that loads it agree.
 */
export function withoutPageSnapshots(environment: NodeJS.ProcessEnv = process.env): void {
  environment.PLAYWRIGHT_NO_COPY_PROMPT = '1';
}

export type Recorder = keyof typeof NO_EVIDENCE;

const modeOf = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'mode' in value) {
    if (typeof value.mode === 'string') return value.mode;
  }
  return 'unknown';
};

/** The recorders that are not off in these resolved options (a shape that is not understood counts as on: it fails closed). */
export function recordersThatAreOn(resolved: Readonly<Record<Recorder, unknown>>): Recorder[] {
  return (Object.keys(NO_EVIDENCE) as Recorder[]).filter(
    (name) => modeOf(resolved[name]) !== 'off',
  );
}

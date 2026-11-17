/**
 * The tests of the browser suite, or one step of a test, that fail now and then on the **hosted WebKit run** and nowhere else, and that the Product Owner accepted as a known flaky problem on
 * 17 November 2026 so that they do not block (the order: "accept the failing tests as known flaky and do not let them block the merge", after the hosted run of 16 November 2026 and the
 * manual runs before it). They are data and no behaviour, so that a node test can read them (`test/known-flaky.test.ts`) and the helper (`known-flaky.ts`) can apply them.
 *
 * **What is left out, and where.** Only on the hosted WebKit jobs, which CI alone marks with `MELARC_WEBKIT_HEADED=1` (the value that launches WebKit headed under a virtual display;
 * ci.yml): a developer's WebKit, Chromium and Firefox run every one of these in full, and so does Chromium and Firefox in CI. Where only the last timing step of a test is flaky, only that step
 * is left out (`scope: 'step'`): the rest of the test, the policy checks among it, still runs on WebKit. Each is the same class: the test reads a hover, a tooltip or a focus **once, within
 * the five seconds of an assertion**, on a headed browser under a virtual display. None of them checks what the product allows, and none has failed in any other engine.
 *
 * **The list is closed.** Adding to it is the Product Owner's decision (`MAX_KNOWN_FLAKY`, held by `test/known-flaky.test.ts`, which also holds every entry to a real test and to its one
 * use). The hosted WebKit jobs have failed on eighteen different tests in the last twenty-four runs of the full matrix, a different few each time: a list of the tests that failed last is
 * not a cure for that, and the report of 17 November 2026 says so.
 *
 * **The cause was found later the same day, and it is not a loaded runner** (the first reading of these entries). The hosted WebKit job ran two workers, so two headed browsers on the one virtual
 * display, whose windows cover each other: the page underneath is hidden to itself and gets no pointer and no focus. The hosted run of main of 17 November 2026 failed a test of the kit that waits on a
 * toast's timer, twice in a row, with the other worker's window up for the whole of its run. A run that launches WebKit headed now uses one worker (`playwright.config.ts`, held by
 * `test/playwright-workers.test.ts`). **Whether this list is still needed is for the Product Owner to say once the full matrix has run clean with one worker**; nothing here is removed before that.
 */
export interface KnownFlaky {
  readonly id: string;
  /** The spec file, in `test/browser`. */
  readonly file: string;
  /** The title of the test, as the spec writes it. */
  readonly title: string;
  /** `test`: the whole test is left out on the hosted WebKit run. `step`: one step of it is, and the test runs on. */
  readonly scope: 'test' | 'step';
  /** What the flaky part checks, in a few words. */
  readonly what: string;
  /** The hosted runs of the workflow it failed in (the run numbers of GitHub Actions). */
  readonly failedIn: readonly string[];
}

/** The most entries the list may hold: one more is the Product Owner's decision. */
export const MAX_KNOWN_FLAKY = 6;

export const KNOWN_FLAKY_ON_HOSTED_WEBKIT = [
  {
    id: 'loading-button-fill-under-pointer',
    file: 'components.spec.ts',
    title: 'a loading button keeps its fill under the pointer, and an ordinary one changes it',
    scope: 'test',
    what: 'the fill of a button read once, right after the pointer was moved onto it',
    failedIn: ['#137', '#147'],
  },
  {
    id: 'rail-tooltip-on-hover-and-focus',
    file: 'components.spec.ts',
    title:
      'shows the name of an entry of the rail in a tooltip on hover and on focus, and Escape takes it away',
    scope: 'test',
    what: 'a tooltip that has to appear within five seconds of a hover and of a focus',
    failedIn: ['#145'],
  },
  {
    id: 'date-field-pointer-states',
    file: 'date-picker.spec.ts',
    title:
      'draws the invalid border, today and the days that are not in the month, and answers the pointer',
    scope: 'step',
    what: 'the background of a day read once after a hover and after a press',
    failedIn: ['#147'],
  },
  {
    id: 'account-menu-heading-focus',
    file: 'top-bar.spec.ts',
    title: 'goes to the trusted browsers and lands on that page’s heading',
    scope: 'step',
    what: 'focus on the heading of the page the account menu went to',
    failedIn: ['#147'],
  },
  {
    id: 'new-menu-heading-focus',
    file: 'top-bar.spec.ts',
    title:
      'lists what the session may create, in the order of the specification, on the crimson button',
    scope: 'step',
    what: 'focus on the heading of the page the New menu went to',
    failedIn: ['#145'],
  },
  {
    id: 'tooltip-on-keyboard-focus-under-policy',
    file: 'primitives-policy.spec.ts',
    title: 'every overlay, the calendar, the table and the toaster run and raise no violation',
    scope: 'step',
    what: 'a tooltip that has to be visible within five seconds of the keyboard reaching its button',
    failedIn: ['#145'],
  },
] as const satisfies readonly KnownFlaky[];

export type KnownFlakyId = (typeof KNOWN_FLAKY_ON_HOSTED_WEBKIT)[number]['id'];

/**
 * Whether this is the hosted WebKit run: WebKit, and the value that only CI sets for the jobs that run it (a developer's machine sets none, and so runs every test in full).
 * `environment` is the process's own unless a test of this function gives another.
 */
export function hostedWebkit(
  browserName: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return browserName === 'webkit' && environment.MELARC_WEBKIT_HEADED === '1';
}

/** The words the report carries for a test or a step that was left out: what, why, who accepted it, and where it still runs. */
export function reasonOf(entry: KnownFlaky): string {
  return `Known flaky on the hosted WebKit run (${entry.id}: ${entry.what}; failed in run ${entry.failedIn.join(', ')}). The Product Owner accepted it on 17 November 2026 so that it does not block. ${
    entry.scope === 'test' ? 'The test' : 'This step'
  } runs in Chromium and Firefox, and in WebKit on a developer's machine.`;
}

import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';

import { KEY_PATTERN_FLAGS, keyPatternSource } from '../../support/permission-catalogue';
import { watchForPermissionKeys } from '../../support/permission-key-watch';

/**
 * WCAG 2.2 level A and AA, the tested baseline (DESIGN_SYSTEM section 14). It is a target and not a conformance claim.
 * axe-core 4.13 has one 2.2 AA rule, `target-size`, which needs layout and so can only run in a real browser. The other
 * new criteria have no automated rule and rest on the keyboard checks and the recorded manual passes.
 */
export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/**
 * Whether Tab moves focus to a link in this engine. Safari's engine leaves links out of the Tab order unless its user
 * turns on "Press Tab to highlight each item", and Playwright's WebKit for Windows never moves focus to one (neither Tab
 * nor Alt+Tab does). The links are no less reachable there, and which engines behave so is not something the tests should
 * assume, so a test asks, and then follows the engine's real order. The page is reloaded afterwards, so that the next key
 * press starts from the top of the document; the caller waits for the page to be ready again.
 */
export async function tabReachesLinks(page: Page): Promise<boolean> {
  await page.keyboard.press('Tab');
  const reached = await page.evaluate(() => document.activeElement?.tagName === 'A');
  await page.reload();
  return reached;
}

/** How a person who can reach links moves focus in this engine: with Tab, with Option+Tab, or (where no key does) not by a key a test can press. */
type LinkWalk = 'Tab' | 'Alt+Tab' | 'script';

/** What each browser launched by a worker was found to do, asked once: the engine's behaviour does not change from one test to the next. */
const linkWalks = new WeakMap<object, Promise<LinkWalk>>();

/**
 * Asks the engine, on a page of its own with nothing of the application in it, which key takes focus from a button to the link after it. Safari's engine leaves links
 * out of the Tab order unless its user turns on "Press Tab to highlight each item", and Option+Tab reaches them; Chromium and Firefox reach them with Tab. Playwright's
 * WebKit for Windows reaches a link with neither (the page sees Alt+Tab, and the engine ignores it), though a script can give a link focus.
 */
async function probeLinkWalk(page: Page): Promise<LinkWalk> {
  const scratch = await page.context().newPage();
  try {
    await scratch.setContent(
      '<button id="before">Before</button><a id="link" href="#link">A link</a><button id="after">After</button>',
    );
    for (const keys of ['Tab', 'Alt+Tab'] as const) {
      await scratch.evaluate(() => {
        document.getElementById('before')?.focus();
      });
      await scratch.keyboard.press(keys);
      if (await scratch.evaluate(() => document.activeElement?.id === 'link')) return keys;
    }
    return 'script';
  } finally {
    await scratch.close();
  }
}

/**
 * Takes focus from the stop it is on to the next one (the one before, with `backwards`), as a person does who can reach links. A test that walks a page with links in it
 * calls this and not `page.keyboard.press('Tab')`, so that it asserts the same thing in every engine and a product claim is never skipped on one:
 *
 * - where Tab reaches links (Chromium, Firefox) it presses Tab, and Shift+Tab backwards;
 * - where Option+Tab does (Safari: Option+Tab, and Option+Shift+Tab backwards) it presses that;
 * - where no key does (Playwright's WebKit for Windows) it gives focus to the next stop in the document order that Option+Tab walks, with a script, and the engine
 *   scrolls it into view as it does for any focus. A key press is a model there and the walk is not: what a test asserts of each stop (its place, its ring) is the engine's.
 */
export async function stepIncludingLinks(
  page: Page,
  options: { readonly backwards?: boolean } = {},
): Promise<void> {
  const backwards = options.backwards === true;
  const context = page.context();
  const key: object = context.browser() ?? context;
  let asked = linkWalks.get(key);
  if (asked === undefined) {
    asked = probeLinkWalk(page);
    linkWalks.set(key, asked);
  }
  let walk: LinkWalk;
  try {
    walk = await asked;
  } catch (error) {
    linkWalks.delete(key);
    throw error;
  }
  if (walk === 'Tab') {
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  } else if (walk === 'Alt+Tab') {
    await page.keyboard.press(backwards ? 'Alt+Shift+Tab' : 'Alt+Tab');
  } else {
    await page.evaluate((back) => {
      const stops = [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable=""], [contenteditable="true"], [tabindex]',
        ),
      ].filter((element) => element.getAttribute('tabindex') !== '-1');
      const from =
        document.activeElement === null || document.activeElement === document.body
          ? null
          : document.activeElement;
      // A stop that is not drawn, is disabled or lies inside something inert takes no focus, so it is passed over, as the keyboard passes over it.
      for (const stop of back ? stops.reverse() : stops) {
        if (from !== null) {
          const where = from.compareDocumentPosition(stop);
          const onTheWay = back
            ? (where & Node.DOCUMENT_POSITION_PRECEDING) !== 0
            : (where & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
          if (!onTheWay) continue;
        }
        stop.focus();
        if (document.activeElement === stop) return;
      }
    }, backwards);
  }
}

/**
 * The accessible-ish name of every element a keyboard can reach, in document order, with or without the links. An element that is not
 * drawn (`display: none`, `visibility: hidden`, as a menu that has slid out of sight is) or that lies inside something inert is not a stop.
 */
export function reachableNames(page: Page, includeLinks: boolean): Promise<string[]> {
  return page.evaluate(
    (withLinks) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ]
        // Not a stop: the hidden input that a library keeps beside a control for the form's value (Radix's checkbox and select do), which is out of
        // the Tab order and out of the accessibility tree (tabindex="-1" inside an aria-hidden container). A real control that regressed to
        // tabindex="-1" is still listed, so that the walks that compare this list with the Tab order fail on it.
        .filter(
          (element) =>
            element.getAttribute('tabindex') !== '-1' ||
            element.closest('[aria-hidden="true"]') === null,
        )
        .filter((element) => withLinks || element.tagName !== 'A')
        .filter(
          (element) =>
            element.getClientRects().length > 0 &&
            getComputedStyle(element).visibility !== 'hidden' &&
            element.closest('[inert]') === null,
        )
        // A group of radio buttons is one stop, as a browser makes it: Tab lands on the chosen one, or on the first when none is chosen
        // (moving forward), and the arrow keys move within the group.
        .filter((element, _index, list) => {
          if (
            !(element instanceof HTMLInputElement) ||
            element.type !== 'radio' ||
            element.name === ''
          ) {
            return true;
          }
          const group = list.filter(
            (other): other is HTMLInputElement =>
              other instanceof HTMLInputElement &&
              other.type === 'radio' &&
              other.name === element.name &&
              other.form === element.form,
          );
          return element === (group.find((radio) => radio.checked) ?? group[0]);
        })
        .map((element) => {
          const labelled =
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
              ? element.labels?.[0]?.textContent
              : null;
          return (element.getAttribute('aria-label') ?? labelled ?? element.textContent).trim();
        }),
    includeLinks,
  );
}

/**
 * The two warnings that Firefox writes to the console of its own accord, about the test origin and about the page, and that no change of ours can prevent (Product Owner,
 * 10 November 2026). Each is matched whole, by the text Firefox wrote (build 1543 of Playwright's Firefox), so that another warning, another wording or another host is a problem
 * as before:
 *
 * - the bounce-tracker classification: Firefox's state-purging heuristic names an origin that is navigated to again and again with no user gesture, which is what a test run is, and
 *   the test origin is the loopback address;
 * - the scroll-linked positioning effect: Firefox's heuristic for a layer that a script positions as the page scrolls, which is how the popovers and the sticky offsets of the kit's
 *   libraries are placed. It names the page it was found on.
 */
export const FIREFOX_OWN_WARNINGS: readonly RegExp[] = [
  /^\[JavaScript Warning: "“127\.0\.0\.1” has been classified as a bounce tracker\. If it does not receive user activation within the next 3,600 seconds it will have its state purged\."\]$/,
  /^\[JavaScript Warning: "This site appears to use a scroll-linked positioning effect\. This may not work well with asynchronous panning; see https:\/\/firefox-source-docs\.mozilla\.org\/performance\/scroll-linked_effects\.html for further details and to join the discussion on related tools and features!" \{file: "http:\/\/127\.0\.0\.1:\d+\/[^"]*" line: \d+\}\]$/,
];

/** Whether a console message is one of Firefox's own two (see `FIREFOX_OWN_WARNINGS`): a warning, from Firefox, with exactly their text. */
export function isFirefoxOwnWarning(
  engine: string | undefined,
  type: string,
  text: string,
): boolean {
  return (
    engine === 'firefox' && type === 'warning' && FIREFOX_OWN_WARNINGS.some((own) => own.test(text))
  );
}

/**
 * The one failed request of a healthy page that is not told as a problem, on Firefox: the page's own favicon, cancelled (`NS_BINDING_ABORTED`). The tab and the brand mark both ask for
 * `/favicon.svg` (the trace of the hosted run of 18 November 2026 shows three requests for it within 50 ms) and Firefox drops one of them: a request that the engine cancels, that no
 * code of ours asked to cancel and that the page is not the worse for, which failed "is a healthy page" now and then (main's run on the merge of #60). It is matched whole, as the
 * two warnings above are: another file, another error, another host or another engine is a problem as before.
 */
export const FIREFOX_OWN_ABORT = /^http:\/\/127\.0\.0\.1:\d+\/favicon\.svg$/;

/** Whether a failed request is the one Firefox cancels of its own accord (see `FIREFOX_OWN_ABORT`): on Firefox, by that error, for that file on the test origin. */
export function isFirefoxOwnAbort(
  engine: string | undefined,
  url: string,
  errorText: string | undefined,
): boolean {
  return engine === 'firefox' && errorText === 'NS_BINDING_ABORTED' && FIREFOX_OWN_ABORT.test(url);
}

/**
 * Records what a healthy page never does: log errors, throw, fail a request, **draw a permission key** (the runtime half of the guard that holds a key off every screen,
 * `test/no-permission-key-on-screen.test.ts`: the page watches its own text and attributes as they are built and as they change, and reports a key of the catalogue as a
 * console error, which is a problem here). Also lists its requests. Call it before the page is opened: the watch is installed in every document the page loads after that.
 */
export function watchPage(page: Page) {
  const problems: string[] = [];
  const requests: string[] = [];
  const engine = page.context().browser()?.browserType().name();
  // Not awaited: Playwright sends its messages in order, so the script is installed before whatever the caller does next; a refusal is an unhandled rejection, which fails the test.
  void page.addInitScript(watchForPermissionKeys, {
    source: keyPatternSource(),
    flags: KEY_PATTERN_FLAGS,
    log: true,
  });
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    if (isFirefoxOwnWarning(engine, message.type(), message.text())) return;
    problems.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText;
    if (isFirefoxOwnAbort(engine, request.url(), errorText)) return;
    problems.push(`request failed: ${request.url()} (${errorText ?? 'no reason given'})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      problems.push(`HTTP ${String(response.status())}: ${response.url()}`);
  });
  page.on('request', (request) => {
    requests.push(request.url());
  });
  return { problems, requests };
}

/**
 * Records every time focus moves into content that is hidden from assistive technology (`aria-hidden="true"` on the element or on an ancestor): a modal dialog hides the rest of the app that way
 * while it is open and while it is on its way out, and a heading focused then may not be announced. Chromium reports it as a console warning ("Blocked aria-hidden on an element because its
 * descendant retained focus"), but only where its accessibility layer is on, as it is on the machine of a person with a screen reader and is not in a hosted headless run; this reads the page
 * itself, so that the check is the same in every engine and on every machine. Call it before the page is opened; the function it returns reads what was found so far.
 */
export async function watchHiddenFocus(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const found: string[] = [];
    (window as unknown as { __hiddenFocus: string[] }).__hiddenFocus = found;
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const hider = target.closest('[aria-hidden="true"]');
        if (hider === null) return;
        const name = (element: Element): string =>
          `<${element.tagName.toLowerCase()}${element.id === '' ? '' : '#' + element.id}>`;
        found.push(
          `focus moved to ${name(target)} inside ${name(hider)}, which is aria-hidden, at ${location.pathname}`,
        );
      },
      true,
    );
  });
  return () =>
    page.evaluate(() => (window as unknown as { __hiddenFocus?: string[] }).__hiddenFocus ?? []);
}

/**
 * Waits until the page has stopped moving: every transition and every animation that is running and will end (a fade, a slide, a glide) has ended. One that
 * never ends (a spinner, a caret) is not waited for, and neither is one that is paused. A read of a colour, an opacity or a place that is made before
 * this is a read of the middle of a movement, which is neither the state it comes from nor the one it goes to. Animations of pseudo-elements (a dialog's
 * scrim) are among those the document lists.
 */
export async function settled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const moving = document.getAnimations().filter((animation) => {
      const end = animation.effect?.getComputedTiming().endTime;
      return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end);
    });
    await Promise.allSettled(moving.map((animation) => animation.finished));
  });
}

/**
 * Brings the animations of one element, and of everything in it, to their end: a panel that slides in, a tooltip that grows into place. A place or a size read before that is a read of the
 * middle of a movement (the Product Owner's review of ba9a18c, item 6: the heading of a sheet read at the place it had a few frames before it arrived, a tooltip a few pixels short of its
 * gap). **It finishes them and does not wait for them** (the hosted WebKit runs of 12 and 13 November 2026): a page whose animation clock has stopped, which a hosted WebKit does for seconds
 * (a sheet five pixels short of its end for the five seconds of a poll; two tooltip tests that waited on an animation until the page was closed), never finishes an animation, and a test
 * that waits for one waits for ever. What the test reads next is the place the movement was going to, which is what it asked for. Like `settled`, it leaves alone an animation that never
 * ends (a spinner, a caret) and one that is paused. A test of the movement itself reads it as it comes and does not call this; where motion is not what a test checks it may also ask for
 * reduced motion (`openKit(..., { reducedMotion: true })`) and have nothing to finish.
 */
export async function animationsDone(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      const end = animation.effect?.getComputedTiming().endTime;
      if (animation.playState !== 'running' || typeof end !== 'number' || !Number.isFinite(end)) {
        continue;
      }
      try {
        animation.finish();
      } catch {
        // One that cannot be finished is left to run: the read that follows is of the page as it is.
      }
    }
  });
}

/**
 * Waits until the page has stopped moving under the reader's scroll: neither its scroll position nor the height of its document has changed for `frames` frames in a row. A page whose table
 * becomes cards, or whose panel opens, can still be growing or shifting its scroll for a few frames after the control that did it was pressed, and a position read in the middle of that is
 * not the position the page rests at. Frames are counted, not milliseconds: it waits as long as the machine takes, and the test's own time is its only limit.
 */
export async function scrollSettled(page: Page, frames = 3): Promise<void> {
  await page.evaluate(async (needed) => {
    const place = (): string =>
      `${String(window.scrollY)}/${String(document.documentElement.scrollHeight)}`;
    let last = place();
    let same = 0;
    while (same < needed) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = place();
      if (now === last) same += 1;
      else {
        same = 0;
        last = now;
      }
    }
  }, frames);
}

/**
 * What axe measured on one element, after its selector: the contrast ratio with both colours and the size of the text, the space a target has,
 * the name that is missing. A violation that comes and goes names the selector and nothing else, and the one hosted run of 18 November 2026 in which a primary button of
 * a screen failed its contrast (and never again in 120 runs of the same test) kept no trace, because the sign-in and device pages turn tracing off: with these figures
 * the next one says which colours were read, and a colour in the middle of a fade is told from a colour that is wrong at a glance (the cause of those two runs was a fade: `withoutTransitions`, below).
 */
function measured(node: {
  readonly any: readonly { readonly message?: string }[];
  readonly all: readonly { readonly message?: string }[];
  readonly none: readonly { readonly message?: string }[];
}): string {
  const message = [...node.any, ...node.all, ...node.none].find(
    (check) => (check.message ?? '') !== '',
  )?.message;
  return message === undefined ? '' : `: ${message.replace(/\s+/g, ' ').slice(0, 220)}`;
}

/**
 * Runs `work` with every transition of the page at its end, and gives the page back as it was. A rule `transition: none` takes a transition that is under way to the value it was going
 * to and gives none to a change that comes after, so a colour read in the meantime is the colour of a state and never the middle of a fade. The rule is a style sheet that the document
 * adopts, not a style element: it adds nothing to the markup, so nothing in the page (an observer of its mutations, a count of its style elements) can notice it, and it leaves nothing behind.
 */
async function withoutTransitions<T>(page: Page, work: () => Promise<T>): Promise<T> {
  const sheet = await page.evaluateHandle(() => {
    const own = new CSSStyleSheet();
    own.replaceSync('*, *::before, *::after { transition: none !important; }');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, own];
    return own;
  });
  try {
    return await work();
  } finally {
    await sheet
      .evaluate((own) => {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((one) => one !== own);
      })
      .catch(() => undefined);
    await sheet.dispose().catch(() => undefined);
  }
}

/**
 * One line per violation: the rule, what it asks for and the first elements that break it. `disable` names rules of axe to leave out of this
 * scan, for the one state in which axe is known to be wrong, with the reason written where it is used. `include` limits the scan to the part of the
 * page a selector names (the sidebar, when it is the sidebar that is under test), so that a test of one part fails for that part only.
 *
 * **The colours are those of a page that has stopped changing.** axe reads the colour of each element at the moment it reaches it, so a button the pointer
 * has just pressed (its fill takes `motion.fast` to arrive under the pointer) is read as a colour that is neither state, and the contrast of a primary button
 * failed in about one run in three at 768px (found in the review of 7 November 2026, and present with the stylesheet and the components of the baseline tree
 * too). The transitions and the animations under way are waited for (`settled`): they are finite, and an animation that never ends (a spinner) is not one of
 * them. A panel that fades in (a dialog, a popover) is read in the same way, at its own opacity once it has arrived and not part way.
 *
 * **`settled` waits for what is moving when it looks, and a fade can begin after that.** A control that an answer enables a moment later (the replacement form of a rider's device page: its
 * button is disabled until the list of reasons is in) turns its label white at once and takes `motion.fast` to leave the disabled grey, so for that moment it is white on grey, and axe, reaching
 * it then, reports a contrast of 1.14 that nobody sees (two hosted runs of 18 November 2026 in about twenty, on that screen at 1280px and nowhere else, and shown on the page itself by holding the
 * answer back: `riders.spec.ts`). So the scan reads the page with its transitions at their end (`withoutTransitions`): a fade that is under way is taken to the colour it was going to, and none begins.
 *
 * **The page is read from its top, not from where the last click left the scroll.** The rule of target size judges the part of a control that nothing covers, and the top
 * bar of the shell is sticky and covers the top of what is scrolled under it. A control that the bar covers a little (the menu of a pickup run's acts, with the bar over
 * its upper half) is under 24px and next to another control, so it fails, and it fails only when the scroll stops in that narrow band: where it stops depends on when the
 * data under the page arrived and the click that scrolled it into view (the hosted run of 18 November 2026: the 768px screen of a draft pickup run, which passed on the
 * same code in every other run). A scan is of the screen, not of a scroll position, so it starts where a person arrives, at the top. The scroll is instant: a smooth one
 * would still be moving when axe reads.
 */
export async function wcagViolations(
  page: Page,
  options: { readonly disable?: readonly string[]; readonly include?: string } = {},
): Promise<string[]> {
  await settled(page);
  await page.evaluate(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  });
  return withoutTransitions(page, async () => {
    const scan = new AxeBuilder({ page })
      .withTags(WCAG_TAGS)
      .disableRules([...(options.disable ?? [])]);
    const results = await (
      options.include === undefined ? scan : scan.include(options.include)
    ).analyze();
    return results.violations.map(
      (violation) =>
        `${violation.id}: ${violation.help} (${violation.nodes
          .slice(0, 3)
          .map((node) => `${node.target.join(' ')}${measured(node)}`)
          .join(', ')})`,
    );
  });
}

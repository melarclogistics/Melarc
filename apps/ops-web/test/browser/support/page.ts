import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

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
 * Records what a healthy page never does: log errors, throw, fail a request, **draw a permission key** (the runtime half of the guard that holds a key off every screen,
 * `test/no-permission-key-on-screen.test.ts`: the page watches its own text and attributes as they are built and as they change, and reports a key of the catalogue as a
 * console error, which is a problem here). Also lists its requests. Call it before the page is opened: the watch is installed in every document the page loads after that.
 */
export function watchPage(page: Page) {
  const problems: string[] = [];
  const requests: string[] = [];
  // Not awaited: Playwright sends its messages in order, so the script is installed before whatever the caller does next; a refusal is an unhandled rejection, which fails the test.
  void page.addInitScript(watchForPermissionKeys, {
    source: keyPatternSource(),
    flags: KEY_PATTERN_FLAGS,
    log: true,
  });
  page.on('console', (message) => {
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    problems.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(
      `request failed: ${request.url()} (${request.failure()?.errorText ?? 'no reason given'})`,
    );
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
 * One line per violation: the rule, what it asks for and the first elements that break it. `disable` names rules of axe to leave out of this
 * scan, for the one state in which axe is known to be wrong, with the reason written where it is used. `include` limits the scan to the part of the
 * page a selector names (the sidebar, when it is the sidebar that is under test), so that a test of one part fails for that part only.
 *
 * **The colours are those of a page that has stopped changing.** axe reads the colour of each element at the moment it reaches it, so a button the pointer
 * has just pressed (its fill takes `motion.fast` to arrive under the pointer) is read as a colour that is neither state, and the contrast of a primary button
 * failed in about one run in three at 768px (found in the review of 7 November 2026, and present with the stylesheet and the components of the baseline tree
 * too). The transitions and the animations under way are waited for (`settled`): they are finite, and an animation that never ends (a spinner) is not one of
 * them. A panel that fades in (a dialog, a popover) is read in the same way, at its own opacity once it has arrived and not part way.
 */
export async function wcagViolations(
  page: Page,
  options: { readonly disable?: readonly string[]; readonly include?: string } = {},
): Promise<string[]> {
  await settled(page);
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
        .map((node) => node.target.join(' '))
        .join(', ')})`,
  );
}

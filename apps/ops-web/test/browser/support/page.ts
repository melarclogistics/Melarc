import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

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
        // Not a stop: the hidden date input that React Aria Components keeps beside a date field for autofill, which is out of the Tab order and
        // out of the accessibility tree (tabindex="-1" inside an aria-hidden container). A real control that regressed to tabindex="-1" is
        // still listed, so that the walks that compare this list with the Tab order fail on it.
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

/** Records what a healthy page never does: log errors, throw, fail a request. Also lists its requests. */
export function watchPage(page: Page) {
  const problems: string[] = [];
  const requests: string[] = [];
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
 * One line per violation: the rule, what it asks for and the first elements that break it. `disable` names rules of axe to leave out of this
 * scan, for the one state in which axe is known to be wrong, with the reason written where it is used. `include` limits the scan to the part of the
 * page a selector names (the sidebar, when it is the sidebar that is under test), so that a test of one part fails for that part only.
 *
 * **The colours are those of a page that has stopped changing.** axe reads the colour of each element at the moment it reaches it, so a button the pointer
 * has just pressed (its fill takes `motion.fast` to arrive under the pointer) is read as a colour that is neither state, and the contrast of a primary button
 * failed in about one run in three at 768px (found in the review of 7 November 2026, and present with the stylesheet and the components of the baseline tree
 * too). The transitions under way are waited for: they are finite, and an animation that never ends (a spinner) is not one of them.
 */
export async function wcagViolations(
  page: Page,
  options: { readonly disable?: readonly string[]; readonly include?: string } = {},
): Promise<string[]> {
  await page.evaluate(async () => {
    const transitions = document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition);
    await Promise.allSettled(transitions.map((animation) => animation.finished));
  });
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

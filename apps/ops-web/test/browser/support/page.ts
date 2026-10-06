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

/** The accessible-ish name of every element a keyboard can reach, in document order, with or without the links. */
export function reachableNames(page: Page, includeLinks: boolean): Promise<string[]> {
  return page.evaluate(
    (withLinks) =>
      [
        ...document.querySelectorAll<HTMLElement>(
          'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ]
        .filter((element) => withLinks || element.tagName !== 'A')
        .map((element) => {
          const labelled =
            element instanceof HTMLInputElement ? element.labels?.[0]?.textContent : null;
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
    // Browsers ask for /favicon.ico on their own. No brand assets exist yet, so it is a 404 and the
    // browser logs it. Delete this allowance when an icon is added.
    if (message.location().url.endsWith('/favicon.ico')) return;
    problems.push(`console ${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', (error) => {
    problems.push(`uncaught: ${error.message}`);
  });
  page.on('requestfailed', (request) => {
    problems.push(`request failed: ${request.url()}`);
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

/** One line per violation: the rule, what it asks for and the first elements that break it. */
export async function wcagViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map(
    (violation) =>
      `${violation.id}: ${violation.help} (${violation.nodes
        .slice(0, 3)
        .map((node) => node.target.join(' '))
        .join(', ')})`,
  );
}

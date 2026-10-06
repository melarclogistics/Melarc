import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** The two widths the Ops Portal specification verifies (surfaces/ops-portal.md section 11). */
const VERIFIED_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
] as const;

/** WCAG 2.1 level A and AA, the working target; it is not a conformance claim. */
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * A strict policy used only as a compatibility baseline: no inline code, no eval, nothing from another
 * origin. The policy the edge will really send is not specified yet; a shell that works under this one
 * does not force that policy to weaken script-src or style-src.
 */
const STRICT_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** Records what a healthy shell never does: log errors, throw, fail a request. Also lists its requests. */
function watchPage(page: Page) {
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

async function wcagViolations(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
  return results.violations.map((violation) => `${violation.id}: ${violation.help}`);
}

test.describe('the application shell in a browser', () => {
  // Break caught: a production build that does not start, logs errors, or reaches for anything other
  // than its own files. The API, above all, is not called: the shell has nothing to ask it.
  test('renders, with no errors, and requests only its own files', async ({ page, baseURL }) => {
    const seen = watchPage(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();
    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page).toHaveTitle('Melarc Ops Portal');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    expect(seen.problems).toEqual([]);
    expect(seen.requests.length).toBeGreaterThan(0);
    for (const url of seen.requests) {
      const { origin, pathname } = new URL(url);
      expect(origin, url).toBe(baseURL);
      expect(pathname.startsWith('/api'), url).toBe(false);
    }
  });

  // Break caught: the shell keeping anything in the browser before any workflow exists.
  test('stores nothing in the browser', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    }));

    expect(stored).toEqual({ local: 0, session: 0, cookie: '', databases: 0, caches: 0 });
  });

  // Break caught: a keyboard user who cannot see where focus is, cannot skip the header, or is left
  // somewhere unexpected after skipping.
  test('keyboard: the skip link is the first stop, visibly focused, and moves focus to the content', async ({
    page,
  }) => {
    await page.goto('/');
    const skipLink = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skipLink).not.toBeInViewport();

    await page.keyboard.press('Tab');

    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeInViewport();
    const outline = await skipLink.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(outline.style).toBe('solid');
    expect(outline.width).toBeGreaterThanOrEqual(2);

    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
  });

  // Break caught: an unknown address giving a blank page, the page reloading when a link is followed,
  // focus left behind after a client-side navigation, or the browser's history not working.
  test('an unknown address shows page-not-found; its link works by keyboard and focuses the new heading', async ({
    page,
  }) => {
    const seen = watchPage(page);
    await page.goto('/definitely/not/a/page');

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page).toHaveTitle('Page not found · Melarc Ops Portal');

    // Tab 1 is the skip link, tab 2 the link home. Following it must not reload the page.
    await page.evaluate(() => Object.assign(window, { survivedNavigation: true }));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Go to the start page' })).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeFocused();
    expect(await page.evaluate(() => 'survivedNavigation' in window)).toBe(true);

    await page.goBack();
    await expect(page).toHaveURL('/definitely/not/a/page');
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    expect(seen.problems).toEqual([]);
  });

  // Break caught: a policy with 'unsafe-inline' or 'unsafe-eval' being needed to run the shell.
  test('runs under a strict Content-Security-Policy', async ({ page }) => {
    await page.route('**/*', async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': STRICT_POLICY },
      });
    });
    const violations: string[] = [];
    await page.exposeFunction('reportViolation', (detail: string) => {
      violations.push(detail);
    });
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (event) => {
        void (
          window as unknown as { reportViolation: (detail: string) => Promise<void> }
        ).reportViolation(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    const seen = watchPage(page);

    const response = await page.goto('/no-such-page');

    // The policy was really sent, and the application still starts and navigates under it.
    expect(response?.headers()['content-security-policy']).toBe(STRICT_POLICY);
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await page.getByRole('link', { name: 'Go to the start page' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  for (const { width, height } of VERIFIED_VIEWPORTS) {
    // Break caught: a layout that breaks at a verified width, or colour contrast that fails in a real
    // browser, which jsdom cannot check. Also with the skip link showing, its most exposed state.
    test(`has no WCAG 2.1 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });

      for (const path of ['/', '/no-such-page']) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        expect(await wcagViolations(page), path).toEqual([]);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `${path} overflows sideways`).toBeLessThanOrEqual(0);
      }

      await page.goto('/');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeInViewport();
      expect(await wcagViolations(page), 'with the skip link focused').toEqual([]);
    });
  }
});

import { expect, test, type Page } from '@playwright/test';

import { reachableNames, tabReachesLinks, watchPage, wcagViolations } from './support/page';

/**
 * The two widths the Ops Portal specification verifies (surfaces/ops-portal.md section 11), and 320 CSS pixels, where
 * content must reflow without sideways scrolling (WCAG 1.4.10, DESIGN_SYSTEM section 14).
 */
const VERIFIED_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 768, height: 1024 },
  { width: 320, height: 640 },
] as const;

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

/**
 * Sends STRICT_POLICY with every response of the page and returns the violations the browser reports, which the caller
 * reads after the page has run.
 */
async function enforceStrictPolicy(page: Page): Promise<string[]> {
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
  return violations;
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

    // The first stop in the document is the skip link, in every engine; Tab arrives there wherever it reaches links.
    const tabs = await tabReachesLinks(page);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect((await reachableNames(page, true))[0]).toBe('Skip to main content');
    if (tabs) await page.keyboard.press('Tab');
    else await skipLink.focus();

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
    const tabs = await tabReachesLinks(page);

    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page).toHaveTitle('Page not found · Melarc Ops Portal');

    // Tab 1 is the skip link, tab 2 the link home. Following it must not reload the page.
    const home = page.getByRole('link', { name: 'Go to the start page' });
    await page.evaluate(() => Object.assign(window, { survivedNavigation: true }));
    if (tabs) {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
    } else {
      await home.focus();
    }
    await expect(home).toBeFocused();
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
    const violations = await enforceStrictPolicy(page);
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

  // Break caught: the typeface being declared but never loading under the policy of this file (font-src 'self'), so that
  // every user silently gets the fallback stack. Inter's Latin subset is the one the page's text needs.
  test('loads Inter from its own files under the strict policy', async ({ page, baseURL }) => {
    const violations = await enforceStrictPolicy(page);
    const seen = watchPage(page);

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Melarc Ops Portal' })).toBeVisible();

    const loaded = await page.evaluate(async () => {
      await document.fonts.ready;
      return [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => face.family.replaceAll(/["']/g, ''));
    });
    expect(loaded).toContain('Inter');
    const fontFiles = seen.requests.filter((url) => new URL(url).pathname.endsWith('.woff2'));
    expect(fontFiles.length).toBeGreaterThan(0);
    for (const url of fontFiles) expect(new URL(url).origin, url).toBe(baseURL);

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  for (const { width, height } of VERIFIED_VIEWPORTS) {
    // Break caught: a layout that breaks at a verified width, or colour contrast that fails in a real
    // browser, which jsdom cannot check. Also with the skip link showing, its most exposed state.
    test(`has no WCAG 2.2 A or AA violation and no sideways scrolling at ${String(width)} px`, async ({
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
      const tabs = await tabReachesLinks(page);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      if (tabs) await page.keyboard.press('Tab');
      else await page.getByRole('link', { name: 'Skip to main content' }).focus();
      await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeInViewport();
      expect(await wcagViolations(page), 'with the skip link focused').toEqual([]);
    });
  }
});

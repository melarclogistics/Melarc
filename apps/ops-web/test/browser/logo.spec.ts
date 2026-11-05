import { expect, test, type Page } from '@playwright/test';

import { stubPreSignInApi } from './support/pre-sign-in-api';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The logo in the banner of the sign-in screen, in a real browser (BRAND_FOUNDATION 4.7): the primary logo on a light ground, and on a dark ground the
 * approved all-white lockup, because the black wordmark of the primary logo would vanish there. Which ground applies is what tokens.css decides: the
 * root's `data-theme`, and otherwise the system's setting. jsdom draws no image, so the pixels the browser painted are read back here: that the
 * lockup is white where it is shown, under the strict content-security policy that refuses a `data:` image, is the proof that matters.
 */
interface Painted {
  readonly src: string;
  /** The pixels the logo painted (not transparent), how many of them are white, and how many are dark. */
  readonly opaque: number;
  readonly white: number;
  readonly dark: number;
}

/** What the banner's logo painted, read back from a canvas at twice the size it is shown at. */
async function painted(page: Page): Promise<Painted> {
  return page.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('.app-header .app-logo');
    if (image === null) throw new Error('The banner has no logo.');
    await image.decode();
    const box = image.getBoundingClientRect();
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(box.width * 2);
    canvas.height = Math.round(box.height * 2);
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('No canvas.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let opaque = 0;
    let white = 0;
    let dark = 0;
    for (let at = 0; at < data.length; at += 4) {
      if ((data[at + 3] ?? 0) < 200) continue;
      opaque += 1;
      const channels = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
      if (Math.min(...channels) >= 245) white += 1;
      else if (Math.max(...channels) <= 90) dark += 1;
    }
    return { src: image.currentSrc, opaque, white, dark };
  });
}

async function openSignIn(page: Page): Promise<void> {
  await stubPreSignInApi(page, {});
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
}

test.describe('the logo in the banner of the sign-in screen', () => {
  // Break caught: the white lockup drawn on a light ground, or the primary logo's black wordmark left on it when nothing says the ground is dark.
  test('is the primary logo, with its black wordmark, on a light ground', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSignIn(page);

    const logo = await painted(page);
    expect(logo.src).toMatch(/melarc-logo-primary-[\w-]+\.svg$/);
    expect(logo.opaque).toBeGreaterThan(500);
    expect(logo.dark).toBeGreaterThan(0);
    expect(logo.white).toBe(0);
  });

  // Break caught: the black wordmark drawn on a dark ground, where it vanishes (a person whose computer is set to dark sees a banner with a red
  // square and no name); a lockup that is not white where it is painted (its fill is a style inside the file, which a policy must let it apply); and
  // the lockup shipped inline as a data: image, which the portal's policy refuses.
  test('is the all-white lockup on a dark ground, painted white, and the policy refuses nothing it draws', async ({
    page,
  }, testInfo) => {
    // The production build is served under the portal's strict policy; the development server injects scripts of its own, so it is not.
    const violations = testInfo.project.name.includes('-dev-')
      ? []
      : await enforceStrictPolicy(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await openSignIn(page);

    const logo = await painted(page);
    expect(logo.src).toMatch(/melarc-logo-dark-[\w-]+\.svg$/);
    expect(logo.opaque).toBeGreaterThan(500);
    expect(logo.white / logo.opaque).toBeGreaterThanOrEqual(0.99);
    expect(logo.dark).toBe(0);
    await expect(page.getByRole('img', { name: 'Melarc Logistics' })).toHaveCount(1);
    expect(violations).toEqual([]);
  });

  // Break caught: the choice of a person ignored, as tokens.css never ignores it: dark chosen on a light system, light chosen on a dark one, and
  // a logo that is read once at the first paint and left when the theme changes afterwards (the toggle of step R4, the system at dusk).
  test("follows the root's data-theme before the system, in both directions, while the page is open", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await openSignIn(page);
    const logo = page.locator('.app-header .app-logo');
    await expect(logo).toHaveAttribute('src', /melarc-logo-primary/);

    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await expect(logo).toHaveAttribute('src', /melarc-logo-dark/);
    expect((await painted(page)).white).toBeGreaterThan(500);

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light';
    });
    await expect(logo).toHaveAttribute('src', /melarc-logo-primary/);
    expect((await painted(page)).dark).toBeGreaterThan(0);

    await page.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await expect(logo).toHaveAttribute('src', /melarc-logo-dark/);
  });
});

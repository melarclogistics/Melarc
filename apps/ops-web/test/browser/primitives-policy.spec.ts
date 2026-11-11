import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { watchPage } from './support/page';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The shadcn/ui primitives in the showcase built for production (`vite build --mode showcase`, made by playwright.config.ts and never deployed),
 * served with the strict content-security policy of the portal: no inline script, no eval, nothing from another origin, and inline style allowed
 * since 5 November 2026 (support/strict-policy.ts; architecture/SECURITY_DESIGN.md section 14.8) because Radix UI and Sonner insert <style> elements
 * as they run. The browser reports every violation, and the primitives must raise none: not for any overlay, its focus handling, its animation or the
 * styles the libraries insert. The development server cannot show this, because it injects its own styles and scripts; a production build can.
 */
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

test.describe('the primitives in a production build under the strict content-security policy', () => {
  // Break caught: a primitive that needs more of the policy than the one relaxation (an inline script, an eval, a font, an image or a request to another
  // origin), in any engine; and a policy that is looser than it needs to be, since the same run under `style-src 'self'` alone reports the styles.
  test('every overlay, the calendar, the table and the toaster run and raise no violation', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    const seen = watchPage(page);
    await page.goto('/__showcase/primitives');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Primitives showcase' }),
    ).toBeVisible();

    // The page is styled under the policy: the Ink primary button has a fill, and the frame's own stylesheet applied.
    const fill = await button(page, 'Save changes').evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');

    // Every overlay, opened and closed with the keyboard.
    for (const [trigger, shows] of [
      ['Edit the pickup note', '[role="dialog"]'],
      ['Cancel the request', '[role="alertdialog"]'],
      ['Open the request panel', '[role="dialog"]'],
      ['Row actions', '[role="menu"]'],
      ['Filters', '[data-slot="popover-content"]'],
      ['Go to…', '[role="dialog"]'],
    ] as const) {
      await button(page, trigger).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(shows).first(), trigger).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator(shows), trigger).toHaveCount(0);
    }

    const select = page.getByRole('combobox', { name: 'Hub', exact: true });
    await select.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-slot="select-content"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-slot="select-content"]')).toHaveCount(0);

    await button(page, 'Next pickup day').focus();
    await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
    await page.keyboard.press('Escape');

    await button(page, 'Show a confirmation').click();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);

    // The calendar changes month, the table is drawn (the primitive alone: its sorting is the kit's DataTable, run under the policy by kit-policy), a tab is chosen, the theme is switched.
    await page
      .getByRole('button', { name: /next month/i })
      .first()
      .click();
    await expect(page.getByText('December 2026').first()).toBeVisible();
    await expect(
      page.getByRole('table').getByRole('columnheader', { name: 'Vendor' }),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'History', exact: true }).click();
    await button(page, 'Dark').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });

  // Break caught: the relaxation kept after nothing needs it, or a claim that cannot be checked. The libraries do insert style elements as they run
  // (Sonner's stylesheet at once, Radix Select's and the scroll area's with their parts), which is the whole reason `style-src` allows inline style.
  test('the libraries insert style elements at run time, which is what style-src allows', async ({
    page,
  }) => {
    await enforceStrictPolicy(page);
    await page.goto('/__showcase/primitives');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Primitives showcase' }),
    ).toBeVisible();
    await button(page, 'Show a confirmation').click();
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(1);

    const inserted = await page.evaluate(
      () =>
        [...document.querySelectorAll('style')].filter(
          (element) => element.textContent.trim() !== '',
        ).length,
    );
    expect(inserted).toBeGreaterThan(0);
  });
});

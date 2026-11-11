import type { Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { watchPage } from './support/page';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The component kit in the showcase built for production (`vite build --mode showcase`, made by playwright.config.ts and never deployed), served with the strict
 * content-security policy of the portal: no inline script, no eval, nothing from another origin, and inline style allowed since 5 November 2026
 * (support/strict-policy.ts; architecture/SECURITY_DESIGN.md section 14.8). The kit runs Motion (a layout that glides, a panel and a bar that come and go, a
 * number that counts) and the libraries under the primitives, which insert styles and set styles by script as they run: the browser reports every violation,
 * and none may be raised, in any engine. The development server cannot show this, because it injects its own scripts and styles; a production build can.
 */
const KIT = '/__showcase/kit';

async function open(
  page: Page,
  group: string,
): Promise<{ violations: string[]; problems: string[] }> {
  const violations = await enforceStrictPolicy(page);
  const seen = watchPage(page);
  await page.goto(`${KIT}/${group}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Kit showcase' })).toBeVisible();
  return { violations, problems: seen.problems };
}

/** The first list of the lists page: the page draws three of the same stops (one with a fixed stop, one disabled), so a button is found within its list. */
const firstStops = (page: Page) =>
  page.getByRole('list', { name: 'Stops of the sample run', exact: true });

test.describe('the kit in a production build under the strict content-security policy', () => {
  // Break caught: a component that needs more of the policy than the one relaxation (a script of its own, an eval, an image or a font from elsewhere), in
  // any engine; Motion that sets a style the policy refuses; and a page that is not styled under it.
  test('the panel, the bar, the glide, the count and the toasts run and raise no violation', async ({
    page,
  }) => {
    const { violations, problems } = await open(page, 'panels');

    // Styled under the policy: the page card has the portal's border, and the Ink primary button has a fill.
    const fill = await page
      .getByRole('button', { name: 'Assign a rider' })
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');

    // The panel comes in with Motion, and goes.
    await page.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'ACC-PR-7KQ2MZ' })).toBeHidden();
    // The figure counts up.
    await expect(
      page.getByRole('figure', { name: /^Counts up once/ }).locator('.ui-stat-tile__value'),
    ).toHaveText('248', { timeout: 5000 });

    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  // Break caught: the table's bar of acts or its changed-row highlight needing more of the policy than the one relaxation (a style set by script that the policy refuses).
  test('the table, its bar of acts and a changed row raise no violation', async ({ page }) => {
    const { violations, problems } = await open(page, 'data');
    const two = page.getByRole('figure', { name: /^Two lines \(a code over a name\)/ });
    // A request that is waiting: only one of those can be confirmed (the bar's act is for the chosen rows it can be taken on, and says "Confirm 0" for the others).
    await two.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }).check();
    await expect(two.getByRole('group', { name: 'Actions for the chosen rows' })).toBeVisible();
    await two.getByRole('button', { name: 'Confirm 1' }).click();
    await expect(two.locator('tr[data-changed="true"]')).toHaveCount(1);
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  // Break caught: Motion's layout glide (a transform set on each item as it moves) refused by the policy, in any engine.
  test('the reorder glide raises no violation', async ({ page }) => {
    const { violations, problems } = await open(page, 'lists');
    await firstStops(page).getByRole('button', { name: 'Move Stop 1, ACC-PR-7KQ2MZ down' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'moved to place 2 of 4' }),
    ).toBeVisible();
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  // Break caught: the menu, the question behind a destructive act or the toasts (Radix UI and Sonner insert styles and set them as they run) needing more of the policy.
  test('the menu, its question and the toasts raise no violation', async ({ page }) => {
    const { violations, problems } = await open(page, 'menus');
    await page.getByRole('button', { name: 'More actions for ACC-PR-7KQ2MZ' }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Cancel request' }).click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'With Undo' }).click();
    await expect(page.locator('.ui-toast')).toHaveCount(1);
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  // Break caught: the tooltip, the popover or the dialog (Radix UI places and styles the first two by script as they open) needing more of the policy, or an avatar's picture or a
  // skeleton's pulse refused by it.
  test('the tooltip, the popover, the dialog, the avatar and the loading bars raise no violation', async ({
    page,
  }) => {
    const { violations, problems } = await open(page, 'overlays');
    await page.getByRole('button', { name: 'Confirm the request' }).focus();
    await expect(page.locator('[data-slot="tooltip-content"]')).toBeVisible();
    await page.getByRole('button', { name: 'Service date' }).click();
    await expect(page.getByRole('dialog', { name: 'Choose a service date' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Add a note' }).click();
    await expect(page.getByRole('dialog', { name: 'Add a note' })).toBeVisible();
    await page.keyboard.press('Escape');

    // The violations and the problems are collected for the life of the page, over the pages that follow.
    await page.goto(`${KIT}/badges`);
    await expect(page.locator('.ui-avatar img')).toHaveCount(2);
    await page.goto(`${KIT}/states`);
    await expect(page.locator('.ui-skeleton-bar').first()).toBeVisible();

    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  // Break caught: the relaxation kept after nothing needs it, or a claim that cannot be checked: Motion and the libraries do set styles at run time (a
  // transform on a gliding item, the toaster's stylesheet), which is what `style-src` allows.
  test('Motion sets styles at run time, which is what style-src allows', async ({ page }) => {
    await open(page, 'lists');
    await firstStops(page).getByRole('button', { name: 'Move Stop 1, ACC-PR-7KQ2MZ down' }).click();

    const styled = await page.evaluate(
      () =>
        document.querySelectorAll('li[style]').length + document.querySelectorAll('style').length,
    );
    expect(styled).toBeGreaterThan(0);
  });
});

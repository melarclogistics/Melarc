import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { watchPage } from './support/page';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The date field in the showcase built for production (`vite build --mode showcase`, made by playwright.config.ts and never deployed),
 * served with the strict content-security policy of the portal: no inline script, no eval, nothing from another origin, and inline style
 * allowed since 5 November 2026 (support/strict-policy.ts). The development server cannot show this, because it injects its own styles and
 * scripts; a production build can. The browser reports every violation, and the field must raise none: not for its popover, its calendar,
 * its focus handling or the styles the libraries under it insert as they run.
 */
const NOW = new Date('2026-10-28T10:00:00Z');
const REQUIRED = 'Demo date (required)';

const group = (page: Page, name = REQUIRED): Locator => page.getByRole('group', { name });

test.describe('the date field in a production build under the strict content-security policy', () => {
  // Break caught: the date field or its calendar (the popover, its focus handling, the styles they set as they run) needing more of the strict policy than the one
  // relaxation, in any engine, or the page not styled under it.
  test('is styled, opens, takes a date by keyboard and by click, and raises no violation', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    const seen = watchPage(page);
    await page.clock.setFixedTime(NOW);
    await page.goto('/__showcase');
    await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
    await page.getByRole('heading', { level: 2, name: 'Date field' }).scrollIntoViewIfNeeded();

    // The stylesheet applied under the policy: the control has the portal's border.
    const control = group(page);
    const border = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.borderTopWidth, style: style.borderTopStyle };
    });
    expect(border).toEqual({ width: '1px', style: 'solid' });
    // Everything the field does.
    await control.getByRole('textbox').click();
    await page.keyboard.type('28102026');
    await expect(page.getByText('The page holds: 2026-10-28')).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.getByText('The page holds: 2026-10-29')).toBeVisible();
    await expect(page.getByRole('dialog')).toBeHidden();

    await control.getByRole('button', { name: /^Calendar/ }).click();
    await page.getByRole('button', { name: /Friday, 30 October 2026/ }).click();
    await expect(page.getByText('The page holds: 2026-10-30')).toBeVisible();

    const range = group(page, 'Demo date in a range');
    await range.getByRole('button', { name: /^Calendar/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();

    expect(violations).toEqual([]);
    expect(seen.problems).toEqual([]);
  });
});

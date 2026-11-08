import { expect, test, type Locator, type Page } from '@playwright/test';

import { watchPage } from './support/page';
import { enforceStrictPolicy } from './support/strict-policy';

/**
 * The date field in the showcase built for production (`vite build --mode showcase`, made by playwright.config.ts and never deployed),
 * served with the strict content-security policy of the portal: nothing inline, nothing from another origin (support/strict-policy.ts). The
 * development server cannot show this, because it injects its own styles; a production build can. The browser reports every violation, and
 * the library must raise none: not for its popover, its calendar, its focus handling or the one style it would insert (index.html, base.css,
 * and test/aria-wiring: src/components/ui/aria-wiring.test.tsx).
 */
const NOW = new Date('2026-10-28T10:00:00Z');
const REQUIRED = 'Demo date (required)';

const group = (page: Page, name = REQUIRED): Locator => page.getByRole('group', { name });

test.describe('the date field in a production build under the strict content-security policy', () => {
  test('is styled, opens, takes a date by keyboard and by click, and raises no violation', async ({
    page,
  }) => {
    const violations = await enforceStrictPolicy(page);
    const seen = watchPage(page);
    await page.clock.setFixedTime(NOW);
    await page.goto('/__showcase');
    await expect(page.getByRole('heading', { level: 1, name: 'Component showcase' })).toBeVisible();
    await page.getByRole('heading', { level: 2, name: 'Date field' }).scrollIntoViewIfNeeded();

    // The stylesheet applied under the policy: the control has the portal's border, and a pressable thing has the one rule that the library
    // would have inserted as a style of its own and that the portal writes in base.css instead.
    const control = group(page);
    const border = await control.evaluate((element) => {
      const style = getComputedStyle(element);
      return { width: style.borderTopWidth, style: style.borderTopStyle };
    });
    expect(border).toEqual({ width: '1px', style: 'solid' });
    const touch = await control.getByRole('button', { name: /^Calendar/ }).evaluate((element) => {
      const probe = document.createElement('div');
      probe.style.touchAction = 'pan-x pan-y pinch-zoom';
      document.body.append(probe);
      const expected = getComputedStyle(probe).touchAction;
      probe.remove();
      return { actual: getComputedStyle(element).touchAction, expected };
    });
    expect(touch.actual).toBe(touch.expected);

    // Everything the field does.
    await control.getByRole('spinbutton', { name: /^day/ }).click();
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
    // The comma after the weekday is the engine's (see date-picker.spec.ts): WebKit on Linux writes none.
    await page.getByRole('button', { name: /Friday,? 30 October 2026/ }).click();
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

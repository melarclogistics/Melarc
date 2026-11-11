import { expect, type Page } from '@playwright/test';

/**
 * No table's own box scrolls sideways (the Product Owner, 10 November 2026): every box the kit's tables draw their rows in has no more to scroll than it shows (`scrollWidth` at most one pixel
 * over `clientWidth`). The check of the page (`documentElement.scrollWidth` against the window) cannot see it: the box scrolls inside itself, so a table that kept a column it had no room for
 * left the page at its width, and 69 tests of 768px still passed with the column fit turned off (the Product Owner's check run of 198e5be). A page with no table passes.
 */
export async function expectNoTableScrollsSideways(page: Page): Promise<void> {
  const scrolling = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.ui-data-table__scroller')]
      .filter((box) => box.getClientRects().length > 0 && box.scrollWidth > box.clientWidth + 1)
      .map(
        (box) =>
          `${box.getAttribute('aria-label') ?? 'a table'}: ${String(box.scrollWidth)} in ${String(box.clientWidth)}`,
      ),
  );
  expect(scrolling, 'the box of a table scrolls sideways').toEqual([]);
}

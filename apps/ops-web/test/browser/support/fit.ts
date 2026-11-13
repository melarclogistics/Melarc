import type { Locator, Page } from '@playwright/test';

import { expect } from './guarded-test';

/**
 * A list drawn as cards by the table's **fit** and not by the width of its box (the Product Owner, 11 November 2026: where a table runs out of room it is cards): the box is as wide as a table needs
 * (40rem) and the cards are drawn all the same. These are the cards that the table used to draw again, in place of the cards, to measure them, and that stay now. Give it the list's region
 * (`getByRole('region', { name })`).
 *
 * **It looks at the result the page reaches, not at the first thing it draws**: a table's first measure is made in the fallback face and is made again when the faces are in (`useColumnFit`, which does
 * it a frame later), so a list read in between is a table in one run and cards in another (the hosted run of 12 November 2026: the approver's queue at 768px, a table in the development-server WebKit).
 * It waits for the faces and for the frames the restart takes (`frames`) before it looks. A test that holds the faces back and asks for the cards drawn meanwhile says `facesLoading`, and is not made to
 * wait for what it is holding.
 */
export async function expectCardsOfTheFit(
  region: Locator,
  options: { readonly facesLoading?: boolean } = {},
): Promise<void> {
  if (options.facesLoading !== true) {
    await region.evaluate(async () => {
      await document.fonts.ready;
    });
    await frames(region.page());
  }
  const drawn = await region.evaluate((box) => {
    const list = box.closest('.ui-data-table');
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    return { layout: list?.getAttribute('data-layout'), rems: (list?.clientWidth ?? 0) / rem };
  });
  expect(drawn.layout, 'the list is cards').toBe('cards');
  expect(
    drawn.rems,
    'the box is wide enough for a table: these are not the cards of a narrow box',
  ).toBeGreaterThanOrEqual(40);
}

/** Marks the element that is on the page now, so that a later look can tell whether it is the same element or one drawn again in its place (`stillThere`). */
export async function markNode(target: Locator, mark: string): Promise<void> {
  await target.evaluate((element, name) => {
    element.setAttribute(name, '');
  }, mark);
}

/** How many elements carry the mark of `markNode` now: one when the element is still the one that was marked, none when the page drew it again in its place. */
export async function stillThere(page: Page, mark: string): Promise<number> {
  return page.locator(`[${mark}]`).count();
}

/**
 * What makes a table measure itself again, made in a real browser and not by the test reaching into the page: a face finishes loading (an unused weight, the way a dialog opened for the first time
 * loads one), and, with `narrowBy`, the window narrows by that many pixels and widens again to the width it was. A list that went to cards and stays cards draws no card again for any of them; one that
 * is drawn as a table to be measured draws every card again and the card that held focus is gone.
 *
 * `narrowBy` is for a window that stays on one side of the shell's own breakpoints: under 768px the sidebar is a sheet and the table's box is wider, which is a box that grew and so, rightly, a
 * table to be measured again. A test at 768px disturbs with the face alone.
 */
export async function disturbTheFit(
  page: Page,
  options: { readonly narrowBy?: number } = {},
): Promise<void> {
  const size = page.viewportSize();
  if (size === null) throw new Error('The test has no viewport to disturb.');
  await page.evaluate(async () => {
    const rule = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .find((candidate): candidate is CSSFontFaceRule => candidate instanceof CSSFontFaceRule);
    if (rule === undefined) return;
    const face = new FontFace('Melarc disturbance', rule.style.getPropertyValue('src'));
    document.fonts.add(face);
    await face.load();
  });
  await frames(page);
  if (options.narrowBy === undefined) return;
  await page.setViewportSize({ width: size.width - options.narrowBy, height: size.height });
  await frames(page);
  await page.setViewportSize(size);
  await frames(page);
}

/**
 * Four frames, so that what the observers were told, the change the table makes for it in the frame after (`nextFrame` in `DataTable`: no layout is changed inside an observer's callback) and what
 * the page drew for it are behind us. Fewer would let a table that is about to draw every card again pass a check that nothing was.
 */
export async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let left = 4;
        const next = (): void => {
          left -= 1;
          if (left === 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
  );
}

import { expect, type Locator, type Page } from '@playwright/test';

/**
 * A control is whole in the window: no part of it is above it, below it, left of it or right of it, to half a pixel, **and no ancestor that clips what is in it (a box that scrolls or hides
 * its overflow: a table's own box, a panel's body) cuts any of it off**, to the same half pixel.
 *
 * `toBeInViewport({ ratio: 1 })` took the engine's own share of the control that is in view and wanted all of it: WebKit gave 0.9997 and 0.9998 for a control that lay inside the window on all
 * four sides, because the engines round the control and the window at fractions of a pixel differently (the engines run of 10 November 2026). The box of the control says where it is, so each side is
 * asked about. The window alone is not enough, though: a control inside a box that scrolls can be inside the window and out of sight, behind the edge of that box, which `ratio` saw and a box
 * check of the window does not (run 7, Stage 4.2), so each clipping ancestor is asked as well.
 */
export async function expectWholeInTheWindow(page: Page, control: Locator): Promise<void> {
  const box = await control.boundingBox();
  const window = page.viewportSize();
  expect(box).not.toBeNull();
  expect(window).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(-0.5);
  expect(box?.y ?? -1).toBeGreaterThanOrEqual(-0.5);
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((window?.width ?? 0) + 0.5);
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual((window?.height ?? 0) + 0.5);

  const clippedBy = await control.evaluate((element) => {
    const found: string[] = [];
    const rect = element.getBoundingClientRect();
    for (
      let ancestor = element.parentElement;
      ancestor !== null && ancestor !== document.documentElement;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const inner = ancestor.getBoundingClientRect();
      const left = inner.left + ancestor.clientLeft;
      const top = inner.top + ancestor.clientTop;
      const right = left + ancestor.clientWidth;
      const bottom = top + ancestor.clientHeight;
      const cuts =
        (style.overflowX !== 'visible' && (rect.left < left - 0.5 || rect.right > right + 0.5)) ||
        (style.overflowY !== 'visible' && (rect.top < top - 0.5 || rect.bottom > bottom + 0.5));
      if (cuts) {
        found.push(`${ancestor.tagName.toLowerCase()}.${ancestor.className.split(' ')[0] ?? ''}`);
      }
    }
    return found;
  });
  expect(clippedBy, 'a box that scrolls or hides its overflow cuts the control off').toEqual([]);
}

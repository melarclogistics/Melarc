import type { Locator } from '@playwright/test';

/**
 * What a list's words look like once the box has fitted its columns (the Product Owner, 11 November 2026: the queue's "One-packag / e / excepti / on" and the approvals' "Brida / l gown" were
 * words broken inside because `overflow-wrap: anywhere` lowered every cell to a letter; **a table never breaks a word: where it runs out of room it is cards**). Two readings of a rendered list, a
 * table or its cards, which jsdom cannot make:
 *
 * - `broken`: the words the browser broke in the middle. A word is the run of letters between spaces and hyphens (a break after a hyphen is a line break, not a broken word), and it is broken when
 *   the browser drew it in more than one piece. A break is allowed only inside a string that has no break point at all and that is wider than the room it has (the browser can do nothing else with
 *   it): such a word is left out. Text that is clipped to a pixel for assistive technology is not drawn and is left out.
 * - `tall`: the rows (of a table) and the cards taller than their content needs. A table cell's content is laid out again, in a copy, 8rem wide (inside the cell, so it takes the cell's own text
 *   styles), and a row is too tall when it is more than a line taller than the tallest of those and than the tallest density. A card is too tall when it is more than a line taller than the
 *   lowest edge of what it flows plus its padding and border (a card with room in it that nothing fills).
 *
 * Give it the region of the list (the `DataTable`'s box, `getByRole('region', { name })`): it holds the table or the cards, whichever is drawn.
 */
export interface TableWords {
  readonly broken: readonly string[];
  readonly tall: readonly string[];
}

export function wordsOf(region: Locator): Promise<TableWords> {
  return region.evaluate((root) => {
    const broken: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || parent.getClientRects().length === 0) continue;
      const box = parent.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2) continue;
      const text = node.textContent ?? '';
      for (const match of text.matchAll(/[^\s-]+/g)) {
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        if (range.getClientRects().length <= 1) continue;
        // A string with no break point at all that is wider than the room it has is broken by the browser, which can do nothing else with it: that is the one break allowed. Its width is
        // measured in a copy that never wraps.
        const whole = text.trim() === match[0];
        if (whole) {
          const copy = document.createElement('span');
          copy.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;';
          copy.textContent = match[0];
          parent.append(copy);
          const natural = copy.getBoundingClientRect().width;
          copy.remove();
          if (natural > parent.clientWidth + 1) continue;
        }
        broken.push(match[0]);
      }
    }

    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const tall: string[] = [];
    for (const row of root.querySelectorAll<HTMLElement>('tbody tr[data-row-id]')) {
      let needed = 0;
      for (const cell of row.querySelectorAll<HTMLElement>(':scope > th, :scope > td')) {
        if (cell.classList.contains('ui-data-table__select')) continue;
        const copy = document.createElement('div');
        copy.style.cssText = `position:absolute;visibility:hidden;inline-size:${String(8 * rem)}px;`;
        for (const child of Array.from(cell.childNodes)) copy.append(child.cloneNode(true));
        cell.append(copy);
        needed = Math.max(needed, copy.getBoundingClientRect().height);
        copy.remove();
      }
      const height = row.getBoundingClientRect().height;
      const line = parseFloat(getComputedStyle(row).lineHeight) || 24;
      // A row is its density at the least (56px at the tallest, the touch density) and as tall as the tallest cell needs; a line more than that is a cell squeezed narrower than it needs.
      if (height > Math.max(needed + 1, 56) + line) {
        tall.push(
          `${row.dataset.rowId ?? 'row'}: ${String(Math.round(height))}px, needs ${String(Math.round(needed))}px`,
        );
      }
    }
    for (const card of root.querySelectorAll<HTMLElement>('li[data-row-id]')) {
      const style = getComputedStyle(card);
      const top = card.getBoundingClientRect().top;
      let bottom = top;
      // The lowest edge of anything the card flows: what is positioned over it (a hit area stretched to its corners) says nothing of how much room its content takes.
      for (const part of card.querySelectorAll<HTMLElement>('*')) {
        if (['absolute', 'fixed'].includes(getComputedStyle(part).position)) continue;
        const where = part.getBoundingClientRect();
        if (where.width > 0 || where.height > 0) bottom = Math.max(bottom, where.bottom);
      }
      const needed =
        bottom - top + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
      const height = card.getBoundingClientRect().height;
      const line = parseFloat(style.lineHeight) || 24;
      if (height > needed + line) {
        tall.push(
          `${card.dataset.rowId ?? 'card'}: ${String(Math.round(height))}px, needs ${String(Math.round(needed))}px`,
        );
      }
    }
    return { broken, tall };
  });
}

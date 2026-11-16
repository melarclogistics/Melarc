import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { PhotoGrid, type PhotoGridItem } from './PhotoGrid';

/**
 * The thumbnail grid (COMPONENT_PATTERNS, *PhotoGrid*): a list of photos as tiles of a fixed size, each a button the page decides the meaning of (open it, or tick it as found). **It is generic and decides
 * nothing**: it knows no operation, no photo store and no rule, draws the picture the page gives it for a tile that is near the screen, and says a tile's state in an icon **and words**, never in colour alone.
 */
const ITEMS: readonly PhotoGridItem[] = [
  { key: 'a', label: 'Parcel 1' },
  { key: 'b', label: 'Parcel 2', state: { kind: 'selected', label: 'Here' } },
  { key: 'c', label: 'Parcel 3', state: { kind: 'marked', label: 'Missing' } },
  { key: 'd', label: 'Parcel 4', state: { kind: 'dimmed', label: 'Not on the table' }, badge: '4' },
  { key: 'e', label: 'Parcel 5' },
  { key: 'f', label: 'Parcel 6' },
  { key: 'g', label: 'Parcel 7' },
];

const picture = (item: PhotoGridItem, context: { readonly near: boolean }) => (
  <span data-testid={`picture-${item.key}`} data-near={String(context.near)} />
);

function grid(props: Partial<Parameters<typeof PhotoGrid>[0]> = {}) {
  return render(
    <PhotoGrid label="Photos of Kente Crafts" items={ITEMS} renderPicture={picture} {...props} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PhotoGrid: what it is', () => {
  it('is a list named by its label, each tile a button named by its label and its state in words', () => {
    grid();

    const list = screen.getByRole('list', { name: 'Photos of Kente Crafts' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(ITEMS.length);
    expect(
      within(list)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-label')),
    ).toEqual([
      'Parcel 1',
      'Parcel 2, Here',
      'Parcel 3, Missing',
      'Parcel 4, Not on the table',
      'Parcel 5',
      'Parcel 6',
      'Parcel 7',
    ]);
  });

  // Break caught: a state told by colour alone (a tile that is "red"): an icon and words are drawn for every state that is not normal.
  it('says a state in an icon and in words, and says nothing for a tile that is as it was', () => {
    grid();

    const selected = screen.getByRole('button', { name: 'Parcel 2, Here' });
    expect(within(selected).getByText('Here')).toBeVisible();
    expect(selected.querySelector('svg')).not.toBeNull();
    const marked = screen.getByRole('button', { name: 'Parcel 3, Missing' });
    expect(within(marked).getByText('Missing')).toBeVisible();
    expect(marked.querySelector('svg')).not.toBeNull();
    const dimmed = screen.getByRole('button', { name: 'Parcel 4, Not on the table' });
    expect(within(dimmed).getByText('Not on the table')).toBeVisible();
    // A tile that is as it was draws no mark.
    expect(
      screen.getByRole('button', { name: 'Parcel 1' }).querySelector('.ui-photo-tile__mark'),
    ).toBeNull();
  });

  it('draws a tile’s badge as text', () => {
    grid();
    expect(within(screen.getByRole('button', { name: /Parcel 4/ })).getByText('4')).toBeVisible();
  });

  it('draws nothing for a list of nothing', () => {
    grid({ items: [] });
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('has no violation of WCAG 2.2 A and AA', async () => {
    const { container } = grid({ selectable: true });
    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('PhotoGrid: pressing a tile', () => {
  // Break caught: a tile that decides something (opens a viewer, ticks itself): the grid only tells the page what was pressed.
  it('tells the page which tile was pressed, by click, Enter and Space, and does nothing itself', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(item: PhotoGridItem, index: number) => void>();
    grid({ onSelect });

    await user.click(screen.getByRole('button', { name: 'Parcel 5' }));
    screen.getByRole('button', { name: 'Parcel 6' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onSelect.mock.calls.map(([item, index]) => [item.key, index])).toEqual([
      ['e', 4],
      ['f', 5],
      ['f', 5],
    ]);
    // The grid did not tick anything for the page.
    expect(screen.getByRole('button', { name: 'Parcel 5' })).not.toHaveAttribute('aria-pressed');
  });

  // Break caught: a toggle that does not say whether it is on (a tile that is ticked and tells a screen reader nothing), or a plain tile that claims to be one.
  it('is a toggle when it is selectable, and says which tiles are on', () => {
    grid({ selectable: true });

    expect(screen.getByRole('button', { name: 'Parcel 2, Here' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: 'Parcel 3, Missing' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('is plain buttons when it is not selectable', () => {
    grid();
    for (const button of screen.getAllByRole('button'))
      expect(button).not.toHaveAttribute('aria-pressed');
  });

  it('does not take a press on a tile that is disabled', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    grid({
      onSelect,
      items: [
        { key: 'x', label: 'Parcel 1', disabled: true },
        { key: 'y', label: 'Parcel 2' },
      ],
    });

    await user.click(screen.getByRole('button', { name: 'Parcel 1' }));

    expect(screen.getByRole('button', { name: 'Parcel 1' })).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe('PhotoGrid: the keyboard', () => {
  /** Lays the tiles out in rows of three, as the stylesheet does at the width of a phone: jsdom has no layout. */
  function layOutInRowsOf(columns: number) {
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      const index = Number(this.getAttribute('data-photo-index'));
      return Number.isNaN(index) ? 0 : Math.floor(index / columns) * 100;
    });
  }

  // Break caught: seven tab stops for seven tiles (a keyboard user tabs through every photo of a run to get past the grid).
  it('is one stop of the Tab key, and the arrow keys move between the tiles', async () => {
    const user = userEvent.setup();
    grid();

    const stops = screen.getAllByRole('button').filter((button) => button.tabIndex === 0);
    expect(stops).toHaveLength(1);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Parcel 2, Here' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Parcel 2, Here' }).tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: 'Parcel 1' }).tabIndex).toBe(-1);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Parcel 7' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();
  });

  it('moves up and down by the rows the layout gives it, and stays where there is no row to go to', async () => {
    layOutInRowsOf(3);
    const user = userEvent.setup();
    grid();
    await user.tab();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Parcel 4, Not on the table' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Parcel 7' })).toHaveFocus();
    // The last row has nothing below it, and the one above is where it came from.
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Parcel 7' })).toHaveFocus();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();
  });

  it('does not run past either end with the left and right arrows', async () => {
    const user = userEvent.setup();
    grid();
    await user.tab();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: 'Parcel 1' })).toHaveFocus();
    // The stop of the Tab key is still a tile that exists (a grid that lost it could not be entered from the keyboard).
    expect(screen.getByRole('button', { name: 'Parcel 1' }).tabIndex).toBe(0);
    await user.keyboard('{End}{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Parcel 7' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Parcel 7' }).tabIndex).toBe(0);
  });

  // Break caught: an arrow key that moves focus and also scrolls the page under the tablet (the grid is moved through with the keys, and the page stays where it is).
  it('keeps the page from scrolling for the keys it handles, and leaves the others alone', () => {
    grid();
    const tile = screen.getByRole('button', { name: 'Parcel 1' });

    for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']) {
      expect(fireEvent.keyDown(tile, { key }), key).toBe(false);
    }
    expect(fireEvent.keyDown(tile, { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(tile, { key: 'Tab' })).toBe(true);
  });

  it('makes the tile that was pressed the stop of the Tab key', async () => {
    const user = userEvent.setup();
    grid();

    await user.click(screen.getByRole('button', { name: 'Parcel 5' }));

    expect(screen.getByRole('button', { name: 'Parcel 5' }).tabIndex).toBe(0);
    expect(screen.getByRole('button', { name: 'Parcel 1' }).tabIndex).toBe(-1);
  });

  // Break caught: a list that shrinks (a vendor's photos replaced by fewer) leaving the Tab stop on a tile that is gone, so that the grid cannot be entered by the keyboard.
  it('keeps a stop of the Tab key when the list gets shorter', () => {
    const { rerender } = grid();
    screen.getByRole('button', { name: 'Parcel 7' }).focus();
    act(() => {
      screen.getByRole('button', { name: 'Parcel 7' }).click();
    });

    rerender(
      <PhotoGrid
        label="Photos of Kente Crafts"
        items={ITEMS.slice(0, 3)}
        renderPicture={picture}
      />,
    );

    expect(screen.getAllByRole('button').filter((button) => button.tabIndex === 0)).toHaveLength(1);
  });
});

describe('PhotoGrid: pictures for the tiles that are near', () => {
  class FakeObserver {
    static all: FakeObserver[] = [];
    readonly callback: IntersectionObserverCallback;
    readonly disconnect = vi.fn();
    readonly observe = vi.fn();
    readonly unobserve = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
      FakeObserver.all.push(this);
    }
    comes(near: boolean, element: Element): void {
      this.callback(
        [{ isIntersecting: near, target: element } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
    }
  }

  // Break caught: sixty pictures asked for when a page opens, near the screen or not (the page asks the platform for a link for each).
  it('says a tile is not near until the browser says it is, and then says so for good', () => {
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    grid();
    expect(FakeObserver.all).toHaveLength(ITEMS.length);
    expect(screen.getByTestId('picture-a')).toHaveAttribute('data-near', 'false');

    const tile = screen.getByRole('button', { name: 'Parcel 1' });
    act(() => {
      FakeObserver.all[0]?.comes(true, tile);
    });
    expect(screen.getByTestId('picture-a')).toHaveAttribute('data-near', 'true');
    expect(screen.getByTestId('picture-e')).toHaveAttribute('data-near', 'false');

    // A tile that has been near stays near: its link is not asked for again when it scrolls away and back.
    act(() => {
      FakeObserver.all[0]?.comes(false, tile);
    });
    expect(screen.getByTestId('picture-a')).toHaveAttribute('data-near', 'true');
  });

  it('stops watching a tile once it is near, and when it is gone', () => {
    FakeObserver.all = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const { unmount } = grid();
    const tile = screen.getByRole('button', { name: 'Parcel 1' });

    act(() => {
      FakeObserver.all[0]?.comes(true, tile);
    });
    expect(FakeObserver.all[0]?.disconnect).toHaveBeenCalled();

    unmount();
    for (const one of FakeObserver.all) expect(one.disconnect).toHaveBeenCalled();
  });

  it('takes every tile as near where the browser has no way to tell', () => {
    grid();
    for (const item of ITEMS) {
      expect(screen.getByTestId(`picture-${item.key}`)).toHaveAttribute('data-near', 'true');
    }
  });

  it('watches with a margin, so that a tile just below the screen is ready when it arrives', () => {
    const margins: (string | undefined)[] = [];
    class MarginObserver extends FakeObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback);
        margins.push(options?.rootMargin);
      }
    }
    vi.stubGlobal('IntersectionObserver', MarginObserver);
    grid();

    expect(margins).toHaveLength(ITEMS.length);
    for (const margin of margins) expect(margin).toMatch(/^\d+px$/);
  });
});

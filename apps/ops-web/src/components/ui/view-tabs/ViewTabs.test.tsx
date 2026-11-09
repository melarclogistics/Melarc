import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { ViewTabs, type ViewTab } from './ViewTabs';

const TABS: readonly ViewTab[] = [
  { id: 'needs-decision', label: 'Needs decision', count: 12 },
  { id: 'confirmed', label: 'Confirmed', count: 0 },
  { id: 'cancelled', label: 'Cancelled', count: 31 },
  { id: 'all', label: 'All' },
];

function Host({
  tabs = TABS,
  initial = 'needs-decision',
  onValueChange,
}: {
  tabs?: readonly ViewTab[];
  initial?: string;
  onValueChange?: (id: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <ViewTabs
      label="Views of the pickup queue"
      tabs={tabs}
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange?.(next);
      }}
    >
      <p>The {value} view</p>
    </ViewTabs>
  );
}

const tab = (name: RegExp | string) => screen.getByRole('tab', { name });

describe('ViewTabs', () => {
  // Break caught: tabs that are not a tablist of tab elements with the current one selected and a tabpanel for its view (the roles a keyboard user navigates by).
  it('is a named list of tabs with the current one selected, and its view as the panel', () => {
    render(<Host />);

    expect(screen.getByRole('tablist', { name: 'Views of the pickup queue' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(tab(/^Needs decision/)).toHaveAttribute('aria-selected', 'true');
    expect(tab(/^Confirmed/)).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The needs-decision view');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/^Needs decision/);
  });

  // Break caught: a count the server did not give drawn as 0 (a view whose count is still being read), or a count that was given and left out.
  it('draws a count only for a view that has one, and never for one that has none', () => {
    const { container } = render(<Host />);

    const pills = [...container.querySelectorAll('.ui-view-tabs__count')].map(
      (pill) => pill.textContent,
    );
    expect(pills).toEqual(['12', '0', '31']);
    expect(tab('All').querySelector('.ui-view-tabs__count')).toBeNull();
  });

  // Break caught: a 0 that was read drawn like work waiting, or dropped as though it were missing.
  it('draws a 0 that was read, quietly', () => {
    render(<Host />);

    const pill = tab(/^Confirmed/).querySelector('.ui-view-tabs__count');
    expect(pill).toHaveTextContent('0');
    expect(pill).toHaveAttribute('data-quiet', 'true');
  });

  // Break caught: the Ink pill on every tab, or on none: only the current view's count is filled.
  it('marks the current view count, and only that one, and follows the view that is chosen', async () => {
    const user = userEvent.setup();
    const { container } = render(<Host />);
    const current = () =>
      [...container.querySelectorAll('.ui-view-tabs__count[data-current="true"]')].map(
        (pill) => pill.textContent,
      );

    expect(current()).toEqual(['12']);
    await user.click(tab(/^Cancelled/));
    expect(current()).toEqual(['31']);
  });

  // Break caught: a tab that does not ask the page for the view, or a page that is not told which.
  it('asks for the view that is chosen, with the pointer, and shows it', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Host onValueChange={onValueChange} />);

    await user.click(tab(/^Cancelled/));

    expect(onValueChange).toHaveBeenCalledWith('cancelled');
    expect(tab(/^Cancelled/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('The cancelled view');
  });

  // Break caught: a list a keyboard cannot walk: Tab enters it at the current view and leaves it in one stop, the arrows and Home and End move focus, and Enter or Space
  // chooses (task R5.2, M12: manual activation, so that an arrow passing over a tab does not ask the server for its view).
  it('is walked from the keyboard: one stop for Tab, the arrows and Home and End move, Enter and Space choose', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button type="button">Before</button>
        <Host />
      </>,
    );

    await user.tab();
    await user.tab();
    expect(tab(/^Needs decision/)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab(/^Confirmed/)).toHaveFocus();
    // Focus moved and nothing was chosen: the view is still the first, and the page was asked for nothing.
    expect(tab(/^Confirmed/)).toHaveAttribute('aria-selected', 'false');
    expect(tab(/^Needs decision/)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(tab(/^Confirmed/)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(tab('All')).toHaveFocus();
    expect(tab('All')).toHaveAttribute('aria-selected', 'false');
    await user.keyboard('{ArrowRight}');
    expect(tab(/^Needs decision/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab(/^Needs decision/)).toHaveFocus();
    await user.keyboard(' ');
    expect(tab(/^Needs decision/)).toHaveAttribute('aria-selected', 'true');
    await user.tab();
    // The next stop is the panel's content or past it, never the next tab.
    expect(tab(/^Confirmed/)).not.toHaveFocus();
  });

  // Break caught: a view that cannot be chosen now taking focus or being chosen.
  it('skips a view that cannot be chosen now', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Host
        onValueChange={onValueChange}
        tabs={[
          { id: 'one', label: 'One', count: 1 },
          { id: 'two', label: 'Two', disabled: true },
          { id: 'three', label: 'Three', count: 3 },
        ]}
        initial="one"
      />,
    );

    await user.click(tab(/^One/));
    await user.keyboard('{ArrowRight}');
    expect(tab(/^Three/)).toHaveFocus();
    await user.click(tab('Two'));
    expect(onValueChange).not.toHaveBeenCalledWith('two');
  });

  // Break caught: two views with one id drawn as if nothing were wrong: a defect of the page.
  it('throws for two views with one id', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <Host
          tabs={[
            { id: 'a', label: 'A' },
            { id: 'a', label: 'Also A' },
          ]}
          initial="a"
        />,
      ),
    ).toThrow(/have the id "a"/);
    quiet.mockRestore();
  });

  // Break caught (task R5.2, M12): a current view that is not one of the views (an address that names a view that no longer exists) throwing, so that the whole page falls
  // over for a stale link: the first view that can be chosen is drawn, and the page is asked for nothing.
  it('draws the first view that can be chosen for a current view that is not there, and asks for nothing', () => {
    const onValueChange = vi.fn();
    render(
      <Host
        initial="nothing"
        onValueChange={onValueChange}
        tabs={[
          { id: 'a', label: 'A', disabled: true },
          { id: 'b', label: 'B' },
        ]}
      />,
    );

    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  // Break caught: a tab with no name (a count alone), a panel not tied to its tab or any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(<Host />);

    expect(await wcagViolations(container)).toEqual([]);
  });
});

/**
 * The row of tabs with the measures of a layout engine given to it by hand: jsdom measures nothing, so a test that reads the fade or the scrolling says what the row measures.
 * `scrollLeft` is kept by the test (and held at 0 or more, as a browser holds it).
 */
function measuredRow(container: HTMLElement, sizes: { scrollWidth: number; clientWidth: number }) {
  const row = container.querySelector<HTMLElement>('.ui-view-tabs__scroll');
  if (row === null) throw new Error('the tabs have no row');
  let left = 0;
  Object.defineProperty(row, 'scrollWidth', { configurable: true, get: () => sizes.scrollWidth });
  Object.defineProperty(row, 'clientWidth', { configurable: true, get: () => sizes.clientWidth });
  Object.defineProperty(row, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (value: number) => {
      left = Math.min(Math.max(0, value), sizes.scrollWidth - sizes.clientWidth);
    },
  });
  return row;
}

describe('ViewTabs on a narrow screen', () => {
  // Break caught: a row that is cut off at the edge of the screen with nothing to say so (the last tab looks like the last tab), or a fade left on a row that fits.
  it('marks which end of the row is cut off, from its scroll position, and none when nothing is', () => {
    const { container } = render(<Host />);
    const sizes = { scrollWidth: 600, clientWidth: 300 };
    const row = measuredRow(container, sizes);
    const scrollTo = (value: number) => {
      row.scrollLeft = value;
      fireEvent.scroll(row);
    };

    scrollTo(0);
    expect(row).toHaveAttribute('data-fade', 'end');
    scrollTo(150);
    expect(row).toHaveAttribute('data-fade', 'start end');
    scrollTo(300);
    expect(row).toHaveAttribute('data-fade', 'start');

    sizes.scrollWidth = 300;
    scrollTo(0);
    expect(row).not.toHaveAttribute('data-fade');
  });

  // Break caught: a view chosen by the address or by the keys that stays out of sight behind the edge, so that the page says one view and the row shows another.
  it('brings the current view into view when it changes, and leaves a view that is clear of the edges where it is', async () => {
    const user = userEvent.setup();
    const { container } = render(<Host />);
    // The list is 520px wide in a row of 300px, so that it can scroll by 220px: 50px of it lie after the last tab.
    const row = measuredRow(container, { scrollWidth: 520, clientWidth: 300 });
    // Four tabs of 110px, 120px apart, in a row 300px wide that starts at 0.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = (left: number, right: number): DOMRect =>
        ({
          left,
          right,
          top: 0,
          bottom: 30,
          width: right - left,
          height: 30,
          x: left,
          y: 0,
        }) as DOMRect;
      if (this.classList.contains('ui-view-tabs__scroll')) return rect(0, 300);
      if (this.getAttribute('role') === 'tab') {
        const place =
          [...(this.parentElement?.children ?? [])].indexOf(this) * 120 - row.scrollLeft;
        return rect(place, place + 110);
      }
      return rect(0, 0);
    });

    // The second view is whole and clear of both ends (120 to 230 in a row of 300, with 24px kept clear): the row stays where it is.
    await user.click(tab(/^Confirmed/));
    expect(row.scrollLeft).toBe(0);

    // A view in the middle that is cut off (240 to 350): the row moves until it is whole and clear of the end by 24px, so that the next one shows beside it.
    await user.click(tab(/^Cancelled/));
    expect(row.scrollLeft).toBe(350 - 300 + 24);
    expect(row).toHaveAttribute('data-fade', 'start end');

    // The last view: the row goes to its end, whole, and the 50px after the tab are not left as a cut-off end (a fade there would say that something is hidden when nothing is).
    await user.click(tab('All'));
    expect(row.scrollLeft).toBe(220);
    expect(row).toHaveAttribute('data-fade', 'start');

    // The first view is cut off now: the row goes back to the start.
    await user.click(tab(/^Needs decision/));
    expect(row.scrollLeft).toBe(0);
    expect(row).toHaveAttribute('data-fade', 'end');
  });

  // Break caught (found on the pickup queue at 320 and 390 px): the current view brought into view once, at the first draw, before the counts and the fonts have arrived and made the list longer,
  // so that the last view is cut off again and its end fades. The row keeps the current view in view while the list grows, until the person scrolls it themselves.
  it('keeps the current view in view while the list grows, and stops once the person has scrolled it', async () => {
    let notify: ResizeObserverCallback = () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          notify = callback;
        }
        observe(): void {
          // The test says when the sizes changed.
        }
        unobserve(): void {
          // As above.
        }
        disconnect(): void {
          // As above.
        }
      },
    );
    const user = userEvent.setup();
    const { container } = render(<Host />);
    const sizes = { scrollWidth: 520, clientWidth: 300 };
    const row = measuredRow(container, sizes);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const rect = (left: number, right: number): DOMRect =>
        ({
          left,
          right,
          top: 0,
          bottom: 30,
          width: right - left,
          height: 30,
          x: left,
          y: 0,
        }) as DOMRect;
      if (this.classList.contains('ui-view-tabs__scroll')) return rect(0, 300);
      if (this.getAttribute('role') === 'tab') {
        const place =
          [...(this.parentElement?.children ?? [])].indexOf(this) * 120 - row.scrollLeft;
        return rect(place, place + 110);
      }
      return rect(0, 0);
    });
    await user.click(tab('All'));
    expect(row.scrollLeft).toBe(220);

    // The counts arrive and the list is longer: the last view is still the current one, and the row follows it to the new end.
    sizes.scrollWidth = 600;
    act(() => {
      notify([], {} as ResizeObserver);
    });
    expect(row.scrollLeft).toBe(300);
    expect(row).toHaveAttribute('data-fade', 'start');

    // The person scrolls the row with the wheel: it is theirs from then on, and the list growing again does not move it.
    fireEvent.wheel(row);
    row.scrollLeft = 100;
    sizes.scrollWidth = 700;
    act(() => {
      notify([], {} as ResizeObserver);
    });
    expect(row.scrollLeft).toBe(100);
  });
});

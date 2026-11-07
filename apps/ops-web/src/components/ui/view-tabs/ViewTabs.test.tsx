import { render, screen } from '@testing-library/react';
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

  // Break caught: a list a keyboard cannot walk: Tab enters it at the current view and leaves it in one stop, the arrows move and choose, Home and End go to the ends.
  it('is walked from the keyboard: one stop for Tab, the arrows and Home and End choose', async () => {
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
    expect(tab(/^Confirmed/)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(tab('All')).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(tab(/^Needs decision/)).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab(/^Needs decision/)).toHaveFocus();
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

  // Break caught: two views with one id, or a current view that is not in the list, drawn as if nothing were wrong: a defect of the page.
  it('throws for two views with one id, and for a current view that is not there', () => {
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
    expect(() => render(<Host initial="nothing" />)).toThrow(/is not one of the views/);
    quiet.mockRestore();
  });

  // Break caught: a tab with no name (a count alone), a panel not tied to its tab or any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(<Host />);

    expect(await wcagViolations(container)).toEqual([]);
  });
});

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Dialog } from '../dialog/Dialog';
import { FilterBar, type FilterBarProps, type FilterChip } from './FilterBar';

const CHIPS: readonly FilterChip[] = [
  { id: 'date', label: 'Service date: this week' },
  { id: 'state', label: 'State: Confirmed' },
  { id: 'hub', label: 'Hub: Accra Central' },
];

/** A page that holds the filters, as a real one does: the bar only asks for one to be taken off, and draws what it is given. */
function Host(props: Partial<FilterBarProps> & { initial?: readonly FilterChip[] }) {
  const { initial = CHIPS, onRemove, ...rest } = props;
  const [chips, setChips] = useState(initial);
  return (
    <FilterBar
      label="Filters"
      chips={chips}
      filterPanel={
        <label>
          Vendor <input type="text" />
        </label>
      }
      {...rest}
      onRemove={(id) => {
        setChips((current) => current.filter((chip) => chip.id !== id));
        onRemove?.(id);
      }}
    />
  );
}

const remove = (name: string) => screen.getByRole('button', { name: `Remove filter: ${name}` });

describe('FilterBar', () => {
  // Break caught: the filters not a named group, or the applied chips not a list a screen reader can count (Safari drops a list whose markers a style removes).
  it('is a named group, and what is applied is a named list of chips', () => {
    render(<Host />);

    const group = screen.getByRole('group', { name: 'Filters' });
    const chips = within(group).getByRole('list', { name: 'Applied filters' });
    expect(
      within(chips)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(CHIPS.map((chip) => chip.label));
  });

  // Break caught: a chip that cannot be removed on its own, or a remove button that does not say which filter it takes off.
  it('removes one chip with its own button, which is named for the filter', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    render(<Host onRemove={onRemove} />);

    await user.click(remove('State: Confirmed'));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith('state');
    expect(screen.queryByText('State: Confirmed')).toBeNull();
    expect(screen.getByText('Service date: this week')).toBeVisible();
  });

  // Break caught: focus left on a button that is gone (it falls to the page and a keyboard user starts again from the top), after removing a chip.
  it('moves focus to the next chip when one is removed, else to the previous one, else to the Filter button', async () => {
    const user = userEvent.setup();
    render(<Host />);

    remove('Service date: this week').focus();
    await user.keyboard('{Enter}');
    expect(remove('State: Confirmed')).toHaveFocus();

    remove('Hub: Accra Central').focus();
    await user.keyboard('{Enter}');
    expect(remove('State: Confirmed')).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Filter' })).toHaveFocus();
    expect(screen.queryByRole('list', { name: 'Applied filters' })).toBeNull();
  });

  // Break caught: no filter applied still draws an empty list or a Clear all that clears nothing.
  it('draws only the Filter button when nothing is applied', () => {
    const { container } = render(<Host initial={[]} />);

    expect(container.querySelector('.ui-filter-bar__chips')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filter' })).toBeVisible();
  });

  // Break caught: "Clear all" offered for a single chip, which has its own remove button, or not offered for several.
  it('offers Clear all from the second chip on, and only when the page can clear them', async () => {
    const user = userEvent.setup();
    const onClearAll = vi.fn();
    const { rerender } = render(
      <FilterBar
        label="Filters"
        chips={CHIPS.slice(0, 1)}
        onRemove={vi.fn()}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();

    rerender(
      <FilterBar label="Filters" chips={CHIPS} onRemove={vi.fn()} onClearAll={onClearAll} />,
    );
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onClearAll).toHaveBeenCalledTimes(1);

    rerender(<FilterBar label="Filters" chips={CHIPS} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  });

  // Break caught: a popover that opens without the person's fields in reach, that cannot be left with Escape, or that loses the person's place.
  it('opens the page fields from the Filter button, with focus inside, and Escape gives focus back', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const button = screen.getByRole('button', { name: 'Filter' });

    await user.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Filter' });
    expect(within(panel).getByRole('textbox')).toBeInTheDocument();
    expect(panel.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  // Break caught: a Filter button with nothing to choose from, which opens an empty popover.
  it('has no Filter button when the page gives it no fields', () => {
    render(<FilterBar label="Filters" chips={[]} onRemove={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Filter' })).toBeNull();
  });

  // Break caught: a sort label drawn when the screen did not say how the rows are ordered: the bar sorts nothing.
  it('says how the rows are ordered only when the screen says it', () => {
    const { rerender } = render(<FilterBar label="Filters" chips={[]} onRemove={vi.fn()} />);
    expect(screen.queryByText(/Sorted by/)).toBeNull();

    rerender(
      <FilterBar
        label="Filters"
        chips={[]}
        onRemove={vi.fn()}
        sortLabel="Sorted by oldest first"
      />,
    );
    expect(screen.getByText('Sorted by oldest first')).toBeVisible();
  });

  // Break caught: two chips with one id, each taking the other's removal and focus.
  it('throws for two filters with one id', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() =>
      render(
        <FilterBar
          label="Filters"
          chips={[
            { id: 'a', label: 'A' },
            { id: 'a', label: 'B' },
          ]}
          onRemove={vi.fn()}
        />,
      ),
    ).toThrow(/have the id "a"/);
    quiet.mockRestore();
  });

  // Break caught: a remove button with no name, a list outside its group or any structure a rule of WCAG 2.2 can see without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(<Host sortLabel="Sorted by oldest first" onClearAll={vi.fn()} />);

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('FilterBar: the search field', () => {
  const SEARCH_LABEL = 'Search by name or email';

  // Break caught (the Product Owner, 10 November 2026): a search that is only in the Filter button's popover, so that the person has to open something to find a name; or one with no name, or after
  // the chips, or one that does not show the search that is applied.
  it('draws the search field first in the bar, named for what it searches, with the applied search in it, with nothing opened', () => {
    render(<Host search={{ label: SEARCH_LABEL, value: 'ama', onSearch: vi.fn() }} />);

    const group = screen.getByRole('group', { name: 'Filters' });
    const form = within(group).getByRole('search', { name: SEARCH_LABEL });
    expect(within(form).getByRole('searchbox', { name: SEARCH_LABEL })).toHaveValue('ama');
    expect(within(form).getByRole('button', { name: 'Search' })).toBeVisible();
    // The popover is shut and the field is in the page, before the chips.
    expect(screen.queryByRole('dialog')).toBeNull();
    const order = form.compareDocumentPosition(
      within(group).getByRole('list', { name: 'Applied filters' }),
    );
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('has no search field when the page gives none', () => {
    render(<Host />);

    expect(screen.queryByRole('search')).toBeNull();
  });

  // Break caught: a search that is sent untrimmed (a name with a space at its end finds nobody), that cannot be sent from the keyboard (Enter) or from the button, or one that cannot be taken off.
  it('applies what is typed, without the spaces at its ends, on Enter and on the button, and an empty field takes the search off', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<Host search={{ label: SEARCH_LABEL, value: '', onSearch, maxLength: 80 }} />);

    const field = screen.getByRole('searchbox', { name: SEARCH_LABEL });
    expect(field).toHaveAttribute('maxlength', '80');
    await user.type(field, '  kofi mensah  {Enter}');
    expect(onSearch).toHaveBeenLastCalledWith('kofi mensah');

    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSearch).toHaveBeenLastCalledWith('');
    expect(onSearch).toHaveBeenCalledTimes(2);
  });

  // Break caught: what the person typed lost whenever the page draws again (the field resets under their hands), or a field that keeps its draft when the address says another search (Back).
  it('keeps what is typed over the applied search, and shows the applied search again when the address says another', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const { rerender } = render(<Host search={{ label: SEARCH_LABEL, value: 'ama', onSearch }} />);
    const field = screen.getByRole('searchbox', { name: SEARCH_LABEL });

    await user.clear(field);
    await user.type(field, 'kof');
    rerender(<Host search={{ label: SEARCH_LABEL, value: 'ama', onSearch }} />);
    expect(screen.getByRole('searchbox', { name: SEARCH_LABEL })).toHaveValue('kof');

    rerender(<Host search={{ label: SEARCH_LABEL, value: 'yaw', onSearch }} />);
    expect(screen.getByRole('searchbox', { name: SEARCH_LABEL })).toHaveValue('yaw');
  });

  it('has no WCAG violations that can be checked without a layout engine', async () => {
    const { container } = render(
      <Host search={{ label: SEARCH_LABEL, value: 'ama', onSearch: vi.fn() }} />,
    );

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('FilterBar: the popover of the page’s fields (task R5.2, M8 and M12)', () => {
  const FILTER = () => screen.getByRole('button', { name: 'Filter' });

  // Break caught: a popover the page cannot close (a filter applied from inside it leaves it open over the rows), or one that ignores what the page says.
  it('is opened and closed by the page when it is given both the state and the change', async () => {
    const user = userEvent.setup();
    const changes: boolean[] = [];
    function Page() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            Apply
          </button>
          <Host
            filterOpen={open}
            onFilterOpenChange={(next) => {
              changes.push(next);
              setOpen(next);
            }}
          />
        </>
      );
    }
    render(<Page />);

    expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull();
    await user.click(FILTER());
    expect(await screen.findByRole('dialog', { name: 'Filter' })).toBeVisible();
    expect(changes).toEqual([true]);

    // The page closes it: the Apply of the page, outside the popover, after the person chose something in it.
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull();
    });
    expect(changes).toEqual([true, false]);

    await user.click(FILTER());
    expect(await screen.findByRole('dialog', { name: 'Filter' })).toBeVisible();
  });

  it('draws the popover open when the page says it is open, and shut when the page says so', () => {
    const view = render(<Host filterOpen onFilterOpenChange={vi.fn()} />);
    expect(screen.getByRole('dialog', { name: 'Filter' })).toBeVisible();

    view.rerender(<Host filterOpen={false} onFilterOpenChange={vi.fn()} />);
    expect(screen.queryByRole('dialog', { name: 'Filter' })).toBeNull();
  });

  // Break caught: the popover drawn into the page's body when the bar is in a dialog, under the dialog's top layer: unseen and out of reach.
  it('is drawn into the dialog that holds the bar', async () => {
    const user = userEvent.setup();
    render(
      <Dialog open title="Choose the requests">
        <Host />
      </Dialog>,
    );

    await user.click(FILTER());

    const popover = await screen.findByRole('dialog', { name: 'Filter' });
    expect(document.querySelector('dialog')?.contains(popover)).toBe(true);
  });
});

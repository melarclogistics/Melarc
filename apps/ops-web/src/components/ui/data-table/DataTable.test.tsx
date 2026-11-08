import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { DataTable, RowTitle, type DataColumn, type DataTableProps } from './DataTable';

interface Request {
  readonly id: string;
  readonly code: string;
  readonly sender: string;
  readonly state: string;
  readonly date: string;
}

const FIRST: Request = {
  id: 'r1',
  code: 'ACC-PR-7KQ2MZ',
  sender: 'Demo Fabrics Ltd',
  state: 'Confirmed',
  date: 'Wed 4 Nov',
};
const SECOND: Request = {
  id: 'r2',
  code: 'ACC-PR-4HT9WD',
  sender: 'Demo Bakery',
  state: 'Waiting',
  date: 'Thu 5 Nov',
};
const THIRD: Request = {
  id: 'r3',
  code: 'ACC-PR-2MX8RC',
  sender: 'Demo Pharmacy',
  state: 'Confirmed',
  date: 'Thu 5 Nov',
};
const REQUESTS: readonly Request[] = [FIRST, SECOND, THIRD];

const REQUEST_COLUMN: DataColumn<Request> = {
  id: 'request',
  header: 'Request / sender',
  rowHeader: true,
  cell: (item) => <RowTitle code={item.code} name={item.sender} />,
};
const STATE_COLUMN: DataColumn<Request> = {
  id: 'state',
  header: 'State',
  cell: (item) => item.state,
};
const DATE_COLUMN: DataColumn<Request> = {
  id: 'date',
  header: 'Service date',
  cell: (item) => item.date,
  sortable: true,
};
const COLUMNS: readonly DataColumn<Request>[] = [REQUEST_COLUMN, STATE_COLUMN, DATE_COLUMN];

type Props = Partial<DataTableProps<Request>>;

function Table(props: Props) {
  return (
    <DataTable<Request>
      label="Pickup requests"
      columns={COLUMNS}
      rows={REQUESTS}
      rowId={(item) => item.id}
      onOpen={vi.fn()}
      openLabel={(item) => `Open ${item.code}, ${item.sender}`}
      {...props}
    />
  );
}

/** A page that holds the selection, as a real one does: the table only asks for a change, and draws what it is given. */
function Chosen({ onOpen, bulk = true }: { onOpen?: (item: Request) => void; bulk?: boolean }) {
  const [ids, setIds] = useState<readonly string[]>([]);
  return (
    <Table
      onOpen={onOpen ?? vi.fn()}
      selection={{
        selectedIds: ids,
        onChange: setIds,
        selectLabel: (item) => `Select ${item.code}`,
        ...(bulk
          ? {
              bulkActions: [
                {
                  id: 'confirm',
                  label: (count) => `Confirm ${String(count)}`,
                  onRun: vi.fn(),
                  primary: true,
                },
              ],
            }
          : {}),
      }}
    />
  );
}

const opener = (code: string) => screen.getByRole('button', { name: new RegExp(`^Open ${code}`) });

describe('DataTable', () => {
  // Break caught: a table with no name, no column headings or a row missing or added, or a box that scrolls and cannot be reached by the keyboard.
  it('is a table named by its label, with a header and a row for each request', () => {
    render(<Table />);

    const table = screen.getByRole('table', { name: 'Pickup requests' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Request / sender', 'State', 'Service date']);
    expect(within(table).getAllByRole('row')).toHaveLength(1 + REQUESTS.length);
    // A box that scrolls on its own has a name and takes focus, so that the rows off to the side can be reached.
    const region = screen.getByRole('region', { name: 'Pickup requests' });
    expect(region).toHaveAttribute('tabindex', '0');
  });

  // Break caught: a code set in the body face, cut short, or lost from the cell that names the row.
  it('names each row by its code in the code face, whole, over the name', () => {
    render(<Table />);

    const header = screen.getByRole('rowheader', { name: /ACC-PR-7KQ2MZ/ });
    expect(header.querySelector('.ui-code')).toHaveTextContent(/^ACC-PR-7KQ2MZ$/);
    expect(header.querySelector('.ui-data-table__name')).toHaveTextContent('Demo Fabrics Ltd');
  });

  describe('opening a record', () => {
    // Break caught: the open act as a click handler on a row or a div (which no keyboard reaches), or a button that is not in the code cell.
    it('is a real button in the code cell, named for the record, and a press opens it', async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      render(<Table onOpen={onOpen} />);

      const button = opener('ACC-PR-4HT9WD');
      expect(button.tagName).toBe('BUTTON');
      expect(button.closest('th')).toHaveAttribute('scope', 'row');
      expect(button).toHaveAccessibleName('Open ACC-PR-4HT9WD, Demo Bakery');
      await user.click(button);

      expect(onOpen).toHaveBeenCalledExactlyOnceWith(REQUESTS[1]);
      // No other element of the row opens anything.
      expect(screen.getAllByRole('button')).toHaveLength(REQUESTS.length);
    });

    // Break caught: Enter on the code button not opening the record, the key a keyboard user opens a row with.
    it('opens with Enter', async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      render(<Table onOpen={onOpen} />);

      opener('ACC-PR-7KQ2MZ').focus();
      await user.keyboard('{Enter}');

      expect(onOpen).toHaveBeenCalledExactlyOnceWith(REQUESTS[0]);
    });

    // Break caught: a table whose rows open nothing drawing buttons that do nothing.
    it('draws no button for a table whose rows open nothing', () => {
      render(
        <DataTable<Request>
          label="Pickup requests"
          columns={COLUMNS}
          rows={REQUESTS}
          rowId={(item) => item.id}
        />,
      );

      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  describe('choosing rows', () => {
    // Break caught: Space opening the record (the button's own press) instead of choosing the row.
    it('chooses the row with Space and does not open it', async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      render(<Chosen onOpen={onOpen} />);

      opener('ACC-PR-7KQ2MZ').focus();
      await user.keyboard(' ');

      expect(onOpen).not.toHaveBeenCalled();
      expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toBeChecked();
      expect(opener('ACC-PR-7KQ2MZ').closest('tr')).toHaveAttribute('data-state', 'selected');
      await user.keyboard(' ');
      expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).not.toBeChecked();
    });

    // Break caught: a box that does not name its row, that cannot be used by the keyboard or whose state is not the page's.
    it('has a checkbox for each row, named for it, that chooses it', async () => {
      const user = userEvent.setup();
      render(<Chosen />);

      const box = screen.getByRole('checkbox', { name: 'Select ACC-PR-2MX8RC' });
      expect(box).not.toBeChecked();
      await user.click(box);

      expect(box).toBeChecked();
      expect(screen.getAllByRole('checkbox')).toHaveLength(REQUESTS.length);
    });

    // Break caught: a "select all" that chooses a page nobody asked to choose (the queue rule).
    it('offers no way to choose every row at once', () => {
      render(<Chosen />);

      expect(screen.queryByRole('checkbox', { name: /all/i })).toBeNull();
      const header = screen.getAllByRole('columnheader')[0];
      expect(header?.querySelector('[role="checkbox"]')).toBeNull();
    });

    // Break caught: the bar drawn for nothing chosen, or its words and its primary act not following the choice.
    it('slides a bar in for the rows that are chosen, with the number and the act', async () => {
      const user = userEvent.setup();
      render(<Chosen />);
      expect(screen.queryByRole('group', { name: 'Actions for the chosen rows' })).toBeNull();

      await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' }));

      const bar = await screen.findByRole('group', { name: 'Actions for the chosen rows' });
      expect(within(bar).getByText('2 selected')).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Confirm 2' })).toBeEnabled();
      expect(within(bar).getByRole('button', { name: 'Clear' })).toBeEnabled();
      // Said once, in words, for whoever hears the page.
      expect(screen.getAllByText('2 selected', { selector: '[role="status"]' })).toHaveLength(1);
    });

    // Break caught: Clear that leaves the rows chosen, or that leaves focus on a button that is gone.
    it('clears the choice with Clear, and focus goes to the row', async () => {
      const user = userEvent.setup();
      render(<Chosen />);
      await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));
      const bar = await screen.findByRole('group', { name: 'Actions for the chosen rows' });

      await user.click(within(bar).getByRole('button', { name: 'Clear' }));

      expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).not.toBeChecked();
      await waitFor(() => {
        expect(screen.queryByRole('group', { name: 'Actions for the chosen rows' })).toBeNull();
      });
      expect(opener('ACC-PR-7KQ2MZ')).toHaveFocus();
    });

    // Break caught: a bar with no act to offer (the choice alone is not an act), or an act that does not receive the ids it acts on.
    it('runs a bulk act on the ids chosen, and draws no bar where there is no act', async () => {
      const user = userEvent.setup();
      const onRun = vi.fn();
      render(
        <Table
          selection={{
            selectedIds: ['r1', 'r3'],
            onChange: vi.fn(),
            selectLabel: (item) => `Select ${item.code}`,
            bulkActions: [
              { id: 'confirm', label: (n) => `Confirm ${String(n)}`, onRun, primary: true },
            ],
          }}
        />,
      );

      await user.click(await screen.findByRole('button', { name: 'Confirm 2' }));
      expect(onRun).toHaveBeenCalledExactlyOnceWith(['r1', 'r3']);
    });

    // Break caught: a bar drawn for a choice that has no act to offer (the choice alone is not an act, and the bar would be empty).
    it('draws no bar when there is no bulk act', async () => {
      const user = userEvent.setup();
      render(<Chosen bulk={false} />);

      await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));

      expect(screen.queryByRole('group', { name: 'Actions for the chosen rows' })).toBeNull();
    });

    // Break caught: a row that cannot be chosen now taking a choice, or a choice kept for a row the page says cannot have one.
    it('does not let a row be chosen that the page says cannot be', () => {
      render(
        <Table
          selection={{
            selectedIds: [],
            onChange: vi.fn(),
            selectLabel: (item) => `Select ${item.code}`,
            isSelectable: (item) => item.state !== 'Waiting',
          }}
        />,
      );

      expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toBeEnabled();
    });
  });

  describe('the keyboard', () => {
    // Break caught: every control of every row in the Tab order (seventy-five stops for twenty-five rows), or none: one row's controls are the stop.
    it('puts one row in the Tab order, and the arrows, Home and End move it', async () => {
      const user = userEvent.setup();
      render(<Chosen />);
      const stops = () =>
        screen
          .getAllByRole('button')
          .concat(screen.getAllByRole('checkbox'))
          .filter((control) => control.getAttribute('tabindex') === '0')
          .map((control) => control.getAttribute('aria-label'));

      expect(stops()).toEqual(['Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd', 'Select ACC-PR-7KQ2MZ']);
      opener('ACC-PR-7KQ2MZ').focus();
      await user.keyboard('{ArrowDown}');
      expect(opener('ACC-PR-4HT9WD')).toHaveFocus();
      expect(stops()).toEqual(['Open ACC-PR-4HT9WD, Demo Bakery', 'Select ACC-PR-4HT9WD']);
      await user.keyboard('{End}');
      expect(opener('ACC-PR-2MX8RC')).toHaveFocus();
      await user.keyboard('{ArrowDown}');
      expect(opener('ACC-PR-2MX8RC')).toHaveFocus();
      await user.keyboard('{Home}');
      expect(opener('ACC-PR-7KQ2MZ')).toHaveFocus();
      await user.keyboard('{ArrowUp}');
      expect(opener('ACC-PR-7KQ2MZ')).toHaveFocus();
    });

    // Break caught: Tab walking through every row (a long queue with no way out), or Tab that cannot leave the table.
    it('leaves the table in a few stops with Tab', async () => {
      const user = userEvent.setup();
      render(
        <>
          <button type="button">Before</button>
          <Chosen />
          <button type="button">After</button>
        </>,
      );

      screen.getByRole('button', { name: 'Before' }).focus();
      await user.tab(); // the box that scrolls
      await user.tab(); // the current row's box
      await user.tab(); // the current row's button
      await user.tab();
      expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    });

    // Break caught: the arrows taken from a control that uses them, so that a field in a cell cannot move its caret.
    it('leaves the arrows to a field inside a cell', async () => {
      const user = userEvent.setup();
      render(
        <Table
          columns={[
            ...COLUMNS,
            {
              id: 'note',
              header: 'Note',
              cell: () => <input aria-label="Note" defaultValue="abc" />,
            },
          ]}
        />,
      );

      const note = screen.getAllByRole('textbox', { name: 'Note' })[0];
      note?.focus();
      await user.keyboard('{ArrowDown}');

      expect(note).toHaveFocus();
    });

    // Break caught: the keys not described to assistive technology, or described with a key the table does not have (Enter where nothing opens, Space where nothing is chosen).
    it('describes its keys to assistive technology, as far as it has them', () => {
      const { rerender } = render(<Chosen />);
      const table = screen.getByRole('table', { name: 'Pickup requests' });
      expect(table).toHaveAccessibleDescription(
        'Use the up and down arrow keys to move between rows. Enter opens the record. Space chooses the row.',
      );

      rerender(
        <DataTable<Request>
          label="Pickup requests"
          columns={COLUMNS}
          rows={REQUESTS}
          rowId={(item) => item.id}
        />,
      );
      expect(screen.getByRole('table')).toHaveAccessibleDescription(
        'Use the up and down arrow keys to move between rows.',
      );
    });
  });

  describe('the inline act of a row', () => {
    // Break caught: an act that is not in the page for a keyboard (it is shown by hover), or that does not name its row.
    it('is a button in each row, named for the row, that runs for that row', async () => {
      const user = userEvent.setup();
      const onRun = vi.fn();
      render(
        <Table
          rowAction={{
            label: 'Confirm',
            ariaLabel: (item) => `Confirm ${item.code}`,
            onRun,
          }}
        />,
      );

      await user.click(screen.getByRole('button', { name: 'Confirm ACC-PR-4HT9WD' }));

      expect(onRun).toHaveBeenCalledExactlyOnceWith(REQUESTS[1]);
      expect(screen.getAllByText('Confirm')).toHaveLength(REQUESTS.length);
    });

    // Break caught: an act offered for a row that the page says it does not apply to (a request already confirmed).
    it('is not drawn for a row it does not apply to', () => {
      render(
        <Table
          rowAction={{
            label: 'Confirm',
            ariaLabel: (item) => `Confirm ${item.code}`,
            onRun: vi.fn(),
            isAvailable: (item) => item.state === 'Waiting',
          }}
        />,
      );

      expect(screen.getAllByRole('button', { name: /^Confirm/ })).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Confirm ACC-PR-4HT9WD' })).toBeVisible();
    });
  });

  describe('its states', () => {
    // Break caught: rows (or a count, or a zero) drawn while the read is under way, or a table that does not say it is busy.
    it('draws skeleton rows in its own shape while it loads, and says it is loading', () => {
      const { container } = render(
        <Table status="loading" loadingRows={4} loadingLabel="Loading pickup requests" />,
      );

      expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
      expect(container.querySelectorAll('.ui-data-table__skeleton-row')).toHaveLength(4);
      expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
      expect(screen.getByRole('status')).toHaveTextContent('Loading pickup requests');
      // The columns are still there: nothing jumps when the rows arrive.
      expect(screen.getAllByRole('columnheader')).toHaveLength(3);
    });

    // Break caught: a failure drawn as an empty list, or drawn with the diagnostic and no way to try again.
    it('draws a failure in the page words, with Retry, and no rows', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn();
      render(
        <Table
          status="error"
          error={{ message: 'The requests could not be read. Try again.', onRetry }}
        />,
      );

      expect(screen.getByRole('alert')).toHaveTextContent(
        'The requests could not be read. Try again.',
      );
      expect(screen.queryByText('ACC-PR-7KQ2MZ')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    // Break caught: a Retry offered for a refusal (a read the person may not make), which would offer what cannot work.
    it('draws no Retry for a failure that cannot be tried again', () => {
      render(<Table status="error" error={{ message: 'You cannot read these requests.' }} />);

      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    // Break caught: an empty table that draws nothing, or that draws a count of 0 of its own.
    it('draws what the page gives it when there are no rows, and a count of nothing', () => {
      const { container } = render(<Table rows={[]} emptyState={<p>Nothing is waiting.</p>} />);

      expect(screen.getByText('Nothing is waiting.')).toBeVisible();
      expect(container.textContent).not.toMatch(/\b0\b/);
    });

    // Break caught: the old rows dropped when a newer read fails, or kept with no word that they are old.
    it('keeps the last rows under a line that says they may be old, with the way to read again', async () => {
      const user = userEvent.setup();
      const onRefresh = vi.fn();
      render(
        <Table
          stale={{ message: 'The list may be out of date. The last read was at 09:42.', onRefresh }}
        />,
      );

      expect(
        screen.getByText('The list may be out of date. The last read was at 09:42.'),
      ).toBeVisible();
      expect(screen.getAllByRole('rowheader')).toHaveLength(REQUESTS.length);
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    // Break caught: a table that invents a total (a count, a "of N") the page did not give.
    it('never draws a total it was not given', () => {
      const { container } = render(<Table />);

      expect(container.textContent).not.toMatch(/\bof \d|\btotal\b|\bshowing\b/i);
      expect(container.textContent).not.toMatch(/\b3 (requests|results|rows)\b/i);
    });

    // Break caught: the footer (the pager) lost, or drawn inside the table where it would be read as a row.
    it('draws what follows it in its frame, outside the table', () => {
      render(<Table footer={<button type="button">Next page</button>} />);

      const table = screen.getByRole('table');
      const next = screen.getByRole('button', { name: 'Next page' });
      expect(table.contains(next)).toBe(false);
    });
  });

  describe('a row that changed', () => {
    // Break caught: a changed row that nothing marks (the highlight is a cue for the eye only: assistive technology is told in words).
    it('is marked for the highlight, and says it was updated to whoever hears the page', () => {
      render(<Table changedIds={['r2']} />);

      const row = opener('ACC-PR-4HT9WD').closest('tr');
      expect(row).toHaveAttribute('data-changed', 'true');
      expect(opener('ACC-PR-4HT9WD')).toHaveAccessibleDescription('Updated');
      expect(opener('ACC-PR-7KQ2MZ').closest('tr')).not.toHaveAttribute('data-changed');
    });
  });

  describe('ordering', () => {
    // Break caught: a table that sorts by itself (the server orders), or whose order is not told in words.
    it('asks for an order and tells the one it is given, and sorts nothing', async () => {
      const user = userEvent.setup();
      const onSortChange = vi.fn();
      render(
        <Table sort={{ columnId: 'date', direction: 'descending' }} onSortChange={onSortChange} />,
      );

      expect(screen.getByRole('columnheader', { name: /Service date/ })).toHaveAttribute(
        'aria-sort',
        'descending',
      );
      expect(screen.getByRole('columnheader', { name: /State/ })).not.toHaveAttribute('aria-sort');
      await user.click(screen.getByRole('button', { name: /Service date/ }));
      expect(onSortChange).toHaveBeenCalledExactlyOnceWith('date');
      // The rows are in the order the server gave, whatever the sort says.
      expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
        'ACC-PR-7KQ2MZDemo Fabrics Ltd',
        'ACC-PR-4HT9WDDemo Bakery',
        'ACC-PR-2MX8RCDemo Pharmacy',
      ]);
    });
  });

  describe('the box that scrolls', () => {
    // Break caught: the place lost when the person comes back, or the box moved again under them as the page keeps writing it.
    it('is put back where it was left, once', () => {
      const { rerender } = render(<Table initialScroll={{ left: 40, top: 120 }} />);
      const box = screen.getByRole('region', { name: 'Pickup requests' });
      expect(box.scrollLeft).toBe(40);
      expect(box.scrollTop).toBe(120);

      box.scrollTop = 300;
      rerender(<Table initialScroll={{ left: 0, top: 0 }} />);
      expect(box.scrollTop).toBe(300);
    });

    // Break caught: the scroll position never reported, so that the page cannot keep the place of a person who opens a record and comes back.
    it('tells the page where it is scrolled to', () => {
      const onScrollChange = vi.fn();
      render(<Table onScrollChange={onScrollChange} />);
      const box = screen.getByRole('region', { name: 'Pickup requests' });

      box.scrollTop = 80;
      fireEvent.scroll(box);

      expect(onScrollChange).toHaveBeenLastCalledWith({ left: 0, top: 80 });
    });

    // Break caught: the record the person came back from not found again: focus goes to its button.
    it('gives focus to the row the person came back from', () => {
      render(<Table focusRowId="r3" />);

      expect(opener('ACC-PR-2MX8RC')).toHaveFocus();
    });

    // Break caught: a height the page asked for that never reaches the box, so that a long queue grows the page and the header cannot stay. (The inline style is
    // read, not the computed one: jsdom computes a rem length into pixels.)
    it('bounds the box when the page says how tall it may be', () => {
      render(<Table maxHeight="20rem" />);

      expect(screen.getByRole('region', { name: 'Pickup requests' }).style.maxHeight).toBe('20rem');
    });
  });

  // Break caught: two rows or two columns with one id, or a table that opens rows with nothing to name them: defects of the page.
  it('throws for the defects of a page that would draw a wrong table', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => render(<Table rows={[FIRST, FIRST]} />)).toThrow(/have the id "r1"/);
    expect(() =>
      render(<Table columns={[REQUEST_COLUMN, { ...STATE_COLUMN, id: 'request' }]} />),
    ).toThrow(/have the id "request"/);
    expect(() =>
      render(<Table columns={COLUMNS.map((column) => ({ ...column, rowHeader: true }))} />),
    ).toThrow(/more than one row-header column/);
    expect(() =>
      render(<Table columns={COLUMNS.map((column) => ({ ...column, rowHeader: false }))} />),
    ).toThrow(/needs a row-header column/);
    quiet.mockRestore();
  });

  // Break caught: a state (loading, failed, empty, stale, a changed row, rows chosen) whose structure fails a rule of WCAG 2.2 that can be seen without a layout engine.
  it('has no WCAG violations that can be checked without a layout engine, in each state', async () => {
    const states: Props[] = [
      {},
      { status: 'loading' },
      { status: 'error', error: { message: 'The requests could not be read.', onRetry: vi.fn() } },
      { rows: [], emptyState: <p>Nothing is waiting.</p> },
      { stale: { message: 'The list may be out of date.', onRefresh: vi.fn() } },
      {
        changedIds: ['r1'],
        rowAction: {
          label: 'Confirm',
          ariaLabel: (item) => `Confirm ${item.code}`,
          onRun: vi.fn(),
        },
      },
    ];
    for (const state of states) {
      const { container, unmount } = render(<Table {...state} />);
      expect(await wcagViolations(container)).toEqual([]);
      unmount();
    }
    const { container } = render(<Chosen />);
    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));
    expect(await wcagViolations(container)).toEqual([]);
  });
});

/** A page that holds the chosen ids, with the acts given: the table asks for a change and draws what it is given. */
function ChosenWith({
  bulkActions,
  initial = [],
  ...rest
}: Props & {
  bulkActions: NonNullable<DataTableProps<Request>['selection']>['bulkActions'];
  initial?: readonly string[];
}) {
  const [ids, setIds] = useState<readonly string[]>(initial);
  return (
    <Table
      {...rest}
      selection={{
        selectedIds: ids,
        onChange: setIds,
        selectLabel: (item) => `Select ${item.code}`,
        ...(bulkActions === undefined ? {} : { bulkActions }),
      }}
    />
  );
}

const cardOf = (item: Request) => (
  <>
    <strong>{item.sender}</strong>
    <span>{item.state}</span>
  </>
);

describe('DataTable: the box of a row and the hit areas (task R5.2, M4)', () => {
  // Break caught (the part jsdom can see): the box drawn bare in its cell, with nothing as big as the cell around it, so that a press beside it falls through to the
  // stretched button and opens the record. The hit area itself (its size, and that a field in a cell is not covered) is measured in a real browser, in `kit.spec.ts`.
  it('wraps the box in a label as big as its cell, with no words of its own', () => {
    render(<Chosen />);

    const box = screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' });
    const label = box.closest('label');
    expect(label).not.toBeNull();
    expect(label).toHaveClass('ui-data-table__box');
    expect(label?.textContent).toBe('');
    expect(label?.closest('td')).toHaveClass('ui-data-table__select');
    // The label adds no second name: the box is named once, by its own label.
    expect(screen.getAllByRole('checkbox', { name: /^Select / })).toHaveLength(3);
  });

  it('chooses the row from a press on the label, and opens nothing', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Chosen onOpen={onOpen} />);

    const label = screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }).closest('label');
    expect(label).not.toBeNull();
    if (label === null) return;
    await user.click(label);

    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toBeChecked();
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('DataTable: the keyboard, further (task R5.2, M5)', () => {
  const open = (item: Request) => `Open ${item.code}, ${item.sender}`;

  // Break caught: a row with a box that is disabled and nothing else the Tab stop and the arrows' landing: focus moves "there" and stays where it was, and Tab finds nothing.
  it('passes over a row that has nothing to focus, with the arrows and with Tab', async () => {
    const user = userEvent.setup();
    render(
      <Table
        onOpen={undefined}
        openLabel={undefined}
        columns={[{ ...REQUEST_COLUMN, rowHeader: false }, STATE_COLUMN]}
        selection={{
          selectedIds: [],
          onChange: vi.fn(),
          selectLabel: (item) => `Select ${item.code}`,
          // The first and the second cannot be chosen: only the third has a box that can take focus.
          isSelectable: (item) => item.id === 'r3',
        }}
      />,
    );

    // The one stop in the Tab order is the box that can be reached: the third row's.
    await user.tab(); // the box that scrolls
    await user.tab(); // the one stop of the rows: the box that can be reached
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-2MX8RC' })).toHaveFocus();

    // And the arrows never stop on a disabled box.
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-2MX8RC' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-2MX8RC' })).toHaveFocus();
  });

  it('moves between the rows that have a control, and over one that has none', async () => {
    const user = userEvent.setup();
    render(
      <Table
        onOpen={undefined}
        openLabel={undefined}
        columns={[{ ...REQUEST_COLUMN, rowHeader: false }, STATE_COLUMN]}
        selection={{
          selectedIds: [],
          onChange: vi.fn(),
          selectLabel: (item) => `Select ${item.code}`,
          // The second cannot be chosen.
          isSelectable: (item) => item.id !== 'r2',
        }}
      />,
    );

    screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-2MX8RC' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toHaveFocus();
  });

  // Break caught: the arrows moving rows although something has already used them (a key handled by a control of the cell).
  it('leaves a key that a control has already handled', async () => {
    const user = userEvent.setup();
    render(
      <Table
        columns={[
          REQUEST_COLUMN,
          {
            id: 'act',
            header: 'Act',
            cell: () => (
              <button
                type="button"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') event.preventDefault();
                }}
              >
                Handles the arrow
              </button>
            ),
          },
        ]}
      />,
    );

    screen.getAllByRole('button', { name: 'Handles the arrow' })[0]?.focus();
    await user.keyboard('{ArrowDown}');

    expect(screen.getAllByRole('button', { name: 'Handles the arrow' })[0]).toHaveFocus();
  });

  // Break caught: a menu button or a combobox in a cell losing its arrows to the table (ArrowDown opens the menu; it must not also move the row).
  it('leaves the arrows to a button that opens a menu, and to a combobox, in a cell', async () => {
    const user = userEvent.setup();
    render(
      <Table
        columns={[
          REQUEST_COLUMN,
          {
            id: 'menu',
            header: 'Menu',
            cell: (item) => (
              <button type="button" aria-haspopup="menu" aria-label={`Acts for ${item.code}`}>
                More
              </button>
            ),
          },
          {
            id: 'pick',
            header: 'Pick',
            cell: (item) => (
              <button
                type="button"
                role="combobox"
                aria-expanded="false"
                aria-label={`Hub for ${item.code}`}
              >
                Hub
              </button>
            ),
          },
        ]}
      />,
    );

    screen.getByRole('button', { name: 'Acts for ACC-PR-7KQ2MZ' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Acts for ACC-PR-7KQ2MZ' })).toHaveFocus();

    screen.getByRole('combobox', { name: 'Hub for ACC-PR-7KQ2MZ' }).focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('combobox', { name: 'Hub for ACC-PR-7KQ2MZ' })).toHaveFocus();
    expect(screen.getByRole('button', { name: open(FIRST) })).toBeInTheDocument();
  });
});

describe('DataTable: no focus stolen, and the place put back (task R5.2, M7)', () => {
  // Break caught: the row the person came back from taking focus again every time the rows change (a refetch, a page, a filter): focus taken from wherever the person went.
  it('gives focus to the row the person came back from once, and not again when the rows change', () => {
    const view = render(
      <>
        <button type="button">Elsewhere</button>
        <Table focusRowId="r3" />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Open ACC-PR-2MX8RC, Demo Pharmacy' })).toHaveFocus();

    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    view.rerender(
      <>
        <button type="button">Elsewhere</button>
        <Table
          focusRowId="r3"
          rows={[...REQUESTS, { ...FIRST, id: 'r4', code: 'ACC-PR-9WXH4T' }]}
        />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Elsewhere' })).toHaveFocus();
  });

  it('gives focus to the row when it is drawn after the table, once the rows have arrived', () => {
    const view = render(<Table focusRowId="r2" status="loading" rows={[]} />);
    expect(document.body).toHaveFocus();

    view.rerender(<Table focusRowId="r2" />);

    expect(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD, Demo Bakery' })).toHaveFocus();
  });

  // Break caught: the saved place applied while the rows are still loading (the box is too short to scroll: the browser clamps it to the top) and never again.
  it('puts the box back where it was left when the rows arrive, and not before', () => {
    const view = render(<Table status="loading" initialScroll={{ left: 0, top: 120 }} />);
    const box = screen.getByRole('region', { name: 'Pickup requests' });
    expect(box.scrollTop).toBe(0);

    view.rerender(<Table initialScroll={{ left: 0, top: 120 }} />);
    expect(screen.getByRole('region', { name: 'Pickup requests' }).scrollTop).toBe(120);

    // Once: a later change of the saved place does not move the box under the person.
    screen.getByRole('region', { name: 'Pickup requests' }).scrollTop = 40;
    view.rerender(<Table initialScroll={{ left: 0, top: 300 }} />);
    expect(screen.getByRole('region', { name: 'Pickup requests' }).scrollTop).toBe(40);
  });
});

describe('DataTable: the regions that speak (task R5.2, M10)', () => {
  // Break caught: a region that arrives with its words (stale, loading, a failure): most screen readers announce a change of a region that was there, not one that appears.
  it('has its status region in the page before it says anything, and fills the same one', () => {
    const view = render(<Table />);
    const region = document.querySelector<HTMLElement>('.ui-data-table__live');
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute('role', 'status');
    expect(region?.textContent).toBe('');

    view.rerender(<Table status="loading" loadingLabel="Loading pickup requests" />);
    expect(document.querySelector('.ui-data-table__live')).toBe(region);
    expect(region).toHaveTextContent('Loading pickup requests');

    view.rerender(<Table stale={{ message: 'These rows may be old.', onRefresh: vi.fn() }} />);
    expect(document.querySelector('.ui-data-table__live')).toBe(region);
    expect(region).toHaveTextContent('These rows may be old.');
  });

  it('has its region of failures in the page before the failure, and the failure is read once', () => {
    const view = render(<Table />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('');

    view.rerender(<Table status="error" error={{ message: 'The requests could not be read.' }} />);

    expect(screen.getByRole('alert')).toBe(alert);
    expect(alert).toHaveTextContent('The requests could not be read.');
    // The words drawn in the table are for the eye: the region above has them for assistive technology, and they are not read twice.
    expect(screen.getAllByText('The requests could not be read.')).toHaveLength(2);
    expect(document.querySelector('.ui-data-table__notice p')).toHaveAttribute(
      'aria-hidden',
      'true',
    );
  });
});

describe('DataTable: the bar of acts, above the rows (task R5.2, M12)', () => {
  // Break caught: the bar after the rows (it floats over the last of them, off the screen of a long table) when it is to be above them and stay in view.
  it('is above the rows, before the box that scrolls', async () => {
    const user = userEvent.setup();
    render(<Chosen />);
    await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));

    const bar = screen.getByRole('group', { name: 'Actions for the chosen rows' });
    const rows = screen.getByRole('region', { name: 'Pickup requests' });
    expect(bar.compareDocumentPosition(rows) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  // Break caught: a bar that offers "Confirm 2" when one of the two cannot be confirmed (the act is run on a row it does not apply to), or that offers an act no chosen row can take.
  it('counts only the rows an act can be taken on, says what it left out, and is not offered where none can', async () => {
    const user = userEvent.setup();
    const confirm = vi.fn();
    const waiting = new Set(['r1', 'r3']);
    render(
      <ChosenWith
        bulkActions={[
          {
            id: 'confirm',
            label: (count) => `Confirm ${String(count)}`,
            primary: true,
            onRun: confirm,
            eligible: (chosen) => chosen.filter((id) => waiting.has(id)),
            note: (left) => `${String(left)} is already confirmed`,
          },
          {
            id: 'cancel',
            label: (count) => `Cancel ${String(count)}`,
            onRun: vi.fn(),
            eligible: (chosen) => chosen.filter((id) => id === 'r9'),
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-4HT9WD' }));

    const bar = screen.getByRole('group', { name: 'Actions for the chosen rows' });
    expect(within(bar).getByRole('button', { name: 'Confirm 1' })).toBeInTheDocument();
    expect(within(bar).getByText('1 is already confirmed')).toBeVisible();
    // No chosen row can be cancelled: that act is not drawn.
    expect(within(bar).queryByRole('button', { name: /^Cancel/ })).toBeNull();
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Confirm 1' }));
    expect(confirm).toHaveBeenCalledWith(['r1']);
  });

  it('keeps the bar, with its count and Clear, when no act can be taken on any chosen row', async () => {
    const user = userEvent.setup();
    render(
      <ChosenWith
        bulkActions={[
          {
            id: 'confirm',
            label: (count) => `Confirm ${String(count)}`,
            onRun: vi.fn(),
            eligible: () => [],
            note: (left) => `${String(left)} is already confirmed`,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));

    const bar = screen.getByRole('group', { name: 'Actions for the chosen rows' });
    expect(within(bar).queryByRole('button', { name: /^Confirm/ })).toBeNull();
    expect(within(bar).getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });
});

describe('DataTable: columns of lesser priority, and numbers (task R5.2, M12)', () => {
  // Break caught: the priorities not written to the cells, so that the stylesheet has nothing to hide by (the hiding itself is measured in a real browser).
  it('marks the header and every cell of a column that may go, and none of the others', () => {
    render(
      <Table
        columns={[
          REQUEST_COLUMN,
          { ...STATE_COLUMN, priority: 2 },
          { ...DATE_COLUMN, priority: 3 },
        ]}
      />,
    );

    expect(screen.getByRole('columnheader', { name: 'State' })).toHaveAttribute(
      'data-priority',
      '2',
    );
    expect(screen.getByRole('columnheader', { name: 'Service date' })).toHaveAttribute(
      'data-priority',
      '3',
    );
    expect(screen.getByRole('columnheader', { name: 'Request / sender' })).not.toHaveAttribute(
      'data-priority',
    );
    const row = screen.getByRole('row', { name: /ACC-PR-7KQ2MZ/ });
    expect(within(row).getByText('Confirmed')).toHaveAttribute('data-priority', '2');
    expect(within(row).getByText('Wed 4 Nov')).toHaveAttribute('data-priority', '3');
  });

  // Break caught: a column of figures left-aligned at some density: the header and every cell of an `end` column say so at the three row heights.
  for (const density of ['single', 'two-line', 'touch'] as const) {
    it(`marks a column of figures to be right-aligned at the ${density} density`, () => {
      render(
        <Table
          density={density}
          columns={[
            REQUEST_COLUMN,
            { id: 'packages', header: 'Packages', cell: () => '3', align: 'end' },
          ]}
        />,
      );

      expect(document.querySelector('.ui-data-table')).toHaveAttribute('data-density', density);
      expect(screen.getByRole('columnheader', { name: 'Packages' })).toHaveAttribute(
        'data-align',
        'end',
      );
      for (const cell of screen.getAllByText('3'))
        expect(cell).toHaveAttribute('data-align', 'end');
    });
  }
});

describe('DataTable: cards where the table is narrow (task R5.2, M12)', () => {
  const cards = { card: cardOf, layout: 'cards' } as const;

  // Break caught: the card layout a second copy of the rows beside the table (two controls for every row, read twice): one drawing at a time.
  it('draws a card for each row in place of the table, with no table beside them', () => {
    render(<Table {...cards} />);

    const list = screen.getByRole('list', { name: 'Pickup requests' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('table')).toBeNull();
    expect(within(list).getByText('Demo Fabrics Ltd')).toBeVisible();
    expect(document.querySelector('.ui-data-table')).toHaveAttribute('data-layout', 'cards');
  });

  it('has one hit target for a card: the button that opens it, named for the record', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<Table {...cards} onOpen={onOpen} />);

    const button = screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' });
    expect(button).toHaveTextContent('Demo Fabrics Ltd');
    await user.click(button);

    expect(onOpen).toHaveBeenCalledWith(FIRST);
  });

  it('has a box and the row’s act in each card, and chooses with the box', async () => {
    const user = userEvent.setup();
    const onRun = vi.fn();
    render(
      <ChosenWith
        {...cards}
        bulkActions={undefined}
        rowAction={{ label: 'Confirm', ariaLabel: (item) => `Confirm ${item.code}`, onRun }}
      />,
    );

    await user.click(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' }));
    expect(screen.getByRole('checkbox', { name: 'Select ACC-PR-7KQ2MZ' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirm ACC-PR-4HT9WD' }));

    expect(onRun).toHaveBeenCalledWith(SECOND);
  });

  it('moves between the cards with the arrows, Home and End, as between rows', async () => {
    const user = userEvent.setup();
    render(<Table {...cards} />);

    await user.tab(); // the box that scrolls
    await user.tab(); // the current card
    expect(
      screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' }),
    ).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Open ACC-PR-4HT9WD, Demo Bakery' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: 'Open ACC-PR-2MX8RC, Demo Pharmacy' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(
      screen.getByRole('button', { name: 'Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd' }),
    ).toHaveFocus();
  });

  // Break caught: the states of the table lost at a narrow width: loading, a failure and none are the table's own, whatever the width.
  it('draws the states in the table’s own shape, at every width', () => {
    const view = render(<Table {...cards} status="loading" />);
    expect(screen.getByRole('table')).toBeInTheDocument();

    view.rerender(
      <Table {...cards} status="error" error={{ message: 'The requests could not be read.' }} />,
    );
    expect(screen.getByRole('table')).toBeInTheDocument();

    view.rerender(<Table {...cards} rows={[]} emptyState={<p>No pickup requests.</p>} />);
    expect(screen.getByText('No pickup requests.')).toBeVisible();
  });

  it('is a table at every width without a card, and at `table` with one', () => {
    const view = render(<Table layout="cards" />);
    expect(screen.getByRole('table')).toBeInTheDocument();

    view.rerender(<Table card={cardOf} layout="table" />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Pickup requests' })).toBeNull();
  });
});

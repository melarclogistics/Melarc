import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { TableColumn } from '../table/Table';
import { QueueTable } from './QueueTable';
import type { useQueuePaging } from './use-queue-paging';

/**
 * Row selection of the queue table (S1.25): a checkbox for each row, in the table and at the head of each card, kept by the screen by the
 * rows' keys so that a choice outlives a move to another page. The table draws and reports; it chooses nothing and holds nothing.
 */
interface DemoRow {
  readonly id: string;
  readonly name: string;
}

const ROWS: readonly DemoRow[] = [
  { id: '1', name: 'Demo row one' },
  { id: '2', name: 'Demo row two' },
  { id: '3', name: 'Demo row three' },
];

const COLUMNS: readonly TableColumn<DemoRow>[] = [
  { key: 'name', header: 'Name', rowHeader: true, cell: (row) => row.name },
];

const PAGING: ReturnType<typeof useQueuePaging> = {
  pageToken: undefined,
  page: 1,
  tokens: [],
  toNextPage: () => undefined,
  toPreviousPage: () => undefined,
  toFirstPage: () => undefined,
  takeFocus: () => false,
};

function Selectable({
  rows = ROWS,
  initial = [],
  limit = Infinity,
  cards = false,
  onToggle,
}: {
  readonly rows?: readonly DemoRow[];
  readonly initial?: readonly string[];
  readonly limit?: number;
  readonly cards?: boolean;
  readonly onToggle?: (row: DemoRow, selected: boolean) => void;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <QueueTable
      caption="Demo rows"
      columns={COLUMNS}
      rows={rows}
      rowKey={(row) => row.id}
      noun={{ one: 'row', other: 'rows' }}
      paging={PAGING}
      nextPageToken={null}
      {...(cards ? { card: (row: DemoRow) => <p>{row.name}</p> } : {})}
      selection={{
        selected,
        rowLabel: (row) => `Select ${row.name}`,
        isDisabled: () => selected.size >= limit,
        onToggle: (row, ticked) => {
          onToggle?.(row, ticked);
          setSelected((current) => {
            const next = new Set(current);
            if (ticked) next.add(row.id);
            else next.delete(row.id);
            return next;
          });
        },
      }}
    />
  );
}

const table = () => screen.getByRole('table', { name: 'Demo rows' });

describe('QueueTable: row selection', () => {
  it('draws a checkbox for each row in a column of its own, named for the row', () => {
    render(<Selectable />);

    expect(within(table()).getByRole('columnheader', { name: 'Select' })).toBeVisible();
    for (const row of ROWS) {
      expect(
        within(table()).getByRole('checkbox', { name: `Select ${row.name}` }),
      ).not.toBeChecked();
    }
  });

  it('draws the rows that were chosen ticked, and reports a tick and a clear', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Selectable initial={['2']} onToggle={onToggle} />);

    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row two' })).toBeChecked();
    await user.click(within(table()).getByRole('checkbox', { name: 'Select Demo row one' }));
    await user.click(within(table()).getByRole('checkbox', { name: 'Select Demo row two' }));

    expect(onToggle).toHaveBeenNthCalledWith(1, ROWS[0], true);
    expect(onToggle).toHaveBeenNthCalledWith(2, ROWS[1], false);
    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row one' })).toBeChecked();
    expect(
      within(table()).getByRole('checkbox', { name: 'Select Demo row two' }),
    ).not.toBeChecked();
  });

  // Break caught: a selection that works with a pointer alone.
  it('is chosen with the keyboard: Tab to the box and Space', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<Selectable onToggle={onToggle} />);

    within(table()).getByRole('checkbox', { name: 'Select Demo row three' }).focus();
    await user.keyboard(' ');

    expect(onToggle).toHaveBeenCalledWith(ROWS[2], true);
  });

  // Break caught: a limit that is only a message: the rest stay tickable and the list grows past what the server accepts.
  it('disables the rows that are not chosen once the screen says no more can be, and never a chosen one', () => {
    render(<Selectable initial={['1']} limit={1} />);

    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row one' })).toBeEnabled();
    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row two' })).toBeDisabled();
    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row three' })).toBeDisabled();
  });

  // Break caught: a choice that is lost when the page of rows changes, or that ticks a row of another page for the person.
  it('draws only the rows shown, whatever else the screen has chosen', () => {
    render(<Selectable rows={ROWS.slice(2)} initial={['1', '2']} />);

    expect(within(table()).getAllByRole('checkbox')).toHaveLength(1);
    expect(
      within(table()).getByRole('checkbox', { name: 'Select Demo row three' }),
    ).not.toBeChecked();
  });

  it('draws the same checkbox on each card, with the word beside it', async () => {
    const user = userEvent.setup();
    render(<Selectable cards />);

    const cards = within(screen.getByRole('list', { name: 'Demo rows' }));
    const box = cards.getByRole('checkbox', { name: 'Select Demo row one' });
    expect(box.closest('label')).toHaveTextContent('Select');
    await user.click(box);

    expect(box).toBeChecked();
    // The table draws the same row, and its box is the same choice.
    expect(within(table()).getByRole('checkbox', { name: 'Select Demo row one' })).toBeChecked();
  });

  // Break caught: a queue given no selection changed by this one.
  it('adds no column and no box to a queue given no selection', () => {
    render(
      <QueueTable
        caption="Demo rows"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        noun={{ one: 'row', other: 'rows' }}
        paging={PAGING}
        nextPageToken={null}
      />,
    );

    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Select' })).toBeNull();
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { wcagViolations } from '../../../test-support/wcag';
import { Table, type TableColumn, type TableProps } from './Table';

/** Synthetic rows: nothing here is product data. */
interface DemoRow {
  readonly id: string;
  readonly name: string;
  readonly hubs: number;
}

const ROWS: readonly DemoRow[] = [
  { id: 'a', name: 'Demo row alpha', hubs: 3 },
  { id: 'b', name: 'Demo row beta', hubs: 12 },
  { id: 'c', name: 'Demo row gamma', hubs: 7 },
];

const COLUMNS: readonly TableColumn<DemoRow>[] = [
  { key: 'name', header: 'Name', cell: (row) => row.name, rowHeader: true, sortable: true },
  { key: 'hubs', header: 'Hubs', cell: (row) => String(row.hubs), numeric: true, sortable: true },
  { key: 'note', header: 'Note', cell: () => 'Synthetic' },
];

function renderTable(props: Partial<TableProps<DemoRow>> = {}) {
  const view = render(
    <Table<DemoRow>
      caption="Demo rows"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(row) => row.id}
      sort={{ onChange: vi.fn() }}
      {...props}
    />,
  );
  return { ...view, user: userEvent.setup() };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Table: structure', () => {
  // Break caught: a grid of divs, which a screen reader cannot navigate by row and column, or a table with no name.
  it('is a native table, named by its caption, with a header cell for each column', () => {
    renderTable();

    const table = screen.getByRole('table', { name: 'Demo rows' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Name', 'Hubs', 'Note']);
    expect(within(table).getAllByRole('row')).toHaveLength(1 + ROWS.length);
  });

  // Break caught: a table whose first column is not a header, so a screen reader reading a cell does not say whose row it is.
  it('makes the cell that names a row a row header', () => {
    renderTable();

    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('rowheader')
        .map((cell) => cell.textContent),
    ).toEqual(ROWS.map((row) => row.name));
    expect(within(table).getAllByRole('cell')).toHaveLength(ROWS.length * 2);
  });

  it('shows the caption, or hides it from the eye and not from assistive technology', () => {
    const { rerender } = renderTable();
    const caption = screen.getByText('Demo rows');
    expect(caption.tagName).toBe('CAPTION');
    expect(caption).not.toHaveClass('ui-table__caption--hidden');

    rerender(
      <Table<DemoRow>
        caption="Demo rows"
        hideCaption
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(row) => row.id}
        sort={{ onChange: vi.fn() }}
      />,
    );

    expect(screen.getByText('Demo rows')).toHaveClass('ui-table__caption--hidden');
    expect(screen.getByRole('table', { name: 'Demo rows' })).toBeInTheDocument();
  });

  // Break caught: a wide table that overflows its page with no way for a keyboard user to scroll it (WCAG 2.1.1). The overflow
  // is a region on purpose: it has a name and it takes focus.
  it('scrolls inside a named region that a keyboard can reach', async () => {
    const { user } = renderTable();

    const region = screen.getByRole('region', { name: 'Demo rows' });
    expect(region).toHaveAttribute('tabindex', '0');

    await user.tab();
    expect(region).toHaveFocus();
  });

  it('aligns a column of numbers to the end and sets it apart from the text around it', () => {
    renderTable();

    const header = screen.getByRole('columnheader', { name: 'Hubs' });
    expect(header).toHaveClass('ui-table__cell--numeric');
    const cells = screen
      .getAllByRole('cell')
      .filter((cell) => cell.classList.contains('ui-table__cell--numeric'));
    expect(cells.map((cell) => cell.textContent)).toEqual(['3', '12', '7']);
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveClass(
      'ui-table__cell--numeric',
    );
  });

  // Break caught: a row whose text is taken for markup. A name or a label is the server's text.
  it('draws what a cell returns, and text is text', () => {
    const hostile = '<img src=x onerror="document.title=1">Eve';
    const { container } = renderTable({
      rows: [{ id: 'h', name: hostile, hubs: 1 }],
    });

    expect(screen.getByText(hostile)).toBeVisible();
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps a row’s element when the rows are put in another order', () => {
    const { rerender } = renderTable();
    const beta = screen.getByRole('rowheader', { name: 'Demo row beta' });

    rerender(
      <Table<DemoRow>
        caption="Demo rows"
        columns={COLUMNS}
        rows={[...ROWS].reverse()}
        rowKey={(row) => row.id}
        sort={{ onChange: vi.fn() }}
      />,
    );

    expect(screen.getByRole('rowheader', { name: 'Demo row beta' })).toBe(beta);
    expect(screen.getAllByRole('rowheader').map((cell) => cell.textContent)).toEqual([
      'Demo row gamma',
      'Demo row beta',
      'Demo row alpha',
    ]);
  });

  it('draws only its header for no rows: what to say about none is the screen’s, in an empty state', () => {
    renderTable({ rows: [] });

    expect(screen.getAllByRole('row')).toHaveLength(1);
  });

  it('has no WCAG 2.1 A or AA violations that can be checked without a layout engine', async () => {
    const { container } = renderTable({
      sort: { onChange: vi.fn(), current: { column: 'hubs', direction: 'descending' } },
    });

    expect(await wcagViolations(container)).toEqual([]);
  });
});

describe('Table: sorting', () => {
  const sort = (current?: { column: string; direction: 'ascending' | 'descending' }) => {
    const onChange = vi.fn();
    return { onChange, sort: { onChange, ...(current === undefined ? {} : { current }) } };
  };

  // Break caught: a header that is a button on a column that cannot be sorted, or one that is not a button on a column that can.
  it('gives a sort button to the sortable columns only, named by the header', () => {
    renderTable(sort());

    expect(screen.getByRole('button', { name: 'Name' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hubs' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Note' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  // Break caught: a sort order shown only by an arrow. `aria-sort` is what assistive technology reads, on the sorted column only.
  it('marks the sorted column, and only that one, for assistive technology', () => {
    renderTable(sort({ column: 'hubs', direction: 'descending' }));

    expect(screen.getByRole('columnheader', { name: 'Hubs' })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort');
    expect(screen.getByRole('columnheader', { name: 'Note' })).not.toHaveAttribute('aria-sort');
  });

  it('says nothing about an order when no column is sorted, or when the sorted column is not one of its columns', () => {
    const { unmount } = renderTable(sort());
    expect(document.querySelectorAll('[aria-sort]')).toHaveLength(0);
    unmount();

    renderTable(sort({ column: 'gone', direction: 'ascending' }));
    expect(document.querySelectorAll('[aria-sort]')).toHaveLength(0);
  });

  it('asks for ascending first, then toggles', async () => {
    const unsorted = sort();
    const { user, unmount } = renderTable(unsorted);
    await user.click(screen.getByRole('button', { name: 'Hubs' }));
    expect(unsorted.onChange).toHaveBeenLastCalledWith('hubs', 'ascending');
    unmount();

    const ascending = sort({ column: 'hubs', direction: 'ascending' });
    const second = renderTable(ascending);
    await second.user.click(screen.getByRole('button', { name: 'Hubs' }));
    expect(ascending.onChange).toHaveBeenLastCalledWith('hubs', 'descending');
    second.unmount();

    const descending = sort({ column: 'hubs', direction: 'descending' });
    const third = renderTable(descending);
    await third.user.click(screen.getByRole('button', { name: 'Hubs' }));
    expect(descending.onChange).toHaveBeenLastCalledWith('hubs', 'ascending');
  });

  it('starts another column ascending, whatever the first was', async () => {
    const state = sort({ column: 'hubs', direction: 'descending' });
    const { user } = renderTable(state);

    await user.click(screen.getByRole('button', { name: 'Name' }));

    expect(state.onChange).toHaveBeenCalledOnce();
    expect(state.onChange).toHaveBeenCalledWith('name', 'ascending');
  });

  // Break caught: a sort that works with the mouse and not with Enter or Space.
  it('sorts from the keyboard', async () => {
    const state = sort();
    const { user } = renderTable(state);

    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Name' })).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(state.onChange).toHaveBeenCalledTimes(2);
  });

  it('does not put the direction in the name of the button', () => {
    renderTable(sort({ column: 'hubs', direction: 'ascending' }));

    expect(screen.getByRole('button', { name: 'Hubs' }).textContent).toBe('Hubs');
  });
});

describe('Table: a table that cannot be drawn is a defect of the page', () => {
  // These fail while rendering on purpose: a table whose columns contradict themselves is a programming error, and a page that
  // shows a wrong table is worse than one that shows its error page.
  const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

  it('refuses a sortable column when nothing can sort', () => {
    quietly();

    expect(() =>
      render(
        <Table<DemoRow>
          caption="Demo rows"
          columns={COLUMNS}
          rows={ROWS}
          rowKey={(row) => row.id}
        />,
      ),
    ).toThrow(/sort/i);
  });

  it('refuses two columns with one key', () => {
    quietly();

    expect(() =>
      renderTable({
        columns: [
          { key: 'same', header: 'One', cell: () => '1' },
          { key: 'same', header: 'Two', cell: () => '2' },
        ],
      }),
    ).toThrow(/same/);
  });

  it('refuses two columns that both name the row', () => {
    quietly();

    expect(() =>
      renderTable({
        columns: [
          { key: 'a', header: 'One', cell: () => '1', rowHeader: true },
          { key: 'b', header: 'Two', cell: () => '2', rowHeader: true },
        ],
      }),
    ).toThrow(/row header/i);
  });

  it('refuses two rows with one key', () => {
    quietly();

    expect(() =>
      renderTable({
        columns: [{ key: 'a', header: 'One', cell: () => '1' }],
        rows: [ROWS[0], ROWS[0]].filter((row): row is DemoRow => row !== undefined),
      }),
    ).toThrow(/key/i);
  });
});

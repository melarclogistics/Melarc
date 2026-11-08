import type { ReactNode } from 'react';

import { Icon } from '../icon/Icon';
import './table.css';

export type SortDirection = 'ascending' | 'descending';

export interface TableColumn<Row> {
  /** Names the column in a sort request and tells two columns apart. Unique in a table. */
  readonly key: string;
  /** The column header, in words. */
  readonly header: string;
  /** What the cell of a row shows. Text is text: a string is never read as markup. */
  readonly cell: (row: Row) => ReactNode;
  /** A column of numbers is aligned to the end and set in figures of one width, so that they can be compared down the column. */
  readonly numeric?: boolean;
  /** The header is a button that asks for this column's order. The table needs a `sort` for it. */
  readonly sortable?: boolean;
  /** The cell names the row: it is a row header. At most one column does. */
  readonly rowHeader?: boolean;
}

export interface TableSort {
  /** The order that is shown now, if the rows are in one the person chose. */
  readonly current?: { readonly column: string; readonly direction: SortDirection };
  /** The person asked for this order. The table sorts nothing: the screen asks the server, or sorts the rows it holds, and gives them back. */
  readonly onChange: (column: string, direction: SortDirection) => void;
}

export interface TableProps<Row> {
  /** What the table is, in a few words. It names the table and the region that scrolls it. */
  readonly caption: string;
  /** Keep the caption for assistive technology and take it from the eye, where the page's own heading already says it. */
  readonly hideCaption?: boolean;
  readonly columns: readonly TableColumn<Row>[];
  readonly rows: readonly Row[];
  /** A key for a row that stays the same when the rows are put in another order. */
  readonly rowKey: (row: Row) => string;
  readonly sort?: TableSort;
}

/** What is wrong with a table that cannot be drawn truthfully. These are defects of the page, so drawing one throws. */
function defect<Row>({
  caption,
  columns,
  rows,
  rowKey,
  sort,
}: TableProps<Row>): string | undefined {
  const columnKeys = new Set<string>();
  for (const column of columns) {
    if (columnKeys.has(column.key)) {
      return `Two columns of the table "${caption}" have the key "${column.key}".`;
    }
    columnKeys.add(column.key);
    if (column.sortable === true && sort === undefined) {
      return `The column "${column.key}" of the table "${caption}" can be sorted, but the table was given no sort to sort with.`;
    }
  }
  if (columns.filter((column) => column.rowHeader === true).length > 1) {
    return `The table "${caption}" has more than one row header column.`;
  }
  const rowKeys = new Set<string>();
  for (const row of rows) {
    const key = rowKey(row);
    if (rowKeys.has(key)) return `Two rows of the table "${caption}" have the key "${key}".`;
    rowKeys.add(key);
  }
  return undefined;
}

/**
 * The table shell (COMPONENT_PATTERNS section 19): a native table with a caption, header cells that are columns, optional row headers,
 * numbers aligned for comparison, rows of about 40px, and sort buttons that say their order with `aria-sort`. It scrolls sideways inside
 * a region that has a name and takes focus, so a wide table never forces the page to scroll and a keyboard can still reach what is off to
 * the side. It is not a data grid: it filters and sorts nothing, owns no selection and no paging, and shows nothing for no rows, because
 * what to say about none is the screen's (an empty state).
 */
export function Table<Row>(props: TableProps<Row>) {
  const { caption, hideCaption = false, columns, rows, rowKey, sort } = props;
  const problem = defect(props);
  if (problem !== undefined) throw new Error(problem);

  return (
    <div className="ui-table">
      <div className="ui-table__scroller" role="region" aria-label={caption} tabIndex={0}>
        <table className="ui-table__table">
          <caption
            className={
              hideCaption ? 'ui-table__caption ui-table__caption--hidden' : 'ui-table__caption'
            }
          >
            {caption}
          </caption>
          <thead>
            <tr>
              {columns.map((column) => {
                const shown =
                  sort?.current?.column === column.key ? sort.current.direction : undefined;
                const next: SortDirection = shown === 'ascending' ? 'descending' : 'ascending';
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={shown}
                    className={column.numeric === true ? 'ui-table__cell--numeric' : undefined}
                  >
                    {column.sortable === true && sort !== undefined ? (
                      <button
                        type="button"
                        className="ui-table__sort"
                        onClick={() => {
                          sort.onChange(column.key, next);
                        }}
                      >
                        {column.header}
                        <Icon
                          name={
                            shown === 'ascending'
                              ? 'sort-ascending'
                              : shown === 'descending'
                                ? 'sort-descending'
                                : 'sort-none'
                          }
                          size="sm"
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => {
                  const className = column.numeric === true ? 'ui-table__cell--numeric' : undefined;
                  return column.rowHeader === true ? (
                    <th key={column.key} scope="row" className={className}>
                      {column.cell(row)}
                    </th>
                  ) : (
                    <td key={column.key} className={className}>
                      {column.cell(row)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

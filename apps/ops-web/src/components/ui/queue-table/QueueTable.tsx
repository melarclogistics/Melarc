import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '../button/Button';
import { Icon } from '../icon/Icon';
import { Table, type TableColumn } from '../table/Table';
import type { QueuePaging } from './use-queue-paging';
import './queue-table.css';

export interface QueueNoun {
  /** What one row is called, in a count: "request". */
  readonly one: string;
  /** What several are called: "requests". */
  readonly other: string;
}

/**
 * Row selection (S1.25): a checkbox for each row, in a column of its own at the table's start and at the head of each card. The queue holds no
 * selection: the screen keeps which rows are chosen (by their keys, so that a choice survives a move to another page of the queue) and the
 * table draws and reports. Nothing here decides what may be chosen: a row the screen says cannot be chosen now is drawn disabled, and the
 * screen says why in its own words.
 */
export interface QueueSelection<Row> {
  /** The keys (`rowKey`) of the rows chosen. Rows of other pages may be in it; only the rows shown are drawn ticked. */
  readonly selected: ReadonlySet<string>;
  /** The person ticked a row or cleared it. */
  readonly onToggle: (row: Row, selected: boolean) => void;
  /** Names a row's checkbox for assistive technology: "Select ACC-PR-7KQ2MZ". */
  readonly rowLabel: (row: Row) => string;
  /** A row that cannot be chosen now (the limit is reached). A row that is ticked can always be cleared. */
  readonly isDisabled?: (row: Row) => boolean;
}

export interface QueueTableProps<Row> {
  /** What the queue is, in a few words. It names the table and its region; the page's heading already says it to the eye. */
  readonly caption: string;
  readonly columns: readonly TableColumn<Row>[];
  /** The rows of the page shown, in the server's order. */
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly noun: QueueNoun;
  /** Where the person is in the queue (`useQueuePaging`). */
  readonly paging: QueuePaging;
  /** The server's token for the next page, or null on the last. */
  readonly nextPageToken: string | null;
  /**
   * How a row reads as a card, for a room too narrow for the columns. A card tells the same facts as its row and never fewer. When it is given
   * the rows are drawn twice, as the table and as a list of cards, and the stylesheet shows the one that fits the room the results have
   * (queue-table.css), so that assistive technology and the keyboard meet one of them. A queue given none is drawn as it always was.
   */
  readonly card?: (row: Row) => ReactNode;
  /** A checkbox for each row, kept by the screen (`QueueSelection`). A queue given none is drawn as it always was. */
  readonly selection?: QueueSelection<Row>;
}

/** The checkbox of one row. The label around it is the target (at least the height of a small control), and the name is the row's. */
function RowSelect<Row>({
  row,
  rowKey,
  selection,
  visibleWord,
}: {
  readonly row: Row;
  readonly rowKey: (row: Row) => string;
  readonly selection: QueueSelection<Row>;
  /** Words beside the box on a card, where a lone box says too little to the eye. */
  readonly visibleWord?: string;
}) {
  const key = rowKey(row);
  const ticked = selection.selected.has(key);
  const blocked = !ticked && selection.isDisabled?.(row) === true;
  return (
    <label className="ui-queue-table__pick">
      <input
        type="checkbox"
        className="ui-queue-table__pick-box"
        aria-label={selection.rowLabel(row)}
        checked={ticked}
        disabled={blocked}
        onChange={(event) => {
          selection.onToggle(row, event.currentTarget.checked);
        }}
      />
      {visibleWord === undefined ? null : (
        <span className="ui-queue-table__pick-word" aria-hidden="true">
          {visibleWord}
        </span>
      )}
    </label>
  );
}

/**
 * The panel of a queue (the reference of 1 November 2026; COMPONENT_PATTERNS section 22f): the filters, the count, the rows and the pager in
 * one white surface with one border, told apart by hairlines and not by a box for each. It holds whatever stands in the place of the rows as
 * well (the loading, an empty state, a failure, a refusal), inset from the panel's edges, so that the person meets every state on the surface
 * the rows would have been drawn on, with the filters still in reach. A queue not given a panel is drawn as it always was.
 */
export function QueuePanel({ children }: { readonly children: ReactNode }) {
  return <div className="ui-queue-panel">{children}</div>;
}

/**
 * The filters of a queue, above it (COMPONENT_PATTERNS section 19: the table filters nothing itself). A named group of the screen's own
 * controls, laid out in a row that wraps, so nothing is clipped at 320 px or at enlarged text. The filters belong to the screen and so do the
 * values; they stay in place while the queue below them loads, fails or is empty.
 *
 * A screen may set something beside the filters (`aside`, the pickup queue's refresh and the time of its last check): it stands at the end of
 * the row where there is room and under the filters where there is not, and it is outside the group, because a control that filters nothing is
 * not one of the filters. A queue given none is drawn as it always was, with no element around the group.
 */
export function QueueFilters({
  label,
  children,
  aside,
}: {
  /** What the group is: "Filter the requests". */
  readonly label: string;
  readonly children: ReactNode;
  /** What stands beside the filters, outside their group. */
  readonly aside?: ReactNode;
}) {
  const group = (
    <div className="ui-queue-filters" role="group" aria-label={label}>
      {children}
    </div>
  );
  if (aside === undefined) return group;
  return (
    <div className="ui-queue-bar">
      {group}
      <div className="ui-queue-bar__aside">{aside}</div>
    </div>
  );
}

/**
 * A page of a queue (surfaces/ops-portal.md section 4: queue-led workspaces): how many rows the page shows, the rows in a `Table`, and a pager
 * that moves by the server's tokens. It never claims a total it was not given (a count of a page is not the size of the queue, so it says when
 * more follow) and never shows a count while loading, because it is drawn only with rows that were read (`ReadState` owns loading, failure and
 * the empty state, which tells *none* from *filtered to nothing*). After the person moves to another page, focus goes to the rows once they
 * are drawn, because the button they pressed is gone while the page loads.
 *
 * Given a `card`, the rows are also drawn as a list of cards beside the table. The list says outright that it is a list (`role="list"`),
 * because a style that removes its markers also takes the list from VoiceOver in Safari, and a phone is where the cards are read.
 */
export function QueueTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  noun,
  paging,
  nextPageToken,
  card,
  selection,
}: QueueTableProps<Row>) {
  const results = useRef<HTMLDivElement>(null);
  const { page, takeFocus } = paging;

  useEffect(() => {
    if (takeFocus()) results.current?.focus();
  }, [page, rows, takeFocus]);

  const shown = rows.length;
  const count = `Showing ${String(shown)} ${shown === 1 ? noun.one : noun.other}${
    page > 1 ? ` on page ${String(page)}` : ''
  }.${nextPageToken === null ? '' : ' More follow on the next page.'}`;

  const shownColumns: readonly TableColumn<Row>[] =
    selection === undefined
      ? columns
      : [
          {
            key: 'select',
            header: 'Select',
            cell: (row) => <RowSelect row={row} rowKey={rowKey} selection={selection} />,
          },
          ...columns,
        ];

  const table = (
    <Table caption={caption} hideCaption columns={shownColumns} rows={rows} rowKey={rowKey} />
  );

  return (
    <div className={card === undefined ? 'ui-queue-table' : 'ui-queue-table ui-queue-table--cards'}>
      <p className="ui-queue-table__count" role="status">
        {count}
      </p>
      <div className="ui-queue-table__results" ref={results} tabIndex={-1}>
        {card === undefined ? (
          table
        ) : (
          <>
            <div className="ui-queue-table__table">{table}</div>
            <ul className="ui-queue-table__cards" role="list" aria-label={caption}>
              {rows.map((row) => (
                <li key={rowKey(row)} className="ui-queue-table__card">
                  {selection === undefined ? null : (
                    <RowSelect
                      row={row}
                      rowKey={rowKey}
                      selection={selection}
                      visibleWord="Select"
                    />
                  )}
                  {card(row)}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {page > 1 || nextPageToken !== null ? (
        <nav className="ui-queue-table__pager" aria-label={`Pages of ${caption.toLowerCase()}`}>
          {page > 1 ? (
            <Button type="button" variant="secondary" onClick={paging.toPreviousPage}>
              <Icon name="previous" size="sm" />
              Previous page
            </Button>
          ) : null}
          {nextPageToken === null ? null : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                paging.toNextPage(nextPageToken);
              }}
            >
              Next page
              <Icon name="next" size="sm" />
            </Button>
          )}
        </nav>
      ) : null}
    </div>
  );
}

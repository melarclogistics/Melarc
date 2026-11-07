import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
  type RowSelectionState,
} from '@tanstack/react-table';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Button } from '../../primitives/button';
import { Checkbox } from '../../primitives/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../primitives/table';
import { OperationalCode } from '../code/OperationalCode';
import { Icon } from '../icon/Icon';
import { AnimatePresence, motion, useMotion } from '../motion/motion';
import { LoadingRow } from '../skeleton/LoadingRow';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './data-table.css';

/** One column of the table. */
export interface DataColumn<Item> {
  /** Tells the column from the others. Unique in a table. */
  readonly id: string;
  /** Names the column, in one to three words. It is the heading's text and its name for assistive technology. */
  readonly header: string;
  /** What a cell holds for a row. The cell of the row-header column is the row's name: usually a `RowTitle`. */
  readonly cell: (item: Item) => ReactNode;
  /** The column that names a row, and holds the button that opens it. At most one; none for a table whose rows open nothing. */
  readonly rowHeader?: boolean;
  /** Where the text sits: `start` (the default), or `end` for a column of figures. */
  readonly align?: 'start' | 'end';
  /** The column's width as a CSS length or percentage. Without one it takes what its content needs. */
  readonly width?: string;
  /** The page can order the rows by this column: its heading is a button that asks for it. The table sorts nothing. */
  readonly sortable?: boolean;
}

export interface DataSort {
  readonly columnId: string;
  readonly direction: 'ascending' | 'descending';
}

/** An act on the chosen rows, drawn in the bar that slides in. */
export interface BulkAction {
  readonly id: string;
  /** The words of the act, with the number it acts on: `(count) => "Confirm " + count`. */
  readonly label: (selected: number) => string;
  readonly onRun: (selectedIds: readonly string[]) => void;
  /** The one act the bar leads with, in Ink. At most one. */
  readonly primary?: boolean;
  readonly disabled?: boolean;
}

export interface DataTableProps<Item> {
  /** Names the table: what its rows are ("Pickup requests"). It is the caption, read by assistive technology, and names the box that scrolls. */
  readonly label: string;
  readonly columns: readonly DataColumn<Item>[];
  /** The rows to draw. The table sorts, filters and pages nothing: they are in the order the server gave. */
  readonly rows: readonly Item[];
  /** Tells a row from the others: the record's id. Unique in a table. */
  readonly rowId: (item: Item) => string;
  /**
   * The density: `single` rows are 36px, `two-line` rows (a code over a name) 52px, and `touch` rows 56px for the hub-floor tablet. A queue at the
   * desk is `single` or `two-line`; the density follows the task and is the screen's to choose.
   */
  readonly density?: 'single' | 'two-line' | 'touch';

  /** Opens the record: the button of the row-header cell, which is stretched over the whole row, and Enter on it. */
  readonly onOpen?: (item: Item) => void;
  /** Names that button for assistive technology and for the pointer: "Open ACC-PR-7KQ2MZ, Demo Fabrics Ltd". It contains the visible words. */
  readonly openLabel?: (item: Item) => string;

  /** Rows can be chosen, and the page keeps which. Without it, no checkbox is drawn. */
  readonly selection?: {
    /** The ids of the chosen rows. The page holds them (they may include rows not on this page of the queue). */
    readonly selectedIds: readonly string[];
    readonly onChange: (selectedIds: readonly string[]) => void;
    /** Names a row's checkbox: "Select ACC-PR-7KQ2MZ". */
    readonly selectLabel: (item: Item) => string;
    /** A row that cannot be chosen now (a limit was reached). The page says why in its own words. Default: every row. */
    readonly isSelectable?: (item: Item) => boolean;
    /** Acts on the chosen rows, in the bar that slides in. Only for acts that are safe and atomic (surfaces/ops-portal.md section 10). */
    readonly bulkActions?: readonly BulkAction[];
  };

  /** The usual next act of a row, shown on hover, on focus and when the row is chosen (always on a touch screen). */
  readonly rowAction?: {
    /** What the button says ("Confirm"). */
    readonly label: string;
    /** Names it for assistive technology, with the row ("Confirm ACC-PR-7KQ2MZ"); contains `label`. */
    readonly ariaLabel?: (item: Item) => string;
    readonly onRun: (item: Item) => void;
    /** Whether the act is offered for a row. Default: every row. */
    readonly isAvailable?: (item: Item) => boolean;
  };

  /** Rows that changed since the last read: each is highlighted and the highlight fades over `motion.highlight`. A cue for the eye only: say it in words where it matters. */
  readonly changedIds?: readonly string[];

  readonly sort?: DataSort;
  /** The person asked to order by a column. The page asks the server and passes the new order. */
  readonly onSortChange?: (columnId: string) => void;

  /** `ready` (the default), `loading` (skeleton rows in the table's shape) or `error`. */
  readonly status?: 'ready' | 'loading' | 'error';
  /** How many skeleton rows to draw while loading. Default 8. */
  readonly loadingRows?: number;
  /** What a screen reader hears while it loads: "Loading pickup requests". */
  readonly loadingLabel?: string;
  /** The failure in the page's words (mapped from the machine code, never the diagnostic message), with the way to try again. */
  readonly error?: { readonly message: string; readonly onRetry?: () => void };
  /** What is drawn when a read succeeded and there are no rows: the page's EmptyState, which tells none from filtered to nothing. */
  readonly emptyState?: ReactNode;
  /** The rows are the last that were read, and a newer read failed or is overdue: the page's words and the way to read again. The rows stay. */
  readonly stale?: { readonly message: string; readonly onRefresh?: () => void };

  /** What follows the table inside its frame: the pager. */
  readonly footer?: ReactNode;
  /** The height of the box the rows scroll in, as a CSS length ("32rem"), so that the header can stay while the rows move. Without one the box is as tall as the rows. */
  readonly maxHeight?: string;
  /** Where the box was scrolled to when the person left, to be put back when they return. The page keeps it in memory (never in the address or a storage). */
  readonly initialScroll?: { readonly left: number; readonly top: number };
  readonly onScrollChange?: (position: { left: number; top: number }) => void;
  /** The row whose button takes focus once it is drawn: the record the person came back from. */
  readonly focusRowId?: string | null;
}

interface RowTitleProps {
  /** The record's code, whole. */
  readonly code: string;
  /** Under the code, one quiet line: a name. Without it the row is a single line. */
  readonly name?: string;
}

/** The row-header cell of a queue: the code in the monospaced face over a name in the quiet text. Two lines are a `two-line` density. */
export function RowTitle({ code, name }: RowTitleProps) {
  return (
    <span className="ui-data-table__title">
      <OperationalCode>{code}</OperationalCode>
      {name === undefined ? null : <span className="ui-data-table__name">{name}</span>}
    </span>
  );
}

/**
 * The queue's table (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *DataTable*): TanStack Table's model (columns, row model, selection) over the
 * table primitive. Rows are 36px, 52px with a code over a name, or 56px on a tablet. The whole row opens its record through a real button in the code cell,
 * stretched over the row; rows can be chosen, a bar slides in with the acts on them, and the usual next act of a row shows on hover, focus and selection. It draws
 * what it is given, in the order it is given, and **never a total it was not given**; it sorts, filters and pages nothing, and decides nothing about what may be
 * chosen or done.
 *
 * The keys: Tab enters the table at one row and leaves it in a few stops (only the current row's controls are in the order), the up and down arrows, Home and End
 * move between rows, Enter opens the record and **Space chooses the row** (it does not open it). The states are the table's own: loading (skeleton rows of its shape),
 * empty and filtered to nothing (the page's EmptyState), an error with a way to try again, and stale rows with a way to read again.
 */
export function DataTable<Item>({
  label,
  columns,
  rows,
  rowId,
  density = 'single',
  onOpen,
  openLabel,
  selection,
  rowAction,
  changedIds,
  sort,
  onSortChange,
  status = 'ready',
  loadingRows = 8,
  loadingLabel = 'Loading',
  error,
  emptyState,
  stale,
  footer,
  maxHeight,
  initialScroll,
  onScrollChange,
  focusRowId,
}: DataTableProps<Item>) {
  const motionKit = useMotion();
  const hintId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  /** The controls of each row, found again when focus is to be put on one: the arrows land on its button that opens it, else its checkbox, else its action. */
  const controls = useRef(
    new Map<string, Partial<Record<'open' | 'box' | 'action', HTMLElement>>>(),
  );
  const control = (id: string): HTMLElement | undefined => {
    const own = controls.current.get(id);
    return own?.open ?? own?.box ?? own?.action;
  };
  const register = (
    id: string,
    kind: 'open' | 'box' | 'action',
    node: HTMLElement | null,
  ): void => {
    const own = controls.current.get(id) ?? {};
    if (node === null) Reflect.deleteProperty(own, kind);
    else own[kind] = node;
    controls.current.set(id, own);
  };
  const [activeId, setActiveId] = useState<string | null>(null);

  const rowHeaderColumns = columns.filter((column) => column.rowHeader === true);
  if (rowHeaderColumns.length > 1) {
    throw new Error(`The table "${label}" has more than one row-header column.`);
  }
  if (onOpen !== undefined && (openLabel === undefined || rowHeaderColumns.length === 0)) {
    throw new Error(
      `The table "${label}" opens rows, so it needs a row-header column and a label for its button.`,
    );
  }
  const duplicateColumn = columns.find(
    (column, index) => columns.findIndex((other) => other.id === column.id) !== index,
  );
  if (duplicateColumn !== undefined) {
    throw new Error(`Two columns of the table "${label}" have the id "${duplicateColumn.id}".`);
  }
  const ids = rows.map(rowId);
  const duplicateRow = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicateRow !== undefined) {
    throw new Error(`Two rows of the table "${label}" have the id "${duplicateRow}".`);
  }

  const selectedIds = selection?.selectedIds;
  const rowSelection = useMemo<RowSelectionState>(
    () => Object.fromEntries((selectedIds ?? []).map((id) => [id, true])),
    [selectedIds],
  );

  const columnDefs = useMemo<ColumnDef<Item>[]>(
    () =>
      columns.map((column) => ({
        id: column.id,
        header: column.header,
        cell: ({ row }: { row: Row<Item> }) => column.cell(row.original),
        enableSorting: column.sortable === true,
      })),
    [columns],
  );

  // TanStack Table's hook returns functions that the React Compiler cannot memoize. This application does not use the compiler, and the table is read afresh from
  // its state on every render, which is what the library documents.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable<Item>({
    data: rows as Item[],
    columns: columnDefs,
    getRowId: rowId,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    enableRowSelection: (row) => selection?.isSelectable?.(row.original) ?? true,
    state: {
      rowSelection,
      sorting:
        sort === undefined ? [] : [{ id: sort.columnId, desc: sort.direction === 'descending' }],
    },
    onRowSelectionChange: (updater) => {
      const next = typeof updater === 'function' ? updater(rowSelection) : updater;
      selection?.onChange(Object.keys(next).filter((id) => next[id] === true));
    },
  });
  const tableRows = table.getRowModel().rows;
  const selectedCount = selection?.selectedIds.length ?? 0;
  const currentId = tableRows.some((row) => row.id === activeId)
    ? activeId
    : (tableRows[0]?.id ?? null);
  const changed = useMemo(() => new Set(changedIds ?? []), [changedIds]);

  // The place the person left: the box is scrolled back once, as it is first drawn. Once: a later change of the saved place (the page writing it as the person
  // scrolls) must not move the box under them.
  const placeToReturnTo = useRef(initialScroll);
  useLayoutEffect(() => {
    const box = scroller.current;
    const place = placeToReturnTo.current;
    if (box === null || place === undefined) return;
    box.scrollLeft = place.left;
    box.scrollTop = place.top;
  }, []);

  // The record the person came back from takes focus once its row is drawn.
  useEffect(() => {
    if (focusRowId === undefined || focusRowId === null) return;
    const own = controls.current.get(focusRowId);
    (own?.open ?? own?.box ?? own?.action)?.focus();
  }, [focusRowId, status, rows.length]);

  const focusRow = (id: string | undefined): void => {
    if (id === undefined) return;
    setActiveId(id);
    control(id)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Arrows belong to a control that uses them (a field, a menu) and are the table's only on the controls that name a row.
    if (
      target.closest(
        'input:not([type="checkbox"]), select, textarea, [role="menu"], [role="listbox"]',
      ) !== null
    )
      return;
    const row = target.closest<HTMLElement>('tr[data-row-id]');
    // A table with nothing in its rows to focus (no button that opens, no box, no act) has no rows to move between.
    if (row === null || controls.current.size === 0) return;
    const index = ids.indexOf(row.dataset.rowId ?? '');
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : Math.min(ids.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
    focusRow(ids[next]);
  };

  const hint = [
    'Use the up and down arrow keys to move between rows.',
    onOpen === undefined ? undefined : 'Enter opens the record.',
    selection === undefined ? undefined : 'Space chooses the row.',
  ]
    .filter((part) => part !== undefined)
    .join(' ');

  const bulk = selection?.bulkActions;
  const columnCount =
    columns.length + (selection === undefined ? 0 : 1) + (rowAction === undefined ? 0 : 1);

  return (
    <div className="ui-data-table" data-density={density}>
      {stale === undefined || status !== 'ready' ? null : (
        <div className="ui-data-table__stale" role="status">
          <Icon name="info" size="sm" />
          <p>{stale.message}</p>
          {stale.onRefresh === undefined ? null : (
            <Button type="button" variant="link" size="sm" onClick={stale.onRefresh}>
              Refresh
            </Button>
          )}
        </div>
      )}
      <div
        ref={scroller}
        className="ui-data-table__scroller"
        role="region"
        aria-label={label}
        tabIndex={0}
        style={maxHeight === undefined ? undefined : { maxHeight }}
        onScroll={
          onScrollChange === undefined
            ? undefined
            : (event) => {
                onScrollChange({
                  left: event.currentTarget.scrollLeft,
                  top: event.currentTarget.scrollTop,
                });
              }
        }
      >
        <Table
          className="ui-data-table__table"
          aria-describedby={hintId}
          aria-busy={status === 'loading' ? true : undefined}
        >
          <caption className="ui-visually-hidden">{label}</caption>
          <TableHeader className="ui-data-table__head">
            <TableRow>
              {selection === undefined ? null : (
                <TableHead scope="col" className="ui-data-table__select">
                  <VisuallyHidden>Select</VisuallyHidden>
                </TableHead>
              )}
              {columns.map((column) => {
                const sorted = sort?.columnId === column.id ? sort.direction : undefined;
                return (
                  <TableHead
                    key={column.id}
                    scope="col"
                    style={column.width === undefined ? undefined : { width: column.width }}
                    data-align={column.align === 'end' ? 'end' : undefined}
                    aria-sort={sorted}
                  >
                    {column.sortable === true && onSortChange !== undefined ? (
                      <button
                        type="button"
                        className="ui-data-table__sort"
                        onClick={() => {
                          onSortChange(column.id);
                        }}
                      >
                        {column.header}
                        <Icon
                          name={
                            sorted === 'ascending'
                              ? 'sort-ascending'
                              : sorted === 'descending'
                                ? 'sort-descending'
                                : 'sort-none'
                          }
                          size="sm"
                        />
                      </button>
                    ) : (
                      column.header
                    )}
                  </TableHead>
                );
              })}
              {rowAction === undefined ? null : (
                <TableHead scope="col" className="ui-data-table__actions">
                  <VisuallyHidden>Actions</VisuallyHidden>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody onKeyDown={onKeyDown}>
            {status === 'loading' ? (
              Array.from({ length: loadingRows }, (_, index) => (
                <LoadingRow
                  key={index}
                  columns={columnCount}
                  index={index}
                  className="ui-data-table__skeleton-row"
                />
              ))
            ) : status === 'error' ? (
              <TableRow className="ui-data-table__message-row">
                <TableCell colSpan={columnCount}>
                  <div className="ui-data-table__notice" data-kind="error">
                    <Icon name="warning" />
                    <p role="alert">{error?.message ?? ''}</p>
                    {error?.onRetry === undefined ? null : (
                      <Button type="button" variant="secondary" size="sm" onClick={error.onRetry}>
                        Retry
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : tableRows.length === 0 ? (
              <TableRow className="ui-data-table__message-row">
                <TableCell colSpan={columnCount}>{emptyState}</TableCell>
              </TableRow>
            ) : (
              tableRows.map((row) => {
                const item = row.original;
                const id = row.id;
                const selected = row.getIsSelected();
                const current = id === currentId;
                const tab = current ? 0 : -1;
                const isChanged = changed.has(id);
                return (
                  <TableRow
                    key={id}
                    data-row-id={id}
                    data-state={selected ? 'selected' : undefined}
                    data-changed={isChanged ? 'true' : undefined}
                    data-current={current ? 'true' : undefined}
                    className="ui-data-table__row"
                  >
                    {selection === undefined ? null : (
                      <TableCell className="ui-data-table__select">
                        <Checkbox
                          ref={(node) => {
                            register(id, 'box', node);
                          }}
                          aria-label={selection.selectLabel(item)}
                          checked={selected}
                          disabled={!row.getCanSelect()}
                          tabIndex={tab}
                          onFocus={() => {
                            setActiveId(id);
                          }}
                          onCheckedChange={(value) => {
                            row.toggleSelected(value === true);
                          }}
                        />
                      </TableCell>
                    )}
                    {row.getVisibleCells().map((cell) => {
                      const column = columns.find((candidate) => candidate.id === cell.column.id);
                      const content = flexRender(cell.column.columnDef.cell, cell.getContext());
                      if (column?.rowHeader === true) {
                        return (
                          <TableHead
                            key={cell.id}
                            scope="row"
                            className="ui-data-table__code"
                            data-align={column.align === 'end' ? 'end' : undefined}
                          >
                            {onOpen === undefined || openLabel === undefined ? (
                              content
                            ) : (
                              <button
                                type="button"
                                ref={(node) => {
                                  register(id, 'open', node);
                                }}
                                className="ui-data-table__open"
                                aria-label={openLabel(item)}
                                aria-describedby={isChanged ? `${hintId}-${id}-changed` : undefined}
                                tabIndex={tab}
                                onFocus={() => {
                                  setActiveId(id);
                                }}
                                onClick={() => {
                                  onOpen(item);
                                }}
                                onKeyDown={(event) => {
                                  // Space chooses the row; it is not the button's own press, which is Enter's here.
                                  if (event.key === ' ' && selection !== undefined) {
                                    event.preventDefault();
                                    if (row.getCanSelect()) row.toggleSelected();
                                  }
                                }}
                                onKeyUp={(event) => {
                                  // A browser presses a button on the key's release: Space has been taken for choosing.
                                  if (event.key === ' ' && selection !== undefined)
                                    event.preventDefault();
                                }}
                              >
                                {content}
                              </button>
                            )}
                            {isChanged ? (
                              <span id={`${hintId}-${id}-changed`} className="ui-visually-hidden">
                                Updated
                              </span>
                            ) : null}
                          </TableHead>
                        );
                      }
                      return (
                        <TableCell
                          key={cell.id}
                          data-align={column?.align === 'end' ? 'end' : undefined}
                        >
                          {content}
                        </TableCell>
                      );
                    })}
                    {rowAction === undefined ? null : (
                      <TableCell className="ui-data-table__actions">
                        {rowAction.isAvailable?.(item) === false ? null : (
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            className="ui-data-table__action"
                            tabIndex={tab}
                            aria-label={rowAction.ariaLabel?.(item)}
                            ref={(node) => {
                              register(id, 'action', node);
                            }}
                            onFocus={() => {
                              setActiveId(id);
                            }}
                            onClick={() => {
                              rowAction.onRun(item);
                            }}
                          >
                            {rowAction.label}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <p id={hintId} className="ui-visually-hidden">
        {hint}
      </p>
      {status === 'loading' ? (
        <p role="status" className="ui-visually-hidden">
          {loadingLabel}
        </p>
      ) : null}
      {selection === undefined ? null : (
        <p role="status" className="ui-visually-hidden">
          {selectedCount === 0 ? '' : `${String(selectedCount)} selected`}
        </p>
      )}
      <AnimatePresence>
        {selection !== undefined && bulk !== undefined && selectedCount > 0 ? (
          <motion.div
            key="bulk-bar"
            role="group"
            aria-label="Actions for the chosen rows"
            className="ui-data-table__bulk"
            initial={motionKit.reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={motionKit.transition('normal')}
          >
            <p className="ui-data-table__bulk-count" aria-hidden="true">
              {`${String(selectedCount)} selected`}
            </p>
            {bulk.map((action) => (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={action.primary === true ? 'default' : 'secondary'}
                disabled={action.disabled === true}
                onClick={() => {
                  action.onRun(selection.selectedIds);
                }}
              >
                {action.label(selectedCount)}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                selection.onChange([]);
                // The bar goes, with the button that had focus: the row the person was on takes it.
                focusRow(currentId ?? undefined);
              }}
            >
              Clear
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {footer === undefined ? null : <div className="ui-data-table__footer">{footer}</div>}
    </div>
  );
}

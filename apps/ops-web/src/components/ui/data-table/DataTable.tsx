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
  type RefObject,
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
  /** Where the text sits: `start` (the default), or `end` for a column of figures, which is right-aligned at every density. */
  readonly align?: 'start' | 'end';
  /** The column's width as a CSS length or percentage. Without one it takes what its content needs. */
  readonly width?: string;
  /** The page can order the rows by this column: its heading is a button that asks for it. The table sorts nothing. */
  readonly sortable?: boolean;
  /**
   * How much the column matters when the table is narrow (task R5.2, M12): `1` is always drawn (the default), `2` goes first when the table's own box is under 48rem, and
   * `3` goes before that, under 64rem, so that a table with a side panel open beside it never needs a sideways scroll at 1440px. A hidden column leaves the page and the
   * accessibility tree (`display: none`), and the screen chooses which columns may go: the table cannot know. The row-header column and the box are always drawn.
   */
  readonly priority?: 1 | 2 | 3;
}

export interface DataSort {
  readonly columnId: string;
  readonly direction: 'ascending' | 'descending';
}

/** An act on the chosen rows, drawn in the bar above the rows. */
export interface BulkAction {
  readonly id: string;
  /** The words of the act, with the number it acts on: `(count) => "Confirm " + count`. The number is that of the rows it can act on (see `eligible`). */
  readonly label: (selected: number) => string;
  /** Runs the act. It is given the rows it can act on: `eligible` has taken the others out. */
  readonly onRun: (selectedIds: readonly string[]) => void;
  /** The one act the bar leads with, in Ink. At most one. */
  readonly primary?: boolean;
  readonly disabled?: boolean;
  /**
   * Which of the chosen rows this act can be taken on (task R5.2, M12), by the screen's own rule, for the table cannot judge rows that are not on this page: it gets every
   * chosen id and gives back those the act applies to. The label counts those, `onRun` is given those, and the act is **not drawn** when none is. Without it, every
   * chosen row. The server decides, whatever the bar offers.
   */
  readonly eligible?: (selectedIds: readonly string[]) => readonly string[];
  /** Said in the bar, in the screen's words, when `eligible` took some of the chosen rows out: "1 is already confirmed". Given how many were taken out. */
  readonly note?: (ineligible: number) => string;
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
    /** Acts on the chosen rows, in the bar above the rows. Only for acts that are safe and atomic (surfaces/ops-portal.md section 10). */
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

  /**
   * What a row is as a card, for a table that is narrow (task R5.2, M12): the facts of the row as one block of text, badges and codes, **with no control in it**, for the
   * table draws the card's one hit target (the button that opens, stretched over the card), its box and its act. Under 40rem of the table's own width the rows are drawn
   * as these cards in place of the table (a 390px phone), and the keys, the box, the open button and the row act work as they do in the table. Without it the table stays a
   * table at every width and scrolls sideways.
   */
  readonly card?: (item: Item) => ReactNode;
  /** `auto` (the default) draws cards when the table's own box is under 40rem; `table` and `cards` fix it, for a screen that knows better and for a test. */
  readonly layout?: 'auto' | 'table' | 'cards';

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
  readonly error?: {
    readonly message: string;
    readonly onRetry?: () => void;
    /** What the way out says. Default "Retry"; a failure that asking again would not mend names the way that does ("Back to first page"). */
    readonly retryLabel?: string;
  };
  /** What is drawn when a read succeeded and there are no rows: the page's EmptyState, which tells none from filtered to nothing. */
  readonly emptyState?: ReactNode;
  /** The rows are the last that were read, and a newer read failed or is overdue: the page's words and the way to read again. The rows stay. */
  readonly stale?: { readonly message: string; readonly onRefresh?: () => void };

  /** What follows the table inside its frame: the pager. */
  readonly footer?: ReactNode;
  /** The height of the box the rows scroll in, as a CSS length ("32rem"), so that the header can stay while the rows move. Without one the box is as tall as the rows. */
  readonly maxHeight?: string;
  /**
   * Where the box was scrolled to when the person left, to be put back when they return. The page keeps it in memory (never in the address or a storage). It is put
   * back **once, when the rows first arrive**: a table that draws loading rows first has no height to scroll to until the rows are there (task R5.2, M7).
   */
  readonly initialScroll?: { readonly left: number; readonly top: number };
  readonly onScrollChange?: (position: { left: number; top: number }) => void;
  /** The row whose button takes focus once it is drawn: the record the person came back from. It takes it once, and a later change of the rows does not take it again. */
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

/** Under this width of the table's own box, in rem (so that enlarged text turns the table into cards sooner), the rows are drawn as cards. */
export const CARDS_BELOW_REM = 40;

/** Whether the table's box is narrow enough for cards: measured as the box changes, and left as it was where nothing can be measured (no layout, a hidden box). */
function useNarrow(root: RefObject<HTMLDivElement | null>, layout: 'auto' | 'table' | 'cards') {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (layout !== 'auto' || element === null || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const width = element.clientWidth;
      if (width === 0) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrow(width < CARDS_BELOW_REM * rem);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [root, layout]);
  return layout === 'cards' ? true : layout === 'table' ? false : narrow;
}

/** A control that can take focus now: not a disabled button, not one marked unavailable. */
const isEnabled = (node: HTMLElement): boolean =>
  !(node instanceof HTMLButtonElement && node.disabled) &&
  node.getAttribute('aria-disabled') !== 'true';

/**
 * The queue's table (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *DataTable*): TanStack Table's model (columns, row model, selection) over the
 * table primitive. Rows are 36px, 52px with a code over a name, or 56px on a tablet. The whole row opens its record through a real button in the code cell,
 * stretched over the row; rows can be chosen, a bar above the rows (which stays in view as they scroll) holds the acts on them, and the usual next act of a row shows on
 * hover, focus and selection. It draws what it is given, in the order it is given, and **never a total it was not given**; it sorts, filters and pages nothing, and
 * decides nothing about what may be chosen or done.
 *
 * The keys: Tab enters the table at one row and leaves it in a few stops (only the current row's controls are in the order), the up and down arrows, Home and End
 * move between the rows that have a control (a row with nothing to focus is passed over), Enter opens the record and **Space chooses the row** (it does not open
 * it). The arrows belong to a control that uses them (a field, a menu, a combobox) and to a key that something has already handled. The states are the table's own:
 * loading (skeleton rows of its shape), empty and filtered to nothing (the page's EmptyState), an error with a way to try again, and stale rows with a way to read again;
 * each is told in a region that is in the page before it speaks. Narrow, the rows are cards (`card`), and the columns the screen marked lesser go (`priority`).
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
  card,
  layout = 'auto',
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
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root, layout);
  const cards = card !== undefined && narrow;
  /** The controls of each row, found again when focus is to be put on one: the arrows land on its button that opens it, else its checkbox, else its action. */
  const controls = useRef(
    new Map<string, Partial<Record<'open' | 'box' | 'action', HTMLElement>>>(),
  );
  /** The control of a row that can take focus now: its button that opens, else its box, else its act, skipping the ones that are disabled. */
  const control = (id: string): HTMLElement | undefined => {
    const own = controls.current.get(id);
    return [own?.open, own?.box, own?.action].find(
      (node): node is HTMLElement => node !== undefined && isEnabled(node),
    );
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

  const bulk = selection?.bulkActions;
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
  /** A row has something to focus when it opens, can be chosen or has an act: what the table can tell without the page drawn. */
  const hasControl = (row: Row<Item>): boolean =>
    onOpen !== undefined ||
    (selection !== undefined && row.getCanSelect()) ||
    (rowAction !== undefined && rowAction.isAvailable?.(row.original) !== false);
  // The row that is the Tab stop: the one the keyboard is on, else the first that has something to focus (a row with only a box that is disabled is no stop).
  const currentId =
    tableRows.find((row) => row.id === activeId && hasControl(row))?.id ??
    tableRows.find(hasControl)?.id ??
    null;
  const changed = useMemo(() => new Set(changedIds ?? []), [changedIds]);

  // The place the person left: the box is scrolled back once, when the rows first arrive (a table that begins with loading rows is too short to scroll to it, and the
  // browser would clamp it to the top). Once: a later change of the saved place (the page writing it as the person scrolls) must not move the box under them.
  const placeToReturnTo = useRef(initialScroll);
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current) return;
    const box = scroller.current;
    const place = placeToReturnTo.current;
    if (box === null || place === undefined) {
      placed.current = true;
      return;
    }
    if (status === 'loading') return;
    box.scrollLeft = place.left;
    box.scrollTop = place.top;
    placed.current = true;
  }, [status, rows.length, cards]);

  // The record the person came back from takes focus once its row is drawn: once, so that a later change of the rows (a refetch, a page, a filter) does not take focus
  // from wherever the person went since.
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (focusRowId === undefined || focusRowId === null) {
      focusedFor.current = null;
      return;
    }
    if (focusedFor.current === focusRowId) return;
    const target = control(focusRowId);
    if (target === undefined) return;
    focusedFor.current = focusRowId;
    target.focus();
    // `control` reads the registry of controls, which is not state.
  }, [focusRowId, status, rows.length, cards]);

  // The bar of acts is above the rows and stays in view; the room it takes is told to the rows, so that a control reached by keyboard is never left under it.
  const barShown = selection !== undefined && bulk !== undefined && selectedCount > 0;
  useLayoutEffect(() => {
    const element = root.current;
    const barElement = bar.current;
    if (element === null) return;
    if (barElement === null) {
      element.style.removeProperty('--ui-data-table-bar');
      return;
    }
    const publish = (): void => {
      element.style.setProperty(
        '--ui-data-table-bar',
        `${String(barElement.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(publish);
    observer.observe(barElement);
    return () => {
      observer.disconnect();
    };
  }, [barShown]);

  /** Puts focus on the nearest row that has a control, from `from` on in `direction`: a row with nothing to focus is passed over. */
  const step = (from: number, direction: 1 | -1): void => {
    for (let index = from; index >= 0 && index < ids.length; index += direction) {
      const id = ids[index];
      if (id === undefined) return;
      const target = control(id);
      if (target !== undefined) {
        setActiveId(id);
        target.focus();
        return;
      }
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    // Arrows belong to a control that uses them (a field, a menu, a combobox, a button that opens a list) and are the table's only on the controls that name a row.
    if (
      target.closest(
        'input:not([type="checkbox"]), select, textarea, [role="menu"], [role="listbox"], [role="combobox"], [aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded="true"]',
      ) !== null
    )
      return;
    const row = target.closest<HTMLElement>('[data-row-id]');
    // A table with nothing in its rows to focus (no button that opens, no box, no act) has no rows to move between.
    if (row === null || controls.current.size === 0) return;
    const index = ids.indexOf(row.dataset.rowId ?? '');
    if (index === -1) return;
    event.preventDefault();
    if (event.key === 'Home') step(0, 1);
    else if (event.key === 'End') step(ids.length - 1, -1);
    else if (event.key === 'ArrowDown') step(index + 1, 1);
    else step(index - 1, -1);
  };

  const hint = [
    'Use the up and down arrow keys to move between rows.',
    onOpen === undefined ? undefined : 'Enter opens the record.',
    selection === undefined ? undefined : 'Space chooses the row.',
  ]
    .filter((part) => part !== undefined)
    .join(' ');

  const columnCount =
    columns.length + (selection === undefined ? 0 : 1) + (rowAction === undefined ? 0 : 1);

  /** The box of a row: a label as big as its cell, so that a press beside the box chooses the row and never opens it. It has no words: the box is named by its own label. */
  const box = (row: Row<Item>, tab: number): ReactNode =>
    selection === undefined ? null : (
      <label className="ui-data-table__box">
        <Checkbox
          ref={(node) => {
            register(row.id, 'box', node);
          }}
          aria-label={selection.selectLabel(row.original)}
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          tabIndex={tab}
          onFocus={() => {
            setActiveId(row.id);
          }}
          onCheckedChange={(value) => {
            row.toggleSelected(value === true);
          }}
        />
      </label>
    );

  /** The button that opens a row's record, with the words it holds: stretched over the row (the table) or the card. */
  const opener = (row: Row<Item>, tab: number, content: ReactNode): ReactNode => {
    if (onOpen === undefined || openLabel === undefined) return content;
    const isChanged = changed.has(row.id);
    return (
      <button
        type="button"
        ref={(node) => {
          register(row.id, 'open', node);
        }}
        className="ui-data-table__open"
        aria-label={openLabel(row.original)}
        aria-describedby={isChanged ? `${hintId}-${row.id}-changed` : undefined}
        tabIndex={tab}
        onFocus={() => {
          setActiveId(row.id);
        }}
        onClick={() => {
          onOpen(row.original);
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
          if (event.key === ' ' && selection !== undefined) event.preventDefault();
        }}
      >
        {content}
      </button>
    );
  };

  /** The usual next act of a row. */
  const action = (row: Row<Item>, tab: number): ReactNode =>
    rowAction === undefined || rowAction.isAvailable?.(row.original) === false ? null : (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="ui-data-table__action"
        tabIndex={tab}
        aria-label={rowAction.ariaLabel?.(row.original)}
        ref={(node) => {
          register(row.id, 'action', node);
        }}
        onFocus={() => {
          setActiveId(row.id);
        }}
        onClick={() => {
          rowAction.onRun(row.original);
        }}
      >
        {rowAction.label}
      </Button>
    );

  // The acts of the bar, each with the chosen rows it can act on: one that no chosen row can take is not drawn, and the rows that were taken out are told.
  const acts =
    selection === undefined || bulk === undefined
      ? []
      : bulk.flatMap((candidate) => {
          const rowsFor = candidate.eligible?.(selection.selectedIds) ?? selection.selectedIds;
          return rowsFor.length === 0 ? [] : [{ action: candidate, rowsFor }];
        });
  const notes =
    selection === undefined
      ? []
      : acts.flatMap(({ action: candidate, rowsFor }) => {
          const left = selection.selectedIds.length - rowsFor.length;
          return left > 0 && candidate.note !== undefined ? [candidate.note(left)] : [];
        });

  return (
    <div
      ref={root}
      className="ui-data-table"
      data-density={density}
      data-layout={cards ? 'cards' : 'table'}
    >
      {/* The regions that speak are in the page before they have anything to say (a region that arrives with its words is not announced by most screen readers): one for the
          state of the rows (stale, loading) and one for a failure; the words come into them, and the visible ones draw beside. */}
      <div role="status" className="ui-data-table__live">
        {stale === undefined || status !== 'ready' ? null : (
          <div className="ui-data-table__stale">
            <Icon name="info" size="sm" />
            <p>{stale.message}</p>
            {stale.onRefresh === undefined ? null : (
              <Button type="button" variant="link" size="sm" onClick={stale.onRefresh}>
                Refresh
              </Button>
            )}
          </div>
        )}
        {status === 'loading' ? <p className="ui-visually-hidden">{loadingLabel}</p> : null}
      </div>
      <div role="alert" className="ui-visually-hidden">
        {status === 'error' ? (error?.message ?? '') : ''}
      </div>
      <AnimatePresence>
        {barShown ? (
          <motion.div
            key="bulk-bar"
            ref={bar}
            role="group"
            aria-label="Actions for the chosen rows"
            className="ui-data-table__bulk"
            initial={motionKit.reduced ? false : { opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={motionKit.transition('normal')}
          >
            <p className="ui-data-table__bulk-count" aria-hidden="true">
              {`${String(selectedCount)} selected`}
            </p>
            {acts.map(({ action: candidate, rowsFor }) => (
              <Button
                key={candidate.id}
                type="button"
                size="sm"
                variant={candidate.primary === true ? 'default' : 'secondary'}
                disabled={candidate.disabled === true}
                onClick={() => {
                  candidate.onRun(rowsFor);
                }}
              >
                {candidate.label(rowsFor.length)}
              </Button>
            ))}
            {notes.map((note) => (
              <p key={note} className="ui-data-table__bulk-note">
                {note}
              </p>
            ))}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                selection.onChange([]);
                // The bar goes, with the button that had focus: the row the person was on takes it.
                if (currentId !== null) {
                  setActiveId(currentId);
                  control(currentId)?.focus();
                }
              }}
            >
              Clear
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
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
        {cards && status === 'ready' && tableRows.length > 0 ? (
          <ul
            role="list"
            className="ui-data-table__cards"
            aria-label={label}
            aria-describedby={hintId}
            onKeyDown={onKeyDown}
          >
            {tableRows.map((row) => {
              const selected = row.getIsSelected();
              const tab = row.id === currentId ? 0 : -1;
              const isChanged = changed.has(row.id);
              return (
                <li
                  key={row.id}
                  className="ui-data-table__card"
                  data-row-id={row.id}
                  data-state={selected ? 'selected' : undefined}
                  data-changed={isChanged ? 'true' : undefined}
                  data-current={row.id === currentId ? 'true' : undefined}
                >
                  {box(row, tab)}
                  <div className="ui-data-table__card-body">
                    {opener(row, tab, card(row.original))}
                    {isChanged ? (
                      <span id={`${hintId}-${row.id}-changed`} className="ui-visually-hidden">
                        Updated
                      </span>
                    ) : null}
                    {action(row, tab)}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
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
                      data-priority={priorityOf(column)}
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
                      {/* Told by the region of failures above; read once. */}
                      <p aria-hidden="true">{error?.message ?? ''}</p>
                      {error?.onRetry === undefined ? null : (
                        <Button type="button" variant="secondary" size="sm" onClick={error.onRetry}>
                          {error.retryLabel ?? 'Retry'}
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
                        <TableCell className="ui-data-table__select">{box(row, tab)}</TableCell>
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
                              {opener(row, tab, content)}
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
                            data-priority={column === undefined ? undefined : priorityOf(column)}
                          >
                            {content}
                          </TableCell>
                        );
                      })}
                      {rowAction === undefined ? null : (
                        <TableCell className="ui-data-table__actions">{action(row, tab)}</TableCell>
                      )}
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        )}
        {/* The cards do not draw the states of the table (loading rows, the failure, none); the table does, in its own shape, whatever the width. */}
      </div>
      <p id={hintId} className="ui-visually-hidden">
        {hint}
      </p>
      {selection === undefined ? null : (
        <p role="status" className="ui-visually-hidden">
          {selectedCount === 0 ? '' : `${String(selectedCount)} selected`}
        </p>
      )}
      {footer === undefined ? null : <div className="ui-data-table__footer">{footer}</div>}
    </div>
  );
}

/** What a column says of its priority for the stylesheet: nothing for the one that is always drawn. */
function priorityOf<Item>(column: DataColumn<Item>): '2' | '3' | undefined {
  return column.priority === 2 ? '2' : column.priority === 3 ? '3' : undefined;
}

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
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';

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
import { Link } from '../link/Link';
import { AnimatePresence, motion, useMotion } from '../motion/motion';
import { LoadingRow } from '../skeleton/LoadingRow';
import { VisuallyHidden } from '../visually-hidden/VisuallyHidden';
import './data-table.css';

/**
 * What a column holds, for the room it needs (the Product Owner, 11 November 2026: a table's text cells shrank to a letter, so the fit never dropped a lesser column for text). `prose` is words that
 * wrap at their spaces (an address, what a request needs, why, who asked) and keeps `PROSE_MIN_WIDTH` of its own; the others are one line whose own width is the room they need: a `badge` (a state),
 * a `code`, a `date` and a `count`, which the screen keeps to a line (a badge does; `NoWrap` is the mark for a code, a date and a count). A column of no kind takes what its content needs.
 */
export type DataColumnKind = 'prose' | 'badge' | 'code' | 'date' | 'count';

/** The room a prose column keeps, so that its words wrap at their spaces and never fall to a letter a line. */
export const PROSE_MIN_WIDTH = '8rem';

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
  /** What the column holds: its default room (see `DataColumnKind`). Without one the column takes what its content needs. */
  readonly kind?: DataColumnKind;
  /**
   * The least room the column keeps, as a CSS length, drawn as `min-inline-size` on a block inside each cell (so a table whose columns cannot all have their room overflows, and the fit takes the lesser
   * columns away). The default is `PROSE_MIN_WIDTH` for a `prose` column and none for any other kind. It is given up only when every lesser column is gone and the box still scrolls.
   */
  readonly minWidth?: string;
  /** The page can order the rows by this column: its heading is a button that asks for it. The table sorts nothing. */
  readonly sortable?: boolean;
  /**
   * How much the column matters when the table's box cannot hold every column (the Product Owner, 10 November 2026: **no table scrolls sideways**): `1` is always drawn (the default), and `2` and `3`
   * are the columns the screen marks **lesser**. The table measures its box and takes lesser columns away, `3` before `2` and the later column before the earlier among equals, **only as many
   * as it takes for the box not to scroll sideways**, and brings them back when the box widens; a column that goes leaves the page and the accessibility tree, and its facts are in the panel
   * and the record (a card, under 40rem, shows them all). The screen chooses which columns may go: the table cannot know. The row-header column and the box are always drawn. **Only a table whose rows
   * open something has lesser columns** (`onOpen` or `opens`): a column it took away would leave a fact nowhere, so a list whose rows open nothing marks none, and is cards where its columns cannot fit.
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

/**
 * What a page may ask of a table without reaching into its markup (the review of 5edada2, M4): where focus goes. A page that keeps the place the person left, or that moves them to the results
 * after a change of page, asks the table; it never looks for a class of the kit, for the kit changes its markup and the page would then fail without a word.
 */
export interface DataTableHandle {
  /**
   * Puts focus on the control of a row as it is drawn now (the button that opens it, else its box, else the link of its code, else its act: the table is a table or cards, whichever it is now), and brings it into view by
   * the least scroll, under the top bar and not behind it. `false` when the row is not drawn or has nothing that can take focus. The id is matched without regard to case.
   */
  readonly focusRow: (id: string) => boolean;
  /** Puts focus on the box the rows are in (the results as a whole), without moving the page: where focus goes when the row it was on is not there. */
  readonly focusResults: () => void;
}

export interface DataTableProps<Item> {
  /** Gives the page the handle above. */
  readonly ref?: Ref<DataTableHandle>;
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

  /** Opens the record: the button of the row-header cell, which is stretched over the whole row, and Enter on it. It makes the rows a list that opens a panel, whose lesser columns may go. */
  readonly onOpen?: (item: Item) => void;
  /**
   * What a row opens, for a table whose rows open something with no button of the table's (`onOpen` implies `panel`): `record` is a page of its own, whose link is the first line of the row header
   * (`RowTitle to`). A table that opens neither has rows that open nothing; it never takes a column away (its facts would be on no screen) and is drawn as cards where its columns cannot fit.
   */
  readonly opens?: 'panel' | 'record';
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

  /** The usual next act of a row, drawn at rest on every row that has one and on every device (the Product Owner, 10 November 2026). */
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
   * table draws the card's one hit target (the button that opens, which is its title, stretched over the card), its box and its act. Under 40rem of the table's own width the rows are drawn
   * as these cards in place of the table (a 390px phone), and the keys, the box, the open button and the row act work as they do in the table. So are the rows of **every** list wherever its columns
   * cannot fit once every lesser column is gone (a table never breaks a word: where it runs out of room it is cards), and they stay cards until the box grows wider than it was when the list went to
   * cards. Without it the table stays a table at every width, and when nothing more can go its words break anywhere before it scrolls sideways.
   */
  readonly card?: (item: Item) => ReactNode;
  /**
   * The heading of a card: the record's code, for **heading navigation** (a person who moves between headings reaches each card). For a table that opens its rows it is also the one button of the
   * card, named for the record (`openLabel`) and stretched over the whole card by a pseudo-element, so that the press target is the card; **the facts are outside the button, read in order after
   * it** (a button's content is presentational to assistive technology, so the facts inside it were never read, and a button may hold phrasing content only). A table that opens its rows needs it.
   */
  readonly cardTitle?: (item: Item) => ReactNode;
  /** The level of a card's heading, so that the page's outline stays in order: 2 (the default) where the cards are under the page's title, 3 under a panel's heading. */
  readonly cardHeadingLevel?: 2 | 3 | 4;
  /**
   * `auto` (the default): **a table from 40rem of its own box up, cards under it** (a 390px phone), and in a table the lesser columns (`priority`) go as far as it takes for it not to scroll sideways;
   * a list whose rows open nothing is cards instead of losing a column, and so is any list whose lesser columns are all gone and whose box still scrolls. `table` and `cards` fix it, for a screen that knows better and for a test. Without `card` there are no cards: the table stays
   * a table at every width, and takes its lesser columns away.
   */
  readonly layout?: 'auto' | 'table' | 'cards';

  /** Rows that changed since the last read: each is highlighted and the highlight fades over `motion.highlight`. A cue for the eye only: say it in words where it matters. */
  readonly changedIds?: readonly string[];

  readonly sort?: DataSort;
  /** The person asked to order by a column. The page asks the server and passes the new order. */
  readonly onSortChange?: (columnId: string) => void;

  /** `ready` (the default), `loading` (skeleton rows in the table's shape) or `error`. */
  readonly status?: 'ready' | 'loading' | 'error';
  /**
   * The rows are being read again and **stay as they are** (after an act, when the person must keep their place, their focus and the row that changed): the table says it is busy to assistive
   * technology and draws nothing else, no skeleton and no loading line. A read that must not be taken for an answer is `status: 'loading'`.
   */
  readonly busy?: boolean;
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

type RowTitleProps = (
  | {
      /** The record's code, whole, in the monospaced face. */
      readonly code: string;
      readonly title?: never;
    }
  | {
      /** A record that is named by a person's name and not by a code (a staff profile, a rider, a vendor's account): its name, in the face of the text, whole. */
      readonly title: string;
      readonly code?: never;
    }
) & {
  /** Under the first line, one quiet line: the name of a code's record, or the work email or the phone of a person. Without it the row is a single line. */
  readonly name?: string;
  /**
   * The record's own page: the first line is then a link to it. For a table whose rows open a page of their own and not a panel, and so have no button that opens them (the approver's queue,
   * the staff list): the link is a real one, which a keyboard, a middle click and a new tab all use.
   */
  readonly to?: string;
};

/**
 * The row-header cell of a queue: the record's code in the monospaced face, or its name (`title`) in the face of the text, over one quiet line (`name`). Two lines are a `two-line` density. A
 * person is named by a name and a code by its code, so no page builds a title of its own (three did, the review of f6cf02b).
 */
export function RowTitle({ code, title, name, to }: RowTitleProps) {
  const first =
    code === undefined ? (
      <span className="ui-data-table__heading">{title}</span>
    ) : (
      <OperationalCode>{code}</OperationalCode>
    );
  return (
    <span className="ui-data-table__title">
      {to === undefined ? first : <Link to={to}>{first}</Link>}
      {name === undefined ? null : <span className="ui-data-table__name">{name}</span>}
    </span>
  );
}

/**
 * Two facts that belong together in one cell, each on its own line: the first as it is, the second quieter beneath it (an address over its hub, a person over a time). Both wrap at their words;
 * `oneLine` keeps the first to a line, as a count must be (see `NoWrap`).
 */
export function CellLines({
  first,
  second,
  oneLine = false,
}: {
  readonly first: ReactNode;
  readonly second: ReactNode;
  readonly oneLine?: boolean;
}) {
  return (
    <span className="ui-data-table__lines">
      <span>{oneLine ? <NoWrap>{first}</NoWrap> : first}</span>
      <span className="ui-data-table__support">{second}</span>
    </span>
  );
}

/**
 * What a cell keeps to one line: a code, a date, a count. A table's cells wrap at their words (the row grows to hold them), so a screen marks the words that must never be broken in the
 * middle, and the kit gives it the mark, so that no page keeps a class of its own for it.
 */
export function NoWrap({ children }: { readonly children: ReactNode }) {
  return <span className="ui-data-table__nowrap">{children}</span>;
}

/** Under this width of the table's own box, in rem (so that enlarged text turns the table into cards sooner), the rows are drawn as cards: a table is a table from 40rem up. */
export const CARDS_BELOW_REM = 40;

/** Whether a table whose box is `widthRem` wide is drawn as cards: under `CARDS_BELOW_REM`, and at every width above it a table, whose lesser columns go before it would scroll sideways. */
export function drawsCards(widthRem: number): boolean {
  return widthRem < CARDS_BELOW_REM;
}

/**
 * Work that an observer asks for and that waits for the next animation frame: asked as often as the observers please and done once, and not at all once cancelled. **A table's layout is never
 * changed inside the callback of a ResizeObserver, nor in the middle of the delivery of the callbacks** (the Product Owner's review of ba9a18c): a layout changed there is a size the
 * observers are told of again in the frame that is delivering them, and WebKit reports it as "ResizeObserver loop completed with undelivered notifications" (the red `kit.spec.ts` of the main
 * branch's first run on Linux). The work of a frame runs before the page is laid out and before the observers are told, and is flushed there (`flushSync`, by the work), so that what the
 * observers are told of next is the final layout and not a step towards it. The frame the observer was told in is drawn as it was: one frame of the earlier layout, in a live resize or a
 * face's swap, is the price; the first measure of a table is a layout effect, which React finishes before the first paint, and waits for no frame.
 */
function nextFrame(work: () => void): { readonly ask: () => void; readonly cancel: () => void } {
  let handle: number | null = null;
  return {
    ask: () => {
      if (handle !== null) return;
      handle = requestAnimationFrame(() => {
        handle = null;
        work();
      });
    },
    cancel: () => {
      if (handle !== null) cancelAnimationFrame(handle);
      handle = null;
    },
  };
}

/**
 * Whether the table's box is narrow enough for cards: measured as the box changes, and left as it was where nothing can be measured (no layout, a hidden box). The first measure is a layout
 * effect, which React finishes before the first paint, so that a table in a narrow box is never drawn as a table first; **a change the observer reports is made in the next animation frame**
 * (`nextFrame`), in one flush, and not inside the observer's callback.
 */
function useNarrow(
  root: RefObject<HTMLDivElement | null>,
  probe: RefObject<HTMLDivElement | null>,
  layout: 'auto' | 'table' | 'cards',
) {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    const watched = probe.current;
    if (
      layout !== 'auto' ||
      element === null ||
      watched === null ||
      typeof ResizeObserver === 'undefined'
    )
      return;
    /** What the box was last found to be, so that a frame that finds it as it was changes nothing. */
    let known: boolean | undefined;
    const measure = (flush: boolean): void => {
      const width = element.clientWidth;
      if (width === 0) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const next = drawsCards(width / rem);
      if (next === known) return;
      known = next;
      if (flush) {
        flushSync(() => {
          setNarrow(next);
        });
      } else {
        setNarrow(next);
      }
    };
    measure(false);
    const frame = nextFrame(() => {
      measure(true);
    });
    // The probe is watched and not the box: it has the width of the box and no height, so the rows becoming cards, which changes the height of the box, is no change of what is watched.
    const observer = new ResizeObserver(frame.ask);
    observer.observe(watched);
    return () => {
      observer.disconnect();
      frame.cancel();
    };
  }, [root, probe, layout]);
  return layout === 'cards' ? true : layout === 'table' ? false : narrow;
}

/**
 * The columns the screen marked lesser, in the order they go: the most lesser first (`3` before `2`), the later column before the earlier among equals. The row-header column is never one of them.
 */
export function dropOrderOf<Item>(columns: readonly DataColumn<Item>[]): readonly string[] {
  return columns
    .map((column, index) => ({ column, index }))
    .filter(({ column }) => (column.priority ?? 1) > 1 && column.rowHeader !== true)
    .sort(
      (first, second) =>
        (second.column.priority ?? 1) - (first.column.priority ?? 1) || second.index - first.index,
    )
    .map(({ column }) => column.id);
}

/** What the fit decided: the lesser columns that went, whether nothing more could go while the box still scrolled sideways, and whether that made the list cards. */
interface ColumnFit {
  readonly dropped: ReadonlySet<string>;
  /** Every lesser column is gone (there may have been none) and the box still scrolls sideways. */
  readonly full: boolean;
  /** The fit is full and the list has a card: it is cards, and **stays cards** (`useColumnFit`) until its box reaches the width the table needed, or its columns change. */
  readonly cards: boolean;
}

/** What is remembered of the moment a list went to cards (`useColumnFit`). */
interface WentToCards {
  /** The width the table needed then: the scroll width of its box with every lesser column gone, which is more than the box held. The table is drawn again when the box reaches it. */
  readonly need: number;
  /** The faces were in when it was decided. A decision made while they were loading was made in the fallback face and is measured again when they are in; only one made with them in is kept. */
  readonly facesIn: boolean;
}

/** Whether the page's faces are in. A page environment without layout (a test's) has no set of faces to wait for. */
function facesAreIn(): boolean {
  const page: { readonly fonts?: FontFaceSet } = document;
  return page.fonts?.status !== 'loading';
}

/** What the fit is told of the table: where its box and its probe are, whether there is anything to measure, the columns that may go in their order, and what the list is made of. */
interface ColumnFitInput {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly probe: RefObject<HTMLDivElement | null>;
  readonly measuring: boolean;
  readonly order: readonly string[];
  /** The columns and their weights: when they change, the fit begins again and the list is a table again. */
  readonly columnsKey: string;
  /** The ids of the rows, in order. */
  readonly rowsKey: string;
  /** The list has a card and may be drawn as cards (`layout="auto"`): a full fit then makes it cards. */
  readonly cardable: boolean;
}

/**
 * **No table scrolls sideways, and none breaks a word** (the Product Owner, 10 and 11 November 2026): the lesser columns that go, as the table's box is measured. A table drawn as a table whose box
 * scrolls sideways takes the next of its lesser columns away (`dropOrderOf`) and measures again, until it does not or none is left (then it is `full`: **a list that has a card is cards**, every list
 * alike, and a table that has no card gives up the room its prose columns keep and lets words break anywhere). It begins again from every column whenever the width of its box changes (a column that now
 * fits comes back), the faces finish loading (the first measure is made in the fallback face, `font-display: swap`) or its rows change (`rowsKey`), so that the lesser columns are never fewer than the room needs;
 * and it measures again, **adding drops and never giving one back**, whenever the table element itself changes its width (what is in it grew: a cell that got its words, a face that was wider than the
 * first). The measure is a layout effect, so what is drawn first is what fits and no frame shows the scroll. Where nothing can be measured (no layout, a hidden box) every column is drawn. The width is
 * read from a probe of no height, so that the columns going, which shortens the rows, is not a change of what is observed. **The start again is made in the next animation frame and not inside
 * the callback of an observer or the signal of the faces** (`nextFrame`): it is one flush there, measure included, so that the layout the observers are told of next is the final one.
 *
 * **The switch to cards is sticky** (the Product Owner's review of 67bc979): drawing the table again to measure it unmounts every card, so that focus on a card's control falls to the body and a dialog
 * opened from it loses its way back. What is remembered is **the width the table needed** when the list went to cards (its box's scroll width, with every lesser column gone), and not the box's
 * width: a box that grew by a scrollbar that went (a revoke leaves the page shorter, and on Windows a scrollbar takes 17px) is no reason to draw the table, which still needs more, and every card,
 * again (the review of ba9a18c). The table is drawn again only when the box reaches that width, or when the columns change. A change of rows, another face and a narrower box keep the cards.
 *
 * **The first decision waits for the faces** (the Product Owner's answer to the note of 7325628): the first measure is made in the fallback face (`font-display: swap`), and a decision to go to cards
 * made then is provisional. While `document.fonts.status` is "loading" the fit may draw cards, but the decision is not kept: when the faces are in (`loadingdone`, or `ready`, which the fit waits for)
 * it begins again from every column and measures once more in the real face, and only a decision made with them in is sticky. So the page reaches the same result whenever the face arrives.
 */
function useColumnFit({
  scroller,
  probe,
  measuring,
  order,
  columnsKey,
  rowsKey,
  cardable,
}: ColumnFitInput): ColumnFit {
  const [dropped, setDropped] = useState(0);
  const [full, setFull] = useState(false);
  /** What the list needed when it went to cards, or `null` while it is a table. */
  const [cardsFrom, setCardsFrom] = useState<WentToCards | null>(null);
  /** Counts the times the measure is to be made again: when the width of the box changed (even when every column was drawn already and nothing else changes), the faces loaded or the table grew. */
  const [epoch, setEpoch] = useState(0);
  const [seenColumns, setSeenColumns] = useState(columnsKey);
  const [seenRows, setSeenRows] = useState(rowsKey);
  if (seenColumns !== columnsKey) {
    setSeenColumns(columnsKey);
    setSeenRows(rowsKey);
    setDropped(0);
    setFull(false);
    setCardsFrom(null);
  } else if (seenRows !== rowsKey) {
    setSeenRows(rowsKey);
    // Cards stay as they are: another set of rows is no reason to unmount the card that has focus.
    if (cardsFrom === null) {
      setDropped(0);
      setFull(false);
    }
  }
  /** What the observers of the box read, which is not state of theirs. */
  const cardsFromNow = useRef(cardsFrom);
  useLayoutEffect(() => {
    cardsFromNow.current = cardsFrom;
  }, [cardsFrom]);
  /** Cards are drawn, so there is no table to measure. */
  const active = measuring && cardsFrom === null;
  const count = Math.min(dropped, order.length);
  useLayoutEffect(() => {
    const measure = (): void => {
      const box = scroller.current;
      if (!active || box === null || box.clientWidth === 0) return;
      if (box.scrollWidth <= box.clientWidth + 1) return;
      if (count < order.length) {
        setDropped(count + 1);
        return;
      }
      if (!full) setFull(true);
      // The layout is read before the faces are asked about: a face the layout asked for is loading by now.
      if (cardable) setCardsFrom({ need: box.scrollWidth, facesIn: facesAreIn() });
    };
    measure();
  }, [scroller, probe, active, cardable, count, order.length, full, columnsKey, rowsKey, epoch]);
  useLayoutEffect(() => {
    const element = probe.current;
    // The start again from every column: the box changed its width, or the faces finished loading. It is made in the next animation frame, in one flush, and never inside the callback of the
    // observer or the signal of the faces (`nextFrame`). A list that went to cards, with the faces in, stays cards unless its box has reached the width the table needed (the fit takes a pixel of
    // scroll for a fit), as the box is when the frame comes; one that went to cards while they were loading is measured again.
    const restart = nextFrame(() => {
      const remembered = cardsFromNow.current;
      if (
        remembered !== null &&
        remembered.facesIn &&
        (element?.clientWidth ?? 0) + 1 < remembered.need
      ) {
        return;
      }
      flushSync(() => {
        setDropped(0);
        setFull(false);
        setCardsFrom(null);
        setEpoch((value) => value + 1);
      });
    });
    // A page environment without layout (a test's) has no set of faces to watch.
    const page: { readonly fonts?: FontFaceSet } = document;
    const fonts = page.fonts;
    fonts?.addEventListener('loadingdone', restart.ask);
    // The faces that are still on their way when the table is drawn: `ready` is told when they are in, which WebKit does for a face its layout asked for where it sends no `loadingdone` (found by the
    // targeted run of 11 November 2026). The two are the same moment in an engine that sends both, and the second restart is a measure that changes nothing.
    let gone = false;
    if (fonts?.status === 'loading') {
      void fonts.ready.then(() => {
        if (!gone) restart.ask();
      });
    }
    let observer: ResizeObserver | undefined;
    if (element !== null && typeof ResizeObserver !== 'undefined') {
      let width = element.clientWidth;
      observer = new ResizeObserver(() => {
        if (element.clientWidth === width) return;
        width = element.clientWidth;
        restart.ask();
      });
      observer.observe(element);
    }
    return () => {
      gone = true;
      restart.cancel();
      fonts?.removeEventListener('loadingdone', restart.ask);
      observer?.disconnect();
    };
  }, [probe]);
  // The table element itself, watched while it is drawn: it grows wider than its box when what is in it grows, and then only drops are added.
  useLayoutEffect(() => {
    const table = scroller.current?.querySelector('table');
    if (!active || table === null || table === undefined || typeof ResizeObserver === 'undefined')
      return;
    // Not flushed in the callback: the table is the element watched, and a drop that shrinks it inside its own callback is a change the observer would be told of at once. The measure is made when
    // React next renders, a frame later, which is for what is in the table having grown and not for the window changing.
    const observer = new ResizeObserver(() => {
      setEpoch((value) => value + 1);
    });
    observer.observe(table);
    return () => {
      observer.disconnect();
    };
  }, [scroller, active, full]);
  const set = useMemo(() => new Set(order.slice(0, count)), [order, count]);
  return { dropped: set, full, cards: cardsFrom !== null };
}

/** The mistakes of a page that production has already told once, so that a table drawn again says nothing more. */
const told = new Set<string>();

/**
 * A page's mistake in what it asks of the table, where the table can still do something sound without it (no title for a card; a priority on a column that cannot go). It is **thrown in development
 * and in tests**, where it is found, and **logged in production**, where a page whose props vary at run time (a column that is lesser for some rows' kinds, a card given later) must never go blank.
 */
function misuse(message: string): void {
  if (!import.meta.env.PROD) throw new Error(message);
  if (told.has(message)) return;
  told.add(message);
  console.error(message);
}

/** A control that can take focus now: not a disabled button, not one marked unavailable. */
const isEnabled = (node: HTMLElement): boolean =>
  !(node instanceof HTMLButtonElement && node.disabled) &&
  node.getAttribute('aria-disabled') !== 'true';

/**
 * The queue's table (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *DataTable*): TanStack Table's model (columns, row model, selection) over the
 * table primitive. Rows are 36px, 52px with a code over a name, or 56px on a tablet. The whole row opens its record through a real button in the code cell,
 * stretched over the row; rows can be chosen, a bar above the rows (which stays in view as they scroll) holds the acts on them, and the usual next act of a row is drawn
 * at rest. It draws what it is given, in the order it is given, and **never a total it was not given**; it sorts, filters and pages nothing, and
 * decides nothing about what may be chosen or done.
 *
 * The keys: Tab enters the table at one row and leaves it in a few stops (only the current row's controls are in the order), the up and down arrows, Home and End
 * move between the rows that have a control (a row with nothing to focus is passed over), Enter opens the record and **Space chooses the row** (it does not open
 * it). The arrows belong to a control that uses them (a field, a menu, a combobox) and to a key that something has already handled. The states are the table's own:
 * loading (skeleton rows of its shape), empty and filtered to nothing (the page's EmptyState), an error with a way to try again, and stale rows with a way to read again;
 * each is told in a region that is in the page before it speaks. Narrow, the rows are cards (`card`), and the columns the screen marked lesser go (`priority`).
 */
export function DataTable<Item>({
  ref,
  label,
  columns,
  rows,
  rowId,
  density = 'single',
  onOpen,
  opens,
  openLabel,
  selection,
  rowAction,
  card,
  cardTitle,
  cardHeadingLevel = 2,
  layout = 'auto',
  changedIds,
  sort,
  onSortChange,
  status = 'ready',
  busy = false,
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
  const probe = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root, probe, layout);
  const narrowCards = card !== undefined && narrow;
  /** Only a table whose rows open something may take a column away: its facts are in the panel or the record. A list that opens nothing keeps every column, or is cards. */
  const canDrop = onOpen !== undefined || opens !== undefined;
  const order = canDrop ? dropOrderOf(columns) : [];
  const columnsKey = columns
    .map((column) => `${column.id}:${String(column.priority ?? 1)}`)
    .join(',');
  const fit = useColumnFit({
    scroller,
    probe,
    measuring: !narrowCards && status === 'ready' && rows.length > 0,
    order,
    columnsKey,
    rowsKey: rows.map(rowId).join('|'),
    cardable: card !== undefined && layout === 'auto',
  });
  /**
   * **A table never breaks a word: where it runs out of room it is cards** (the Product Owner, 11 November 2026). A list that has a card and whose columns cannot fit with every lesser column gone is
   * drawn as cards (every fact), never as a table with a fact missing or a word broken inside, whether its rows open something or not.
   */
  const cards = card !== undefined && (narrowCards || fit.cards);
  /** Nothing more can go, the box still scrolls and the list has no card to be: the table gives up the room its prose columns keep and lets words break anywhere, so that even a string with no break never scrolls the box. */
  const exhausted = fit.full && !cards;
  /** The columns drawn: every one but the lesser columns that the room has taken away. */
  const shown = columns.filter((column) => !fit.dropped.has(column.id));
  /** The controls of each row, found again when focus is to be put on one: the arrows land on its button that opens it, else its checkbox, else its action. */
  const controls = useRef(
    new Map<string, Partial<Record<'open' | 'box' | 'action', HTMLElement>>>(),
  );
  /**
   * The control of a row that can take focus now: its button that opens, else its box, else its act, skipping the ones that are disabled. `kinds` narrows the search to some of them, in that order.
   */
  const control = (
    id: string,
    kinds: readonly ('open' | 'box' | 'action')[] = ['open', 'box', 'action'],
  ): HTMLElement | undefined => {
    const own = controls.current.get(id);
    return kinds
      .map((kind) => own?.[kind])
      .find((node): node is HTMLElement => node !== undefined && isEnabled(node));
  };
  /** The link of a row as it is drawn now (a row of the table, or a card), for a row that has no control of the table's own. `wanted` is the row's id in lower case. */
  const linkOf = (wanted: string): HTMLElement | undefined => {
    const row = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-row-id]') ?? []).find(
      (candidate) => candidate.dataset.rowId?.toLowerCase() === wanted,
    );
    return row?.querySelector<HTMLElement>('a[href]') ?? undefined;
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

  useImperativeHandle(
    ref,
    () => ({
      focusRow: (id) => {
        const wanted = id.toLowerCase();
        const key = [...controls.current.keys()].find(
          (candidate) => candidate.toLowerCase() === wanted,
        );
        // A row whose code is a link to a page of its own (`RowTitle` with `to`) has no button that opens it: its link is what takes focus, before the row's act (the review of 499399c: the
        // officer who comes back from the request they opened is on its link, and not on Approve).
        const target =
          (key === undefined ? undefined : control(key, ['open', 'box'])) ??
          linkOf(wanted) ??
          (key === undefined ? undefined : control(key));
        if (target === undefined) return false;
        if (key !== undefined) setActiveId(key);
        target.focus({ preventScroll: true });
        // The least scroll that brings it into view; the page's scroll padding and the control's scroll margin keep it clear of the top bar and of the table's own header.
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return true;
      },
      focusResults: () => {
        scroller.current?.focus({ preventScroll: true });
      },
    }),
    // `control` reads the registry of controls, which is a ref and not state: the handle needs no new identity when the rows change.
    [],
  );

  const rowHeaderColumns = columns.filter((column) => column.rowHeader === true);
  if (rowHeaderColumns.length > 1) {
    throw new Error(`The table "${label}" has more than one row-header column.`);
  }
  if (onOpen !== undefined && (openLabel === undefined || rowHeaderColumns.length === 0)) {
    throw new Error(
      `The table "${label}" opens rows, so it needs a row-header column and a label for its button.`,
    );
  }
  if (card !== undefined && onOpen !== undefined && cardTitle === undefined) {
    misuse(
      `The table "${label}" opens rows as cards, so it needs a cardTitle: the card's title is its button that opens the record.`,
    );
  }
  if (!canDrop && columns.some((column) => (column.priority ?? 1) > 1)) {
    misuse(
      `The table "${label}" marks lesser columns but its rows open nothing, so no column may go: a fact it took away would be on no screen. Remove the priorities (it is cards where its columns cannot fit).`,
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
    shown.length + (selection === undefined ? 0 : 1) + (rowAction === undefined ? 0 : 1);

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
      {/* Of no height and the width of the box: what the table watches to start again from every column when its room changes (`useColumnFit`). */}
      <div ref={probe} className="ui-data-table__probe" aria-hidden="true" />
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
        aria-busy={busy ? true : undefined}
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
                    {cardTitle === undefined ? null : (
                      <CardHeading level={cardHeadingLevel}>
                        {opener(row, tab, cardTitle(row.original))}
                      </CardHeading>
                    )}
                    {card(row.original)}
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
            data-fit={exhausted ? 'exhausted' : undefined}
            data-rows={status !== 'ready' || tableRows.length === 0 ? 'none' : undefined}
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
                {shown.map((column) => {
                  const sorted = sort?.columnId === column.id ? sort.direction : undefined;
                  return (
                    <TableHead
                      key={column.id}
                      scope="col"
                      style={column.width === undefined ? undefined : { width: column.width }}
                      data-align={column.align === 'end' ? 'end' : undefined}
                      data-priority={priorityOf(column)}
                      data-kind={column.kind}
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
                      {row
                        .getVisibleCells()
                        .filter((cell) => !fit.dropped.has(cell.column.id))
                        .map((cell) => {
                          const column = columns.find(
                            (candidate) => candidate.id === cell.column.id,
                          );
                          const room =
                            exhausted || column === undefined ? undefined : minWidthOf(column);
                          const drawn = flexRender(cell.column.columnDef.cell, cell.getContext());
                          // The room the column keeps is a block inside the cell, so that the cell's least width is a width and not one letter.
                          const content =
                            room === undefined ? (
                              drawn
                            ) : (
                              <div className="ui-data-table__cell" style={{ minInlineSize: room }}>
                                {drawn}
                              </div>
                            );
                          if (column?.rowHeader === true) {
                            return (
                              <TableHead
                                key={cell.id}
                                scope="row"
                                className="ui-data-table__code"
                                data-align={column.align === 'end' ? 'end' : undefined}
                                data-kind={column.kind}
                              >
                                {opener(row, tab, content)}
                                {isChanged ? (
                                  <span
                                    id={`${hintId}-${id}-changed`}
                                    className="ui-visually-hidden"
                                  >
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
                              data-kind={column?.kind}
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

/** The heading of a card, at the level the page's outline asks for. */
function CardHeading({
  level,
  children,
}: {
  readonly level: 2 | 3 | 4;
  readonly children: ReactNode;
}) {
  const Heading = `h${String(level)}` as 'h2' | 'h3' | 'h4';
  return <Heading className="ui-data-table__card-title">{children}</Heading>;
}

/** The room a column keeps: the width it names, else `PROSE_MIN_WIDTH` for prose, else none (its content's own one line is its room). */
export function minWidthOf<Item>(column: DataColumn<Item>): string | undefined {
  return column.minWidth ?? (column.kind === 'prose' ? PROSE_MIN_WIDTH : undefined);
}

/** What a column says of its priority for the stylesheet: nothing for the one that is always drawn. */
function priorityOf<Item>(column: DataColumn<Item>): '2' | '3' | undefined {
  return column.priority === 2 ? '2' : column.priority === 3 ? '3' : undefined;
}

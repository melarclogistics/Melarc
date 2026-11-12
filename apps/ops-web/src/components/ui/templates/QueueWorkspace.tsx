import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ReactNode,
  type Ref,
} from 'react';

import { Button } from '../button/Button';
import { DataTable, type DataTableHandle, type DataTableProps } from '../data-table/DataTable';
import { EmptyStateV2 } from '../empty-state/EmptyStateV2';
import { FilterBar, type FilterBarProps } from '../filter-bar/FilterBar';
import { PageHeader, type PageHeaderProps } from '../page-header/PageHeader';
import { Panel } from '../panel/Panel';
import { SidePanel, type SidePanelProps } from '../side-panel/SidePanel';
import { ViewTabs, type ViewTabsProps } from '../view-tabs/ViewTabs';
import './queue-workspace.css';

/**
 * What the queue's read has come to. The page maps its query to one of these, and **the words of a failure are the page's own** (a refusal names the capability in plain words,
 * PRODUCT_DESIGN_DIRECTION section 6.5), never the API's diagnostic `message`, a permission key or a role.
 */
export type QueueResult<Item> =
  | { readonly status: 'loading' }
  | {
      readonly status: 'error';
      /** What went wrong, and what to do, in the page's words. */
      readonly message: string;
      readonly onRetry?: () => void;
      /** What the way out says. Default "Retry"; a failure that asking again would not mend names the way that does ("Back to first page"). */
      readonly retryLabel?: string;
    }
  | {
      readonly status: 'ready';
      /** The rows in the order the server gave them. An empty list is told as one of the three kinds of nothing (`empty`). */
      readonly rows: readonly Item[];
      /** The rows are the last that were read and a newer read failed or is overdue: the page's words, and the way to read again. The rows stay. */
      readonly stale?: { readonly message: string; readonly onRefresh?: () => void };
      /**
       * A newer read is under way **after an act** (a confirmation, a decision) and the rows stay where they are, with the person's place, their focus and the row that changed
       * (`table.changedIds`): the table says it is busy and draws no loading rows. A page that must not show rows as if they answered the read says `loading` instead (a page of
       * another filter, a refresh the person asked for).
       */
      readonly refreshing?: boolean;
    };

interface EmptinessBase {
  /** What the queue lists, in the plural: "pickup requests". It words the three kinds of nothing and the loading line. */
  readonly noun: string;
  /** What to say when there is nothing to list and nothing hides it ("Requests booked at your hubs appear here."): the line under "No pickup requests yet". */
  readonly none: string;
  /** Set when the empty answer appears because of something the person just did (a filter, a hub): it is announced. */
  readonly announce?: boolean;
  /**
   * The hub the switcher chose. **A chosen hub is a filter**: a queue with nothing at it says "Nothing at <hub>" and offers *Show all hubs*, and never "No requests yet" as if
   * nothing existed anywhere. The hub is the server's reading (`hub_id`) and the page's to pass; the template only words the state.
   */
  readonly hub?: { readonly name: string; readonly onShowAllHubs: () => void };
  /**
   * Set by a paged queue, with the page it shows (counted from 1) and the way back. A page after the first can hold nothing without the queue being empty (rows move between reads), so
   * it says **"No <noun> on this page"** with *Back to first page*, whatever the filters and the hub are, and never "No <noun> yet" as if nothing existed anywhere: every list says it
   * in the same words (the Product Owner, 10 November 2026). It does not go looking through the earlier pages on its own.
   */
  readonly laterPage?: { readonly page: number; readonly onFirstPage: () => void };
}

/** What an empty answer is, so that the template can tell nothing yet from nothing that fits. */
export type QueueEmptiness = EmptinessBase &
  (
    | { readonly filtered?: false }
    | {
        /** The page's own filters are set. */
        readonly filtered: true;
        /** Takes every filter off. Required: the one useful thing to do with a filter that hides everything. */
        readonly onClearFilters: () => void;
        /** What the button says, in the queue's own words ("Show every request"). */
        readonly clearLabel: string;
        /**
         * What the filters hide, in the queue's own words, under "No <noun> match" and beside the button ("Nothing fits these filters. Show every request to start again."): the template has no
         * words of its own for it, so that the sentence and the button say the same thing.
         */
        readonly filteredText: string;
      }
  );

/** What a page may ask of the queue without reaching into its markup: where focus goes. The table's own handle. */
export type QueueWorkspaceHandle = DataTableHandle;

/** The table's own configuration: everything of `DataTable` that the template does not decide (its states are `result`'s and `empty`'s). */
export type QueueTableConfig<Item> = Omit<
  DataTableProps<Item>,
  'rows' | 'status' | 'error' | 'emptyState' | 'stale' | 'loadingLabel'
>;

export interface QueueWorkspaceProps<Item> {
  /** Gives the page the focus handle: put focus on a row (the record the person came back from, the one an act changed) or on the results, whatever the table is drawn as now. */
  readonly ref?: Ref<QueueWorkspaceHandle>;
  /** The page's header: title, the count where the server states one, the freshness line, the breadcrumb and the page's actions (the one primary, in Ink). */
  readonly header: PageHeaderProps;
  /** Named views of the queue, each with the server's count where it states one. Without them the queue is one list. */
  readonly views?: Omit<ViewTabsProps, 'children'>;
  /** The filters: what is applied is a chip that can be taken off on its own, and the order the rows are in is told. Without it there is no filter row. */
  readonly filters?: FilterBarProps;
  /** A line or a banner between the filters and the table (a refinement the address asked for, a notice). */
  readonly notice?: ReactNode;
  readonly result: QueueResult<Item>;
  readonly empty: QueueEmptiness;
  /** A whole state of the page's own that replaces the kinds of nothing (the approver's queue worked down to nothing, told as the good news it is). */
  readonly emptyState?: ReactNode;
  readonly table: QueueTableConfig<Item>;
  /** The record that is open beside the queue. The queue, its filters, its scroll and its chosen rows stay as they were: the panel is drawn beside the table and not instead of it. */
  readonly panel?: SidePanelProps;
}

/** The nothing of an answer that has no rows, in one of its three kinds (COMPONENT_PATTERNS, *EmptyState v2*): the page's `emptyState` takes its place. */
function Emptiness({ empty }: { readonly empty: QueueEmptiness }) {
  const { noun, none, announce = false, hub, laterPage } = empty;
  if (laterPage !== undefined && laterPage.page > 1) {
    return (
      <EmptyStateV2
        variant="filtered-empty"
        title={`No ${noun} on this page`}
        headingLevel={3}
        announce
        action={
          <Button type="button" variant="secondary" onClick={laterPage.onFirstPage}>
            Back to first page
          </Button>
        }
      >
        {`Page ${String(laterPage.page)} has no ${noun} now. Earlier pages may still have some.`}
      </EmptyStateV2>
    );
  }
  const clear =
    empty.filtered === true ? (
      <Button type="button" variant="secondary" onClick={empty.onClearFilters}>
        {empty.clearLabel}
      </Button>
    ) : undefined;
  // The words name the buttons beside them: the way back to every hub and, when the page's own filters are set as well, the way to take the others off.
  if (hub !== undefined) {
    return (
      <EmptyStateV2
        variant="filtered-empty"
        title={`Nothing at ${hub.name}`}
        headingLevel={3}
        announce
        action={
          <>
            <Button type="button" variant="secondary" onClick={hub.onShowAllHubs}>
              Show all hubs
            </Button>
            {clear}
          </>
        }
      >
        {clear === undefined
          ? `No ${noun} at ${hub.name}. Show all hubs to see those of every hub your session reaches.`
          : `No ${noun} at ${hub.name} fit these filters. Show all hubs, or take the other filters off.`}
      </EmptyStateV2>
    );
  }
  if (empty.filtered === true) {
    return (
      <EmptyStateV2
        variant="filtered-empty"
        title={`No ${noun} match`}
        headingLevel={3}
        announce={announce}
        action={clear}
      >
        {empty.filteredText}
      </EmptyStateV2>
    );
  }
  return (
    <EmptyStateV2 variant="empty" title={`No ${noun} yet`} headingLevel={3} announce={announce}>
      {none}
    </EmptyStateV2>
  );
}

/**
 * The queue workspace template (PRODUCT_DESIGN_DIRECTION section 6.1; COMPONENT_PATTERNS, *QueueWorkspace*): work to be done or watched. It composes the kit into the one page
 * shape of a queue, in this order: the page header (title, the server's count, freshness, the page's actions), the views with their counts, the filter row with removable
 * chips, the table, and the record that is open in a panel beside it. **It owns the structure, the states and the behaviour of the shape, and never the data**: what a row is,
 * what a view counts, which acts are offered and what the server refused are the page's and the server's, and a figure that was not given is not drawn (never as 0).
 *
 * What it carries from the kit, so that a page does not wire it again: the fit of the columns (the table measures its own box, which narrows when the panel opens, and takes a column
 * the page marked lesser away only as far as it takes for the box not to scroll sideways, whatever is beside it, so the table never scrolls sideways at 1440px; its prose columns keep
 * their room and its words break at their spaces; the rows are cards under 40rem of the box, and wherever the table has nothing more to give: every lesser column gone and the box still overflowing), the bar of acts above the rows and its eligible-only acts, cards at 390px, the place the officer left and the row they
 * came from (`table.initialScroll`, `table.onScrollChange`, `table.focusRowId`), and the panel becoming a full-screen sheet at 768px and below. **Every state is told:** loading
 * (rows of the table's own shape), nothing yet, nothing that fits the filters, nothing at the chosen hub (with *Show all hubs*), a failure with a way to try again, and stale rows with
 * a way to read again.
 */
export function QueueWorkspace<Item>({
  ref,
  header,
  views,
  filters,
  notice,
  result,
  empty,
  emptyState,
  table,
  panel,
}: QueueWorkspaceProps<Item>) {
  const root = useRef<HTMLDivElement>(null);
  const tableHandle = useRef<DataTableHandle>(null);
  useImperativeHandle(
    ref,
    () => ({
      focusRow: (id) => tableHandle.current?.focusRow(id) ?? false,
      focusResults: () => {
        tableHandle.current?.focusResults();
      },
    }),
    [],
  );
  /** The record the panel was last opened from, and whether the row's own act (the queue's Confirm) opened it and not the button that opens the row: the control to give focus back to. */
  const openedFrom = useRef<{ readonly id: string; readonly byAct: boolean } | undefined>(
    undefined,
  );
  const { onOpen, rowId, rowAction } = table;
  /**
   * The control the panel was opened from, as it is drawn now (the table's row button, or the card's, whichever layout the table is in): the row's own act when that is what opened it and it is still
   * there, else the button that opens the row. A confirmation takes its own act away, and the way back is then the row.
   */
  const controlOf = useCallback(
    (
      from: { readonly id: string; readonly byAct: boolean } | undefined,
    ): HTMLElement | undefined => {
      if (from === undefined) return undefined;
      const row = Array.from(root.current?.querySelectorAll('[data-row-id]') ?? []).find(
        (candidate) => candidate.getAttribute('data-row-id') === from.id,
      );
      const act = from.byAct
        ? row?.querySelector<HTMLElement>('.ui-data-table__action:not(:disabled)')
        : null;
      return act ?? row?.querySelector<HTMLElement>('.ui-data-table__open') ?? undefined;
    },
    [],
  );

  // Opening the panel narrows the table's own box, and a table narrower than 40rem is drawn as cards: the row button the person pressed is then not the one that is there
  // when the panel closes, and closing the panel widens the box again and swaps it once more. So the way back to the row is the row's control **as it is drawn now**,
  // and, once the layout has settled, focus that the swap dropped is put back (never focus the person has moved to a control of their own).
  const open = panel?.open === true;
  const wasOpen = useRef(false);
  // The table decides what its room holds (`DataTable`: a table from 40rem up whose lesser columns go as far as it takes for it not to scroll sideways, and cards under 40rem): a panel docked
  // beside it narrows its box and the columns go by themselves; the page and this template ask nothing of it.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    let frames = 0;
    let frame = 0;
    const settle = (): void => {
      frames += 1;
      if (frames < 3) {
        frame = requestAnimationFrame(settle);
        return;
      }
      const active = document.activeElement;
      if (active === null || active === document.body) controlOf(openedFrom.current)?.focus();
    };
    frame = requestAnimationFrame(settle);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [open, controlOf]);

  const grid = (
    <DataTable<Item>
      {...table}
      ref={tableHandle}
      busy={result.status === 'ready' && result.refreshing === true}
      {...(onOpen === undefined
        ? {}
        : {
            onOpen: (item: Item) => {
              openedFrom.current = { id: rowId(item), byAct: false };
              onOpen(item);
            },
          })}
      // A row's own act that opens the panel (the queue's Confirm) is a way to open it as the row's button is: the way back is the row, and not the act, which the act itself may take away.
      {...(rowAction === undefined
        ? {}
        : {
            rowAction: {
              ...rowAction,
              onRun: (item: Item) => {
                openedFrom.current = { id: rowId(item), byAct: true };
                rowAction.onRun(item);
              },
            },
          })}
      rows={result.status === 'ready' ? result.rows : []}
      status={result.status === 'ready' ? 'ready' : result.status}
      loadingLabel={`Loading ${empty.noun}`}
      {...(result.status === 'error'
        ? {
            error: {
              message: result.message,
              ...(result.onRetry === undefined ? {} : { onRetry: result.onRetry }),
              ...(result.retryLabel === undefined ? {} : { retryLabel: result.retryLabel }),
            },
          }
        : {})}
      {...(result.status === 'ready' && result.stale !== undefined ? { stale: result.stale } : {})}
      emptyState={emptyState ?? <Emptiness empty={empty} />}
    />
  );
  // A queue with no views, no filters and no notice has nothing above its rows: they start at the top of the page card (queue-workspace.css), and not under an empty band.
  const bare = views === undefined && filters === undefined && notice === undefined;
  const body = (
    <div className="ui-queue-workspace__body" data-bare={bare ? 'true' : undefined}>
      {filters === undefined ? null : (
        <div className="ui-queue-workspace__filters">
          <FilterBar {...filters} />
        </div>
      )}
      {notice === undefined ? null : <div className="ui-queue-workspace__notice">{notice}</div>}
      {grid}
    </div>
  );
  return (
    <div ref={root} className="ui-queue-workspace">
      <PageHeader {...header} />
      <div
        className="ui-queue-workspace__split"
        data-panel={panel?.open === true ? 'open' : undefined}
      >
        <div className="ui-queue-workspace__main">
          <Panel variant="page" padding="none">
            {views === undefined ? body : <ViewTabs {...views}>{body}</ViewTabs>}
          </Panel>
        </div>
        {panel === undefined ? null : (
          <div className="ui-queue-workspace__aside">
            <SidePanel
              {...panel}
              returnFocusTo={panel.returnFocusTo ?? (() => controlOf(openedFrom.current) ?? null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

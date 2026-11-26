import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Field } from '../../../components/ui/field/Field';
import type { BreadcrumbEntry } from '../../../components/ui/page-header/PageHeader';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { Select } from '../../../components/ui/select/Select';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
  type QueueTableConfig,
  type QueueWorkspaceHandle,
} from '../../../components/ui/templates/QueueWorkspace';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import type { WorkListPageView } from '../../../platform/pickup-work/pickup-work-shape';
import type { WorkListParams } from '../../../platform/pickup-work/use-pickup-work-queries';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import '../pickup/pickup-pages.css';

/**
 * The page of every Ops work list of the door and the failure (S1.30: the failed pickups, the handshakes, the short counts and the collection disputes), which differ in what a row says and
 * which acts a row offers, and in nothing else: a list the server filters, in views that are the list's own `open` filter, scoped to the hub the switcher chose, paged by the server's
 * tokens and drawn by the queue workspace template. **The server filters**: the page asks, in the address and in the request, and draws what comes back whole, because the part of a page that
 * matched would pass for the whole. It states no count of its own: a view says what it is, and the server states no total.
 *
 * A row may open a record beside the list (`panel`), where an act is taken: when the act is done the panel closes, the page says what it came to, and the list is read again with its rows
 * kept, so that the officer keeps their place and sees the row change. A failed read of the list again leaves the rows under a line that says they may be out of date.
 */
export interface WorkView {
  readonly id: string;
  readonly label: string;
  /** What the list's `open` filter says for the view: `undefined` is all of the list. */
  readonly open: boolean | undefined;
  /** What an empty view says, under "No <things> yet" ("Nothing is waiting for Ops"). */
  readonly none: string;
  /** How many the server stated for the view, where it states one (a vendor's orders: the counts of the whole vendor). Left out, no count is drawn: a count that was not given is never drawn as 0. */
  readonly count?: number | null;
}

/** What a panel's body can ask of the page it is beside. */
export interface PanelTools {
  readonly close: () => void;
  /** An act was done: the panel closes, the page says what it came to, and the list is read again with its rows kept. */
  readonly acted: (notice: ReactNode) => void;
  /** The record changed under the officer: the list is read again, rows kept, and the panel stays to be worked again. */
  readonly reload: () => Promise<unknown>;
}

/** The record that is open beside the list. */
export interface WorkPanel {
  readonly code: string;
  readonly status?: ReactNode;
  readonly fullPage?: { readonly to: string };
  readonly body: ReactNode;
}

export interface WorkListProps<Item> {
  /** Names the list in the page's memory of its own state (the paging). */
  readonly name: string;
  /** The `operationId` of the list, so that a failure is worded for it. */
  readonly operation: string;
  readonly title: string;
  readonly description: string;
  /** The pages above this one (a list that belongs to a record: the vendor's orders). */
  readonly breadcrumb?: readonly BreadcrumbEntry[];
  /** Actions of the whole page, the one primary in Ink (a vendor's orders: *Make the next order*, *Close this vendor*). */
  readonly actions?: ReactNode;
  readonly viewsLabel: string;
  /** The first view is the one a visit starts at. */
  readonly views: readonly [WorkView, ...WorkView[]];
  readonly noun: { readonly plural: string; readonly one: string; readonly other: string };
  readonly tableLabel: string;
  /**
   * Whether the hub the switcher chose narrows the list (default: it does). A list whose operation has no hub filter says `false`: it is then asked for no hub, the hub does not start it again at the first page, and an
   * empty list is never said to be empty "at" the hub chosen, because that would say what the server did not do (the receiving queue lists the hubs of the grant, and each row names its hub).
   */
  readonly hubFilter?: boolean;
  /**
   * The lookup of the list: a search field that is always in the bar (a run's code, a vendor's name). The text is in the address as `q`, a new text starts the list again at the first page, and the list's own
   * hook is given it as `WorkListParams.q` once it is as long as the server takes. **The server finds; the page filters nothing.** Left out, the list has no lookup.
   */
  readonly lookup?: {
    /** What the field searches, which is also its name ("Search by run code or vendor name"). */
    readonly label: string;
    /** The shortest text the server takes: a shorter text is not applied, and the field keeps what was typed. */
    readonly minLength: number;
    readonly maxLength: number;
  };
  /**
   * One filter beside the view and the lookup, in the address under a name of its own and in the filter bar (a chip when it is applied, a choice in the popover of the *Filter* button): the count differences' kind,
   * SHORT or OVER (the contract's `variance`, D-D5). A value in the address that is none of the options is no filter. **The server filters** it too: the list's own hook sends it.
   */
  readonly choice?: {
    /** The parameter of the address. */
    readonly param: string;
    /** What the filter is called: the label of its field and the start of its chip ("Kind of difference: Over"). */
    readonly label: string;
    /** The option that takes the filter off. */
    readonly allLabel: string;
    readonly options: readonly { readonly id: string; readonly label: string }[];
  };
  /** A refusal of the list, in the words of the screen: what the account cannot do, or the hub it does not work in. */
  readonly refusal: (problem: Problem) => string;
  readonly useList: (params: WorkListParams) => UseQueryResult<WorkListPageView<Item>>;
  readonly rowId: (item: Item) => string;
  readonly table: Omit<QueueTableConfig<Item>, 'label' | 'rowId' | 'footer' | 'onOpen'>;
  /** What the page says of itself, always, above the list: what it does not do, and where the rest is. */
  readonly note?: ReactNode;
  /** The record beside the list for an open row, with the acts the session can take on it. A row that has none opens nothing. */
  readonly panel?: (item: Item, tools: PanelTools) => WorkPanel;
}

/** Whether the server refused the parameter the list sent with this name, as the real API names it (`/page_token`). */
const refusedParameter = (error: unknown, name: string): boolean =>
  error instanceof OperationFailure &&
  error.violations.some(
    (violation) =>
      violation.in === 'query' && (violation.pointer === `/${name}` || violation.pointer === name),
  );

export function WorkList<Item>({
  name,
  operation,
  title,
  description,
  breadcrumb,
  actions,
  viewsLabel,
  views,
  noun,
  tableLabel,
  refusal,
  hubFilter = true,
  lookup,
  choice,
  useList,
  rowId,
  table,
  note,
  panel,
}: WorkListProps<Item>) {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const [first] = views;
  const current = views.find((view) => view.id === params.get('view')) ?? first;
  // The lookup the address holds, if the list has one and the text is long enough for the server to take: a shorter text in the address is no search.
  const typed = lookup === undefined ? '' : (params.get('q') ?? '').trim();
  const q = lookup !== undefined && typed.length >= lookup.minLength ? typed : '';
  // The page's one extra filter, as the address holds it: only one of its options is a filter.
  const picked =
    choice === undefined
      ? undefined
      : choice.options.find((option) => option.id === params.get(choice.param));
  const [filterOpen, setFilterOpen] = useState(false);
  // The hub the switcher chose (task C3) is a filter of the list like the view: another hub or another view starts again at the first page.
  const chosenHub = useActiveHub();
  const hubId = hubFilter ? chosenHub : undefined;
  const { hub: chosen, showAllHubs } = useHubScope();
  const hub = hubFilter ? chosen : undefined;
  const signature = `${name}|${current.id}|${hubId ?? ''}|${q}|${picked?.id ?? ''}`;
  const paging = useQueuePaging(signature);
  const list = useList({
    ...(current.open === undefined ? {} : { open: current.open }),
    view: current.id,
    ...(q === '' ? {} : { q }),
    ...(picked === undefined ? {} : { choice: picked.id }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const refreshSummary = useRefreshQueueSummary();
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const pageKey = `${signature}|${paging.pageToken ?? ''}`;

  // The record that is open, for the page it was opened on: a row that is open belongs to one page of one view, and is not open on another.
  const [selection, setSelection] = useState<
    { readonly id: string; readonly key: string } | undefined
  >(undefined);
  const [notice, setNotice] = useState<ReactNode>(undefined);
  /** The list is read again after an act, and its rows stay while it is. */
  const [afterAct, setAfterAct] = useState(false);
  /** The page whose reading again after an act failed: its rows stay, under a line that says they may be out of date. */
  const [staleAfterAct, setStaleAfterAct] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);

  const settled = !list.isFetching && (list.isSuccess || list.isError);
  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been read,
  // whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  if (me === undefined) return null;

  const rows = list.data?.items ?? [];
  const selectedId = selection?.key === pageKey ? selection.id : undefined;
  const selected =
    selectedId === undefined ? undefined : rows.find((row) => rowId(row) === selectedId);

  /** The list is read again, its rows kept; if that read fails the rows stay with a line that says they may be out of date and the way to read them again. */
  function refresh(): Promise<unknown> {
    setStaleAfterAct(undefined);
    setAfterAct(true);
    void refreshSummary();
    return list
      .refetch()
      .then((read) => {
        if (read.isError) setStaleAfterAct(pageKey);
      })
      .finally(() => {
        setAfterAct(false);
      });
  }

  function firstPage(): void {
    paging.toFirstPage();
  }

  function changeView(id: string): void {
    setNotice(undefined);
    const next = new URLSearchParams();
    if (id !== first.id) next.set('view', id);
    // The search and the kind are filters like the view: another view keeps them.
    if (q !== '') next.set('q', q);
    if (choice !== undefined && picked !== undefined) next.set(choice.param, picked.id);
    setParams(next, { replace: true });
  }

  /** Applies the page's one extra filter (a choice in the popover, or its chip taken off): the others in the address stay, and the list starts again at its first page. */
  function applyChoice(id: string): void {
    if (choice === undefined) return;
    setNotice(undefined);
    const next = new URLSearchParams(params);
    if (id === '') next.delete(choice.param);
    else next.set(choice.param, id);
    setParams(next, { replace: true });
  }

  /** Applies what was typed in the lookup (Enter, or the button): empty takes the search off, and a text shorter than the server takes is not applied. */
  function applyLookup(text: string): void {
    if (lookup === undefined) return;
    if (text !== '' && text.length < lookup.minLength) return;
    setNotice(undefined);
    const next = new URLSearchParams(params);
    if (text === '') next.delete('q');
    else next.set('q', text);
    setParams(next, { replace: true });
  }

  const cursorRefused = refusedParameter(list.error, 'page_token');

  const result: QueueResult<Item> = (() => {
    if (list.status === 'pending') return { status: 'loading' };
    if (list.isFetching && list.status === 'success') {
      // After an act the rows stay while the list is read again; any other read again takes the loading rows' place.
      return afterAct ? { status: 'ready', rows, refreshing: true } : { status: 'loading' };
    }
    // Read again after an act and failed (or being read once more): the rows the officer was working on stay, under the line that says so.
    if (
      list.status === 'error' &&
      list.data !== undefined &&
      (afterAct || staleAfterAct === pageKey)
    ) {
      return {
        status: 'ready',
        rows,
        refreshing: afterAct,
        stale: {
          message: `The ${noun.plural} could not be read again, so these rows may be out of date.`,
          onRefresh: () => {
            void refresh();
          },
        },
      };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, {
        operation,
        ...(cursorRefused ? { context: 'cursor' } : {}),
      });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale')
        return { status: 'loading' };
      const message =
        problem.kind === 'forbidden'
          ? refusal(problem)
          : problem.reference === undefined
            ? problem.message
            : `${problem.message} Reference: ${problem.reference}`;
      if (cursorRefused) {
        return { status: 'error', message, onRetry: firstPage, retryLabel: 'Back to first page' };
      }
      const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
      return {
        status: 'error',
        message,
        ...(retryable
          ? {
              onRetry: () => {
                void list.refetch();
              },
            }
          : {}),
      };
    }
    return { status: 'ready', rows };
  })();

  // A search that finds nothing is a filter that hides everything: it says so, with the way to take it off, and never "No runs yet" as if nothing existed.
  const searched =
    q === ''
      ? {}
      : {
          filtered: true as const,
          onClearFilters: () => {
            applyLookup('');
          },
          clearLabel: 'Clear the search',
          filteredText: `Nothing matches “${q}”. Clear the search to see every ${noun.one} again.`,
        };
  const empty: QueueEmptiness = {
    noun: noun.plural,
    none: current.none,
    ...searched,
    // A page after the first can hold nothing without the list being empty (the rows move between reads): the template says so, as every list does.
    laterPage: { page: paging.page, onFirstPage: firstPage },
    // A chosen hub is a filter too: the list is empty at this hub, which says nothing of the others.
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };

  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;
  const tools: PanelTools = {
    close: () => {
      setSelection(undefined);
    },
    acted: (text) => {
      setSelection(undefined);
      setNotice(text);
      void refresh();
    },
    reload: () => refresh(),
  };
  const open = panel === undefined || selected === undefined ? undefined : panel(selected, tools);

  const banner =
    notice === undefined && note === undefined ? undefined : (
      <>
        {notice === undefined ? null : (
          <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
            <Alert variant="success">{notice}</Alert>
          </div>
        )}
        {note === undefined ? null : typeof note === 'string' ? (
          <p className="pickup-form-note">{note}</p>
        ) : (
          // A note that is more than text (the orders page's summary has paragraphs and a list of facts) is a block: a paragraph cannot hold one, and React says so in development.
          <div className="pickup-form-note">{note}</div>
        )}
      </>
    );

  return (
    <>
      <title>{`${title} · Melarc Ops Portal`}</title>
      <QueueWorkspace<Item>
        ref={workspace}
        header={{
          title,
          description,
          ...(breadcrumb === undefined ? {} : { breadcrumb }),
          ...(actions === undefined ? {} : { actions }),
          freshness: {
            state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: () => {
              void refresh();
            },
          },
        }}
        views={{
          label: viewsLabel,
          value: current.id,
          onValueChange: changeView,
          tabs: views.map((view) => ({
            id: view.id,
            label: view.label,
            ...(view.count === undefined || view.count === null ? {} : { count: view.count }),
          })),
        }}
        {...(lookup === undefined && choice === undefined
          ? {}
          : {
              filters: {
                label: lookup === undefined ? `Filter the ${noun.plural}` : 'Search',
                ...(lookup === undefined
                  ? {}
                  : {
                      search: {
                        label: lookup.label,
                        value: q,
                        onSearch: applyLookup,
                        maxLength: lookup.maxLength,
                      },
                    }),
                chips: [
                  ...(q === '' ? [] : [{ id: 'q', label: `Search: ${q}` }]),
                  ...(choice === undefined || picked === undefined
                    ? []
                    : [{ id: 'choice', label: `${choice.label}: ${picked.label}` }]),
                ],
                onRemove: (chip: string) => {
                  if (chip === 'choice') applyChoice('');
                  else applyLookup('');
                },
                ...(choice === undefined
                  ? {}
                  : {
                      filterOpen,
                      onFilterOpenChange: setFilterOpen,
                      filterPanel: (
                        <Field label={choice.label}>
                          <Select
                            value={picked?.id ?? ''}
                            onChange={(event) => {
                              applyChoice(event.target.value);
                              setFilterOpen(false);
                            }}
                          >
                            <option value="">{choice.allLabel}</option>
                            {choice.options.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                      ),
                    }),
              },
            })}
        {...(banner === undefined ? {} : { notice: banner })}
        result={result}
        empty={empty}
        table={{
          ...table,
          label: tableLabel,
          rowId,
          ...(panel === undefined
            ? {}
            : {
                onOpen: (item: Item) => {
                  setNotice(undefined);
                  setSelection({ id: rowId(item), key: pageKey });
                },
              }),
          // The pager is in the page whatever the table is doing, so that its status region is the same one while a page is read.
          footer: (
            <QueuePager
              label={`Pages of ${noun.plural}`}
              noun={{ one: noun.one, other: noun.other }}
              shown={result.status === 'ready' && list.data !== undefined ? rows.length : undefined}
              page={paging.page}
              hasNext={list.data !== undefined && list.data.nextPageToken !== null}
              onNext={() => {
                if (list.data !== undefined && list.data.nextPageToken !== null) {
                  paging.toNextPage(list.data.nextPageToken);
                }
              }}
              onPrevious={paging.toPreviousPage}
            />
          ),
        }}
        {...(panel === undefined
          ? {}
          : {
              panel: {
                open: open !== undefined,
                onClose: tools.close,
                code: open?.code ?? '',
                ...(open?.status === undefined ? {} : { status: open.status }),
                ...(open?.fullPage === undefined ? {} : { fullPage: open.fullPage }),
                children: open?.body ?? null,
              },
            })}
      />
    </>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';

import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { Field } from '../../../components/ui/field/Field';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
  type QueueWorkspaceHandle,
} from '../../../components/ui/templates/QueueWorkspace';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import type { ConfirmedPickup } from '../../../platform/pickup/pickup-commands';
import {
  calendarDateOf,
  PICKUP_STATES,
  type CutoffExceptionState,
  type PickupState,
} from '../../../platform/pickup/pickup-shape';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import {
  pickupRequestKey,
  usePickupRequest,
  usePickupRequests,
  type PickupRecord,
} from '../../../platform/pickup/use-pickup-queries';
import { refusalText } from '../../../platform/problem/capability-words';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { PICKUP_STATE_MAP, PICKUP_STATE_ORDER, serviceDateText } from './pickup-presentation';
import { PickupQueuePanel, useConfirmedNews } from './PickupQueuePanel';
import {
  openLabelOf,
  QUEUE_COLUMNS,
  QueueCard,
  queueFactsOf,
  type QueueFacts,
} from './pickup-queue-view';
import { isUnclaimed, requestOfClick, restoreQueuePlace, searchOf } from './queue-return';
import './pickup-pages.css';

/** A state from the address, or nothing: an address is the person's to edit, and a value that is not a state is no filter. */
const stateOf = (text: string | null): PickupState | undefined =>
  PICKUP_STATES.find((state) => state === text);

/**
 * The cut-off decision from the address (`?cutoff=PENDING_OPS_REVIEW`), or nothing. The landing sends the late bookings here with it (task C1.1,
 * `AC-QSUM-11`); the one value the page offers is the one that is somebody's work, and any other is no filter, like any value the person edits in.
 * **The late bookings are the confirmed requests whose decision is pending** (what the landing counts): the filter is a refinement of the
 * Confirmed state and is no filter under another, because a request cancelled after it was raised keeps the decision it had and nothing is left
 * to decide on it (the review of C1.1).
 */
const cutoffOf = (
  text: string | null,
  state: PickupState | undefined,
): CutoffExceptionState | undefined =>
  state === 'CONFIRMED' && text === 'PENDING_OPS_REVIEW' ? text : undefined;

/**
 * Whether a date the date field gave is one a person has finished typing. The field gives each whole date on the way to the one meant (the year
 * 2, then 20, then 202, then 2026); a year of fewer than four figures is one still being typed, and is not asked of the server.
 */
const isFinishedDate = (date: string): boolean => Number(date.slice(0, 4)) >= 1000;

/** The words of the late-bookings filter, as its chip says them. */
const LATE_BOOKINGS = 'Only late bookings waiting for a cut-off decision';

/** The views of the queue: every request, and each state a request moves through, in the order it moves. */
const ALL_VIEW = 'all';

/** What the queue says when it could not be read again after an act and keeps the rows it had: they may be out of date. */
const STALE_QUEUE =
  'The pickup requests could not be read again, so these rows may be out of date.';

/**
 * A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5). The server's own answer is the same for a session that may not read
 * the queue and for one whose hub does not reach it; what the person can do about either is to ask whoever sets up their access.
 */
function refusalWords(problem: Problem): string {
  return refusalText(problem.forbidden, 'pickup.read', { of: 'pickup requests' });
}

/**
 * Pickup requests (surfaces/ops-portal.md section 7, `/pickup-requests`; S1.19; redesign step R6): the queue of the requests at the session's hubs, drawn by the queue workspace
 * template. The views are the states a request moves through, the filter row holds the service date and the late bookings, and **a request opens in a panel beside the queue**
 * (its summary, read as its own page reads it, and the one act the queue offers: confirming it), with "Open full page" for the rest. **Empty tells "no requests" from "nothing fits"
 * from "nothing at this hub"**, because conflating them sends Ops hunting for a bug. Which requests the session may see is the server's decision (vendor ownership and hub);
 * the filters are in the address, and the page of results is not. A request is named by its operational code, never by its id. How a request is drawn is
 * \`pickup-queue-view.tsx\`; this page keeps the reading, the filters, the states and the paging.
 *
 * The page of results is **a place the officer can come back to**, for one visit to a request and no longer (COMPONENT_PATTERNS section 22f): going to a request's own page from the
 * panel leaves where they were (the filters stay in the address; the cursors of the pages visited, the position and the request stay in the application's memory,
 * \`platform/pickup/queue-continuity.ts\`), and the browser's Back or the request's link back brings them to that page, **read again** from the server, with focus on the request if
 * it is still there. Any other way to the queue starts at its first page. **There is no bulk act:** confirming takes the version of one request and the API has no bulk path.
 */
export function PickupRequestListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const state = stateOf(params.get('state'));
  const cutoff = cutoffOf(params.get('cutoff'), state);
  const serviceDate = calendarDateOf(params.get('date'));
  // The hub the switcher chose (task C3): one of the filters of the list, so part of the signature: a page token, a place left and a visit are each
  // for one hub, and another hub starts again at the first page.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const signature = `${state ?? ''}|${cutoff ?? ''}|${serviceDate ?? ''}|${hubId ?? ''}`;
  // Read once, as a state starts, from a memory that a render (or a render the development build runs twice) cannot use up.
  const continuity = useQueueContinuity();
  const [arrival] = useState(() => continuity.returningTo(signature));
  const paging = useQueuePaging(signature, arrival?.tokens);
  const list = usePickupRequests({
    ...(state === undefined ? {} : { state }),
    ...(cutoff === undefined ? {} : { cutoffExceptionState: cutoff }),
    ...(serviceDate === undefined ? {} : { serviceDate }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  // The counts beside the menu are read again with the page, when the person asks for it (task C1, `AC-QSUM-09`).
  const refreshSummary = useRefreshQueueSummary();
  const announceConfirmed = useConfirmedNews();
  // What the date field holds while a date is being typed, for the filter it was typed over: the field must keep what the person typed even
  // when it is not yet a date worth asking for.
  const [typed, setTyped] = useState<{ over: string | undefined; value: string | null }>({
    over: serviceDate,
    value: serviceDate ?? null,
  });
  const dateShown = typed.over === serviceDate ? typed.value : (serviceDate ?? null);
  const [interacted, setInteracted] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  /** The request open in the panel beside the queue. A confirmation is made in the panel, with the version of the read the panel shows, and nowhere else on this page. */
  const [opened, setOpened] = useState<QueueFacts | undefined>();
  /** How many times the row's own Confirm has asked for focus on the panel's (0: the panel was opened by the row's button that opens it, which asks for none). */
  const [confirmAsk, setConfirmAsk] = useState(0);
  /** The panel's own read of the request open beside the queue: its header and its body are drawn from it, and never from the list's row, which is older. */
  const panelRead = usePickupRequest(opened?.id ?? '', opened !== undefined);
  const queryClient = useQueryClient();
  // What an act in the panel came to (the server's answer for the request it made) is written into that read, so that the panel shows it at once and draws from one place; and what the queue
  // does about it: the rows stay while they are read again, the row that changed is marked, and focus returns to it once they are drawn (the review of 5edada2). The read goes with the panel, so
  // a request opened again later is read again and never drawn as the answer it once had (the review of 499399c).
  const [changed, setChanged] = useState<
    { readonly visit: number; readonly ids: readonly string[] } | undefined
  >();
  const [afterAct, setAfterAct] = useState(false);
  /** The page whose reading again after an act failed: its rows stay, under a line that says they may be out of date (the review of 499399c). */
  const [staleAfterAct, setStaleAfterAct] = useState<string | undefined>();
  const returnTo = useRef<string | undefined>(undefined);
  const shown = panelRead.data?.request;

  // Refresh page: the page now shown is read again, by the same query (its filters and its cursor). One read at a time: the header's Refresh says it is
  // busy and ignores a press, and a press that gets here while a read is under way (before the screen has drawn the busy line) is given that
  // read, not a second one: `cancelRefetch: false`, where the default cancels the read under way and starts again.
  //
  // The completion is said once, of the **visit** the refresh was asked in: the page the officer is looking at, counted anew each time the
  // filters or the cursor change (adjusted while rendering, so that no render shows a visit with another's word), so that coming back to a
  // filter they were on is a visit of its own and not the old one again. A visit's number is never used twice, so what was said of one visit
  // can be said of no other, and an answer that arrives in another visit (late, after the officer has been elsewhere and come back) is said
  // of nothing.
  const pageKey = `${signature}|${paging.pageToken ?? ''}`;
  const [visit, setVisit] = useState({ key: pageKey, id: 0 });
  const [refreshedVisit, setRefreshedVisit] = useState<number | undefined>();
  if (visit.key !== pageKey) setVisit({ key: pageKey, id: visit.id + 1 });

  function refreshPage(): void {
    const askedIn = visit.id;
    setRefreshedVisit(undefined);
    void refreshSummary();
    void list.refetch({ cancelRefetch: false }).then((result) => {
      if (result.isSuccess) setRefreshedVisit(askedIn);
    });
  }

  // A place is for one arrival at the queue: whether this one used it or it was not for this one, it is let go of once the queue is on screen.
  const { discard } = continuity;
  useEffect(() => {
    discard();
  }, [discard]);

  // Once the page that was left has been read again and drawn, the officer gets their position back, and focus where nobody has put it (the
  // request they opened, else the results). Only if the page is still the one they came back to: not after a change of filter or of page.
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const restored = useRef(arrival === undefined);

  // Once the rows that were read again after an act are drawn, focus goes to the row that changed (the request's own button), else to the results: the officer is not left on nothing.
  // Only where nobody has put it: a person who moved on while the queue was read again keeps their focus (the review of 499399c).
  useEffect(() => {
    if (afterAct || returnTo.current === undefined) return;
    const id = returnTo.current;
    returnTo.current = undefined;
    if (!isUnclaimed(document.activeElement)) return;
    if (workspace.current?.focusRow(id) !== true) workspace.current?.focusResults();
  }, [afterAct, list.dataUpdatedAt]);

  /**
   * The queue is read again after an act, its rows kept. If that read fails the rows stay, with a line that says they may be out of date and the way to read them again; any other read that
   * fails takes the rows' place, as it always did.
   */
  function readAgainAfterAct(): void {
    setStaleAfterAct(undefined);
    setAfterAct(true);
    void list
      .refetch()
      .then((read) => {
        if (read.isError) setStaleAfterAct(pageKey);
      })
      .finally(() => {
        setAfterAct(false);
      });
  }

  /** The act of the panel was answered: say so, show the answer in the panel at once, mark the row, and read the page again with its rows kept. */
  function confirmedInPanel({ request, etag }: ConfirmedPickup): void {
    announceConfirmed(request);
    // The answer is kept with its own version, the one the request has now (the review of f6cf02b: it was kept with the version of the read before the act, so that "Open full page", which reads
    // this same entry, could act on a version that was not the record's). An answer that carried no version leaves nothing to keep, and the entry is read again. The panel reads the request
    // again when it is opened again.
    const key = pickupRequestKey(request.id);
    if (etag === undefined) {
      void queryClient.invalidateQueries({ queryKey: key });
    } else {
      queryClient.setQueryData<PickupRecord>(key, { request, etag });
    }
    setChanged({ visit: visit.id, ids: [request.id] });
    returnTo.current = request.id;
    readAgainAfterAct();
  }
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const stillThere =
    signature === arrival?.signature &&
    paging.tokens.length === arrival.tokens.length &&
    paging.tokens.every((token, index) => token === arrival.tokens[index]);
  useEffect(() => {
    if (arrival === undefined || restored.current || !settled) return;
    restored.current = true;
    if (stillThere && workspace.current !== null) restoreQueuePlace(workspace.current, arrival);
  }, [arrival, settled, stillThere]);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once, so that it does not wait for the next table and be taken from the officer then.
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  /** Going to the opened request's own page leaves where the officer was, for the visit: a plain click on the panel's "Open full page", which is a move in this tab. */
  function leavePlace(event: MouseEvent<HTMLDivElement>): void {
    if (opened === undefined) return;
    const requestId = requestOfClick(event, {
      selector: 'a[href]',
      key: 'href',
      idOf: (link) => (link.getAttribute('href') === opened.href ? opened.id : undefined),
    });
    if (requestId === undefined) return;
    continuity.leave({
      signature,
      search: searchOf({
        ...(state === undefined ? {} : { state }),
        ...(cutoff === undefined ? {} : { cutoff }),
        ...(serviceDate === undefined ? {} : { date: serviceDate }),
      }),
      tokens: paging.tokens,
      scrollY: window.scrollY,
      requestId,
    });
  }

  /** The first page, on purpose: the officer's choice, and the end of any place left. */
  function firstPage(): void {
    continuity.discard();
    paging.toFirstPage();
  }

  // The server will not open a saved page: its failure is told as that, in its own words, with the way out that works (a retry would fail alike).
  // The service alone can judge an opaque position and names the parameter `/page_token`, which is what the real API sends; the contract's
  // validation names a parameter it refuses by its bare name. Both are this parameter.
  const cursorRefused =
    list.error instanceof OperationFailure &&
    list.error.violations.some(
      (violation) =>
        violation.in === 'query' &&
        (violation.pointer === '/page_token' || violation.pointer === 'page_token'),
    );

  const hubs = me?.session.authorized_hubs;
  // The rows of the last page that was read, which a failed read again after an act keeps (the data of a query stays when a later read of it fails).
  const rows = useMemo(
    () =>
      list.data !== undefined && hubs !== undefined
        ? list.data.items.map((request) => queueFactsOf(request, hubs))
        : [],
    [list.data, hubs],
  );

  if (me === undefined || hubs === undefined) return null;
  const canConfirm = me.holds('pickup.request.confirm');

  /** A change of filter, where `''` takes one off. */
  function change(next: { state?: PickupState | ''; cutoff?: ''; date?: string }): void {
    continuity.discard();
    setInteracted(true);
    const nextState = next.state === undefined ? state : next.state === '' ? undefined : next.state;
    // The late bookings are asked for by the link of the landing and taken off by their own chip, or by any state but Confirmed, which they
    // are a refinement of: nothing else changes them.
    const nextCutoff = next.cutoff === undefined && nextState === 'CONFIRMED' ? cutoff : undefined;
    const nextDate =
      next.date === undefined ? serviceDate : next.date === '' ? undefined : next.date;
    const out = new URLSearchParams();
    if (nextState !== undefined) out.set('state', nextState);
    if (nextCutoff !== undefined) out.set('cutoff', nextCutoff);
    if (nextDate !== undefined) out.set('date', nextDate);
    setParams(out, { replace: true });
  }

  function clearEverything(): void {
    setTyped({ over: undefined, value: null });
    change({ state: '', cutoff: '', date: '' });
  }

  const filtering = state !== undefined || cutoff !== undefined || serviceDate !== undefined;

  const result: QueueResult<QueueFacts> = (() => {
    if (list.status === 'pending') return { status: 'loading' };
    if (list.isFetching && list.status === 'success') {
      // After an act the rows stay: the officer keeps their place, their focus and the row that changed (the table says it is busy). Any other read again (a refresh asked for, a
      // page, a filter) is not drawn as if the earlier rows answered it: the loading treatment takes their place, and a failure takes their place if the read fails.
      return afterAct ? { status: 'ready', rows, refreshing: true } : { status: 'loading' };
    }
    // Read again after an act and failed (or being read once more): the rows the person was working on stay, under the line that says so.
    if (
      list.status === 'error' &&
      list.data !== undefined &&
      (afterAct || staleAfterAct === pageKey)
    ) {
      return {
        status: 'ready',
        rows,
        refreshing: afterAct,
        stale: { message: STALE_QUEUE, onRefresh: readAgainAfterAct },
      };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, {
        operation: 'listPickupRequests',
        ...(cursorRefused ? { context: 'cursor' } : {}),
      });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale') {
        return { status: 'loading' };
      }
      const message =
        problem.kind === 'forbidden'
          ? refusalWords(problem)
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

  const emptiness = {
    noun: 'pickup requests',
    none: 'Requests booked at your hubs appear here, from WhatsApp, a walk-in sender or a vendor’s own booking.',
    announce: interacted,
    // A page after the first can hold nothing without the queue being empty (requests move between reads): the template says so, as every list does, and does not go looking through the
    // earlier pages on its own.
    laterPage: { page: paging.page, onFirstPage: firstPage },
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: clearEverything,
        clearLabel: 'Show every request',
        filteredText: 'Nothing fits these filters. Show every request to start again.',
      }
    : emptiness;

  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;

  return (
    <>
      <title>Pickup requests · Melarc Ops Portal</title>
      <div className="pickup-queue" onClickCapture={leavePlace}>
        <QueueWorkspace<QueueFacts>
          ref={workspace}
          header={{
            title: 'Pickup requests',
            description: 'Requests at your authorized hubs.',
            freshness: {
              state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
              ...(updatedAt === undefined ? {} : { updatedAt }),
              onRefresh: refreshPage,
            },
            ...(me.holds('pickup.request.create')
              ? {
                  // The panel's act is the one primary of the view; booking is one of the New menu's too.
                  actions: (
                    <ButtonLink to="/pickup-requests/new" variant="secondary">
                      Book a pickup
                    </ButtonLink>
                  ),
                }
              : {}),
          }}
          views={{
            label: 'Views of the pickup requests',
            value: state ?? ALL_VIEW,
            onValueChange: (id) => {
              change({ state: stateOf(id) ?? '' });
            },
            tabs: [
              { id: ALL_VIEW, label: 'All' },
              ...PICKUP_STATE_ORDER.map((key) => ({ id: key, label: PICKUP_STATE_MAP[key].label })),
            ],
          }}
          filters={{
            label: 'Filter the pickup requests',
            chips: [
              ...(serviceDate === undefined
                ? []
                : [{ id: 'date', label: `Service date: ${serviceDateText(serviceDate)}` }]),
              ...(cutoff === undefined ? [] : [{ id: 'cutoff', label: LATE_BOOKINGS }]),
            ],
            onRemove: (id) => {
              if (id === 'date') {
                setTyped({ over: undefined, value: null });
                change({ date: '' });
              } else {
                change({ cutoff: '' });
              }
            },
            onClearAll: () => {
              setTyped({ over: undefined, value: null });
              change({ cutoff: '', date: '' });
            },
            filterOpen,
            onFilterOpenChange: setFilterOpen,
            filterPanel: (
              <Field label="Service date" help="Day, month and year.">
                <DatePicker
                  value={dateShown}
                  onChange={(next) => {
                    setTyped({ over: serviceDate, value: next });
                    if (next === null) {
                      if (serviceDate !== undefined) change({ date: '' });
                    } else if (isFinishedDate(next)) {
                      change({ date: next });
                      setFilterOpen(false);
                    }
                  }}
                />
              </Field>
            ),
          }}
          notice={
            <p role="status" className="pickup-hidden">
              {refreshedVisit === visit.id ? 'Page refreshed.' : ''}
            </p>
          }
          result={result}
          empty={empty}
          table={{
            label: 'Pickup requests',
            columns: QUEUE_COLUMNS,
            rowId: (row) => row.id,
            density: 'two-line',
            onOpen: (row: QueueFacts) => {
              setConfirmAsk(0);
              setOpened(row);
            },
            openLabel: openLabelOf,
            changedIds: changed?.visit === visit.id ? changed.ids : [],
            card: (row) => <QueueCard facts={row} />,
            // The code is the heading of each card, for heading navigation (outside the card's button, which is presentational).
            cardTitle: (row) => <OperationalCode>{row.code}</OperationalCode>,
            ...(canConfirm
              ? {
                  rowAction: {
                    label: 'Confirm',
                    ariaLabel: (row: QueueFacts) => `Confirm ${row.code}`,
                    isAvailable: (row: QueueFacts) => row.confirmable,
                    // The row's Confirm opens the request in the panel with focus on the panel's own Confirm: the question is asked there, over the version the panel read.
                    onRun: (row: QueueFacts) => {
                      setConfirmAsk((count) => count + 1);
                      setOpened(row);
                    },
                  },
                }
              : {}),
            // The pager is in the page whatever the table is doing, so that its status region is the same one while a page is read (the review of 499399c).
            footer: (
              <QueuePager
                label="Pages of pickup requests"
                noun={{ one: 'request', other: 'requests' }}
                shown={
                  result.status === 'ready' && list.data !== undefined ? rows.length : undefined
                }
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
          panel={{
            open: opened !== undefined,
            onClose: () => {
              setConfirmAsk(0);
              setOpened(undefined);
            },
            code: opened?.code ?? '',
            ...(opened === undefined
              ? {}
              : {
                  // The state in the header is the panel's own read: until it has answered the header shows none, and never the list's row, which is older than the panel's answer.
                  ...(shown === undefined
                    ? {}
                    : { status: <StatusBadge status={shown.state} map={PICKUP_STATE_MAP} /> }),
                  fullPage: { to: opened.href },
                }),
            children:
              opened === undefined ? null : (
                <PickupQueuePanel
                  key={opened.id}
                  record={panelRead}
                  hubs={hubs}
                  canConfirm={canConfirm}
                  confirmAsk={confirmAsk}
                  onConfirmed={confirmedInPanel}
                />
              ),
          }}
        />
      </div>
    </>
  );
}

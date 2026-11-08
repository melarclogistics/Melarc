import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { Field } from '../../../components/ui/field/Field';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
} from '../../../components/ui/templates/QueueWorkspace';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import {
  calendarDateOf,
  PICKUP_STATES,
  type CutoffExceptionState,
  type PickupState,
} from '../../../platform/pickup/pickup-shape';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { PICKUP_STATE_MAP, PICKUP_STATE_ORDER, serviceDateText } from './pickup-presentation';
import { PickupQueuePanel, ConfirmPickupDialog, useConfirmedNews } from './PickupQueuePanel';
import {
  openLabelOf,
  QUEUE_COLUMNS,
  QueueCard,
  queueFactsOf,
  type QueueFacts,
} from './pickup-queue-view';
import { REQUEST_ROW_BUTTONS, requestOfClick, restorePlace, searchOf } from './queue-return';
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

/**
 * A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5). The server's own answer is the same for a session that may not read
 * the queue and for one whose hub does not reach it; what the person can do about either is to ask whoever sets up their access.
 */
function refusalWords(problem: Problem): string {
  return problem.forbidden === 'outside-hubs'
    ? 'These pickup requests are at a hub your account does not work in.'
    : 'Your account cannot read pickup requests. Ask an administrator to give you access.';
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
  /** The request open in the panel beside the queue, and the one whose confirmation is being asked. */
  const [opened, setOpened] = useState<QueueFacts | undefined>();
  const [confirming, setConfirming] = useState<QueueFacts | undefined>();

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
  const queue = useRef<HTMLDivElement>(null);
  const restored = useRef(arrival === undefined);
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const stillThere =
    signature === arrival?.signature &&
    paging.tokens.length === arrival.tokens.length &&
    paging.tokens.every((token, index) => token === arrival.tokens[index]);
  useEffect(() => {
    if (arrival === undefined || restored.current || !settled) return;
    restored.current = true;
    if (stillThere && queue.current !== null) {
      restorePlace(queue.current, arrival, REQUEST_ROW_BUTTONS);
    }
  }, [arrival, settled, stillThere]);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once, so that it does not wait for the next table and be taken from the officer then.
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    queue.current
      ?.querySelector<HTMLElement>('.ui-data-table__scroller')
      ?.focus({ preventScroll: true });
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
  const rows = useMemo(
    () =>
      list.isSuccess && hubs !== undefined
        ? list.data.items.map((request) => queueFactsOf(request, hubs))
        : [],
    [list.isSuccess, list.data, hubs],
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
    // While a page that was read is read again, the rows of the earlier read are not drawn as if they answered it: the loading treatment takes
    // their place (as for a first read), and a failure takes their place if the read fails.
    if (list.status === 'pending' || (list.isFetching && list.status === 'success')) {
      return { status: 'loading' };
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

  // A page after the first can hold nothing without the queue being empty (requests move between reads): it says so, and does not go looking
  // through the earlier pages on its own.
  const pastTheEnd =
    paging.page > 1 ? (
      <EmptyStateV2
        variant="filtered-empty"
        title="No requests on this page"
        headingLevel={3}
        announce
        action={
          <Button type="button" variant="secondary" onClick={firstPage}>
            Back to first page
          </Button>
        }
      >
        {`Page ${String(paging.page)} has no requests now. Earlier pages may still have some.`}
      </EmptyStateV2>
    ) : undefined;

  const emptiness = {
    noun: 'pickup requests',
    none: 'Requests booked at your hubs appear here, from WhatsApp, a walk-in sender or a vendor’s own booking.',
    announce: interacted,
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: clearEverything,
        clearLabel: 'Show every request',
      }
    : emptiness;

  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;

  return (
    <>
      <title>Pickup requests · Melarc Ops Portal</title>
      <div className="pickup-queue" ref={queue} onClickCapture={leavePlace}>
        <QueueWorkspace<QueueFacts>
          header={{
            title: 'Pickup requests',
            description: 'Requests at your authorized hubs.',
            freshness: {
              state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
              ...(updatedAt === undefined ? {} : { updatedAt }),
              onRefresh: refreshPage,
            },
            ...(me.holds('pickup.request.create')
              ? { actions: <ButtonLink to="/pickup-requests/new">Book a pickup</ButtonLink> }
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
          {...(pastTheEnd === undefined ? {} : { emptyState: pastTheEnd })}
          table={{
            label: 'Pickup requests',
            columns: QUEUE_COLUMNS,
            rowId: (row) => row.id,
            density: 'two-line',
            onOpen: setOpened,
            openLabel: openLabelOf,
            card: (row) => <QueueCard facts={row} />,
            ...(canConfirm
              ? {
                  rowAction: {
                    label: 'Confirm',
                    ariaLabel: (row: QueueFacts) => `Confirm ${row.code}`,
                    isAvailable: (row: QueueFacts) => row.confirmable,
                    onRun: setConfirming,
                  },
                }
              : {}),
            ...(result.status === 'ready' && list.isSuccess
              ? {
                  footer: (
                    <QueuePager
                      label="Pages of pickup requests"
                      noun={{ one: 'request', other: 'requests' }}
                      shown={rows.length}
                      page={paging.page}
                      hasNext={list.data.nextPageToken !== null}
                      onNext={() => {
                        if (list.data.nextPageToken !== null) {
                          paging.toNextPage(list.data.nextPageToken);
                        }
                      }}
                      onPrevious={paging.toPreviousPage}
                    />
                  ),
                }
              : {}),
          }}
          panel={{
            open: opened !== undefined,
            onClose: () => {
              setOpened(undefined);
            },
            code: opened?.code ?? '',
            ...(opened === undefined
              ? {}
              : {
                  status: <StatusBadge status={opened.state} map={PICKUP_STATE_MAP} />,
                  fullPage: { to: opened.href },
                }),
            children:
              opened === undefined ? null : (
                <PickupQueuePanel
                  key={opened.id}
                  row={opened}
                  hubs={hubs}
                  canConfirm={canConfirm}
                  onConfirmed={(request) => {
                    announceConfirmed(request);
                    void list.refetch();
                  }}
                />
              ),
          }}
        />
      </div>
      <ConfirmPickupDialog
        open={confirming !== undefined}
        id={confirming?.id ?? ''}
        code={confirming?.code ?? ''}
        onDone={(request) => {
          setConfirming(undefined);
          announceConfirmed(request);
          void list.refetch();
        }}
        onCancel={() => {
          setConfirming(undefined);
        }}
        onReload={() => list.refetch()}
      />
    </>
  );
}

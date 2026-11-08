import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import {
  QueueFilters,
  QueuePanel,
  QueueTable,
} from '../../../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { ReadState, type ReadQuery } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import {
  calendarDateOf,
  PICKUP_STATES,
  type CutoffExceptionState,
  type PickupRequestPageView,
  type PickupState,
} from '../../../platform/pickup/pickup-shape';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { NothingAtHub } from '../NothingAtHub';
import { PICKUP_STATE_MAP, PICKUP_STATE_ORDER } from './pickup-presentation';
import { QUEUE_COLUMNS, QueueCard, queueFactsOf } from './pickup-queue-view';
import { requestOfClick, restorePlace, searchOf } from './queue-return';
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

/**
 * What the page says of its last check, in a line: that one is under way, when the last one that worked was, or that the last one failed and
 * when the one before it worked. Nothing before any read of this page has worked. The time is the moment this page's read was answered (the
 * browser's clock, as the portal shows time) and says nothing of the rest of the queue: a read of another filter or another page is another
 * query, whose time is nothing until it is answered.
 */
function checkLine(check: {
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly dataUpdatedAt: number;
}): string {
  if (check.isFetching) return 'Checking this page…';
  const answered =
    check.dataUpdatedAt > 0
      ? formatInstant(new Date(check.dataUpdatedAt).toISOString())
      : undefined;
  if (answered === undefined) return '';
  return check.isError
    ? `Refresh failed. Last successful check: ${answered}`
    : `Last checked ${answered}`;
}

/**
 * Pickup requests (surfaces/ops-portal.md section 7, `/pickup-requests`; S1.19): the queue of the requests at the session's hubs, filtered by
 * state and service date. **Empty tells "no requests" from "filtered to nothing"**, because conflating them sends Ops hunting for a bug. Which
 * requests the session may see is the server's decision (vendor ownership and hub); the filters are in the address, and the page of results is
 * not. A request is named by its operational code, never by its id. How a request is drawn, as a row of six columns and as a card, is
 * `pickup-queue-view.tsx`; this page keeps the reading, the filters, the states and the paging.
 *
 * The page of results is **a place the officer can come back to**, for one visit to a request and no longer (COMPONENT_PATTERNS section 22f):
 * opening a request leaves where they were (the filters stay in the address; the cursors of the pages visited, the position and the request
 * stay in the application's memory, `platform/pickup/queue-continuity.ts`), and the browser's Back or the request's link back brings them to
 * that page, **read again** from the server, with focus on the request if it is still there. Any other way to the queue starts at its first page.
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
  // What the date field holds while a date is being typed, for the filter it was typed over: the field must keep what the person typed even
  // when it is not yet a date worth asking for.
  const [typed, setTyped] = useState<{ over: string | undefined; value: string | null }>({
    over: serviceDate,
    value: serviceDate ?? null,
  });
  const dateShown = typed.over === serviceDate ? typed.value : (serviceDate ?? null);
  const [interacted, setInteracted] = useState(false);

  // Refresh page: the page now shown is read again, by the same query (its filters and its cursor). One read at a time: the button says it is
  // busy and ignores a press, and a press that gets here while a read is under way (before the screen has drawn the busy button) is given that
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

  // While a page that was read is read again, the rows of the earlier read are not drawn as if they answered it: the loading treatment takes
  // their place (as for a first read), and a failure takes their place if the read fails (`ReadState` never draws data beside a failure).
  const shown: ReadQuery<PickupRequestPageView> =
    list.isFetching && list.status === 'success'
      ? { status: 'pending', data: undefined, error: null, refetch: list.refetch, isFetching: true }
      : list;

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
    if (stillThere && queue.current !== null) restorePlace(queue.current, arrival);
  }, [arrival, settled, stillThere]);

  // A move to another page that has nothing to draw (no rows, or a failure) leaves the pager button it was made from gone, and the table that
  // would take focus is not there: focus goes to the message, once, so that it does not wait for the next table and be taken from the officer then.
  const { takeFocus } = paging;
  const hasRows = list.isSuccess && list.data.items.length > 0;
  useEffect(() => {
    if (!settled || hasRows || !takeFocus()) return;
    queue.current?.querySelector<HTMLElement>('.ui-read-state')?.focus({ preventScroll: true });
  }, [settled, hasRows, takeFocus]);

  /** Opening a request leaves where the officer was, for the visit: a plain click on its link, which is a move in this tab. */
  function leavePlace(event: MouseEvent<HTMLDivElement>): void {
    const requestId = requestOfClick(event);
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

  if (me === undefined) return null;

  /** A change of filter, where `''` takes one off. */
  function change(next: { state?: PickupState | ''; cutoff?: ''; date?: string }): void {
    continuity.discard();
    setInteracted(true);
    const nextState = next.state === undefined ? state : next.state === '' ? undefined : next.state;
    // The late bookings are asked for by the link of the landing and taken off by their own button, or by any state but Confirmed, which they
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

  /**
   * Where a button that takes a filter off hands focus on: the button is gone once it has, and focus would fall to the page. The filter row's
   * own control is the nearest place that is still there.
   */
  function focusFilter(selector: string): void {
    queue.current?.querySelector<HTMLElement>(selector)?.focus();
  }

  function clearEverything(): void {
    setTyped({ over: undefined, value: null });
    change({ state: '', cutoff: '', date: '' });
  }

  const filtering = state !== undefined || cutoff !== undefined || serviceDate !== undefined;
  // A page after the first can hold nothing without the queue being empty (requests move between reads): it says so, and does not go looking
  // through the earlier pages on its own.
  const empty =
    paging.page > 1 ? (
      <EmptyState
        kind="filtered"
        heading="No requests on this page"
        announce
        action={
          <Button type="button" variant="secondary" onClick={firstPage}>
            Back to first page
          </Button>
        }
      >
        Page {paging.page} has no requests now. Earlier pages may still have some.
      </EmptyState>
    ) : hub !== undefined ? (
      // A chosen hub is a filter too (audit B1): the list is empty at this hub, which says nothing of the others.
      <NothingAtHub
        hub={hub}
        showAllHubs={showAllHubs}
        what="pickup requests"
        filtered={filtering}
        clear={
          <Button type="button" variant="secondary" onClick={clearEverything}>
            Show every request
          </Button>
        }
      />
    ) : filtering ? (
      <EmptyState
        kind="filtered"
        heading="No pickup requests match"
        announce={interacted}
        action={
          <Button type="button" variant="secondary" onClick={clearEverything}>
            Show every request
          </Button>
        }
      >
        {cutoff === undefined
          ? 'Nothing fits this state and service date. Show every request to start again.'
          : 'Nothing fits these filters. Show every request to start again.'}
      </EmptyState>
    ) : (
      <EmptyState kind="none" heading="No pickup requests yet" announce={interacted}>
        Requests booked at your hubs appear here, from WhatsApp, a walk-in sender or a vendor’s own
        booking.
      </EmptyState>
    );

  return (
    <>
      <title>Pickup requests · Melarc Ops Portal</title>
      <PageHeader
        title="Pickup requests"
        description="Requests at your authorized hubs."
        {...(me.holds('pickup.request.create')
          ? { actions: <ButtonLink to="/pickup-requests/new">Book a pickup</ButtonLink> }
          : {})}
      />
      <div className="pickup-queue" ref={queue} onClickCapture={leavePlace}>
        <QueuePanel>
          <QueueFilters
            label="Filter the pickup requests"
            aside={
              <div className="pickup-freshness">
                <p className="pickup-freshness__text">{checkLine(list)}</p>
                <Button
                  type="button"
                  variant="secondary"
                  loading={list.isFetching}
                  onClick={refreshPage}
                >
                  Refresh page
                </Button>
                <p role="status" className="pickup-hidden">
                  {refreshedVisit === visit.id ? 'Page refreshed.' : ''}
                </p>
              </div>
            }
          >
            <Field label="State">
              <Select
                name="state"
                value={state ?? ''}
                onChange={(event) => {
                  change({ state: stateOf(event.target.value) ?? '' });
                }}
              >
                <option value="">Every state</option>
                {PICKUP_STATE_ORDER.map((key) => (
                  <option key={key} value={key}>
                    {PICKUP_STATE_MAP[key].label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="pickup-date-filter">
              <Field label="Service date" help="Day, month and year.">
                <DatePicker
                  value={dateShown}
                  onChange={(next) => {
                    setTyped({ over: serviceDate, value: next });
                    if (next === null) {
                      if (serviceDate !== undefined) change({ date: '' });
                    } else if (isFinishedDate(next)) {
                      change({ date: next });
                    }
                  }}
                />
              </Field>
              {serviceDate === undefined ? null : (
                <div className="pickup-date-filter__clear">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setTyped({ over: undefined, value: null });
                      change({ date: '' });
                      focusFilter('.pickup-date-filter input');
                    }}
                  >
                    Every service date
                  </Button>
                </div>
              )}
            </div>
            {cutoff === undefined ? null : (
              <div className="pickup-cutoff-filter">
                <p className="pickup-cutoff-filter__text">
                  Only late bookings waiting for a cut-off decision.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    change({ cutoff: '' });
                    focusFilter('select[name="state"]');
                  }}
                >
                  Every cut-off decision
                </Button>
              </div>
            )}
          </QueueFilters>

          <ReadState<PickupRequestPageView>
            query={shown}
            isEmpty={(data) => data.items.length === 0}
            empty={empty}
            loadingLabel="Loading the pickup requests…"
            skeleton={<Skeleton lines={5} />}
            permission="pickup.read"
            operation="listPickupRequests"
            {...(cursorRefused
              ? {
                  context: 'cursor',
                  recovery: (
                    <Button type="button" variant="secondary" onClick={firstPage}>
                      Back to first page
                    </Button>
                  ),
                }
              : {})}
          >
            {(data) => (
              <QueueTable
                caption="Pickup requests"
                columns={QUEUE_COLUMNS}
                rows={data.items.map((request) =>
                  queueFactsOf(request, me.session.authorized_hubs),
                )}
                rowKey={(row) => row.id}
                noun={{ one: 'request', other: 'requests' }}
                paging={paging}
                nextPageToken={data.nextPageToken}
                card={(row) => <QueueCard facts={row} />}
              />
            )}
          </ReadState>
        </QueuePanel>
      </div>
    </>
  );
}

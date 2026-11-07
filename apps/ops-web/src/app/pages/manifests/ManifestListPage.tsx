import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import {
  QueueFilters,
  QueuePanel,
  QueueTable,
} from '../../../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { TableColumn } from '../../../components/ui/table/Table';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import {
  MANIFEST_FILTER_STATES,
  type ManifestFilterState,
  type ManifestPageView,
  type ManifestView,
} from '../../../platform/manifest/manifest-shape';
import { useManifests } from '../../../platform/manifest/use-manifest-queries';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { NothingAtHub } from '../NothingAtHub';
import { hubNameOf } from '../staff/staff-presentation';
import { serviceDateText } from '../pickup/pickup-presentation';
import { MANIFEST_LINKS, requestOfClick, restorePlace } from '../pickup/queue-return';
import { filtersOf, searchOf, stateOfText } from './manifest-list-filters';
import { MANIFEST_STATE_MAP } from './manifest-presentation';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

/**
 * What the queue tells of a manifest, made once from the record so that the row and the card cannot tell different things. A list of manifests
 * carries no stops and no rider's name (`listPickupManifests`): whether a rider is assigned is told, and who, on the manifest's own page.
 */
interface ManifestFacts {
  readonly id: string;
  readonly code: string;
  readonly href: string;
  readonly state: ManifestView['state'];
  readonly serviceDate: string;
  readonly hub: string;
  readonly rider: string;
  readonly moments: string;
}

function momentsOf(manifest: ManifestView): string {
  if (manifest.completed_at !== undefined) {
    return `Completed ${formatInstant(manifest.completed_at) ?? ''}`.trim();
  }
  if (manifest.started_at !== undefined) {
    return `Started ${formatInstant(manifest.started_at) ?? ''}`.trim();
  }
  if (manifest.dispatched_at !== undefined) {
    return `Dispatched ${formatInstant(manifest.dispatched_at) ?? ''}`.trim();
  }
  return 'Not dispatched';
}

function factsOf(
  manifest: ManifestView,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): ManifestFacts {
  return {
    id: manifest.id,
    code: manifest.code,
    href: `/manifests/${manifest.id}`,
    state: manifest.state,
    serviceDate: serviceDateText(manifest.service_date),
    hub: hubNameOf(manifest.responsible_hub_id, hubs),
    rider: manifest.assigned_rider_id === undefined ? 'No rider yet' : 'A rider is assigned',
    moments: momentsOf(manifest),
  };
}

const COLUMNS: readonly TableColumn<ManifestFacts>[] = [
  {
    key: 'manifest',
    header: 'Manifest / hub',
    rowHeader: true,
    cell: (row) => (
      <span className="manifest-lines">
        <span className="manifest-nowrap">
          <Link to={row.href} data-manifest-id={row.id}>
            {row.code}
          </Link>
        </span>
        <span className="manifest-support">{row.hub}</span>
      </span>
    ),
  },
  {
    key: 'state',
    header: 'State',
    cell: (row) => <StatusBadge status={row.state} map={MANIFEST_STATE_MAP} />,
  },
  {
    key: 'date',
    header: 'Service date',
    cell: (row) => <span className="manifest-nowrap">{row.serviceDate}</span>,
  },
  {
    key: 'rider',
    header: 'Rider / progress',
    cell: (row) => (
      <span className="manifest-lines">
        <span>{row.rider}</span>
        <span className="manifest-support">{row.moments}</span>
      </span>
    ),
  },
];

function ManifestCard({ facts }: { readonly facts: ManifestFacts }) {
  return (
    <>
      <div className="manifest-card__head">
        <h2 className="manifest-card__title">
          <Link to={facts.href} data-manifest-id={facts.id}>
            {facts.code}
          </Link>
        </h2>
        <StatusBadge status={facts.state} map={MANIFEST_STATE_MAP} />
      </div>
      <dl className="manifest-card__facts">
        <div className="manifest-card__fact">
          <dt>Service date</dt>
          <dd>{facts.serviceDate}</dd>
        </div>
        <div className="manifest-card__fact">
          <dt>Hub</dt>
          <dd>{facts.hub}</dd>
        </div>
        <div className="manifest-card__fact">
          <dt>Rider / progress</dt>
          <dd>
            <span className="manifest-lines">
              <span>{facts.rider}</span>
              <span className="manifest-support">{facts.moments}</span>
            </span>
          </dd>
        </div>
      </dl>
    </>
  );
}

/** What the filters on the screen are called when the list under them is empty: "the state Draft and the service date Wed 4 Nov 2026". */
function describeFilters(state: ManifestFilterState | undefined, date: string | undefined): string {
  const parts = [
    ...(state === undefined ? [] : [`the state ${MANIFEST_STATE_MAP[state].label}`]),
    ...(date === undefined ? [] : [`the service date ${serviceDateText(date)}`]),
  ];
  return parts.join(' and ');
}

/**
 * Whether a date the date field gave is one a person has finished typing. The field gives each whole date on the way to the one meant (the year
 * 2, then 20, then 202, then 2026); a year of fewer than four figures is one still being typed, and is not asked of the server.
 */
const isFinishedDate = (date: string): boolean => Number(date.slice(0, 4)) >= 1000;

/** Whether the server refused the parameter the list sent with this name, as the real API names it (`/page_token`). */
const refusedParameter = (error: unknown, name: string): boolean =>
  error instanceof OperationFailure &&
  error.violations.some(
    (violation) =>
      violation.in === 'query' && (violation.pointer === `/${name}` || violation.pointer === name),
  );

/**
 * Manifests (surfaces/ops-portal.md section 7, `/manifests`; S1.25): the manifests of the session's hubs, **never filtered by vendor** (a
 * manifest spans vendors), as the server lists them: oldest first, narrowed by the two filters the operation has, `state` and `service_date`
 * (OB-S1-25), each exact and combined as "and". **The server filters**: the screen asks, in the address and in the request, and draws what comes
 * back whole, because the part of a page that matched would pass for the whole. A manifest is named by its operational code, never by its id;
 * its state is a labelled badge.
 *
 * It adapts the pickup queue's filters (COMPONENT_PATTERNS section 22f): a named group of the screen's own controls above the rows, the chosen
 * values in the address (so that a reload keeps them), a change of filter starting again at the first page, and an empty list told apart: **no
 * manifests at all** is not **a filter that hides everything**, which says what was filtered and offers to take it off. A failed read stays a
 * failure, with the filters in place.
 *
 * The page of results is **a place the officer can come back to**, for one visit to a manifest and no longer, **on the pickup queue's terms**
 * (the same memory, `platform/pickup/queue-continuity.ts`, held for this list apart from the queue's): opening a manifest leaves where they were
 * (the filters stay in the address; the cursors of the pages visited, the position and the manifest stay in the application's memory), and the
 * browser's Back or the manifest's link back brings them to that page, **read again** from the server, with focus on the manifest if it is still
 * there. Any other way to the list starts at its first page.
 */
export function ManifestListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const { state, date } = filtersOf(params);
  // The hub the switcher chose (task C3) is a filter of the list like the other two, so it is part of the signature.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const signature = `${state ?? ''}|${date ?? ''}|${hubId ?? ''}`;
  // Read once, as a state starts, from a memory that a render (or a render the development build runs twice) cannot use up.
  const continuity = useQueueContinuity('manifests');
  const [arrival] = useState(() => continuity.returningTo(signature));
  // A page token belongs to the filters it was made with: a change of any of them starts again at the first page.
  const paging = useQueuePaging(signature, arrival?.tokens);
  const list = useManifests({
    ...(state === undefined ? {} : { state }),
    ...(date === undefined ? {} : { serviceDate: date }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const refreshSummary = useRefreshQueueSummary();
  const queue = useRef<HTMLDivElement>(null);
  // What the date field holds while a date is being typed, for the filter it was typed over: the field must keep what the person typed even
  // when it is not yet a date worth asking for.
  const [typed, setTyped] = useState<{ over: string | undefined; value: string | null }>({
    over: date,
    value: date ?? null,
  });
  const dateShown = typed.over === date ? typed.value : (date ?? null);
  const [interacted, setInteracted] = useState(false);

  // A place is for one arrival at the list: whether this one used it or it was not for this one, it is let go of once the list is on screen.
  const { discard } = continuity;
  useEffect(() => {
    discard();
  }, [discard]);

  // Once the page that was left has been read again and drawn, the officer gets their position back, and focus where nobody has put it (the
  // manifest they opened, else the results). Only if the page is still the one they came back to: not after a change of filter or of page.
  const restored = useRef(arrival === undefined);
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const stillThere =
    signature === arrival?.signature &&
    paging.tokens.length === arrival.tokens.length &&
    paging.tokens.every((token, index) => token === arrival.tokens[index]);
  useEffect(() => {
    if (arrival === undefined || restored.current || !settled) return;
    restored.current = true;
    if (stillThere && queue.current !== null) restorePlace(queue.current, arrival, MANIFEST_LINKS);
  }, [arrival, settled, stillThere]);

  // A move to a page with nothing to draw leaves the pager button it was made from gone: focus goes to the message, once.
  const { takeFocus } = paging;
  const hasRows = list.isSuccess && list.data.items.length > 0;
  useEffect(() => {
    if (!settled || hasRows || !takeFocus()) return;
    queue.current?.querySelector<HTMLElement>('.ui-read-state')?.focus({ preventScroll: true });
  }, [settled, hasRows, takeFocus]);

  /** Opening a manifest leaves where the officer was, for the visit: a plain click on its link, which is a move in this tab. */
  function leavePlace(event: MouseEvent<HTMLDivElement>): void {
    const manifestId = requestOfClick(event, MANIFEST_LINKS);
    if (manifestId === undefined) return;
    continuity.leave({
      signature,
      search: searchOf({
        ...(state === undefined ? {} : { state }),
        ...(date === undefined ? {} : { date }),
      }),
      tokens: paging.tokens,
      scrollY: window.scrollY,
      requestId: manifestId,
    });
  }

  /** The first page, on purpose: the officer's choice, and the end of any place left. */
  function firstPage(): void {
    continuity.discard();
    paging.toFirstPage();
  }

  if (me === undefined) return null;
  const checked =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;
  // The server will not open a saved page: told as that, in its own words, with the way out that works (a retry would fail alike).
  const cursorRefused = refusedParameter(list.error, 'page_token');

  /** A change of filter, where `''` takes one off. The address is the filters' home, and the page starts again. */
  function change(next: { state?: string; date?: string }): void {
    continuity.discard();
    setInteracted(true);
    const nextState = next.state === undefined ? state : stateOfText(next.state);
    const nextDate = next.date === undefined ? date : next.date === '' ? undefined : next.date;
    setParams(
      new URLSearchParams(
        searchOf({
          ...(nextState === undefined ? {} : { state: nextState }),
          ...(nextDate === undefined ? {} : { date: nextDate }),
        }),
      ),
      { replace: true },
    );
  }

  function clearEverything(): void {
    continuity.discard();
    setTyped({ over: undefined, value: null });
    setInteracted(true);
    setParams(new URLSearchParams(), { replace: true });
  }

  const filtering = state !== undefined || date !== undefined;
  // A page after the first can hold nothing without the list being empty (manifests move between reads): it says so, and does not go looking
  // through the earlier pages on its own.
  const empty =
    paging.page > 1 ? (
      <EmptyState
        kind="filtered"
        heading="No manifests on this page"
        announce
        action={
          <Button type="button" variant="secondary" onClick={firstPage}>
            Back to first page
          </Button>
        }
      >
        Page {paging.page} has no manifests now. Earlier pages may still have some.
      </EmptyState>
    ) : hub !== undefined ? (
      // A chosen hub is a filter too (audit B1): the list is empty at this hub, which says nothing of the others.
      <NothingAtHub
        hub={hub}
        showAllHubs={showAllHubs}
        what="manifests"
        filtered={filtering}
        clear={
          <Button type="button" variant="secondary" onClick={clearEverything}>
            Show every manifest
          </Button>
        }
      />
    ) : filtering ? (
      <EmptyState
        kind="filtered"
        heading="No manifests match"
        announce={interacted}
        action={
          <Button type="button" variant="secondary" onClick={clearEverything}>
            Show every manifest
          </Button>
        }
      >
        {`Nothing fits ${describeFilters(state, date)}. Show every manifest to start again.`}
      </EmptyState>
    ) : (
      <EmptyState kind="none" heading="No manifests yet" announce={interacted}>
        A manifest is built from the pool of confirmed pickups. It appears here once it is made.
      </EmptyState>
    );

  return (
    <>
      <title>Manifests · Melarc Ops Portal</title>
      <PageHeader
        title="Manifests"
        description="Pickup runs at your authorized hubs."
        {...(me.holds('pickup.manifest.create')
          ? { actions: <ButtonLink to="/manifests/new">Build a manifest</ButtonLink> }
          : {})}
      />
      <div className="manifest-queue" ref={queue} onClickCapture={leavePlace}>
        <QueuePanel>
          <QueueFilters
            label="Filter the manifests"
            aside={
              <div className="pickup-freshness">
                <p className="pickup-freshness__text">
                  Listed oldest first, as the server returns them.
                  {checked === undefined ? '' : ` Last checked ${checked}.`}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  loading={list.isFetching}
                  onClick={() => {
                    // The counts beside the menu are read again with the page (task C1, `AC-QSUM-09`).
                    void refreshSummary();
                    void list.refetch({ cancelRefetch: false });
                  }}
                >
                  Refresh page
                </Button>
              </div>
            }
          >
            <Field label="State">
              <Select
                value={state ?? ''}
                onChange={(event) => {
                  change({ state: event.target.value });
                }}
              >
                <option value="">Every state</option>
                {MANIFEST_FILTER_STATES.map((key) => (
                  <option key={key} value={key}>
                    {MANIFEST_STATE_MAP[key].label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="pickup-date-filter">
              <Field label="Service date" help="Day, month and year.">
                <DatePicker
                  value={dateShown}
                  onChange={(next) => {
                    setTyped({ over: date, value: next });
                    if (next === null) {
                      if (date !== undefined) change({ date: '' });
                    } else if (isFinishedDate(next)) {
                      change({ date: next });
                    }
                  }}
                />
              </Field>
              {date === undefined ? null : (
                <div className="pickup-date-filter__clear">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setTyped({ over: undefined, value: null });
                      change({ date: '' });
                    }}
                  >
                    Every service date
                  </Button>
                </div>
              )}
            </div>
          </QueueFilters>
          <ReadState<ManifestPageView>
            query={
              list.isFetching && list.status === 'success'
                ? {
                    status: 'pending',
                    data: undefined,
                    error: null,
                    refetch: list.refetch,
                    isFetching: true,
                  }
                : list
            }
            isEmpty={(data) => data.items.length === 0}
            empty={empty}
            loadingLabel="Loading the manifests…"
            skeleton={<Skeleton lines={5} />}
            permission="pickup.read"
            operation="listPickupManifests"
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
                caption="Manifests"
                columns={COLUMNS}
                rows={data.items.map((manifest) => factsOf(manifest, me.session.authorized_hubs))}
                rowKey={(row) => row.id}
                noun={{ one: 'manifest', other: 'manifests' }}
                paging={paging}
                nextPageToken={data.nextPageToken}
                card={(row) => <ManifestCard facts={row} />}
              />
            )}
          </ReadState>
        </QueuePanel>
      </div>
    </>
  );
}

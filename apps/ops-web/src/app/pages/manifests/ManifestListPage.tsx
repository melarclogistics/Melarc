import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { NoWrap, RowTitle, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { DatePicker } from '../../../components/ui/date-picker/DatePicker';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
import { Field } from '../../../components/ui/field/Field';
import { Link } from '../../../components/ui/link/Link';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
  type QueueWorkspaceHandle,
} from '../../../components/ui/templates/QueueWorkspace';
import { OperationFailure } from '../../../platform/api/api-response';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import {
  MANIFEST_FILTER_STATES,
  type ManifestFilterState,
  type ManifestView,
} from '../../../platform/manifest/manifest-shape';
import { useManifests } from '../../../platform/manifest/use-manifest-queries';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import { cannotText } from '../../../platform/problem/capability-words';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { serviceDateText } from '../pickup/pickup-presentation';
import { requestOfClick, restoreQueuePlace } from '../pickup/queue-return';
import { filtersOf, searchOf, stateOfText } from './manifest-list-filters';
import { MANIFEST_STATE_MAP } from './manifest-presentation';
import '../pickup/pickup-pages.css';

/**
 * What the list tells of a pickup run, made once from the record so that the row and the card cannot tell different things. A list of manifests
 * carries no stops and no rider's name (`listPickupManifests`): whether a rider is assigned is told, and who, on the run's own page.
 */
interface RunFacts {
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
): RunFacts {
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

/** Two facts that belong together, the second quieter beneath the first. */
function Pair({ first, second }: { readonly first: string; readonly second: string }) {
  return (
    <span className="pickup-lines">
      <span>{first}</span>
      <span className="pickup-support">{second}</span>
    </span>
  );
}

/** The state as a badge that wraps at its words in a narrow column, instead of making the column as wide as the longest state. */
function State({ state }: { readonly state: RunFacts['state'] }) {
  return (
    <span className="pickup-state">
      <StatusBadge status={state} map={MANIFEST_STATE_MAP} />
    </span>
  );
}

/**
 * The four facts of a pickup run in four columns: the code over the hub (the code is the row's header, and **a link to the run's own page**: a row opens a page and not a panel, so
 * there is no button over the row, and a keyboard, a middle click and a new tab all use the link), where the run stands, the day it is for, and the rider and how far it has come.
 */
const COLUMNS: readonly DataColumn<RunFacts>[] = [
  {
    id: 'run',
    header: 'Pickup run / hub',
    rowHeader: true,
    cell: (row) => <RowTitle code={row.code} name={row.hub} to={row.href} />,
  },
  { id: 'state', header: 'State', cell: (row) => <State state={row.state} /> },
  { id: 'date', header: 'Service date', cell: (row) => <NoWrap>{row.serviceDate}</NoWrap> },
  {
    id: 'rider',
    header: 'Rider / progress',
    cell: (row) => <Pair first={row.rider} second={row.moments} />,
  },
];

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="pickup-card__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A pickup run as a card, for a room too narrow for the columns: the state, then the facts in the order a person reads them, each under the name of its column. It holds **no control**:
 * its code is the card's heading, outside the card, and the link to the run.
 */
function RunCard({ facts }: { readonly facts: RunFacts }) {
  return (
    <>
      <div className="pickup-card__head">
        <State state={facts.state} />
      </div>
      <dl className="pickup-card__facts">
        <Fact label="Service date">{facts.serviceDate}</Fact>
        <Fact label="Hub">{facts.hub}</Fact>
        <Fact label="Rider / progress">
          <Pair first={facts.rider} second={facts.moments} />
        </Fact>
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

/** The view that shows every state. */
const ALL_VIEW = 'all';

/**
 * A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5): what the account cannot do, or, for a hub it does not work in, that.
 */
function refusalWords(problem: Problem): string {
  return problem.forbidden === 'outside-hubs'
    ? 'These pickup runs are at a hub your account does not work in.'
    : cannotText('pickup.read');
}

/**
 * Pickup runs (surfaces/ops-portal.md section 7, `/manifests`; S1.25; redesign step R7a): the manifests of the session's hubs, **never filtered by vendor** (a pickup run spans vendors), as the
 * server lists them: oldest first, narrowed by the two filters the operation has, `state` and `service_date` (OB-S1-25), each exact and combined as "and", drawn by the queue workspace
 * template. The views are the states a run moves through, the filter row holds the service date, and a run opens on a page of its own (its code is a link). **The server filters**: the screen
 * asks, in the address and in the request, and draws what comes back whole, because the part of a page that matched would pass for the whole. A run is named by its operational code, never by
 * its id; its state is a labelled badge.
 *
 * It follows the pickup queue's filters (COMPONENT_PATTERNS section 22f): the chosen values are in the address (so that a reload keeps them), a change of filter starts again at the first page,
 * and an empty list is told apart: **no pickup runs at all** is not **a filter that hides everything**, which says what was filtered and offers to take it off. A failed read stays a failure,
 * with the filters in place.
 *
 * The page of results is **a place the officer can come back to**, for one visit to a pickup run and no longer, **on the pickup queue's terms** (the same memory,
 * `platform/pickup/queue-continuity.ts`, held for this list apart from the queue's): opening a run leaves where they were (the filters stay in the address; the cursors of the pages visited,
 * the position and the run stay in the application's memory), and the browser's Back or the run's link back brings them to that page, **read again** from the server, with focus on the run if
 * it is still there. Any other way to the list starts at its first page.
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
  const workspace = useRef<QueueWorkspaceHandle>(null);
  // What the date field holds while a date is being typed, for the filter it was typed over: the field must keep what the person typed even
  // when it is not yet a date worth asking for.
  const [typed, setTyped] = useState<{ over: string | undefined; value: string | null }>({
    over: date,
    value: date ?? null,
  });
  const dateShown = typed.over === date ? typed.value : (date ?? null);
  const [interacted, setInteracted] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  // A place is for one arrival at the list: whether this one used it or it was not for this one, it is let go of once the list is on screen.
  const { discard } = continuity;
  useEffect(() => {
    discard();
  }, [discard]);

  // Once the page that was left has been read again and drawn, the officer gets their position back, and focus where nobody has put it (the
  // run they opened, else the results). Only if the page is still the one they came back to: not after a change of filter or of page.
  const restored = useRef(arrival === undefined);
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
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  const hubs = me?.session.authorized_hubs;
  const rows = useMemo(
    () =>
      list.isSuccess && hubs !== undefined
        ? list.data.items.map((manifest) => factsOf(manifest, hubs))
        : [],
    [list.isSuccess, list.data, hubs],
  );

  /** Opening a run leaves where the officer was, for the visit: a plain click on its link, which is a move in this tab. */
  function leavePlace(event: MouseEvent<HTMLDivElement>): void {
    const manifestId = requestOfClick(event, {
      selector: 'a[href]',
      key: 'href',
      // The link of a run is in its row or its card, which carry the run's id.
      idOf: (link) => link.closest<HTMLElement>('[data-row-id]')?.dataset.rowId,
    });
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

  if (me === undefined || hubs === undefined) return null;
  const updatedAt =
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
    setTyped({ over: undefined, value: null });
    change({ state: '', date: '' });
  }

  function refreshPage(): void {
    // The counts beside the menu are read again with the page (task C1, `AC-QSUM-09`). One read at a time: a press while a read is under way is that read's.
    void refreshSummary();
    void list.refetch({ cancelRefetch: false });
  }

  const filtering = state !== undefined || date !== undefined;

  const result: QueueResult<RunFacts> = (() => {
    // Any read of the page, a refresh asked for, a page or a filter, is not drawn as if the earlier rows answered it: the loading treatment takes their place, and a failure takes their place if it fails.
    if (list.status === 'pending' || (list.isFetching && list.status === 'success')) {
      return { status: 'loading' };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, {
        operation: 'listPickupManifests',
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

  // A page after the first can hold nothing without the list being empty (pickup runs move between reads): it says so, and does not go looking
  // through the earlier pages on its own.
  const pastTheEnd =
    paging.page > 1 ? (
      <EmptyStateV2
        variant="filtered-empty"
        title="No pickup runs on this page"
        headingLevel={3}
        announce
        action={
          <Button type="button" variant="secondary" onClick={firstPage}>
            Back to first page
          </Button>
        }
      >
        {`Page ${String(paging.page)} has no pickup runs now. Earlier pages may still have some.`}
      </EmptyStateV2>
    ) : undefined;

  const emptiness = {
    noun: 'pickup runs',
    none: 'A pickup run is built from the pool of confirmed pickups. It appears here once it is made.',
    announce: interacted,
    // A chosen hub is a filter too (audit B1): the list is empty at this hub, which says nothing of the others.
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: clearEverything,
        clearLabel: 'Show every pickup run',
        filteredText: `Nothing fits ${describeFilters(state, date)}. Show every pickup run to start again.`,
      }
    : emptiness;

  return (
    <>
      <title>Pickup runs · Melarc Ops Portal</title>
      <div onClickCapture={leavePlace}>
        <QueueWorkspace<RunFacts>
          ref={workspace}
          header={{
            title: 'Pickup runs',
            description: 'Runs built from confirmed pickups at your authorized hubs.',
            freshness: {
              state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
              ...(updatedAt === undefined ? {} : { updatedAt }),
              onRefresh: refreshPage,
            },
            ...(me.holds('pickup.manifest.create')
              ? { actions: <ButtonLink to="/manifests/new">Build a pickup run</ButtonLink> }
              : {}),
          }}
          views={{
            label: 'Views of the pickup runs',
            value: state ?? ALL_VIEW,
            onValueChange: (id) => {
              change({ state: stateOfText(id) ?? '' });
            },
            tabs: [
              { id: ALL_VIEW, label: 'All' },
              ...MANIFEST_FILTER_STATES.map((key) => ({
                id: key,
                label: MANIFEST_STATE_MAP[key].label,
              })),
            ],
          }}
          filters={{
            label: 'Filter the pickup runs',
            chips:
              date === undefined
                ? []
                : [{ id: 'date', label: `Service date: ${serviceDateText(date)}` }],
            onRemove: () => {
              setTyped({ over: undefined, value: null });
              change({ date: '' });
            },
            sortLabel: 'Oldest first, as the server lists them',
            filterOpen,
            onFilterOpenChange: setFilterOpen,
            filterPanel: (
              <Field label="Service date" help="Day, month and year.">
                <DatePicker
                  value={dateShown}
                  onChange={(next) => {
                    setTyped({ over: date, value: next });
                    if (next === null) {
                      if (date !== undefined) change({ date: '' });
                    } else if (isFinishedDate(next)) {
                      change({ date: next });
                      setFilterOpen(false);
                    }
                  }}
                />
              </Field>
            ),
          }}
          result={result}
          empty={empty}
          {...(pastTheEnd === undefined ? {} : { emptyState: pastTheEnd })}
          table={{
            label: 'Pickup runs',
            columns: COLUMNS,
            rowId: (row) => row.id,
            density: 'two-line',
            card: (row) => <RunCard facts={row} />,
            // The code is the heading of each card, for heading navigation, and the link to the run.
            cardTitle: (row) => (
              <Link to={row.href}>
                <OperationalCode>{row.code}</OperationalCode>
              </Link>
            ),
            ...(result.status === 'ready' && list.isSuccess
              ? {
                  footer: (
                    <QueuePager
                      label="Pages of pickup runs"
                      noun={{ one: 'pickup run', other: 'pickup runs' }}
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
        />
      </div>
    </>
  );
}

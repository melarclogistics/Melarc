import { useEffect, useMemo, useRef, useState, type ReactNode, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { type DataColumn } from '../../../components/ui/data-table/DataTable';
import { Field } from '../../../components/ui/field/Field';
import { Input } from '../../../components/ui/input/Input';
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
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import { refusalText } from '../../../platform/problem/capability-words';
import { problemOf, type Problem } from '../../../platform/problem/problem-copy';
import {
  RIDER_STATUSES,
  type RiderStatus,
  type RiderView,
} from '../../../platform/rider/rider-shape';
import { useRiders } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import {
  deviceSentence,
  pinSentence,
  RIDER_STATUS_MAP,
  RIDER_STATUS_ORDER,
} from './rider-presentation';
import './riders.css';

/** The longest search the server accepts (`listRiders`, `q`). */
const SEARCH_LIMIT = 128;

/** The view that shows every status. */
const ALL_VIEW = 'all';

/** A status from the address, or nothing: an address is the person's to edit, and a value that is not a status is no filter. */
const statusOf = (text: string | null): RiderStatus | undefined =>
  RIDER_STATUSES.find((status) => status === text);

/**
 * What the roster tells of a rider, made once from the record so that the row and the card cannot tell different things. **Identity and readiness only**: the answer carries no PIN, no
 * hash and no key, `rider-shape.ts` reads none, and this has nowhere to hold one. Whether a PIN is set and whether a device is active are said, as facts, apart from the status.
 */
interface RiderFacts {
  readonly id: string;
  readonly name: string;
  readonly phone: string;
  readonly href: string;
  readonly status: RiderStatus;
  readonly pinSaid: string;
  readonly deviceSaid: string;
  readonly hub: string;
}

function factsOf(
  rider: RiderView,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): RiderFacts {
  return {
    id: rider.id,
    name: rider.full_name,
    phone: rider.phone,
    href: `/admin/riders/${rider.id}`,
    status: rider.status,
    pinSaid: pinSentence(rider),
    deviceSaid: deviceSentence(rider),
    hub: hubNameOf(rider.primary_hub_id, hubs),
  };
}

/** The status as a badge that wraps at its words in a narrow column ("Temporarily unavailable"), instead of making the column as wide as the longest status. */
function State({ status }: { readonly status: RiderStatus }) {
  return <StatusBadge status={status} map={RIDER_STATUS_MAP} wraps />;
}

/**
 * The five facts of a rider in five columns: the name over the phone (the name is the row's header, and **a link to the rider's own page**: a row opens a page and not a panel, so there is
 * no button over the row, and a keyboard, a middle click and a new tab all use the link), where the rider stands (administratively), then whether a PIN is set and whether a device is
 * active (readiness, told as facts and apart from the status), and the hub.
 */
const COLUMNS: readonly DataColumn<RiderFacts>[] = [
  {
    id: 'rider',
    header: 'Rider / phone',
    rowHeader: true,
    cell: (row) => (
      <span className="rider-title">
        <Link to={row.href}>{row.name}</Link>
        <span className="rider-title__support">{row.phone}</span>
      </span>
    ),
  },
  { id: 'status', header: 'Status', cell: (row) => <State status={row.status} /> },
  { id: 'pin', header: 'PIN', cell: (row) => row.pinSaid },
  { id: 'device', header: 'Device', cell: (row) => row.deviceSaid },
  { id: 'hub', header: 'Hub', cell: (row) => row.hub },
];

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="rider-card__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * A rider as a card, for a room too narrow for the columns: the status, then the facts in the order a person reads them, each under the name of its column. It holds **no control**: the
 * name is the card's heading, outside the card, and the link to the rider.
 */
function RiderCard({ facts }: { readonly facts: RiderFacts }) {
  return (
    <>
      <div className="rider-card__head">
        <State status={facts.status} />
      </div>
      <dl className="rider-card__facts">
        <Fact label="Phone">{facts.phone}</Fact>
        <Fact label="PIN">{facts.pinSaid}</Fact>
        <Fact label="Device">{facts.deviceSaid}</Fact>
        <Fact label="Hub">{facts.hub}</Fact>
      </dl>
    </>
  );
}

/** A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5): what the account cannot do, or, for a hub it does not work in, that. */
function refusalWords(problem: Problem): string {
  return refusalText(problem.forbidden, 'dispatch.read', { of: 'riders' });
}

/**
 * Riders (surfaces/ops-portal.md section 7, `/admin/riders`; S0.60a; redesign step R7b): the roster an officer finds a rider on, to register a device for the rider, replace a handset or
 * report one lost, drawn by the queue workspace template (the reference pattern: the pickup run list, `/manifests`). It shows **identity and readiness only**: the name, the phone, the
 * status, the hub, whether a PIN is set and whether a device is active. Never a PIN, a hash or a key: the screen has nowhere to show any. Which riders the session may see is the
 * server's decision (each rider's primary hub); **the server filters** (the status, the views of the page, and the search, a field in the filter row's popover that shows as a chip,
 * both in the address) **and pages** (by token, for the filters it was made with): the screen draws what comes back, whole.
 */
export function RiderListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const status = statusOf(params.get('status'));

  // The hub the person narrowed the screens to in the top bar, if they did: a filter of the list like the status, so a change of hub is a new list.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();

  // A page token belongs to the filters it was made with: a change of any of them starts again at the first page.
  const signature = `${status ?? ''}|${q}|${hubId ?? ''}`;
  const paging = useQueuePaging(signature);
  const list = useRiders({
    q,
    ...(status === undefined ? {} : { status }),
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const [typing, setTyping] = useState({ over: q, text: q });
  const draft = typing.over === q ? typing.text : q;
  const [interacted, setInteracted] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  const hubs = me?.session.authorized_hubs;
  const rows = useMemo(
    () =>
      list.isSuccess && hubs !== undefined
        ? list.data.items.map((rider) => factsOf(rider, hubs))
        : [],
    [list.isSuccess, list.data, hubs],
  );

  if (me === undefined || hubs === undefined) return null;
  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;

  /** A change of filter, where `''` takes one off. The address is the filters' home, and the page starts again. */
  function change(next: { status?: RiderStatus | ''; q?: string }): void {
    setInteracted(true);
    const nextStatus =
      next.status === undefined ? status : next.status === '' ? undefined : next.status;
    const nextQ = next.q ?? q;
    const out = new URLSearchParams();
    if (nextStatus !== undefined) out.set('status', nextStatus);
    if (nextQ !== '') out.set('q', nextQ);
    setParams(out, { replace: true });
  }

  function search(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    change({ q: draft.trim() });
    setFilterOpen(false);
  }

  const result: QueueResult<RiderFacts> = (() => {
    // Any read of the page, a refresh asked for, a page or a filter, is not drawn as if the earlier rows answered it: the loading treatment takes their place, and a failure takes their place if it fails.
    if (list.status === 'pending' || (list.isFetching && list.status === 'success')) {
      return { status: 'loading' };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, { operation: 'listRiders' });
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

  const filtering = q !== '' || status !== undefined;
  const emptiness = {
    noun: 'riders',
    none: 'The riders of your hubs appear here once they are on the roster.',
    announce: interacted,
    // A chosen hub is a filter too (audit B1): the roster is empty at this hub, which says nothing of the others.
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: () => {
          change({ status: '', q: '' });
        },
        clearLabel: 'Show every rider',
        filteredText: 'Nothing fits this view and search. Show every rider to start again.',
      }
    : emptiness;

  return (
    <>
      <title>Riders · Melarc Ops Portal</title>
      <QueueWorkspace<RiderFacts>
        ref={workspace}
        header={{
          title: 'Riders',
          description: 'The riders at your hubs, and whether each is ready to sign in.',
          freshness: {
            state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: () => {
              void list.refetch({ cancelRefetch: false });
            },
          },
        }}
        views={{
          label: 'Views of the riders',
          value: status ?? ALL_VIEW,
          onValueChange: (id) => {
            change({ status: statusOf(id) ?? '' });
          },
          tabs: [
            { id: ALL_VIEW, label: 'All' },
            ...RIDER_STATUS_ORDER.map((key) => ({ id: key, label: RIDER_STATUS_MAP[key].label })),
          ],
        }}
        filters={{
          label: 'Filter the riders',
          chips: q === '' ? [] : [{ id: 'q', label: `Search: ${q}` }],
          onRemove: () => {
            change({ q: '' });
          },
          filterOpen,
          onFilterOpenChange: setFilterOpen,
          filterPanel: (
            <form className="rider-search" role="search" noValidate onSubmit={search}>
              <Field label="Search by name or phone">
                <Input
                  type="search"
                  name="q"
                  value={draft}
                  maxLength={SEARCH_LIMIT}
                  autoComplete="off"
                  onChange={(event) => {
                    setTyping({ over: q, text: event.target.value });
                  }}
                />
              </Field>
              <Button type="submit" variant="secondary">
                Search
              </Button>
            </form>
          ),
        }}
        result={result}
        empty={empty}
        table={{
          label: 'Riders',
          columns: COLUMNS,
          rowId: (row) => row.id,
          density: 'two-line',
          card: (row) => <RiderCard facts={row} />,
          // The name is the heading of each card, for heading navigation, and the link to the rider.
          cardTitle: (row) => <Link to={row.href}>{row.name}</Link>,
          // The pager is in the page whatever the table is doing, so that its status region is the same one while a page is read (the review of 499399c).
          footer: (
            <QueuePager
              label="Pages of riders"
              noun={{ one: 'rider', other: 'riders' }}
              shown={result.status === 'ready' && list.isSuccess ? rows.length : undefined}
              page={paging.page}
              hasNext={list.isSuccess && list.data.nextPageToken !== null}
              onNext={() => {
                if (list.isSuccess && list.data.nextPageToken !== null) {
                  paging.toNextPage(list.data.nextPageToken);
                }
              }}
              onPrevious={paging.toPreviousPage}
            />
          ),
        }}
      />
    </>
  );
}

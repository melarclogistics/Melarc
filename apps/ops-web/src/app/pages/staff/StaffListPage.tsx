import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { RowTitle, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { EmptyStateV2 } from '../../../components/ui/empty-state/EmptyStateV2';
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
import { problemOf } from '../../../platform/problem/problem-copy';
import { useRefreshQueueSummary } from '../../../platform/queue-summary/use-queue-summary';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import type { StaffIdentityView, StaffStatus } from '../../../platform/staff/staff-shape';
import { useAssignableBundles, useStaffList } from '../../../platform/staff/use-staff-queries';
import { formatInstant } from '../../../platform/time/format-time';
import {
  defaultViewFor,
  hubNameOf,
  roleNameOf,
  STAFF_STATUS_MAP,
  STAFF_VIEWS,
  statusOfView,
  viewOf,
  type StaffView,
} from './staff-presentation';

/** The longest search the server accepts (`listStaffIdentities`, `q`). */
const SEARCH_LIMIT = 128;

const VIEW_ORDER = Object.keys(STAFF_VIEWS) as StaffView[];

/**
 * What the list tells of a person, made once from the record so that the row and the card cannot tell different things. The role is told only to a session that may read the roles:
 * for anyone else the column is left out, because "Another role" on every row would tell them nothing.
 */
interface ProfileFacts {
  readonly id: string;
  readonly name: string;
  readonly href: string;
  readonly email: string;
  readonly status: StaffStatus;
  readonly role: string | undefined;
  readonly hub: string;
}

/** The status as a badge, on one line: the column takes its width. */
function Status({ status }: { readonly status: StaffStatus }) {
  return <StatusBadge status={status} map={STAFF_STATUS_MAP} />;
}

const PERSON: DataColumn<ProfileFacts> = {
  id: 'person',
  header: 'Name / work email',
  rowHeader: true,
  // The name is a link to the profile and is the row's header: a row opens a page and not a panel, so there is no button over the row.
  cell: (row) => <RowTitle title={row.name} name={row.email} to={row.href} />,
};
const STATUS: DataColumn<ProfileFacts> = {
  id: 'status',
  header: 'Status',
  cell: (row) => <Status status={row.status} />,
};
// The name and the status are what a person is picked by. The role comes next, and the hub last: at a hub the people mostly share one, and it is the first to go where the box is short (the table
// takes the lesser columns away, the most lesser first, only as far as it takes for it not to scroll sideways, and a card shows every fact).
const ROLE: DataColumn<ProfileFacts> = {
  id: 'role',
  header: 'Role',
  priority: 2,
  cell: (row) => row.role ?? '',
};
const HUB: DataColumn<ProfileFacts> = {
  id: 'hub',
  header: 'Hub',
  priority: 3,
  cell: (row) => row.hub,
};

/** The facts of a person in four columns, or in three for a session that may not read the roles. */
const COLUMNS: readonly DataColumn<ProfileFacts>[] = [PERSON, STATUS, ROLE, HUB];
const COLUMNS_WITHOUT_ROLE: readonly DataColumn<ProfileFacts>[] = [PERSON, STATUS, HUB];

/**
 * A person as a card, for a room too narrow for the columns: the status, the work email under it, then the facts in the order a person reads them, each a label and its value (`CardFacts`).
 * It holds **no control**: the name is the card's heading, outside the card, and the link to the profile.
 */
function ProfileCard({ facts }: { readonly facts: ProfileFacts }) {
  return (
    <CardFacts
      head={<Status status={facts.status} />}
      lead={facts.email}
      facts={[
        ...(facts.role === undefined ? [] : [{ label: 'Role', value: facts.role }]),
        { label: 'Hub', value: facts.hub },
      ]}
    />
  );
}

/**
 * Staff (surfaces/ops-portal.md section 7, `/admin/staff`; redesign step R7b): the people with a staff profile at the session's hubs, and the approver's queue,
 * which is the same list filtered to the profiles waiting for a decision. It is drawn by the queue workspace template (COMPONENT_PATTERNS, *QueueWorkspace*): the views are
 * the statuses a profile has, the search by name or email is a field in the filter row, always there, and a chip when it is applied, and a person opens on a page of their own
 * (their name is a link). A person who can approve opens on the queue, because that is what they came for; anyone else opens on everyone. The view and the search are in
 * the address, so a link (the landing's "Review the queue") and the Back button mean what they say; the page of results is not, because a token the server gave is only
 * good for the list it was given for.
 *
 * Whom the session may see is the server's decision (scoped to its hubs); what this page hides decides nothing. The one count it draws is exact only where it can be: the
 * whole of the approver's queue on one page.
 */
export function StaffListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const canApprove = me?.holds('staff.identity.approve') === true;
  const canCreate = me?.holds('staff.identity.create') === true;
  const canReadRoles = me?.holds('permission.assignable_bundle.read') === true;

  const view = viewOf(params.get('view')) ?? defaultViewFor(canApprove);
  const q = (params.get('q') ?? '').trim();

  // The hub the person narrowed the screens to in the top bar, if they did: a filter of the list like the view, so a change of hub is a new list.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();

  // The tokens of the pages visited, for the list they were given for: a token is only good for the filter that produced it.
  const signature = `${view}|${q}|${hubId ?? ''}`;
  const paging = useQueuePaging(signature);

  const status = statusOfView(view);
  const list = useStaffList({
    ...(status === undefined ? {} : { status }),
    ...(hubId === undefined ? {} : { hubId }),
    q,
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const bundles = useAssignableBundles(canReadRoles);
  const refreshSummary = useRefreshQueueSummary();

  const [interacted, setInteracted] = useState(false);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been
  // read, whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const settled = !list.isFetching && (list.isSuccess || list.isError);
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  const hubs = me?.session.authorized_hubs;
  const roles = bundles.data;
  const rows = useMemo(
    () =>
      list.isSuccess && hubs !== undefined
        ? list.data.items.map((person: StaffIdentityView): ProfileFacts => ({
            id: person.id,
            name: person.full_name,
            href: `/admin/staff/${person.id}`,
            email: person.work_email,
            status: person.status,
            role: roles === undefined ? undefined : roleNameOf(person.role_bundle_id, roles),
            hub: hubNameOf(person.primary_hub_id, hubs),
          }))
        : [],
    [list.isSuccess, list.data, hubs, roles],
  );

  if (me === undefined || hubs === undefined) return null;

  // The roles are part of what the list shows, so the list is not drawn until they are in, or known not to come.
  const waitingForRoles = canReadRoles && bundles.isPending;
  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;

  function refreshPage(): void {
    // The count beside the menu is read again with the page (task C1, `AC-QSUM-09`). One read at a time: a press while a read is under way is that read's.
    void refreshSummary();
    void list.refetch({ cancelRefetch: false });
  }

  /** A change of view or of search. The address is their home, and the page starts again. */
  function change(next: { view?: StaffView; q?: string }): void {
    setInteracted(true);
    const nextView = next.view ?? view;
    const nextQ = next.q ?? q;
    const out = new URLSearchParams();
    out.set('view', nextView);
    if (nextQ !== '') out.set('q', nextQ);
    setParams(out, { replace: true });
  }

  function showEveryone(): void {
    setInteracted(true);
    setParams(new URLSearchParams({ view: 'all' }), { replace: true });
  }

  const result: QueueResult<ProfileFacts> = (() => {
    // A page being read, or the roles it is to be drawn with: the loading treatment, and not the rows of the page before.
    if (
      list.status === 'pending' ||
      (list.isFetching && list.status === 'success') ||
      (list.isSuccess && waitingForRoles)
    ) {
      return { status: 'loading' };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, { operation: 'listStaffIdentities' });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale') {
        return { status: 'loading' };
      }
      const message =
        problem.kind === 'forbidden'
          ? refusalText(problem.forbidden, 'staff.read', { of: 'staff profiles' })
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

  const filtering = q !== '' || view !== 'all';
  const emptiness = {
    noun: 'staff profiles',
    none: 'Profiles that are created at your hubs appear here.',
    announce: interacted,
    // A page after the first that holds nothing is told as that, in the words of every list (the Product Owner, 10 November 2026), and not as the queue being empty.
    laterPage: { page: paging.page, onFirstPage: paging.toFirstPage },
    // A chosen hub is a filter too (audit B1): nothing at this hub says nothing of the others, so it is never "nothing is waiting" or "no profiles yet".
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness = filtering
    ? {
        ...emptiness,
        filtered: true,
        onClearFilters: showEveryone,
        clearLabel: 'Show everyone',
        filteredText: 'Nothing fits this view and search. Show everyone to start again.',
      }
    : emptiness;
  // The approver's queue worked down to nothing is good news and is told as that; a search of it, or a hub, is not.
  const allClear =
    hub === undefined && q === '' && view === 'waiting' && paging.page === 1 ? (
      <EmptyStateV2
        variant="all-clear"
        title="Nothing is waiting for approval"
        headingLevel={3}
        announce={interacted}
      >
        New profiles appear here as soon as someone creates them.
      </EmptyStateV2>
    ) : undefined;

  // The whole queue is on the page: the count is exact, and it is the number an approver came for. Anywhere else the pager says what the page holds and no more.
  const wholeQueue =
    result.status === 'ready' &&
    rows.length > 0 &&
    view === 'waiting' &&
    q === '' &&
    paging.page === 1 &&
    list.isSuccess &&
    list.data.nextPageToken === null;

  return (
    <>
      <title>Staff · Melarc Ops Portal</title>
      <QueueWorkspace<ProfileFacts>
        ref={workspace}
        header={{
          title: 'Staff',
          description: 'Everyone with a staff profile at your hubs.',
          freshness: {
            state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: refreshPage,
          },
          ...(wholeQueue
            ? {
                count: {
                  value: rows.length,
                  noun:
                    rows.length === 1
                      ? 'profile waiting for approval'
                      : 'profiles waiting for approval',
                },
              }
            : {}),
          ...(canCreate
            ? { actions: <ButtonLink to="/admin/staff/new">Add a staff profile</ButtonLink> }
            : {}),
        }}
        views={{
          label: 'Views of the staff',
          value: view,
          onValueChange: (id) => {
            const next = viewOf(id);
            if (next !== undefined) change({ view: next });
          },
          tabs: VIEW_ORDER.map((key) => ({ id: key, label: STAFF_VIEWS[key].label })),
        }}
        filters={{
          label: 'Filter the staff',
          // The search is a field in the bar, always there (the Product Owner, 10 November 2026), and not behind the Filter button: this list has no other filter to choose from.
          search: {
            label: 'Search by name or email',
            value: q,
            onSearch: (text) => {
              change({ q: text });
            },
            maxLength: SEARCH_LIMIT,
          },
          chips: q === '' ? [] : [{ id: 'q', label: `Search: ${q}` }],
          onRemove: () => {
            change({ q: '' });
          },
        }}
        result={result}
        empty={empty}
        {...(allClear === undefined ? {} : { emptyState: allClear })}
        table={{
          label: 'Staff profiles',
          columns: roles === undefined ? COLUMNS_WITHOUT_ROLE : COLUMNS,
          rowId: (row) => row.id,
          density: 'two-line',
          card: (row) => <ProfileCard facts={row} />,
          // The rows open a page of their own (the link of the first line), so the lesser columns may go: their facts are in the record.
          opens: 'record',
          // The name is the heading of each card, for heading navigation, and the link to the profile.
          cardTitle: (row) => <Link to={row.href}>{row.name}</Link>,
          // The pager is in the page whatever the table is doing, so that its status region is the same one while a page is read (the review of 499399c).
          footer: (
            <QueuePager
              label="Pages of staff profiles"
              noun={{ one: 'profile', other: 'profiles' }}
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

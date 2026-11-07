import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { Icon } from '../../../components/ui/icon/Icon';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Table, type TableColumn } from '../../../components/ui/table/Table';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import type {
  AssignableBundleView,
  StaffIdentityPageView,
  StaffIdentityView,
} from '../../../platform/staff/staff-shape';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import { useAssignableBundles, useStaffList } from '../../../platform/staff/use-staff-queries';
import { NothingAtHub } from '../NothingAtHub';
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
import './staff-pages.css';

/** The longest search the server accepts (`listStaffIdentities`, `q`). */
const SEARCH_LIMIT = 128;

const VIEW_ORDER = Object.keys(STAFF_VIEWS) as StaffView[];

function countText(
  view: StaffView,
  searching: boolean,
  page: number,
  shown: number,
  more: boolean,
): string {
  const noun = shown === 1 ? 'profile' : 'profiles';
  // The whole queue is on the page: the count is exact, and it is the number an approver came for.
  if (view === 'waiting' && !searching && page === 1 && !more) {
    return `${String(shown)} ${noun} ${shown === 1 ? 'is' : 'are'} waiting for approval.`;
  }
  const where = page > 1 ? ` on page ${String(page)}` : '';
  return `Showing ${String(shown)} ${noun}${where}.${more ? ' More follow on the next page.' : ''}`;
}

/**
 * Staff (surfaces/ops-portal.md section 7, `/admin/staff`): the people with a staff profile at the session's hubs, and the approver's queue,
 * which is the same list filtered to the profiles waiting for a decision. A person who can approve opens on the queue, because that is what
 * they came for; anyone else opens on everyone. The view and the search are in the address, so a link (the landing's "Review the queue") and
 * the Back button mean what they say; the page of results is not, because a token the server gave is only good for the list it was given for.
 *
 * Whom the session may see is the server's decision (scoped to its hubs); what this page hides decides nothing.
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
  const [paging, setPaging] = useState<{ signature: string; tokens: readonly string[] }>({
    signature,
    tokens: [],
  });
  const tokens = paging.signature === signature ? paging.tokens : [];
  const pageToken = tokens.at(-1);
  const page = tokens.length + 1;

  const status = statusOfView(view);
  const list = useStaffList({
    ...(status === undefined ? {} : { status }),
    ...(hubId === undefined ? {} : { hubId }),
    q,
    ...(pageToken === undefined ? {} : { pageToken }),
    enabled: me !== undefined,
  });
  const bundles = useAssignableBundles(canReadRoles);

  // What the person typed and has not sent yet. It follows the address when the address changes (Back, a link): what was typed is
  // kept with the search it was typed over, and is the search again as soon as that is not the one in the address.
  const [typing, setTyping] = useState({ over: q, text: q });
  const draft = typing.over === q ? typing.text : q;

  const [interacted, setInteracted] = useState(false);
  const results = useRef<HTMLDivElement>(null);
  const focusResults = useRef(false);
  useEffect(() => {
    if (focusResults.current && list.status === 'success') {
      focusResults.current = false;
      results.current?.focus();
    }
  }, [list.status, list.data]);

  if (me === undefined) return null;

  const roles: readonly AssignableBundleView[] | undefined = bundles.data;
  // The roles are part of what the list shows, so the list is not drawn until they are in, or known not to come.
  const waitingForRoles = canReadRoles && bundles.isPending;
  const query = {
    status: list.status === 'success' && waitingForRoles ? ('pending' as const) : list.status,
    data: list.data,
    error: list.error,
    refetch: list.refetch,
    isFetching: list.isFetching,
  };

  function change(next: { view?: StaffView; q?: string }): void {
    setInteracted(true);
    const nextView = next.view ?? view;
    const nextQ = next.q ?? q;
    const out = new URLSearchParams();
    out.set('view', nextView);
    if (nextQ !== '') out.set('q', nextQ);
    setParams(out, { replace: true });
  }

  function search(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    change({ q: draft.trim() });
  }

  const columns: TableColumn<StaffIdentityView>[] = [
    {
      key: 'name',
      header: 'Name',
      rowHeader: true,
      cell: (row) => (
        <span className="staff-nowrap">
          <Link to={`/admin/staff/${row.id}`}>{row.full_name}</Link>
        </span>
      ),
    },
    {
      key: 'email',
      header: 'Work email',
      cell: (row) => <span className="staff-nowrap">{row.work_email}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} map={STAFF_STATUS_MAP} />,
    },
    ...(roles === undefined
      ? []
      : [
          {
            key: 'role',
            header: 'Role',
            cell: (row: StaffIdentityView) => roleNameOf(row.role_bundle_id, roles),
          },
        ]),
    {
      key: 'hub',
      header: 'Hub',
      cell: (row) => hubNameOf(row.primary_hub_id, me.session.authorized_hubs),
    },
  ];

  const showEveryone = (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        setInteracted(true);
        setParams(new URLSearchParams({ view: 'all' }), { replace: true });
      }}
    >
      Show everyone
    </Button>
  );
  const addProfile = canCreate ? (
    <ButtonLink to="/admin/staff/new">Add a staff profile</ButtonLink>
  ) : undefined;
  const announce = interacted;

  const empty =
    hub !== undefined ? (
      // A chosen hub is a filter too (audit B1): nothing at this hub says nothing of the others, so it is never "nothing is waiting" or "no profiles yet".
      <NothingAtHub
        hub={hub}
        showAllHubs={showAllHubs}
        what="staff profiles"
        filtered={q !== '' || view !== 'all'}
        clear={showEveryone}
      />
    ) : q === '' && view === 'waiting' ? (
      <EmptyState kind="none" heading="Nothing is waiting for approval" announce={announce}>
        New profiles appear here as soon as someone creates them.
      </EmptyState>
    ) : q === '' && view === 'all' ? (
      <EmptyState kind="none" heading="No staff profiles yet" announce={announce}>
        Profiles that are created at your hubs appear here.
      </EmptyState>
    ) : (
      <EmptyState
        kind="filtered"
        heading="No profiles match"
        announce={announce}
        action={showEveryone}
      >
        Nothing fits this view and search. Show everyone to start again.
      </EmptyState>
    );

  function goTo(nextTokens: readonly string[]): void {
    focusResults.current = true;
    setPaging({ signature, tokens: nextTokens });
  }

  return (
    <>
      <title>Staff · Melarc Ops Portal</title>
      <PageHeader
        title="Staff"
        description="Everyone with a staff profile at your hubs."
        actions={addProfile}
      />

      <form className="staff-filters" role="search" noValidate onSubmit={search}>
        <Field label="Show">
          <Select
            value={view}
            onChange={(event) => {
              const next = viewOf(event.target.value);
              if (next !== undefined) change({ view: next });
            }}
          >
            {VIEW_ORDER.map((key) => (
              <option key={key} value={key}>
                {STAFF_VIEWS[key].label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="staff-filters__search">
          <Field label="Search by name or email">
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
        </div>
        <div className="staff-filters__submit">
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>

      <ReadState<StaffIdentityPageView>
        query={query}
        isEmpty={(data) => data.items.length === 0}
        empty={empty}
        loadingLabel="Loading staff…"
        skeleton={<Skeleton lines={4} />}
        permission="staff.read"
        operation="listStaffIdentities"
      >
        {(data) => {
          const nextToken = data.nextPageToken;
          return (
            <>
              <p className="staff-count" role="status">
                {countText(view, q !== '', page, data.items.length, data.nextPageToken !== null)}
              </p>
              <div className="staff-results" ref={results} tabIndex={-1}>
                <Table
                  caption="Staff profiles"
                  hideCaption
                  columns={columns}
                  rows={data.items}
                  rowKey={(row) => row.id}
                />
              </div>
              {tokens.length > 0 || data.nextPageToken !== null ? (
                <nav className="staff-pager" aria-label="Pages">
                  {tokens.length > 0 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        goTo(tokens.slice(0, -1));
                      }}
                    >
                      <Icon name="previous" size="sm" />
                      Previous page
                    </Button>
                  ) : null}
                  {nextToken === null ? null : (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        goTo([...tokens, nextToken]);
                      }}
                    >
                      Next page
                      <Icon name="next" size="sm" />
                    </Button>
                  )}
                </nav>
              ) : null}
            </>
          );
        }}
      </ReadState>
    </>
  );
}

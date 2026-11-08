import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
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
import {
  RIDER_STATUSES,
  type RiderPageView,
  type RiderStatus,
  type RiderView,
} from '../../../platform/rider/rider-shape';
import { useRiders } from '../../../platform/rider/use-rider-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { hubNameOf } from '../staff/staff-presentation';
import {
  deviceSentence,
  pinSentence,
  RIDER_STATUS_MAP,
  RIDER_STATUS_ORDER,
} from './rider-presentation';
import '../staff/staff-pages.css';

/** The longest search the server accepts (`listRiders`, `q`). */
const SEARCH_LIMIT = 128;

/** A status from the address, or nothing: an address is the person's to edit, and a value that is not a status is no filter. */
const statusOf = (text: string | null): RiderStatus | undefined =>
  RIDER_STATUSES.find((status) => status === text);

/**
 * Riders (surfaces/ops-portal.md section 7, `/admin/riders`; S0.60a): the roster an officer finds a rider on, to register a device for the
 * rider, replace a handset or report one lost. It shows **identity and readiness only**: the name, the phone, the status, the hub, whether a PIN
 * is set and whether a device is active. Never a PIN, a hash or a key: the screen has nowhere to show any. Which riders the session may see is the
 * server's decision (each rider's primary hub); the search and the status are in the address, the page of results is not.
 */
export function RiderListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const status = statusOf(params.get('status'));

  // The tokens of the pages visited, for the list they were given for: a token is only good for the filter that produced it.
  const signature = `${status ?? ''}|${q}`;
  const [paging, setPaging] = useState<{ signature: string; tokens: readonly string[] }>({
    signature,
    tokens: [],
  });
  const tokens = paging.signature === signature ? paging.tokens : [];
  const pageToken = tokens.at(-1);
  const list = useRiders({
    q,
    ...(status === undefined ? {} : { status }),
    ...(pageToken === undefined ? {} : { pageToken }),
    enabled: me !== undefined,
  });
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
  }

  const columns: TableColumn<RiderView>[] = [
    {
      key: 'name',
      header: 'Rider',
      rowHeader: true,
      cell: (row) => (
        <span className="staff-nowrap">
          <Link to={`/admin/riders/${row.id}`}>{row.full_name}</Link>
        </span>
      ),
    },
    {
      key: 'phone',
      header: 'Phone',
      cell: (row) => <span className="staff-nowrap">{row.phone}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} map={RIDER_STATUS_MAP} />,
    },
    { key: 'pin', header: 'PIN', cell: (row) => pinSentence(row) },
    { key: 'device', header: 'Device', cell: (row) => deviceSentence(row) },
    {
      key: 'hub',
      header: 'Hub',
      cell: (row) => hubNameOf(row.primary_hub_id, me.session.authorized_hubs),
    },
  ];

  const filtering = q !== '' || status !== undefined;
  const empty = filtering ? (
    <EmptyState
      kind="filtered"
      heading="No riders match"
      announce={interacted}
      action={
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            change({ status: '', q: '' });
          }}
        >
          Show every rider
        </Button>
      }
    >
      Nothing fits this view and search. Show every rider to start again.
    </EmptyState>
  ) : (
    <EmptyState kind="none" heading="No riders yet" announce={interacted}>
      The riders of your hubs appear here once they are on the roster.
    </EmptyState>
  );

  return (
    <>
      <title>Riders · Melarc Ops Portal</title>
      <PageHeader
        title="Riders"
        description="The riders at your hubs, and whether each is ready to sign in."
      />
      <form className="staff-filters" role="search" noValidate onSubmit={search}>
        <Field label="Status">
          <Select
            value={status ?? ''}
            onChange={(event) => {
              change({ status: statusOf(event.target.value) ?? '' });
            }}
          >
            <option value="">Every status</option>
            {RIDER_STATUS_ORDER.map((key) => (
              <option key={key} value={key}>
                {RIDER_STATUS_MAP[key].label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="staff-filters__search">
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
        </div>
        <div className="staff-filters__submit">
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </div>
      </form>

      <ReadState<RiderPageView>
        query={list}
        isEmpty={(data) => data.items.length === 0}
        empty={empty}
        loadingLabel="Loading riders…"
        skeleton={<Skeleton lines={4} />}
        permission="dispatch.read"
        operation="listRiders"
      >
        {(data) => {
          const nextToken = data.nextPageToken;
          const shown = data.items.length;
          return (
            <>
              <p className="staff-count" role="status">
                {`Showing ${String(shown)} ${shown === 1 ? 'rider' : 'riders'}${tokens.length > 0 ? ` on page ${String(tokens.length + 1)}` : ''}.${nextToken === null ? '' : ' More follow on the next page.'}`}
              </p>
              <div className="staff-results" ref={results} tabIndex={-1}>
                <Table
                  caption="Riders"
                  hideCaption
                  columns={columns}
                  rows={data.items}
                  rowKey={(row) => row.id}
                />
              </div>
              {tokens.length > 0 || nextToken !== null ? (
                <nav className="staff-pager" aria-label="Pages">
                  {tokens.length > 0 ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => {
                        focusResults.current = true;
                        setPaging({ signature, tokens: tokens.slice(0, -1) });
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
                        focusResults.current = true;
                        setPaging({ signature, tokens: [...tokens, nextToken] });
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

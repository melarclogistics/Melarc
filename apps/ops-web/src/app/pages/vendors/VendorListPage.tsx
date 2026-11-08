import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useSearchParams } from 'react-router';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { Button } from '../../../components/ui/button/Button';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Field } from '../../../components/ui/field/Field';
import { Icon } from '../../../components/ui/icon/Icon';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Table, type TableColumn } from '../../../components/ui/table/Table';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import { useVendorAccounts } from '../../../platform/vendor/use-vendor-queries';
import type {
  VendorAccountPageView,
  VendorAccountView,
} from '../../../platform/vendor/vendor-shape';
import { NothingAtHub } from '../NothingAtHub';
import { hubNameOf } from '../staff/staff-presentation';
import { secretSentence, VENDOR_STATUS_MAP } from './vendor-presentation';
import '../staff/staff-pages.css';

/** The longest search the server accepts (`listVendorAccounts`, `q`). */
const SEARCH_LIMIT = 128;

/**
 * Vendor accounts (surfaces/ops-portal.md section 7, `/admin/vendors`; S0.52b): the identifier, the organisation, the status, whether a secret
 * exists and how many browsers are active, for every account the session's grant reaches. **Never a credential or a recovery address**: the
 * screen has nowhere to show either. Which accounts the session may see is the server's decision (each organisation's responsible hub); the
 * search is in the address, the page of results is not.
 */
export function VendorListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  // The hub the person narrowed the screens to in the top bar, if they did: a filter of the list like the search, so a change of hub is a new list.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const signature = `${q}|${hubId ?? ''}`;
  const [paging, setPaging] = useState<{ signature: string; tokens: readonly string[] }>({
    signature,
    tokens: [],
  });
  const tokens = paging.signature === signature ? paging.tokens : [];
  const pageToken = tokens.at(-1);
  const list = useVendorAccounts({
    ...(hubId === undefined ? {} : { hubId }),
    q,
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

  function search(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    setInteracted(true);
    const next = draft.trim();
    setParams(next === '' ? new URLSearchParams() : new URLSearchParams({ q: next }), {
      replace: true,
    });
  }

  const columns: TableColumn<VendorAccountView>[] = [
    {
      key: 'identifier',
      header: 'Account',
      rowHeader: true,
      cell: (row) => (
        <span className="staff-nowrap">
          <Link to={`/admin/vendors/${row.id}`}>{row.account_identifier}</Link>
        </span>
      ),
    },
    { key: 'organisation', header: 'Organisation', cell: (row) => row.legal_name },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} map={VENDOR_STATUS_MAP} />,
    },
    { key: 'secret', header: 'Secret', cell: (row) => secretSentence(row) },
    { key: 'browsers', header: 'Active browsers', cell: (row) => String(row.active_device_count) },
    {
      key: 'hub',
      header: 'Hub',
      cell: (row) => hubNameOf(row.responsible_hub_id, me.session.authorized_hubs),
    },
  ];

  const clearSearch = (
    <Button
      type="button"
      variant="secondary"
      onClick={() => {
        setInteracted(true);
        setParams(new URLSearchParams(), { replace: true });
      }}
    >
      Clear the search
    </Button>
  );
  const empty =
    hub !== undefined ? (
      // A chosen hub is a filter too (audit B1): no account at this hub says nothing of the others, so it is never "no vendor accounts yet".
      <NothingAtHub
        hub={hub}
        showAllHubs={showAllHubs}
        what="vendor accounts"
        filtered={q !== ''}
        clear={clearSearch}
      />
    ) : q === '' ? (
      <EmptyState kind="none" heading="No vendor accounts yet" announce={interacted}>
        Accounts of the vendors at your hubs appear here once their organisation is approved.
      </EmptyState>
    ) : (
      <EmptyState
        kind="filtered"
        heading="No accounts match"
        announce={interacted}
        action={clearSearch}
      >
        Nothing fits this search. Clear it to see every account.
      </EmptyState>
    );

  return (
    <>
      <title>Vendors · Melarc Ops Portal</title>
      <PageHeader title="Vendors" description="The accounts of the vendors your session reaches." />
      <form className="staff-filters" role="search" noValidate onSubmit={search}>
        <div className="staff-filters__search">
          <Field label="Search by organisation or account">
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

      <ReadState<VendorAccountPageView>
        query={list}
        isEmpty={(data) => data.items.length === 0}
        empty={empty}
        loadingLabel="Loading vendor accounts…"
        skeleton={<Skeleton lines={4} />}
        permission="vendor.read"
        operation="listVendorAccounts"
      >
        {(data) => {
          const nextToken = data.nextPageToken;
          const shown = data.items.length;
          return (
            <>
              <p className="staff-count" role="status">
                {`Showing ${String(shown)} ${shown === 1 ? 'account' : 'accounts'}${tokens.length > 0 ? ` on page ${String(tokens.length + 1)}` : ''}.${nextToken === null ? '' : ' More follow on the next page.'}`}
              </p>
              <div className="staff-results" ref={results} tabIndex={-1}>
                <Table
                  caption="Vendor accounts"
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

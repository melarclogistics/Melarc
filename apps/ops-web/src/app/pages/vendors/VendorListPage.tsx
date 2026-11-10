import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

import { CardFacts } from '../../../components/ui/card-facts/CardFacts';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { RowTitle, type DataColumn } from '../../../components/ui/data-table/DataTable';
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
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { useVendorAccounts } from '../../../platform/vendor/use-vendor-queries';
import type { VendorAccountView } from '../../../platform/vendor/vendor-shape';
import { hubNameOf } from '../staff/staff-presentation';
import { secretSentence, VENDOR_STATUS_MAP } from './vendor-presentation';
import './vendors.css';

/** The longest search the server accepts (`listVendorAccounts`, `q`). */
const SEARCH_LIMIT = 128;

/**
 * What the list tells of a vendor account, made once from the record so that the row and the card cannot tell different things. **Never a credential or a recovery address**:
 * the answer carries neither, `vendor-shape.ts` reads neither, and this has nowhere to hold one.
 */
interface AccountFacts {
  readonly id: string;
  readonly code: string;
  readonly organisation: string;
  readonly href: string;
  readonly status: VendorAccountView['status'];
  readonly secret: string;
  readonly browsers: string;
  readonly hub: string;
}

function factsOf(
  account: VendorAccountView,
  hubs: readonly { readonly id: string; readonly display_name: string }[],
): AccountFacts {
  return {
    id: account.id,
    code: account.account_identifier,
    organisation: account.legal_name,
    href: `/admin/vendors/${account.id}`,
    status: account.status,
    secret: secretSentence(account),
    browsers: String(account.active_device_count),
    hub: hubNameOf(account.responsible_hub_id, hubs),
  };
}

/** The status as a badge, on one line: the column takes its width. */
function State({ status }: { readonly status: AccountFacts['status'] }) {
  return <StatusBadge status={status} map={VENDOR_STATUS_MAP} />;
}

/**
 * The five facts of an account in five columns: the identifier over the organisation (the identifier is the row's header, and **a link to the account's own page**: a row opens a page
 * and not a panel, so there is no button over the row, and a keyboard, a middle click and a new tab all use the link), where the account stands, whether the vendor has set its
 * shared secret (said, never shown), how many browsers are active, and the hub. The account and its status are what an officer finds an account by; the secret and the count of browsers are
 * facts beside them (marked lesser, 2) and the hub the last (3): the table takes the lesser columns away, the most lesser first, only as far as it takes for it not to scroll sideways, and a card
 * shows every fact.
 */
const COLUMNS: readonly DataColumn<AccountFacts>[] = [
  {
    id: 'account',
    header: 'Account / organisation',
    rowHeader: true,
    cell: (row) => <RowTitle code={row.code} name={row.organisation} to={row.href} />,
  },
  { id: 'status', header: 'Status', cell: (row) => <State status={row.status} /> },
  { id: 'secret', header: 'Secret', priority: 2, cell: (row) => row.secret },
  {
    id: 'browsers',
    header: 'Active browsers',
    align: 'end',
    priority: 2,
    cell: (row) => row.browsers,
  },
  { id: 'hub', header: 'Hub', priority: 3, cell: (row) => row.hub },
];

/**
 * An account as a card, for a room too narrow for the columns: the status, the organisation under it, then the facts in the order a person reads them, each a label and its value
 * (`CardFacts`). It holds **no control**: its identifier is the card's heading, outside the card, and the link to the account.
 */
function AccountCard({ facts }: { readonly facts: AccountFacts }) {
  return (
    <CardFacts
      head={<State status={facts.status} />}
      lead={facts.organisation}
      facts={[
        { label: 'Secret', value: facts.secret },
        { label: 'Active browsers', value: facts.browsers },
        { label: 'Hub', value: facts.hub },
      ]}
    />
  );
}

/** A refusal in the words of the screen, never a permission key or a role (PRODUCT_DESIGN_DIRECTION section 6.5): what the account cannot do, or, for a hub it does not work in, that. */
function refusalWords(problem: Problem): string {
  return refusalText(problem.forbidden, 'vendor.read', { of: 'vendor accounts' });
}

/**
 * Vendor accounts (surfaces/ops-portal.md section 7, `/admin/vendors`; S0.52b; redesign step R7b): the identifier, the organisation, the status, whether a secret exists and how many
 * browsers are active, for every account the session's grant reaches, drawn by the queue workspace template (the reference pattern: the pickup run list, `/manifests`). **Never a
 * credential or a recovery address**: the screen has nowhere to show either. Which accounts the session may see is the server's decision (each organisation's responsible hub); **the server
 * searches** (the text is sent as `q`, and is in the address, so that a reload keeps it) **and pages** (by token, for the search it was made with): the screen draws what comes back, whole.
 * The search is a field in the filter row, always there, and shows as a chip that can be taken off; an empty list is told as no accounts at all, as a search that hides everything, or as nothing
 * at the chosen hub, and a failed read stays a failure with the search in place.
 */
export function VendorListPage() {
  const me = useSignedInSession();
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  // The hub the person narrowed the screens to in the top bar, if they did: a filter of the list like the search, so a change of hub is a new list.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const signature = `${q}|${hubId ?? ''}`;
  // A page token belongs to the filters it was made with: a change of any of them starts again at the first page.
  const paging = useQueuePaging(signature);
  const list = useVendorAccounts({
    ...(hubId === undefined ? {} : { hubId }),
    q,
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const [interacted, setInteracted] = useState(false);

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
        ? list.data.items.map((account) => factsOf(account, hubs))
        : [],
    [list.isSuccess, list.data, hubs],
  );

  if (me === undefined || hubs === undefined) return null;
  const updatedAt =
    list.dataUpdatedAt > 0 ? formatInstant(new Date(list.dataUpdatedAt).toISOString()) : undefined;

  function search(text: string): void {
    setInteracted(true);
    setParams(text === '' ? new URLSearchParams() : new URLSearchParams({ q: text }), {
      replace: true,
    });
  }

  function clearSearch(): void {
    setInteracted(true);
    setParams(new URLSearchParams(), { replace: true });
  }

  const result: QueueResult<AccountFacts> = (() => {
    // Any read of the page, a refresh asked for, a page or a search, is not drawn as if the earlier rows answered it: the loading treatment takes their place, and a failure takes their place if it fails.
    if (list.status === 'pending' || (list.isFetching && list.status === 'success')) {
      return { status: 'loading' };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, { operation: 'listVendorAccounts' });
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

  const emptiness = {
    noun: 'vendor accounts',
    none: 'Accounts of the vendors at your hubs appear here once their organisation is approved.',
    announce: interacted,
    // A page after the first that holds nothing is told as that, in the words of every list (the Product Owner, 10 November 2026), and not as the list being empty.
    laterPage: { page: paging.page, onFirstPage: paging.toFirstPage },
    // A chosen hub is a filter too (audit B1): no account at this hub says nothing of the others, so it is never "no vendor accounts yet".
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };
  const empty: QueueEmptiness =
    q === ''
      ? emptiness
      : {
          ...emptiness,
          filtered: true,
          onClearFilters: clearSearch,
          clearLabel: 'Clear the search',
          filteredText: 'Nothing fits this search. Clear it to see every account.',
        };

  return (
    <>
      <title>Vendors · Melarc Ops Portal</title>
      <QueueWorkspace<AccountFacts>
        ref={workspace}
        header={{
          title: 'Vendors',
          description: 'The accounts of the vendors your session reaches.',
          freshness: {
            state: list.isFetching ? 'refreshing' : list.isError ? 'failed' : 'idle',
            ...(updatedAt === undefined ? {} : { updatedAt }),
            onRefresh: () => {
              void list.refetch({ cancelRefetch: false });
            },
          },
        }}
        filters={{
          label: 'Filter the vendor accounts',
          // The search is a field in the bar, always there (the Product Owner, 10 November 2026), and not behind the Filter button: this list has no other filter to choose from.
          search: {
            label: 'Search by organisation or account',
            value: q,
            onSearch: search,
            maxLength: SEARCH_LIMIT,
          },
          chips: q === '' ? [] : [{ id: 'q', label: `Search: ${q}` }],
          onRemove: clearSearch,
        }}
        result={result}
        empty={empty}
        table={{
          label: 'Vendor accounts',
          columns: COLUMNS,
          rowId: (row) => row.id,
          density: 'two-line',
          card: (row) => <AccountCard facts={row} />,
          // The identifier is the heading of each card, for heading navigation, and the link to the account.
          cardTitle: (row) => (
            <Link to={row.href}>
              <OperationalCode>{row.code}</OperationalCode>
            </Link>
          ),
          // The pager is in the page whatever the table is doing, so that its status region is the same one while a page is read (the review of 499399c).
          footer: (
            <QueuePager
              label="Pages of vendor accounts"
              noun={{ one: 'account', other: 'accounts' }}
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

import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { DataTable, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { Panel } from '../../../components/ui/panel/Panel';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { useApiClient } from '../../../platform/api/api-client';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { useVendorAccount, type VendorRecord } from '../../../platform/vendor/use-vendor-queries';
import {
  recoverVendorCredential,
  reissueVendorSetupLink,
} from '../../../platform/vendor/vendor-commands';
import type { RegisteredDeviceView } from '../../../platform/vendor/vendor-shape';
import { hubNameOf } from '../staff/staff-presentation';
import { UUID } from '../staff/WithProfile';
import {
  channelSentence,
  DEVICE_STATUS_MAP,
  registeredBySentence,
  secretSentence,
  VENDOR_STATUS_MAP,
} from './vendor-presentation';
import './vendors.css';

type Act = 'reissue' | 'recover';

/** The way up from the account's header and from its other states: the list of accounts. */
const WAY_UP = [{ label: 'Vendors', to: '/admin/vendors' }] as const;

/** Focus to the heading when a page replaces the one that was loading in the same place (see `WithProfile`). */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body)
      document.querySelector<HTMLElement>('h1')?.focus();
  }, []);
}

function AccountNotFound() {
  useFocusFallenToHeading();
  return (
    <>
      <title>Account not found · Melarc Ops Portal</title>
      <PageHeader title="Account not found" breadcrumb={WAY_UP} />
      <p>{copyFor({ operation: 'getVendorAccount', code: 'NOT_FOUND' })}</p>
    </>
  );
}

function OutsideHubs() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="outside-hubs" />;
}

function NoAccess() {
  useFocusFallenToHeading();
  return <ForbiddenPage kind="permission-missing" permission="vendor.read" />;
}

/** One browser of the account as a card, for a room too narrow for the columns: its status, then the facts, each under its name. */
function BrowserCard({
  device,
  organisation,
}: {
  readonly device: RegisteredDeviceView;
  readonly organisation: ReactNode;
}) {
  return (
    <>
      <div className="vendor-card__head">
        <StatusBadge status={device.status} map={DEVICE_STATUS_MAP} />
      </div>
      <dl className="vendor-card__facts">
        <div className="vendor-card__fact">
          <dt>Registered</dt>
          <dd>
            {device.registered_at === undefined
              ? 'Not recorded'
              : (formatInstant(device.registered_at) ?? 'Not recorded')}
          </dd>
        </div>
        <div className="vendor-card__fact">
          <dt>Registered by</dt>
          <dd>{organisation}</dd>
        </div>
      </dl>
    </>
  );
}

/** The account that was read, and what the session may do with it. It is given the read itself and does not ask again. */
function Account({
  id,
  record,
  query,
}: {
  readonly id: string;
  readonly record: VendorRecord;
  readonly query: UseQueryResult<VendorRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [act, setAct] = useState<Act | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);
  // The page draws its own heading once the account is read (the one the wrapper drew while it loaded is gone): focus is put on it, as on any record page.
  useFocusFallenToHeading();

  if (me === undefined) return null;
  const { account, devices, etag } = record;
  const refreshing = query.isFetching;
  // An account that already holds a secret is recovered, not set up again (STATE_CONFLICT on a re-issue); one that holds none is set up.
  const mayReissue = !account.credential_established && me.holds('vendor.organization.approve');
  const mayRecover = account.credential_established && me.holds('vendor.credential.recover');
  const where = channelSentence(account).toLowerCase();

  function finish(message: string): void {
    setAct(undefined);
    setNotice(message);
    void query.refetch();
  }
  function reload(): Promise<unknown> {
    setAct(undefined);
    return query.refetch();
  }

  // A browser the vendor registered itself is the organisation's act, never a person's: the account is shared (AC-SLICE-000-15).
  const columns: DataColumn<RegisteredDeviceView>[] = [
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusBadge status={row.status} map={DEVICE_STATUS_MAP} />,
    },
    {
      id: 'registered',
      header: 'Registered',
      cell: (row) =>
        row.registered_at === undefined
          ? 'Not recorded'
          : (formatInstant(row.registered_at) ?? 'Not recorded'),
    },
    { id: 'by', header: 'Registered by', cell: (row) => registeredBySentence(row, account) },
  ];

  return (
    <>
      <RecordPage
        breadcrumb={WAY_UP}
        header={{
          code: account.account_identifier,
          status: <StatusBadge status={account.status} map={VENDOR_STATUS_MAP} />,
          sentence:
            account.status === 'SUSPENDED'
              ? 'This account cannot sign in while it is suspended.'
              : 'This account can sign in.',
        }}
        // The acts follow the account's secret and the held keys and decide nothing: a new setup link for an account with no secret, a recovery for one that holds one.
        acts={{
          ...(mayReissue
            ? {
                primary: (
                  <Button
                    type="button"
                    loading={refreshing}
                    onClick={() => {
                      setAct('reissue');
                    }}
                  >
                    Send a new setup link
                  </Button>
                ),
              }
            : {}),
          ...(mayRecover
            ? {
                secondary: (
                  <Button
                    type="button"
                    variant="secondary"
                    loading={refreshing}
                    onClick={() => {
                      setAct('recover');
                    }}
                  >
                    Start recovery
                  </Button>
                ),
              }
            : {}),
        }}
        notice={
          notice === undefined ? undefined : (
            <div ref={noticeBox} tabIndex={-1}>
              <Alert variant="success">
                <p>{notice}</p>
              </Alert>
            </div>
          )
        }
        main={
          <>
            <Panel title="The account" headingLevel={2}>
              <div className="vendor-facts-groups">
                <DescriptionList
                  items={[
                    { label: 'Organisation', value: account.legal_name },
                    {
                      label: 'Hub',
                      value: hubNameOf(account.responsible_hub_id, me.session.authorized_hubs),
                    },
                  ]}
                />
                <DescriptionList
                  heading="Sign-in"
                  headingLevel={3}
                  items={[
                    { label: 'Shared secret', value: secretSentence(account) },
                    { label: 'Where links go', value: channelSentence(account) },
                    { label: 'Active browsers', value: String(account.active_device_count) },
                  ]}
                />
              </div>
            </Panel>
            {devices.length === 0 ? (
              <Panel title="Browsers" headingLevel={2}>
                <p>No browser has been registered for this account.</p>
              </Panel>
            ) : (
              <Panel title="Browsers" headingLevel={2} padding="none">
                <DataTable<RegisteredDeviceView>
                  label="Browsers of the account"
                  columns={columns}
                  rows={devices}
                  rowId={(row) => row.id}
                  card={(row) => (
                    <BrowserCard device={row} organisation={registeredBySentence(row, account)} />
                  )}
                  cardHeadingLevel={3}
                />
              </Panel>
            )}
          </>
        }
      />

      <ReasonConfirmationDialog
        open={act === 'reissue'}
        title="Send a new setup link?"
        consequence={
          <p>
            A new link is sent to {where}, with the account identifier. Any earlier link stops
            working. The vendor still sets its own secret.
          </p>
        }
        confirmLabel="Send new link"
        confirmVariant="primary"
        operation="reissueVendorCredentialSetup"
        version={etag}
        send={(command) =>
          reissueVendorSetupLink(client, id, command.version ?? etag, {
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={(grant) => {
          const until = formatInstant(grant.expiresAt);
          finish(
            `A new setup link is on its way to ${where}.${until === undefined ? '' : ` It works until ${until}.`}`,
          );
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />

      <ReasonConfirmationDialog
        open={act === 'recover'}
        title="Start recovery?"
        consequence={
          <p>
            A recovery link is sent to {where}, with the account identifier. Nothing changes until
            the vendor uses it; then its secret is replaced, every session ends and every browser
            but the one used must be registered again. You never see the new secret.
          </p>
        }
        confirmLabel="Send recovery link"
        confirmVariant="primary"
        operation="recoverVendorCredential"
        version={etag}
        send={(command) =>
          recoverVendorCredential(client, id, command.version ?? etag, {
            reasonCode: command.reasonCode,
            ...(command.note === undefined ? {} : { note: command.note }),
          })
        }
        onDone={(outcome) => {
          const until = formatInstant(outcome.expiresAt);
          finish(
            outcome.coalesced
              ? `A recovery link sent to ${where} a moment ago can still be used, so no new one was sent.`
              : `A recovery link is on its way to ${where}.${until === undefined ? '' : ` It works until ${until}.`}`,
          );
        }}
        onCancel={() => {
          setAct(undefined);
        }}
        onReload={reload}
      />
    </>
  );
}

function Reading({ id }: { readonly id: string }) {
  const query = useVendorAccount(id);
  if (query.status === 'error') {
    const problem = problemOf(query.error, { operation: 'getVendorAccount' });
    if (problem.kind === 'not-found') return <AccountNotFound />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs')
      return <OutsideHubs />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'permission-missing')
      return <NoAccess />;
  }
  const title = query.data?.account.account_identifier ?? 'Vendor account';
  return (
    <>
      <title>{`${title} · Melarc Ops Portal`}</title>
      {query.status === 'success' ? (
        <Account id={id} record={query.data} query={query} />
      ) : (
        // Loading, or a failure that is not one of the pages above: the page still has its heading and its way up, and says what is happening.
        <>
          <PageHeader title="Vendor account" breadcrumb={WAY_UP} />
          <ReadState<VendorRecord>
            query={query}
            isEmpty={() => false}
            empty={null}
            loadingLabel="Loading the account…"
            skeleton={<Skeleton lines={4} />}
            permission="vendor.read"
            operation="getVendorAccount"
          >
            {() => null}
          </ReadState>
        </>
      )}
    </>
  );
}

/**
 * One vendor account (surfaces/ops-portal.md section 7, `/admin/vendors/{id}`; S0.52b; redesign step R7b, the record template, as the pickup run's page is): its authentication status and
 * its browsers, and the two acts on its credential: **re-issue a lapsed setup link** for an account with no secret (the approval authority, at the vendor's own hub) and **start
 * exceptional recovery** for one that holds one (Platform Admin, every hub). Each act sends the version the page read and a reason, in the question of its own dialog, which is also where
 * what it does is told; each refusal names its own capability in plain words. **The secret and every link are never displayed**: no answer holds one and the page has no field for one.
 * An account outside the session's hubs and one that does not exist are pages of their own. A browser the vendor registered is attributed to the organisation, never to a person
 * (AC-SLICE-000-15).
 */
export function VendorDetailPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <AccountNotFound />;
  return <Reading key={id} id={id} />;
}

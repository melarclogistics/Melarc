import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { ReasonConfirmationDialog } from '../../../components/ui/reason-confirmation/ReasonConfirmationDialog';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Table, type TableColumn } from '../../../components/ui/table/Table';
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
import '../staff/staff-pages.css';

type Act = 'reissue' | 'recover';

function BackToVendors() {
  return (
    <p className="staff-back">
      <Link to="/admin/vendors">Back to vendors</Link>
    </p>
  );
}

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
      <PageHeading>Account not found</PageHeading>
      <p>{copyFor({ operation: 'getVendorAccount', code: 'NOT_FOUND' })}</p>
      <BackToVendors />
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

  if (me === undefined) return null;
  const { account, devices, etag } = record;
  const organisation = account.legal_name;
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

  const columns: TableColumn<RegisteredDeviceView>[] = [
    {
      key: 'status',
      header: 'Status',
      rowHeader: true,
      cell: (row) => <StatusBadge status={row.status} map={DEVICE_STATUS_MAP} />,
    },
    {
      key: 'registered',
      header: 'Registered',
      cell: (row) =>
        row.registered_at === undefined ? 'Not recorded' : formatInstant(row.registered_at),
    },
    { key: 'by', header: 'Registered by', cell: (row) => registeredBySentence(row, account) },
  ];

  return (
    <>
      {notice === undefined ? null : (
        <div className="staff-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>{notice}</p>
          </Alert>
        </div>
      )}

      <p className="staff-status">
        <StatusBadge status={account.status} map={VENDOR_STATUS_MAP} />{' '}
        <span>
          {account.status === 'SUSPENDED'
            ? 'This account cannot sign in while it is suspended.'
            : 'This account can sign in.'}
        </span>
      </p>

      <dl className="staff-facts">
        <dt>Account</dt>
        <dd>{account.account_identifier}</dd>
        <dt>Organisation</dt>
        <dd>{organisation}</dd>
        <dt>Hub</dt>
        <dd>{hubNameOf(account.responsible_hub_id, me.session.authorized_hubs)}</dd>
        <dt>Shared secret</dt>
        <dd>{secretSentence(account)}</dd>
        <dt>Where links go</dt>
        <dd>{channelSentence(account)}</dd>
        <dt>Active browsers</dt>
        <dd>{String(account.active_device_count)}</dd>
      </dl>

      {mayReissue || mayRecover ? (
        <section className="staff-actions" aria-labelledby="vendor-actions">
          <h2 id="vendor-actions">What you can do</h2>
          {mayReissue ? (
            <div>
              <p className="staff-action__text">
                If the vendor’s first setup link expired or never arrived, send a new one to {where}
                .
              </p>
              <div className="staff-action__buttons">
                <Button
                  type="button"
                  variant="secondary"
                  loading={refreshing}
                  onClick={() => {
                    setAct('reissue');
                  }}
                >
                  Send a new setup link
                </Button>
              </div>
            </div>
          ) : null}
          {mayRecover ? (
            <div>
              <p className="staff-action__text">
                If the vendor has lost its shared secret, or someone who knew it should no longer
                use it, send a recovery link to {where}. Using it replaces the secret and every
                browser of the account.
              </p>
              <div className="staff-action__buttons">
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
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="vendor-browsers">
        <h2 id="vendor-browsers">Browsers</h2>
        {devices.length === 0 ? (
          <p>No browser has been registered for this account.</p>
        ) : (
          <Table
            caption="Browsers of the account"
            hideCaption
            columns={columns}
            rows={devices}
            rowKey={(row) => row.id}
          />
        )}
      </section>

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
      <BackToVendors />
      <PageHeader
        title={title}
        {...(query.data === undefined ? {} : { description: query.data.account.legal_name })}
      />
      {query.status === 'success' ? (
        <Account id={id} record={query.data} query={query} />
      ) : (
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
      )}
    </>
  );
}

/**
 * One vendor account (surfaces/ops-portal.md section 7, `/admin/vendors/{id}`; S0.52b): its authentication status and its browsers, and the
 * two acts on its credential: **re-issue a lapsed setup link** for an account with no secret (the approval authority, at the vendor's own hub)
 * and **start exceptional recovery** for one that holds one (Platform Admin, every hub). Each act sends the version the page read and a
 * reason; each refusal names its own permission. **The secret and every link are never displayed**: no answer holds one and the page has no
 * field for one. An account outside the session's hubs and one that does not exist are pages of their own. A browser the vendor registered is
 * attributed to the organisation, never to a person (AC-SLICE-000-15).
 */
export function VendorDetailPage() {
  const { id = '' } = useParams();
  if (!UUID.test(id)) return <AccountNotFound />;
  return <Reading key={id} id={id} />;
}

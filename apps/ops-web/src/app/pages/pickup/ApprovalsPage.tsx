import { useEffect, useRef, useState } from 'react';

// eslint-disable-next-line no-restricted-imports -- the older PageHeader: this screen moves to the kit's when it is rebuilt (task R5.2, M12)
import { PageHeader } from '../../../components/PageHeader';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { EmptyState } from '../../../components/ui/empty-state/EmptyState';
import { Link } from '../../../components/ui/link/Link';
import { QueueTable } from '../../../components/ui/queue-table/QueueTable';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import type { TableColumn } from '../../../components/ui/table/Table';
import { useApiClient } from '../../../platform/api/api-client';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import { approveOnePackageException } from '../../../platform/pickup/pickup-commands';
import type {
  ApprovalView,
  OnePackageExceptionView,
  PickupRequestPageView,
  PickupRequestView,
} from '../../../platform/pickup/pickup-shape';
import { usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { NothingAtHub } from '../NothingAtHub';
import { hubNameOf } from '../staff/staff-presentation';
import { actorText, isSelf, packagesText, PICKUP_STATE_MAP } from './pickup-presentation';
import './pickup-pages.css';

/** A row of the queue: a request and the exception it waits on (the query refuses a page where a request carries none in that state). */
interface Waiting {
  readonly request: PickupRequestView;
  readonly exception: OnePackageExceptionView;
}

/** What an approval came to, as its answer said it: the request it was for and the approval record. */
interface Approved {
  readonly request: PickupRequestView;
  readonly approval: ApprovalView;
}

const rowsOf = (page: PickupRequestPageView): Waiting[] =>
  page.items.flatMap((request) =>
    request.one_package_exception === undefined
      ? []
      : [{ request, exception: request.one_package_exception }],
  );

/**
 * The one-package exceptions waiting for approval (surfaces/ops-portal.md section 7, `/approvals`; S1.19): the approver's queue, which is the
 * list of pickup requests whose exception is `REQUESTED` (`listPickupRequests` with `one_package_exception_state`), read and scoped by the
 * server, paged by its tokens. Each row says what is asked and by whom, and offers one act, the approval (`approveOnePackageException`),
 * behind a confirmation that says what it does.
 *
 * **The page decides nothing the server decides.** It says the maker-checker rule in plain words, and sends the approval whoever asked: a
 * refusal (`SELF_APPROVAL_FORBIDDEN`) is told as the rule, with the key of who can approve instead, and never a role. After an approval the
 * page shows what the answer said (approved, and by whom) and reads the queue again, which no longer holds the request; it states no fee. An
 * exception of a request that is no longer pending is shown with its state and offered no approval: the request is not going to be collected.
 */
export function ApprovalsPage() {
  const me = useSignedInSession();
  const client = useApiClient();
  // The hub the switcher chose (task C3) is one of the filters of the queue: another hub starts again at the first page.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const paging = useQueuePaging(`one-package-exceptions-requested|${hubId ?? ''}`);
  const list = usePickupRequests({
    exceptionState: 'REQUESTED',
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const [target, setTarget] = useState<Waiting | undefined>(undefined);
  const [approved, setApproved] = useState<Approved | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (approved !== undefined) noticeBox.current?.focus();
  }, [approved]);

  if (me === undefined) return null;
  const principalId = me.session.principal_id;
  const mayApprove = me.holds('pickup.exception.approve');

  function refresh(): Promise<unknown> {
    return list.refetch();
  }

  const columns: TableColumn<Waiting>[] = [
    {
      key: 'code',
      header: 'Request',
      rowHeader: true,
      cell: ({ request }) => (
        <span className="pickup-nowrap">
          <Link to={`/pickup-requests/${request.id}`}>{request.code}</Link>
        </span>
      ),
    },
    {
      key: 'sender',
      header: 'Sender',
      cell: ({ request }) => request.sender_name ?? 'Not recorded',
    },
    { key: 'packages', header: 'Packages', cell: ({ request }) => packagesText(request) },
    {
      key: 'recipient',
      header: 'Recipient',
      cell: ({ exception }) => (
        <span className="pickup-lines">
          <span>{exception.recipient.name}</span>
          <span>{exception.recipient.location.address}</span>
        </span>
      ),
    },
    { key: 'why', header: 'Why', cell: ({ exception }) => exception.note },
    {
      key: 'asked',
      header: 'Asked',
      cell: ({ exception }) => (
        <span className="pickup-lines">
          <span>{actorText(exception.requested_by, principalId)}</span>
          <span className="pickup-nowrap">{formatInstant(exception.requested_at)}</span>
        </span>
      ),
    },
    {
      key: 'hub',
      header: 'Hub',
      cell: ({ request }) => hubNameOf(request.responsible_hub_id, me.session.authorized_hubs),
    },
    {
      key: 'state',
      header: 'Request state',
      cell: ({ request }) => <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
    },
    {
      key: 'decision',
      header: 'Decision',
      cell: (row) =>
        row.request.state !== 'PENDING' ? (
          'Nothing to approve: the request is no longer waiting for confirmation.'
        ) : mayApprove ? (
          <Button
            type="button"
            aria-label={`Approve the exception of ${row.request.code}`}
            onClick={() => {
              setApproved(undefined);
              setTarget(row);
            }}
          >
            Approve
          </Button>
        ) : (
          <>
            Approving needs the permission <code>pickup.exception.approve</code>.
          </>
        ),
    },
  ];

  const approvedBy = approved?.approval.approved_by;

  return (
    <>
      <title>One-package exceptions to approve · Melarc Ops Portal</title>
      <PageHeader
        title="One-package exceptions to approve"
        description="Single-package pickups at your hubs that wait for an approval before they can be confirmed."
      />
      <p className="pickup-form-note">
        Approving an exception lets a single package be collected: the single-package pickup fee
        becomes due, and the request can then be confirmed. Whoever asked for an exception cannot
        also approve it, unless they approve at the platform’s highest tier: the server checks this.
      </p>

      {approved === undefined ? null : (
        <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
          <Alert variant="success">
            <p>
              {`The one-package exception of ${approved.request.code} is approved${
                approvedBy === undefined
                  ? ''
                  : ` by ${actorText(approvedBy, principalId).toLowerCase()}`
              }. The request can now be confirmed.`}
            </p>
            <p>
              <Link to={`/pickup-requests/${approved.request.id}`}>
                {`Open ${approved.request.code}`}
              </Link>
            </p>
          </Alert>
        </div>
      )}

      <ReadState<PickupRequestPageView>
        query={list}
        isEmpty={(data) => data.items.length === 0}
        empty={
          hub !== undefined ? (
            // A chosen hub is a filter of the queue (audit B1): nothing waiting at this hub says nothing of the others.
            <NothingAtHub
              hub={hub}
              showAllHubs={showAllHubs}
              what="one-package exceptions waiting for approval"
            />
          ) : (
            <EmptyState kind="none" heading="No exceptions waiting">
              A one-package exception appears here when an Ops officer asks for one at your hubs,
              and leaves once it is approved.
            </EmptyState>
          )
        }
        loadingLabel="Loading the exceptions waiting for approval…"
        skeleton={<Skeleton lines={4} />}
        permission="pickup.read"
        operation="listPickupRequests"
        context="approvals"
      >
        {(data) => (
          <QueueTable
            caption="One-package exceptions waiting for approval"
            columns={columns}
            rows={rowsOf(data)}
            rowKey={({ request }) => request.id}
            noun={{ one: 'exception', other: 'exceptions' }}
            paging={paging}
            nextPageToken={data.nextPageToken}
          />
        )}
      </ReadState>

      <ConfirmationDialog<ApprovalView>
        open={target !== undefined}
        title={`Approve the exception of ${target?.request.code ?? 'this request'}?`}
        consequence={
          <>
            <p>
              A single package is then collected for this request: the single-package pickup fee
              becomes due, and the request can be confirmed. An approval is not taken back.
            </p>
            {target !== undefined && isSelf(target.exception.requested_by, principalId) ? (
              <p>
                You asked for this exception yourself. Whoever asks for one cannot also approve it,
                unless they approve at the platform’s highest tier: the server decides.
              </p>
            ) : null}
          </>
        }
        confirmLabel="Approve the exception"
        operation="approveOnePackageException"
        send={() =>
          approveOnePackageException(client, target?.request.id ?? '', target?.exception.id ?? '')
        }
        onDone={(approval) => {
          if (target !== undefined) setApproved({ request: target.request, approval });
          setTarget(undefined);
          void refresh();
        }}
        onCancel={() => {
          setTarget(undefined);
        }}
        onReload={() => {
          setTarget(undefined);
          return refresh();
        }}
      />
    </>
  );
}

import { useEffect, useRef, useState, type MouseEvent } from 'react';

import { Alert } from '../../../components/ui/alert/Alert';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { RowTitle, NoWrap, type DataColumn } from '../../../components/ui/data-table/DataTable';
import { OperationalCode } from '../../../components/ui/code/OperationalCode';
import { Link } from '../../../components/ui/link/Link';
import { QueuePager } from '../../../components/ui/templates/QueuePager';
import {
  QueueWorkspace,
  type QueueEmptiness,
  type QueueResult,
  type QueueWorkspaceHandle,
} from '../../../components/ui/templates/QueueWorkspace';
import { useQueuePaging } from '../../../components/ui/queue-table/use-queue-paging';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { useApiClient } from '../../../platform/api/api-client';
import { useActiveHub, useHubScope } from '../../../platform/hub/active-hub';
import { approveOnePackageException } from '../../../platform/pickup/pickup-commands';
import { useQueueContinuity } from '../../../platform/pickup/queue-continuity-context';
import type {
  ApprovalView,
  OnePackageExceptionView,
  PickupRequestPageView,
  PickupRequestView,
} from '../../../platform/pickup/pickup-shape';
import { usePickupRequests } from '../../../platform/pickup/use-pickup-queries';
import { cannotText } from '../../../platform/problem/capability-words';
import { problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { actorText, isSelf, packagesText, PICKUP_STATE_MAP } from './pickup-presentation';
import { requestOfClick, restoreQueuePlace } from './queue-return';
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

const NOTHING_TO_APPROVE = 'Nothing to approve: the request is no longer waiting for confirmation.';

/** Two facts that belong together, the second quieter beneath the first. */
function Pair({ first, second }: { readonly first: string; readonly second: string }) {
  return (
    <span className="pickup-lines">
      <span>{first}</span>
      <span className="pickup-support">{second}</span>
    </span>
  );
}

/** One exception waiting, as a card for a room too narrow for the columns: every fact, and no control (the table draws the card's one button, and the approval). */
function WaitingCard({
  row,
  principalId,
  hubs,
}: {
  readonly row: Waiting;
  readonly principalId: string | undefined;
  readonly hubs: readonly { readonly id: string; readonly display_name: string }[];
}) {
  const { request, exception } = row;
  return (
    <>
      <p className="pickup-card__head">
        <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />
      </p>
      <p className="pickup-card__sender pickup-support">{request.sender_name ?? 'Not recorded'}</p>
      <dl className="pickup-card__facts">
        <div className="pickup-card__fact">
          <dt>Packages</dt>
          <dd>{packagesText(request)}</dd>
        </div>
        <div className="pickup-card__fact">
          <dt>Recipient</dt>
          <dd>
            <Pair first={exception.recipient.name} second={exception.recipient.location.address} />
          </dd>
        </div>
        <div className="pickup-card__fact">
          <dt>Why</dt>
          <dd>{exception.note}</dd>
        </div>
        <div className="pickup-card__fact">
          <dt>Asked</dt>
          <dd>
            <Pair
              first={actorText(exception.requested_by, principalId)}
              second={formatInstant(exception.requested_at) ?? ''}
            />
          </dd>
        </div>
        <div className="pickup-card__fact">
          <dt>Hub</dt>
          <dd>{hubNameOf(request.responsible_hub_id, hubs)}</dd>
        </div>
      </dl>
    </>
  );
}

/**
 * The one-package exceptions waiting for approval (surfaces/ops-portal.md section 7, `/approvals`; S1.19; redesign step R7a): the approver's queue, which is the list of pickup requests
 * whose exception is `REQUESTED` (`listPickupRequests` with `one_package_exception_state`), read and scoped by the server, paged by its tokens, drawn by the queue workspace template.
 * Each row says what is asked and by whom, and offers one act, the approval (`approveOnePackageException`), behind a confirmation that says what it does.
 *
 * **The page decides nothing the server decides.** It says the maker-checker rule in plain words, and sends the approval whoever asked: a refusal (`SELF_APPROVAL_FORBIDDEN`) is told as the
 * rule (a different approver decides), and never by a key or a role. After an approval the page shows what the answer said (approved, and by whom), keeps its rows while it reads the queue
 * again, which no longer holds the request, and states no fee. An exception of a request that is no longer pending is shown with its state and offered no approval: the request is not going
 * to be collected.
 */
export function ApprovalsPage() {
  const me = useSignedInSession();
  const client = useApiClient();
  // The hub the switcher chose (task C3) is one of the filters of the queue: another hub starts again at the first page.
  const hubId = useActiveHub();
  const { hub, showAllHubs } = useHubScope();
  const signature = `one-package-exceptions-requested|${hubId ?? ''}`;
  // Read once, as a state starts, from a memory that a render (or a render the development build runs twice) cannot use up.
  const continuity = useQueueContinuity('approvals');
  const [arrival] = useState(() => continuity.returningTo(signature));
  const paging = useQueuePaging(signature, arrival?.tokens);
  const list = usePickupRequests({
    exceptionState: 'REQUESTED',
    ...(hubId === undefined ? {} : { hubId }),
    ...(paging.pageToken === undefined ? {} : { pageToken: paging.pageToken }),
    enabled: me !== undefined,
  });
  const [target, setTarget] = useState<Waiting | undefined>(undefined);
  const [approved, setApproved] = useState<Approved | undefined>(undefined);
  /** The queue is read again after an approval, and its rows stay while it is (the officer keeps their place). */
  const [afterAct, setAfterAct] = useState(false);
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (approved !== undefined) noticeBox.current?.focus();
  }, [approved]);

  // The workspace's handle puts focus where a person is given back: on the results once a page is read, and on the request they opened when they come back to the queue.
  const workspace = useRef<QueueWorkspaceHandle>(null);
  const settled = !list.isFetching && (list.isSuccess || list.isError);

  // A place is for one arrival at the queue: whether this one used it or it was not for this one, it is let go of once the queue is on screen.
  const { discard } = continuity;
  useEffect(() => {
    discard();
  }, [discard]);

  // Once the page that was left has been read again and drawn, the officer gets their position back, and focus where nobody has put it (the request they opened, else the results).
  // Only if the page is still the one they came back to: not after a change of hub or of page.
  const restored = useRef(arrival === undefined);
  const stillThere =
    signature === arrival?.signature &&
    paging.tokens.length === arrival.tokens.length &&
    paging.tokens.every((token, index) => token === arrival.tokens[index]);
  useEffect(() => {
    if (arrival === undefined || restored.current || !settled) return;
    restored.current = true;
    if (stillThere && workspace.current !== null) restoreQueuePlace(workspace.current, arrival);
  }, [arrival, settled, stillThere]);

  // A move to another page leaves the pager button it was made from gone (while the next page loads), and focus would fall to the top of the document: once the page has been read,
  // whatever it holds (rows, nothing, a failure), focus goes to the results, once.
  const { takeFocus } = paging;
  useEffect(() => {
    if (!settled || !takeFocus()) return;
    workspace.current?.focusResults();
  }, [settled, list.dataUpdatedAt, takeFocus]);

  /** Opening a request leaves where the officer was, for the visit: a plain click on its link, which is a move in this tab. */
  function leavePlace(event: MouseEvent<HTMLDivElement>): void {
    const requestId = requestOfClick(event, {
      selector: 'a[href]',
      key: 'href',
      // The code is the link of its row, or of its card, which carry the request's id.
      idOf: (link) => link.closest<HTMLElement>('[data-row-id]')?.dataset.rowId,
    });
    if (requestId === undefined) return;
    continuity.leave({
      signature,
      search: '',
      tokens: paging.tokens,
      scrollY: window.scrollY,
      requestId,
    });
  }

  if (me === undefined) return null;
  const principalId = me.session.principal_id;
  const mayApprove = me.holds('pickup.exception.approve');
  const hubs = me.session.authorized_hubs;

  function refresh(): Promise<unknown> {
    setAfterAct(true);
    return list.refetch().finally(() => {
      setAfterAct(false);
    });
  }

  const columns: DataColumn<Waiting>[] = [
    {
      id: 'request',
      header: 'Request / sender',
      rowHeader: true,
      cell: ({ request }) => (
        <RowTitle
          code={request.code}
          name={request.sender_name ?? 'Not recorded'}
          to={`/pickup-requests/${request.id}`}
        />
      ),
    },
    {
      id: 'packages',
      header: 'Packages',
      priority: 3,
      cell: ({ request }) => <NoWrap>{packagesText(request)}</NoWrap>,
    },
    {
      id: 'recipient',
      header: 'Recipient',
      cell: ({ exception }) => (
        <Pair first={exception.recipient.name} second={exception.recipient.location.address} />
      ),
    },
    { id: 'why', header: 'Why', cell: ({ exception }) => exception.note },
    {
      id: 'asked',
      header: 'Asked',
      cell: ({ exception }) => (
        <Pair
          first={actorText(exception.requested_by, principalId)}
          second={formatInstant(exception.requested_at) ?? ''}
        />
      ),
    },
    {
      id: 'hub',
      header: 'Hub',
      priority: 3,
      cell: ({ request }) => hubNameOf(request.responsible_hub_id, hubs),
    },
    {
      id: 'state',
      header: 'Request state',
      cell: ({ request }) => (
        <span className="pickup-lines">
          <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />
          {request.state !== 'PENDING' ? (
            <span className="pickup-support">{NOTHING_TO_APPROVE}</span>
          ) : mayApprove ? null : (
            <span className="pickup-support">{cannotText('pickup.exception.approve')}</span>
          )}
        </span>
      ),
    },
  ];

  const rows = list.isSuccess ? rowsOf(list.data) : [];

  const result: QueueResult<Waiting> = (() => {
    if (list.status === 'pending') return { status: 'loading' };
    if (list.isFetching && list.status === 'success') {
      // After an approval the rows stay while the queue is read again; any other read again takes the loading rows' place.
      return afterAct ? { status: 'ready', rows, refreshing: true } : { status: 'loading' };
    }
    if (list.status === 'error') {
      const problem = problemOf(list.error, {
        operation: 'listPickupRequests',
        context: 'approvals',
      });
      // A session that has ended or an answer that is stale is the session boundary's, which has already taken the person away.
      if (problem.kind === 'session-ended' || problem.kind === 'stale')
        return { status: 'loading' };
      const retryable = problem.kind === 'unavailable' || problem.kind === 'rate-limited';
      return {
        status: 'error',
        message:
          problem.kind === 'forbidden' && problem.forbidden === 'permission-missing'
            ? cannotText('pickup.read')
            : problem.reference === undefined
              ? problem.message
              : `${problem.message} Reference: ${problem.reference}`,
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

  const empty: QueueEmptiness = {
    noun: 'exceptions waiting for approval',
    none: 'A one-package exception appears here when an Ops officer asks for one at your hubs, and leaves once it is approved.',
    ...(hub === undefined ? {} : { hub: { name: hub.display_name, onShowAllHubs: showAllHubs } }),
  };

  const approvedBy = approved?.approval.approved_by;
  return (
    <>
      <title>One-package exceptions to approve · Melarc Ops Portal</title>
      <div onClickCapture={leavePlace}>
        <QueueWorkspace<Waiting>
          ref={workspace}
          header={{
            title: 'One-package exceptions to approve',
            description:
              'Single-package pickups at your hubs that wait for an approval before they can be confirmed.',
          }}
          notice={
            <>
              <p className="pickup-form-note">
                Approving an exception lets a single package be collected: the single-package pickup
                fee becomes due, and the request can then be confirmed. Whoever asked for an
                exception cannot also approve it, unless they approve at the platform’s highest
                tier: the server checks this.
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
            </>
          }
          result={result}
          empty={empty}
          table={{
            label: 'One-package exceptions waiting for approval',
            columns,
            rowId: ({ request }) => request.id,
            density: 'two-line',
            card: (row) => <WaitingCard row={row} principalId={principalId} hubs={hubs} />,
            // The code is the heading of each card and the link to the request's own page.
            cardTitle: ({ request }) => (
              <Link to={`/pickup-requests/${request.id}`}>
                <OperationalCode>{request.code}</OperationalCode>
              </Link>
            ),
            rowAction: {
              label: 'Approve',
              ariaLabel: ({ request }) => `Approve the exception of ${request.code}`,
              isAvailable: ({ request }) => mayApprove && request.state === 'PENDING',
              onRun: (row) => {
                setApproved(undefined);
                setTarget(row);
              },
            },
            ...(result.status === 'ready' && list.isSuccess
              ? {
                  footer: (
                    <QueuePager
                      label="Pages of exceptions"
                      noun={{ one: 'exception', other: 'exceptions' }}
                      shown={rows.length}
                      page={paging.page}
                      hasNext={list.data.nextPageToken !== null}
                      onNext={() => {
                        if (list.data.nextPageToken !== null)
                          paging.toNextPage(list.data.nextPageToken);
                      }}
                      onPrevious={paging.toPreviousPage}
                    />
                  ),
                }
              : {}),
          }}
        />
      </div>

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

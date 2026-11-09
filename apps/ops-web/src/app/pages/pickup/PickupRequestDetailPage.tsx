import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import type { ActionMenuItem } from '../../../components/ui/action-menu/ActionMenu';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import {
  DescriptionList,
  type DescriptionItem,
} from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { MoneyAmount } from '../../../components/ui/money/MoneyAmount';
import { Panel } from '../../../components/ui/panel/Panel';
import type { Stage } from '../../../components/ui/record-header/StageTracker';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { Timeline, type TimelineEntry } from '../../../components/ui/timeline/Timeline';
import { useApiClient } from '../../../platform/api/api-client';
import { subjectLogPath } from '../../../platform/notifications/notification-shape';
import {
  cancelPickupRequest,
  escalatePickupRequest,
  extendPickupAttempts,
  resolveCutoffException,
  waiveCancellationCharge,
} from '../../../platform/pickup/pickup-commands';
import type {
  EstimateView,
  LocationView,
  OnePackageExceptionView,
  PickupRequestView,
} from '../../../platform/pickup/pickup-shape';
import type { PickupRecord } from '../../../platform/pickup/use-pickup-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { AttemptChain } from './AttemptChain';
import { EstimateSummary } from './EstimateSummary';
import { CancelRequestDialog, CutoffDialog, NoteActDialog } from './PickupActDialogs';
import { ConfirmPickupDialog } from './PickupQueuePanel';
import {
  actorText,
  cancelledByText,
  CHARGE_OUTCOME_LABELS,
  CUTOFF_LABELS,
  hasApprovedException,
  hasRequestedException,
  INTENT_LABELS,
  isSinglePackage,
  packagesText,
  PAYER_LABELS,
  PICKUP_STATE_MAP,
  serviceDateText,
  STATE_SENTENCES,
} from './pickup-presentation';
import { WithPickupRequest } from './WithPickupRequest';
import './pickup-pages.css';

/** The acts that open their own question or form from the page's primary button (the others are the menu's, and each brings its dialog). */
type Act = 'confirm' | 'cutoff' | 'waive';

/** The news of an act the API said was done: what it came to, the estimate its answer carried, and where the next attempt is. */
interface Notice {
  readonly text: string;
  readonly estimate?: EstimateView;
  readonly next?: string;
}

function Place({ location }: { readonly location: LocationView }) {
  return (
    <>
      <p>{location.address}</p>
      {location.landmark === undefined ? null : <p>{`Landmark: ${location.landmark}`}</p>}
    </>
  );
}

/** Who pays, and for a shared payment the sender's part as the booking stated it: intent, never a price. */
function Payer({ request }: { readonly request: PickupRequestView }) {
  const payer = request.default_payer_intent;
  if (payer === undefined) return 'Not recorded';
  const amount = request.split_sender_amount;
  const percentage = request.split_sender_percentage;
  if (payer !== 'SPLIT') return PAYER_LABELS[payer];
  return (
    <>
      <p>{PAYER_LABELS[payer]}</p>
      {request.split_basis === 'FIXED_AMOUNT' && amount !== undefined ? (
        <p>
          The sender pays{' '}
          <MoneyAmount amountMinor={amount.amount_minor} currency={amount.currency} /> of it.
        </p>
      ) : null}
      {request.split_basis === 'PERCENTAGE' && percentage !== undefined ? (
        <p>{`The sender pays ${String(percentage)}% of it.`}</p>
      ) : null}
    </>
  );
}

const EXCEPTION_STATE_WORDS: Readonly<Record<OnePackageExceptionView['state'], string>> = {
  REQUESTED: 'Waiting for approval',
  APPROVED: 'Approved',
  REJECTED: 'Refused',
};

/**
 * The one-package exception a request carries: where it is, who asked and when, the recipient it carries and why. The fee is told only as the
 * server snapshotted it on approval; the person who decided is "you" or another member of staff, because the read names nobody. Who may decide
 * it is told as the capability, in plain words, and never as a key.
 */
function ExceptionFacts({
  exception,
  principalId,
}: {
  readonly exception: OnePackageExceptionView;
  readonly principalId: string | undefined;
}) {
  const decided =
    exception.decided_at === undefined ? '' : ` on ${formatInstant(exception.decided_at) ?? ''}`;
  const checker =
    exception.approved_by === undefined
      ? ''
      : ` by ${actorText(exception.approved_by, principalId).toLowerCase()}`;
  const fee = exception.single_package_fee;
  return (
    <>
      <p>
        {exception.state === 'REQUESTED'
          ? 'Waiting for an approver to approve it.'
          : `${EXCEPTION_STATE_WORDS[exception.state]}${checker}${decided}.`}
      </p>
      <p>
        {`Requested by ${actorText(exception.requested_by, principalId).toLowerCase()} on ${
          formatInstant(exception.requested_at) ?? ''
        }.`}
      </p>
      {fee === undefined ? null : (
        <p>
          The single-package fee that became due:{' '}
          <MoneyAmount amountMinor={fee.amount_minor} currency={fee.currency} />.
        </p>
      )}
      <p>{`Recipient: ${exception.recipient.name}, ${exception.recipient.phone}`}</p>
      <Place location={exception.recipient.location} />
      <p>{`Why: ${exception.note}`}</p>
    </>
  );
}

/** A fact of the record, in the list it belongs to: left out when the record does not hold it. */
const fact = (label: string, value: ReactNode, held = true): readonly DescriptionItem[] =>
  held ? [{ label, value }] : [];

/**
 * The facts of the record, grouped by what they mean (PRODUCT_DESIGN_DIRECTION section 6.2): the pickup itself, who to reach and who pays, and the exceptions it carries. The page
 * places the groups: the pickup and the exceptions are the work, and the people are the side column's, beside it where there is room. A fact the record does not hold is not drawn, and
 * one it holds without a value says so in words. The record's history is told by its own dated facts, as a timeline (`historyOf`).
 */
interface FactGroups {
  readonly pickup: readonly DescriptionItem[];
  readonly people: readonly DescriptionItem[];
  readonly exceptions: readonly DescriptionItem[];
}

function useFactGroups(request: PickupRequestView): FactGroups {
  const me = useSignedInSession();
  const capAmount = request.liability_cap_snapshot?.amount_minor;
  const pickup: readonly DescriptionItem[] = [
    ...fact(
      'Booked as',
      request.pickup_intent === undefined ? undefined : INTENT_LABELS[request.pickup_intent],
    ),
    ...fact('Sender', request.sender_name, request.sender_name !== undefined),
    ...fact('Service date', serviceDateText(request.scheduled_service_date)),
    ...fact('Packages', packagesText(request)),
    ...fact(
      'Pickup at',
      request.resolved_pickup_location === undefined ? undefined : (
        <Place location={request.resolved_pickup_location} />
      ),
    ),
    ...fact(
      'Collect from',
      request.collection_point === undefined ? undefined : (
        <>
          <p>{`${request.collection_point.contact_name}, ${request.collection_point.phone}`}</p>
          <Place location={request.collection_point.location} />
          {request.collection_point.landmark === undefined ? null : (
            <p>{`Landmark: ${request.collection_point.landmark}`}</p>
          )}
        </>
      ),
      request.collection_point !== undefined,
    ),
    ...fact(
      'Seller’s reference',
      request.collection_reference === undefined ? undefined : (
        <>
          <p>{request.collection_reference.reference_name}</p>
          {request.collection_reference.seller_order_reference === undefined ? null : (
            <p>{`Order: ${request.collection_reference.seller_order_reference}`}</p>
          )}
        </>
      ),
      request.collection_reference !== undefined,
    ),
    ...fact(
      'Item to collect',
      request.collection_item === undefined ? undefined : (
        <>
          <p>
            {`${request.collection_item.description}, ${String(request.collection_item.quantity)} ${
              request.collection_item.quantity === 1 ? 'item' : 'items'
            }`}
          </p>
          {request.collection_item.handling_note === undefined ? null : (
            <p>{`Handling: ${request.collection_item.handling_note}`}</p>
          )}
        </>
      ),
      request.collection_item !== undefined,
    ),
    ...fact(
      'Today’s goods',
      request.current_item_description,
      request.current_item_description !== undefined,
    ),
    ...fact('Hub', hubNameOf(request.responsible_hub_id, me?.session.authorized_hubs ?? [])),
    ...fact('Attempt', String(request.attempt_number)),
    ...fact(
      'Rider',
      request.rider_assigned === true ? 'Assigned to the pickup run' : 'Not assigned yet',
      request.state === 'CONFIRMED' && request.rider_assigned !== undefined,
    ),
  ];
  const people: readonly DescriptionItem[] = [
    ...fact('Contact phone', request.primary_phone),
    ...fact('Second contact phone', request.secondary_phone, request.secondary_phone !== undefined),
    ...fact('Who pays', <Payer request={request} />),
    ...fact(
      'Declared value',
      request.declared_value_minor === undefined ? undefined : (
        <MoneyAmount amountMinor={request.declared_value_minor} currency="GHS" />
      ),
      request.declared_value_minor !== undefined,
    ),
    ...fact(
      'Liability cap',
      request.liability_cap_acknowledged_at === undefined ? undefined : capAmount === undefined ? (
        `Acknowledged by the sender on ${formatInstant(request.liability_cap_acknowledged_at) ?? ''}.`
      ) : (
        <>
          Capped at <MoneyAmount amountMinor={capAmount} currency="GHS" />, acknowledged by the
          sender on {formatInstant(request.liability_cap_acknowledged_at)}.
        </>
      ),
      request.liability_cap_acknowledged_at !== undefined,
    ),
  ];
  const exceptions: readonly DescriptionItem[] = [
    ...fact(
      'One-package exception',
      request.one_package_exception === undefined ? undefined : (
        <ExceptionFacts
          exception={request.one_package_exception}
          principalId={me?.session.principal_id}
        />
      ),
      request.one_package_exception !== undefined,
    ),
    ...fact(
      'Late booking',
      request.cutoff_exception_state === undefined
        ? undefined
        : CUTOFF_LABELS[request.cutoff_exception_state],
      request.cutoff_exception_state !== undefined,
    ),
    ...fact(
      'Attempt limit',
      'Extended for this request: one further attempt past the hub’s limit.',
      request.attempt_extension_id !== undefined,
    ),
  ];
  return { pickup, people, exceptions };
}

/**
 * What the record itself says happened, with when: booked, the one-package exception asked for and decided, confirmed, escalated, cancelled. **Only dated facts of the record, and
 * nothing invented**: a fuller history (who did each act, an act that left no date on the request) would need a read of the request's audit trail, which the pickup API does not
 * offer to an Ops session (the record carries the dates above and no more). Oldest first, the latest marked.
 */
function historyOf(
  request: PickupRequestView,
  principalId: string | undefined,
): readonly TimelineEntry[] {
  const chargeAmount =
    request.cancellation_charge?.amount_minor ?? request.cancellation_charge_snapshot?.amount_minor;
  const cancelledBy = cancelledByText(request);
  const exception = request.one_package_exception;
  const facts: {
    readonly at: string;
    readonly key: string;
    readonly title: string;
    readonly more?: ReactNode;
  }[] = [
    ...(request.created_at === undefined
      ? []
      : [{ at: request.created_at, key: 'booked', title: 'Booked' }]),
    ...(exception === undefined
      ? []
      : [
          {
            at: exception.requested_at,
            key: 'exception-requested',
            title: 'One-package exception asked for',
            more: <p>{`By ${actorText(exception.requested_by, principalId).toLowerCase()}.`}</p>,
          },
        ]),
    ...(exception?.decided_at === undefined
      ? []
      : [
          {
            at: exception.decided_at,
            key: 'exception-decided',
            title:
              exception.state === 'REJECTED'
                ? 'One-package exception refused'
                : 'One-package exception approved',
            ...(exception.approved_by === undefined
              ? {}
              : {
                  more: (
                    <p>{`By ${actorText(exception.approved_by, principalId).toLowerCase()}.`}</p>
                  ),
                }),
          },
        ]),
    ...(request.confirmed_at === undefined
      ? []
      : [{ at: request.confirmed_at, key: 'confirmed', title: 'Confirmed' }]),
    ...(request.escalated_at === undefined
      ? []
      : [{ at: request.escalated_at, key: 'escalated', title: 'Escalated' }]),
    ...(request.cancelled_at === undefined
      ? []
      : [
          {
            at: request.cancelled_at,
            key: 'cancelled',
            title: 'Cancelled',
            more: (
              <>
                {cancelledBy === undefined ? null : <p>{cancelledBy}</p>}
                {request.cancellation_reason?.label === undefined ? null : (
                  <p>{`Reason: ${request.cancellation_reason.label}`}</p>
                )}
                {request.cancellation_charge_outcome === undefined ? null : (
                  <p>{CHARGE_OUTCOME_LABELS[request.cancellation_charge_outcome]}</p>
                )}
                {chargeAmount === undefined ? null : (
                  <p>
                    Charge as applied: <MoneyAmount amountMinor={chargeAmount} currency="GHS" />
                  </p>
                )}
              </>
            ),
          },
        ]),
  ];
  const ordered = [...facts].sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  return ordered.map((entry, index) => ({
    key: entry.key,
    title: entry.title,
    details: (
      <>
        <p>{formatInstant(entry.at) ?? ''}</p>
        {entry.more}
      </>
    ),
    current: index === ordered.length - 1,
  }));
}

/**
 * The way a request goes, for the tracker (`contracts/state-machines.md` section 3): **one forward path**, waiting for confirmation and then confirmed, and two ends, declined (from
 * waiting) and cancelled (from either), each drawn as the end it is: the last stage, reached. A cancelled request that was confirmed has been through the confirmation; one that was
 * not has not.
 */
function stagesOf(request: PickupRequestView): {
  readonly label: string;
  readonly stages: readonly Stage[];
  readonly currentId: string;
} {
  const label = 'Progress of the pickup request';
  const waiting: Stage = { id: 'waiting', label: 'Waiting for confirmation' };
  const confirmed: Stage = { id: 'confirmed', label: 'Confirmed' };
  switch (request.state) {
    case 'PENDING':
      return { label, stages: [waiting, confirmed], currentId: 'waiting' };
    case 'CONFIRMED':
      return { label, stages: [waiting, confirmed], currentId: 'confirmed' };
    case 'DECLINED':
      return {
        label,
        stages: [waiting, { id: 'declined', label: 'Declined' }],
        currentId: 'declined',
      };
    case 'CANCELLED':
      return {
        label,
        stages: [
          waiting,
          ...(request.confirmed_at === undefined ? [] : [confirmed]),
          { id: 'cancelled', label: 'Cancelled' },
        ],
        currentId: 'cancelled',
      };
  }
}

/** Focus to the heading when the page replaces the one that was loading in the same place (the heading of the loaded request is a new element). */
function useFocusFallenToHeading(): void {
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (active === null || active === document.body) {
      document.querySelector<HTMLElement>('h1')?.focus();
    }
  }, []);
}

function Request({
  record,
  query,
}: {
  readonly record: PickupRecord;
  readonly query: UseQueryResult<PickupRecord>;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [open, setOpen] = useState<Act | undefined>(undefined);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  useFocusFallenToHeading();
  useEffect(() => {
    if (notice !== undefined) noticeBox.current?.focus();
  }, [notice]);
  const groups = useFactGroups(record.request);
  if (me === undefined) return null;
  const history = historyOf(record.request, me.session.principal_id);

  const { request, etag } = record;
  const id = request.id;
  const pending = request.state === 'PENDING';
  const confirmed = request.state === 'CONFIRMED';
  const live = pending || confirmed;
  const needsException = pending && isSinglePackage(request) && !hasApprovedException(request);
  const exceptionWaiting = needsException && hasRequestedException(request);
  const lateToDecide = confirmed && request.cutoff_exception_state === 'PENDING_OPS_REVIEW';
  const escalatedAt =
    request.escalated_at === undefined ? undefined : formatInstant(request.escalated_at);
  const chargeToWaive =
    request.state === 'CANCELLED' && request.cancellation_charge_outcome === 'APPLIED';
  // Once a rider holds the request's run, its cancellation records a charge decision either way (cancelPickupRequest); before, none.
  const decidesCharge = confirmed && request.rider_assigned === true;

  function close(): void {
    setOpen(undefined);
  }

  /** The act was done: say what it came to, keep what its answer carried, and read the request again for its new state and version. */
  function done(text: string, answer: PickupRequestView): void {
    setOpen(undefined);
    setNotice({
      text,
      ...(answer.indicative_estimate === undefined ? {} : { estimate: answer.indicative_estimate }),
      ...(answer.replacement_request_id === undefined
        ? {}
        : { next: answer.replacement_request_id }),
    });
    void query.refetch();
  }

  function reload(): Promise<unknown> {
    setOpen(undefined);
    setNotice(undefined);
    return query.refetch();
  }

  // The acts the session can take, and no other: hiding is presentation and never enforcement, and the server checks the key, the hub and the state.
  const mayConfirm = me.holds('pickup.request.confirm');
  const primary: ReactNode = (() => {
    if (pending && !needsException && mayConfirm) {
      return (
        <Button
          type="button"
          onClick={() => {
            setOpen('confirm');
          }}
        >
          Confirm the pickup
        </Button>
      );
    }
    if (needsException && !exceptionWaiting && me.holds('pickup.exception.request')) {
      return <ButtonLink to={`/pickup-requests/${id}/exception`}>Request the exception</ButtonLink>;
    }
    if (lateToDecide && mayConfirm) {
      return (
        <Button
          type="button"
          onClick={() => {
            setOpen('cutoff');
          }}
        >
          Decide the late booking
        </Button>
      );
    }
    if (chargeToWaive && me.holds('pickup.cancellation_charge.waive')) {
      return (
        <Button
          type="button"
          onClick={() => {
            setOpen('waive');
          }}
        >
          Waive the charge
        </Button>
      );
    }
    return undefined;
  })();
  const secondary: ReactNode =
    exceptionWaiting && me.holds('pickup.exception.approve') ? (
      <ButtonLink to="/approvals" variant="secondary">
        Go to the exceptions to approve
      </ButtonLink>
    ) : undefined;

  // The rarer and heavier acts: each brings its own question or form, which the menu opens in its place and gives focus back from. The destructive one is last, and the menu says so.
  const menu: ActionMenuItem[] = [
    ...(confirmed && me.holds('pickup.request.cancel')
      ? [
          {
            id: 'reschedule',
            label: 'Reschedule the pickup',
            icon: 'pickup-requests' as const,
            dialog: ({ onClose }: { readonly onClose: () => void }) => (
              <CancelRequestDialog<PickupRequestView>
                open
                mode="reschedule"
                decidesCharge={decidesCharge}
                mayCharge={me.holds('pickup.request.cancel_chargeable')}
                canExtend={me.holds('pickup.attempt.extend')}
                version={etag}
                send={(fields, version, key) =>
                  cancelPickupRequest(client, id, version, fields, key)
                }
                onDone={(answer) => {
                  const outcome =
                    answer.cancellation_charge_outcome === undefined
                      ? ''
                      : ` ${CHARGE_OUTCOME_LABELS[answer.cancellation_charge_outcome]}`;
                  onClose();
                  done(
                    `The pickup is rescheduled: this request is cancelled and its next attempt is booked.${outcome}`,
                    answer,
                  );
                }}
                onCancel={onClose}
                onReload={() => {
                  onClose();
                  return reload();
                }}
              />
            ),
          },
        ]
      : []),
    ...(confirmed && escalatedAt === undefined && me.holds('pickup.failure.resolve')
      ? [
          {
            id: 'escalate',
            label: 'Escalate the request',
            dialog: ({ onClose }: { readonly onClose: () => void }) => (
              <NoteActDialog<PickupRequestView>
                open
                title="Escalate this request?"
                consequence={
                  <p>
                    Escalation records that the request is out of the hub’s own hands. It is
                    recorded once, with your note, and is not taken back. Nothing else changes: the
                    request can still be rescheduled or cancelled.
                  </p>
                }
                confirmLabel="Escalate the request"
                noteLabel="Why it is escalated"
                noteHelp="One line: what happened, and what was decided with the vendor or sender. Leave out phone numbers and email addresses."
                operation="escalatePickupRequest"
                notePointer="/note"
                version={etag}
                retryable
                send={(note, version, key) => escalatePickupRequest(client, id, version, note, key)}
                onDone={(answer) => {
                  onClose();
                  done('The request is escalated.', answer);
                }}
                onCancel={onClose}
                onReload={() => {
                  onClose();
                  return reload();
                }}
              />
            ),
          },
        ]
      : []),
    ...(confirmed && me.holds('pickup.attempt.extend')
      ? [
          {
            id: 'extend',
            label: 'Extend the attempts',
            dialog: ({ onClose }: { readonly onClose: () => void }) => (
              <NoteActDialog<PickupRequestView>
                open
                title="Extend the attempts of this request?"
                consequence={
                  <p>
                    This allows one further attempt for this request alone, past the hub’s limit:
                    its next reschedule makes that attempt, and a reschedule after that needs
                    another extension. The setting does not change, and the extension is kept on the
                    record with your reason.
                  </p>
                }
                confirmLabel="Allow one further attempt"
                noteLabel="Why the attempts are extended"
                noteHelp="One line. It is kept with the extension and cannot be changed later. Leave out phone numbers and email addresses."
                operation="extendPickupAttempts"
                notePointer="/reason"
                version={etag}
                retryable
                send={(reason, version, key) =>
                  extendPickupAttempts(client, id, version, reason, key)
                }
                onDone={(answer) => {
                  onClose();
                  done(
                    'The attempts are extended: this request may have one further attempt. Reschedule it to make that attempt.',
                    answer,
                  );
                }}
                onCancel={onClose}
                onReload={() => {
                  onClose();
                  return reload();
                }}
              />
            ),
          },
        ]
      : []),
    ...(live && me.holds('pickup.request.cancel')
      ? [
          {
            id: 'cancel',
            label: 'Cancel the request',
            destructive: true as const,
            dialog: ({ onClose }: { readonly onClose: () => void }) => (
              <CancelRequestDialog<PickupRequestView>
                open
                mode="cancel"
                decidesCharge={decidesCharge}
                mayCharge={me.holds('pickup.request.cancel_chargeable')}
                canExtend={me.holds('pickup.attempt.extend')}
                version={etag}
                send={(fields, version, key) =>
                  cancelPickupRequest(client, id, version, fields, key)
                }
                onDone={(answer) => {
                  const outcome =
                    answer.cancellation_charge_outcome === undefined
                      ? ''
                      : ` ${CHARGE_OUTCOME_LABELS[answer.cancellation_charge_outcome]}`;
                  onClose();
                  done(`The request is cancelled.${outcome}`, answer);
                }}
                onCancel={onClose}
                onReload={() => {
                  onClose();
                  return reload();
                }}
              />
            ),
          },
        ]
      : []),
  ];

  const sentence = `${STATE_SENTENCES[request.state]}${
    escalatedAt === undefined ? '' : ` Escalated on ${escalatedAt}.`
  }`;

  // The one short line under the acts, only when it changes whether to act now (the Product Owner, 9 November 2026): why the confirmation is not offered yet. The other rules a person must
  // know before they choose an act (an escalation is recorded once and is not taken back; once a rider holds the request's run, cancelling or rescheduling it records a decision about
  // the cancellation charge) are told in the question of their act, where the choice is made, and not in paragraphs above the content.
  const note: string | undefined = exceptionWaiting
    ? 'The one-package exception is requested and waits for an approver: the request can be confirmed once it is approved.'
    : needsException
      ? 'This request is for a single package: it can be confirmed once its one-package exception is approved.'
      : undefined;

  return (
    <>
      <RecordPage
        header={{
          code: request.code,
          status: <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
          sentence,
          stages: stagesOf(request),
        }}
        acts={{
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
          menu: { label: `More actions for ${request.code}`, items: menu },
          ...(note === undefined ? {} : { note }),
        }}
        notice={
          notice === undefined ? undefined : (
            <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
              <Alert variant="success">
                <p>{notice.text}</p>
                {notice.next === undefined ? null : (
                  <p>
                    <Link to={`/pickup-requests/${notice.next}`}>Go to the new attempt</Link>
                  </p>
                )}
              </Alert>
              {notice.estimate === undefined ? null : (
                <EstimateSummary estimate={notice.estimate} />
              )}
            </div>
          )
        }
        main={
          <>
            <Panel title="The request" headingLevel={2}>
              <div className="pickup-facts-groups">
                <DescriptionList heading="Pickup" headingLevel={3} items={groups.pickup} />
                {groups.exceptions.length === 0 ? null : (
                  <DescriptionList
                    heading="Exceptions"
                    headingLevel={3}
                    items={groups.exceptions}
                  />
                )}
              </div>
            </Panel>
            {/* The estimate an act's answer carried is shown with its news; the record's own, when the read carries one, is not shown twice. */}
            {request.indicative_estimate === undefined || notice?.estimate !== undefined ? null : (
              <EstimateSummary estimate={request.indicative_estimate} />
            )}
            <Panel title="Attempts" headingLevel={2}>
              <AttemptChain request={request} />
            </Panel>
          </>
        }
        // Beside the work where the page has room (from 1280px of window), after it where it has not: who to reach and who pays, the history, and what is related.
        side={
          <>
            <Panel title="Who to reach, and who pays" headingLevel={2}>
              <DescriptionList items={groups.people} />
            </Panel>
            {history.length === 0 ? null : (
              <Panel title="History" headingLevel={2}>
                <Timeline label="History of this request, oldest first" entries={history} />
              </Panel>
            )}
            {me.holds('notification.read') ? (
              <Panel title="Related" headingLevel={2}>
                {/* The message log narrowed to this request, for a session that lists the key of the log (the server checks it all the same). */}
                <p>
                  <Link to={subjectLogPath('PICKUP_REQUEST', id)}>Messages about this request</Link>
                </p>
              </Panel>
            ) : null}
          </>
        }
      />

      <ConfirmPickupDialog
        open={open === 'confirm'}
        id={id}
        version={etag}
        onDone={(answer) => {
          done('The request is confirmed. It waits in the pool for a pickup run.', answer);
        }}
        onCancel={close}
        onReload={reload}
      />
      <CutoffDialog<PickupRequestView>
        open={open === 'cutoff'}
        version={etag}
        send={(resolution, version, key) =>
          resolveCutoffException(client, id, version, resolution, key)
        }
        onDone={(answer) => {
          done(
            answer.state === 'CANCELLED'
              ? 'The late booking is moved to the next operating day: this request is cancelled and a new one is booked.'
              : 'The late booking is approved for the same day.',
            answer,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <NoteActDialog<PickupRequestView>
        open={open === 'waive'}
        title="Waive the cancellation charge?"
        consequence={
          <p>
            The charge is relieved in full: a waiver has no amount. The charge as applied stays on
            the record, and the waiver is kept with your note.
          </p>
        }
        confirmLabel="Waive the charge"
        noteLabel="Why the charge is waived"
        noteHelp="One line, kept with the waiver."
        operation="waiveCancellationCharge"
        notePointer="/note"
        version={etag}
        retryable={false}
        send={(note, version) => waiveCancellationCharge(client, id, version, note)}
        onDone={(answer) => {
          done('The cancellation charge is waived in full.', answer);
        }}
        onCancel={close}
        onReload={reload}
      />
    </>
  );
}

/**
 * One pickup request (surfaces/ops-portal.md section 7, `/pickup-requests/{id}`; S1.19; redesign step R6): the record page template. Its header says where the request
 * stands and what can be done next (one primary act, the others in the menu, the destructive one last), its body holds the facts grouped by what they mean, the estimate when
 * an answer carried one and the attempt chain. **Every act sends the version the page read** (`If-Match`), so a concurrent edit is a `STATE_CONFLICT` that is explained and read
 * again, never a silent overwrite; the acts that take an `Idempotency-Key` send a new one each time and the same one only to try a lost answer again. A request outside the
 * session's hubs and one that does not exist are pages of their own. **An act the session cannot take is not drawn**: what is offered is a hint and decides nothing, since the
 * server checks the key, the hub and the state. An escalation is recorded once (`escalated_at`) and is then told, not offered; an extension allows one further attempt; whether
 * a rider holds the request's run decides whether a cancellation asks for the charge decision. **The tracker is the contract's one forward path** (waiting for confirmation, then
 * confirmed; declined and cancelled are drawn as the ends they are): a path through dispatch and collection is not something the request's own read carries, and is not drawn. The
 * history is the record's own dated facts as a timeline, and the people are in the side column, beside the work where there is room.
 */
export function PickupRequestDetailPage() {
  const { id = '' } = useParams();
  return (
    <WithPickupRequest
      id={id}
      ownsHeading
      heading={(request) => ({
        title: request?.code ?? 'Pickup request',
        description: 'Pickup request',
        documentTitle: request?.code ?? 'Pickup request',
      })}
    >
      {(record, query) => <Request record={record} query={query} />}
    </WithPickupRequest>
  );
}

import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import type { ActionMenuItem } from '../../../components/ui/action-menu/ActionMenu';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import {
  DescriptionList,
  type DescriptionItem,
} from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { MoneyAmount } from '../../../components/ui/money/MoneyAmount';
import { Panel } from '../../../components/ui/panel/Panel';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import { useApiClient } from '../../../platform/api/api-client';
import { subjectLogPath } from '../../../platform/notifications/notification-shape';
import {
  cancelPickupRequest,
  confirmPickupRequest,
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
 * The facts of the record, grouped by what they mean (PRODUCT_DESIGN_DIRECTION section 6.2): the pickup itself, who to reach and who pays, the exceptions it carries and its
 * history. A fact the record does not hold is not drawn, and one it holds without a value says so in words.
 */
function Facts({ request }: { readonly request: PickupRequestView }) {
  const me = useSignedInSession();
  const capAmount = request.liability_cap_snapshot?.amount_minor;
  const chargeAmount =
    request.cancellation_charge?.amount_minor ?? request.cancellation_charge_snapshot?.amount_minor;
  const cancelledBy = cancelledByText(request);
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
  const history: readonly DescriptionItem[] = [
    ...fact('Booked', formatInstant(request.created_at ?? ''), request.created_at !== undefined),
    ...fact(
      'Confirmed',
      formatInstant(request.confirmed_at ?? ''),
      request.confirmed_at !== undefined,
    ),
    ...fact(
      'Cancellation',
      <>
        {cancelledBy === undefined ? null : <p>{cancelledBy}</p>}
        {request.cancelled_at === undefined ? null : (
          <p>{`On ${formatInstant(request.cancelled_at) ?? ''}.`}</p>
        )}
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
      </>,
      request.state === 'CANCELLED',
    ),
  ];
  return (
    <div className="pickup-facts-groups">
      <DescriptionList heading="Pickup" headingLevel={3} items={pickup} />
      <DescriptionList heading="Who to reach, and who pays" headingLevel={3} items={people} />
      {exceptions.length === 0 ? null : (
        <DescriptionList heading="Exceptions" headingLevel={3} items={exceptions} />
      )}
      {history.length === 0 ? null : (
        <DescriptionList heading="History" headingLevel={3} items={history} />
      )}
    </div>
  );
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
  if (me === undefined) return null;

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

  return (
    <>
      <RecordPage
        header={{
          code: request.code,
          status: <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />,
          sentence,
        }}
        acts={{
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
          menu: { label: `More actions for ${request.code}`, items: menu },
        }}
        notice={
          <>
            {notice === undefined ? null : (
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
            )}
            {exceptionWaiting ? (
              <p className="pickup-act__text">
                The one-package exception is requested and waits for an approver. The request can be
                confirmed once it is approved.
              </p>
            ) : needsException ? (
              <p className="pickup-act__text">
                This request is for a single package. It can be confirmed only once its one-package
                exception is approved.
              </p>
            ) : null}
            {!live && !chargeToWaive ? (
              <p className="pickup-act__text">
                {request.state === 'CANCELLED'
                  ? 'A cancelled request is not changed again. Its attempts are listed below.'
                  : 'A declined request is not changed again.'}
              </p>
            ) : null}
          </>
        }
        main={
          <>
            <Panel title="The request" headingLevel={2}>
              <Facts request={request} />
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
        {...(me.holds('notification.read')
          ? {
              side: (
                <Panel title="Related" headingLevel={2}>
                  {/* The message log narrowed to this request, for a session that lists the key of the log (the server checks it all the same). */}
                  <p>
                    <Link to={subjectLogPath('PICKUP_REQUEST', id)}>
                      Messages about this request
                    </Link>
                  </p>
                </Panel>
              ),
            }
          : {})}
      />

      <ConfirmationDialog<PickupRequestView>
        open={open === 'confirm'}
        title="Confirm this pickup?"
        consequence={
          <p>
            The request joins the pool of confirmed pickups waiting for a run. Nothing is charged
            and no credit is reserved. A request booked after the hub’s cut-off is confirmed all the
            same, and waits for an Ops decision on the late booking.
          </p>
        }
        confirmLabel="Confirm the pickup"
        operation="confirmPickupRequest"
        version={etag}
        send={(command) => confirmPickupRequest(client, id, command.version ?? etag)}
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
 * a rider holds the request's run decides whether a cancellation asks for the charge decision. There is no stage tracker: the request's states are four, and a path through
 * dispatch and collection is not something the request's own read carries.
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

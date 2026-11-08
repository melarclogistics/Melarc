import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { ConfirmationDialog } from '../../../components/ui/confirmation/ConfirmationDialog';
import { Link } from '../../../components/ui/link/Link';
import { MoneyAmount } from '../../../components/ui/money/MoneyAmount';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
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
  PickupState,
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
} from './pickup-presentation';
import { WithPickupRequest } from './WithPickupRequest';
import './pickup-pages.css';

const STATE_SENTENCES: Readonly<Record<PickupState, string>> = {
  PENDING: 'It waits for an Ops officer to confirm it.',
  CONFIRMED: 'It is confirmed and waits in the pool for a pickup run.',
  DECLINED: 'It was declined.',
  CANCELLED: 'It was cancelled. Its record and its history stay.',
};

type Act = 'confirm' | 'cutoff' | 'cancel' | 'reschedule' | 'extend' | 'escalate' | 'waive';

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

/** One fact of the record, or nothing when the record does not hold it. */
function Fact({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
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
 * server snapshotted it on approval; the person who decided is "you" or another member of staff, because the read names nobody.
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
        {exception.state === 'REQUESTED' ? (
          <>
            Waiting for a holder of <code>pickup.exception.approve</code> to approve it.
          </>
        ) : (
          `${EXCEPTION_STATE_WORDS[exception.state]}${checker}${decided}.`
        )}
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

function Facts({ request }: { readonly request: PickupRequestView }) {
  const me = useSignedInSession();
  const capAmount = request.liability_cap_snapshot?.amount_minor;
  const chargeAmount =
    request.cancellation_charge?.amount_minor ?? request.cancellation_charge_snapshot?.amount_minor;
  return (
    <dl className="pickup-facts">
      <Fact term="Booked as">
        {request.pickup_intent === undefined
          ? 'Not recorded'
          : INTENT_LABELS[request.pickup_intent]}
      </Fact>
      {request.sender_name === undefined ? null : <Fact term="Sender">{request.sender_name}</Fact>}
      <Fact term="Service date">{serviceDateText(request.scheduled_service_date)}</Fact>
      <Fact term="Packages">{packagesText(request)}</Fact>
      <Fact term="Pickup at">
        {request.resolved_pickup_location === undefined ? (
          'Not recorded'
        ) : (
          <Place location={request.resolved_pickup_location} />
        )}
      </Fact>
      {request.collection_point === undefined ? null : (
        <Fact term="Collect from">
          <p>{`${request.collection_point.contact_name}, ${request.collection_point.phone}`}</p>
          <Place location={request.collection_point.location} />
          {request.collection_point.landmark === undefined ? null : (
            <p>{`Landmark: ${request.collection_point.landmark}`}</p>
          )}
        </Fact>
      )}
      {request.collection_reference === undefined ? null : (
        <Fact term="Seller’s reference">
          <p>{request.collection_reference.reference_name}</p>
          {request.collection_reference.seller_order_reference === undefined ? null : (
            <p>{`Order: ${request.collection_reference.seller_order_reference}`}</p>
          )}
        </Fact>
      )}
      {request.collection_item === undefined ? null : (
        <Fact term="Item to collect">
          <p>
            {`${request.collection_item.description}, ${String(request.collection_item.quantity)} ${
              request.collection_item.quantity === 1 ? 'item' : 'items'
            }`}
          </p>
          {request.collection_item.handling_note === undefined ? null : (
            <p>{`Handling: ${request.collection_item.handling_note}`}</p>
          )}
        </Fact>
      )}
      {request.current_item_description === undefined ? null : (
        <Fact term="Today’s goods">{request.current_item_description}</Fact>
      )}
      <Fact term="Contact phone">{request.primary_phone ?? 'Not recorded'}</Fact>
      {request.secondary_phone === undefined ? null : (
        <Fact term="Second contact phone">{request.secondary_phone}</Fact>
      )}
      <Fact term="Who pays">
        <Payer request={request} />
      </Fact>
      {request.declared_value_minor === undefined ? null : (
        <Fact term="Declared value">
          <MoneyAmount amountMinor={request.declared_value_minor} currency="GHS" />
        </Fact>
      )}
      {request.liability_cap_acknowledged_at === undefined ? null : (
        <Fact term="Liability cap">
          {capAmount === undefined ? (
            `Acknowledged by the sender on ${formatInstant(request.liability_cap_acknowledged_at) ?? ''}.`
          ) : (
            <>
              Capped at <MoneyAmount amountMinor={capAmount} currency="GHS" />, acknowledged by the
              sender on {formatInstant(request.liability_cap_acknowledged_at)}.
            </>
          )}
        </Fact>
      )}
      {request.one_package_exception === undefined ? null : (
        <Fact term="One-package exception">
          <ExceptionFacts
            exception={request.one_package_exception}
            principalId={me?.session.principal_id}
          />
        </Fact>
      )}
      {request.cutoff_exception_state === undefined ? null : (
        <Fact term="Late booking">{CUTOFF_LABELS[request.cutoff_exception_state]}</Fact>
      )}
      <Fact term="Attempt">{String(request.attempt_number)}</Fact>
      {request.attempt_extension_id === undefined ? null : (
        <Fact term="Attempt limit">
          Extended for this request: one further attempt past the hub’s limit.
        </Fact>
      )}
      {request.state !== 'CONFIRMED' || request.rider_assigned === undefined ? null : (
        <Fact term="Rider">
          {request.rider_assigned ? 'Assigned to the pickup run' : 'Not assigned yet'}
        </Fact>
      )}
      <Fact term="Hub">
        {hubNameOf(request.responsible_hub_id, me?.session.authorized_hubs ?? [])}
      </Fact>
      {request.created_at === undefined ? null : (
        <Fact term="Booked">{formatInstant(request.created_at)}</Fact>
      )}
      {request.confirmed_at === undefined ? null : (
        <Fact term="Confirmed">{formatInstant(request.confirmed_at)}</Fact>
      )}
      {request.state !== 'CANCELLED' ? null : (
        <Fact term="Cancellation">
          {cancelledByText(request) === undefined ? null : <p>{cancelledByText(request)}</p>}
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
        </Fact>
      )}
    </dl>
  );
}

/** One act the page offers: a heading, what it does, and its control, or the permission it needs when the session does not hold it. */
function ActBlock({
  title,
  permission,
  holds,
  text,
  control,
}: {
  readonly title: string;
  readonly permission: string;
  readonly holds: boolean;
  readonly text: string;
  readonly control: ReactNode;
}) {
  return (
    <div className="pickup-act">
      <h3>{title}</h3>
      {holds ? (
        <>
          <p className="pickup-act__text">{text}</p>
          <div className="pickup-act__buttons">{control}</div>
        </>
      ) : (
        <p className="pickup-act__text">
          This needs the permission <code>{permission}</code>, which your session does not hold.
        </p>
      )}
    </div>
  );
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

  return (
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
          {notice.estimate === undefined ? null : <EstimateSummary estimate={notice.estimate} />}
        </div>
      )}

      <p className="pickup-status">
        <StatusBadge status={request.state} map={PICKUP_STATE_MAP} />{' '}
        <span>{STATE_SENTENCES[request.state]}</span>
        {escalatedAt === undefined ? null : <span>{` Escalated on ${escalatedAt}.`}</span>}
      </p>

      <Facts request={request} />

      {/* The message log narrowed to this request, for a session that lists the key of the log (the server checks it all the same). */}
      {me.holds('notification.read') ? (
        <p>
          <Link to={subjectLogPath('PICKUP_REQUEST', id)}>Messages about this request</Link>
        </p>
      ) : null}

      {/* The estimate an act's answer carried is shown with its news; the record's own, when the read carries one, is not shown twice. */}
      {request.indicative_estimate === undefined || notice?.estimate !== undefined ? null : (
        <EstimateSummary estimate={request.indicative_estimate} />
      )}

      <section className="pickup-section" aria-labelledby="pickup-acts">
        <h2 id="pickup-acts">What you can do</h2>
        {!live && !chargeToWaive ? (
          <p className="pickup-act__text">
            {request.state === 'CANCELLED'
              ? 'A cancelled request is not changed again. Its attempts are listed below.'
              : 'A declined request is not changed again.'}
          </p>
        ) : null}

        {pending ? (
          exceptionWaiting ? (
            <div className="pickup-act">
              <h3>The one-package exception</h3>
              <p className="pickup-act__text">
                The exception is requested and waits for a holder of{' '}
                <code>pickup.exception.approve</code> to approve it. The request can be confirmed
                once it is approved.
              </p>
              {me.holds('pickup.exception.approve') ? (
                <div className="pickup-act__buttons">
                  <ButtonLink to="/approvals" variant="secondary">
                    Go to the exceptions to approve
                  </ButtonLink>
                </div>
              ) : null}
            </div>
          ) : needsException ? (
            <ActBlock
              title="Request the one-package exception"
              permission="pickup.exception.request"
              holds={me.holds('pickup.exception.request')}
              text="This request is for a single package. It can be confirmed only once its one-package exception is approved, by a holder of pickup.exception.approve."
              control={
                <ButtonLink to={`/pickup-requests/${id}/exception`} variant="secondary">
                  Request the exception
                </ButtonLink>
              }
            />
          ) : (
            <ActBlock
              title="Confirm the pickup"
              permission="pickup.request.confirm"
              holds={me.holds('pickup.request.confirm')}
              text="Confirming puts the request in the pool for a pickup run. Nothing is charged and no credit is reserved."
              control={
                <Button
                  type="button"
                  onClick={() => {
                    setOpen('confirm');
                  }}
                >
                  Confirm the pickup
                </Button>
              }
            />
          )
        ) : null}

        {lateToDecide ? (
          <ActBlock
            title="Decide the late booking"
            permission="pickup.request.confirm"
            holds={me.holds('pickup.request.confirm')}
            text="It was booked after the hub’s cut-off. Approve it for the same day, or move it to the next operating day."
            control={
              <Button
                type="button"
                onClick={() => {
                  setOpen('cutoff');
                }}
              >
                Decide the late booking
              </Button>
            }
          />
        ) : null}

        {confirmed ? (
          <ActBlock
            title="Reschedule the pickup"
            permission="pickup.request.cancel"
            holds={me.holds('pickup.request.cancel')}
            text="This request is cancelled and its next attempt is booked as a new pending request, linked to it. Use it after a failed pickup."
            control={
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen('reschedule');
                }}
              >
                Reschedule the pickup
              </Button>
            }
          />
        ) : null}

        {confirmed && escalatedAt !== undefined ? (
          <div className="pickup-act">
            <h3>Escalated</h3>
            <p className="pickup-act__text">
              {`Escalated on ${escalatedAt}. An escalation is recorded once and is not taken back; the request can still be rescheduled or cancelled.`}
            </p>
          </div>
        ) : null}
        {confirmed && escalatedAt === undefined ? (
          <ActBlock
            title="Escalate the request"
            permission="pickup.failure.resolve"
            holds={me.holds('pickup.failure.resolve')}
            text="For a pickup that failed and cannot simply be tried again: a refused collection, or a request that has used its attempts. It is recorded once."
            control={
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen('escalate');
                }}
              >
                Escalate the request
              </Button>
            }
          />
        ) : null}

        {confirmed ? (
          <ActBlock
            title="Extend the attempts"
            permission="pickup.attempt.extend"
            holds={me.holds('pickup.attempt.extend')}
            text="Use this when the request has used its pickup attempts and must be tried again. It allows one further attempt, for this request alone."
            control={
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen('extend');
                }}
              >
                Extend the attempts
              </Button>
            }
          />
        ) : null}

        {live ? (
          <ActBlock
            title="Cancel the request"
            permission="pickup.request.cancel"
            holds={me.holds('pickup.request.cancel')}
            text={
              decidesCharge
                ? 'A rider is assigned to this request’s run, so cancelling it asks for your decision on the cancellation charge.'
                : 'A request can be cancelled at any point. Nothing is charged before a rider is assigned to its run.'
            }
            control={
              <Button
                type="button"
                variant="danger"
                onClick={() => {
                  setOpen('cancel');
                }}
              >
                Cancel the request
              </Button>
            }
          />
        ) : null}

        {chargeToWaive ? (
          <ActBlock
            title="Waive the cancellation charge"
            permission="pickup.cancellation_charge.waive"
            holds={me.holds('pickup.cancellation_charge.waive')}
            text="A waiver relieves the charge in full. The charge as applied stays on the record."
            control={
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setOpen('waive');
                }}
              >
                Waive the charge
              </Button>
            }
          />
        ) : null}
      </section>

      <section className="pickup-section" aria-labelledby="pickup-attempts">
        <h2 id="pickup-attempts">Attempts</h2>
        <AttemptChain request={request} />
      </section>

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
      <CancelRequestDialog<PickupRequestView>
        open={open === 'cancel' || open === 'reschedule'}
        mode={open === 'reschedule' ? 'reschedule' : 'cancel'}
        decidesCharge={decidesCharge}
        mayCharge={me.holds('pickup.request.cancel_chargeable')}
        canExtend={me.holds('pickup.attempt.extend')}
        version={etag}
        send={(fields, version, key) => cancelPickupRequest(client, id, version, fields, key)}
        onDone={(answer) => {
          const outcome =
            answer.cancellation_charge_outcome === undefined
              ? ''
              : ` ${CHARGE_OUTCOME_LABELS[answer.cancellation_charge_outcome]}`;
          done(
            open === 'reschedule'
              ? `The pickup is rescheduled: this request is cancelled and its next attempt is booked.${outcome}`
              : `The request is cancelled.${outcome}`,
            answer,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <NoteActDialog<PickupRequestView>
        open={open === 'escalate'}
        title="Escalate this request?"
        consequence={
          <p>
            Escalation records that the request is out of the hub’s own hands. It is recorded once,
            with your note, and is not taken back. Nothing else changes: the request can still be
            rescheduled or cancelled.
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
          done('The request is escalated.', answer);
        }}
        onCancel={close}
        onReload={reload}
      />
      <NoteActDialog<PickupRequestView>
        open={open === 'extend'}
        title="Extend the attempts of this request?"
        consequence={
          <p>
            This allows one further attempt for this request alone, past the hub’s limit: its next
            reschedule makes that attempt, and a reschedule after that needs another extension. The
            setting does not change, and the extension is kept on the record with your reason.
          </p>
        }
        confirmLabel="Allow one further attempt"
        noteLabel="Why the attempts are extended"
        noteHelp="One line. It is kept with the extension and cannot be changed later. Leave out phone numbers and email addresses."
        operation="extendPickupAttempts"
        notePointer="/reason"
        version={etag}
        retryable
        send={(reason, version, key) => extendPickupAttempts(client, id, version, reason, key)}
        onDone={(answer) => {
          done(
            'The attempts are extended: this request may have one further attempt. Reschedule it to make that attempt.',
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
 * One pickup request (surfaces/ops-portal.md section 7, `/pickup-requests/{id}`; S1.19): its state, what it holds, the estimate when an answer
 * carried one, the acts the record and the session's keys allow, and its attempt chain. **Every act sends the version the page read**
 * (`If-Match`), so a concurrent edit is a `STATE_CONFLICT` that is explained and read again, never a silent overwrite; the acts that take an
 * `Idempotency-Key` send a new one each time and the same one only to try a lost answer again. A request outside the session's hubs and one that
 * does not exist are pages of their own. What is offered is a hint and decides nothing: the server checks the key, the hub and the state. An
 * escalation is recorded once (`escalated_at`) and is then told, not offered; an extension allows one further attempt; whether a rider holds
 * the request's run decides whether a cancellation asks for the charge decision.
 */
export function PickupRequestDetailPage() {
  const { id = '' } = useParams();
  return (
    <WithPickupRequest
      id={id}
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

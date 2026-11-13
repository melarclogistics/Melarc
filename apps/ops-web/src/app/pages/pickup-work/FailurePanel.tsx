import { useState, type ReactNode } from 'react';

import { Button } from '../../../components/ui/button/Button';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { useApiClient } from '../../../platform/api/api-client';
import {
  cancelPickupRequest,
  escalatePickupRequest,
  extendPickupAttempts,
} from '../../../platform/pickup/pickup-commands';
import type { PickupRequestView } from '../../../platform/pickup/pickup-shape';
import { usePickupRequest, type PickupRecord } from '../../../platform/pickup/use-pickup-queries';
import type { PickupFailureView } from '../../../platform/pickup-work/pickup-work-shape';
import { lackedText } from '../../../platform/problem/capability-words';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { FAILURE_LABELS } from '../manifests/manifest-presentation';
import { CancelRequestDialog, NoteActDialog } from '../pickup/PickupActDialogs';
import { CHARGE_OUTCOME_LABELS } from '../pickup/pickup-presentation';
import {
  CONTACT_METHOD_WORDS,
  countText,
  escalationText,
  isWaiting,
  waitText,
} from './pickup-work-presentation';
import type { PanelTools } from './WorkList';
import './pickup-work-pages.css';

/** The four acts of a failure, each with its own question. */
type Act = 'reschedule' | 'cancel' | 'escalate' | 'extend';

/** The way to the stop's page, where the rider's photos open one at a time. */
const stopPath = (failure: PickupFailureView): string =>
  `/manifests/${failure.pickup_manifest_id}/stops/${failure.pickup_stop_id}`;

/**
 * What the failure says of itself, **as the server gave it** (surfaces/ops-portal.md section 7, `/pickup-failures`): every field section 17.3 makes mandatory is here and none is worked out by
 * the page (the wait is the database's, the escalation is the ledger's). The retryability of the failure and the state of the attempts' cap are not here: the read has no field for them, and a cap that
 * stops a reschedule is told by the refusal.
 */
function Facts({ failure }: { readonly failure: PickupFailureView }) {
  const decidedAt = failure.decided_at === null ? undefined : formatInstant(failure.decided_at);
  const escalated = escalationText(failure.escalation);
  const escalatedAt =
    failure.escalated_at === null ? undefined : formatInstant(failure.escalated_at);
  return (
    <>
      <DescriptionList
        heading="The failure"
        headingLevel={3}
        items={[
          { label: 'Sender', value: failure.sender_name },
          { label: 'Category', value: FAILURE_LABELS[failure.category] },
          { label: 'Reason', value: failure.reason.label },
          { label: 'Rider’s note', value: failure.note ?? 'The rider left no note.' },
          { label: 'Failed', value: formatInstant(failure.failed_at) },
          {
            label: isWaiting(failure.decision) ? 'Waiting' : 'Waited',
            value: waitText(failure.waiting_seconds),
          },
          {
            label: 'Attempt',
            value: `Attempt ${String(failure.attempt_number)}${failure.attempt_extended ? ', extended by Senior Ops' : ''}`,
          },
          {
            label: 'Photos',
            value:
              failure.photo_count === 0 ? (
                'The rider attached no photo.'
              ) : (
                <>
                  {`${countText(failure.photo_count, 'photo', 'photos')}. `}
                  <Link to={stopPath(failure)}>Open the stop to see them</Link>
                </>
              ),
          },
          {
            label: 'Escalation',
            value:
              escalated === undefined
                ? 'Not escalated.'
                : `${escalated}${escalatedAt === undefined ? '' : ` ${escalatedAt}.`}`,
          },
        ]}
      />
      <section className="work-panel__section" aria-label="Contact attempts">
        <h3 className="work-panel__heading">What the rider did to reach the sender</h3>
        {failure.contact_attempts.length === 0 ? (
          <p>The rider recorded no attempt to reach the sender.</p>
        ) : (
          <ol className="work-panel__attempts">
            {failure.contact_attempts.map((attempt, index) => (
              <li key={`${String(index)}:${attempt.attempted_at}`}>
                <strong>{CONTACT_METHOD_WORDS[attempt.method]}</strong>
                {` · ${formatInstant(attempt.attempted_at) ?? ''} · ${attempt.outcome}`}
                {attempt.note === undefined ? null : (
                  <span className="work-panel__support">{attempt.note}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {isWaiting(failure.decision) ? null : (
        <section className="work-panel__section" aria-label="What was decided">
          <h3 className="work-panel__heading">What was decided</h3>
          <p>
            {failure.decision === 'RESCHEDULED'
              ? 'The pickup was rescheduled: its request was cancelled and its next attempt was booked.'
              : 'The pickup was cancelled, and no further attempt was booked.'}
            {decidedAt === undefined ? '' : ` ${decidedAt}.`}
          </p>
          {failure.replacement_request_id === null ? null : (
            <p>
              <Link to={`/pickup-requests/${failure.replacement_request_id}`}>
                Open the new request
              </Link>
            </p>
          )}
        </section>
      )}
    </>
  );
}

/** The acts of a request that still waits, over the version just read: only those the session can take, and the question of each in its own dialog. */
function Acts({
  failure,
  record,
  tools,
  refetch,
}: {
  readonly failure: PickupFailureView;
  readonly record: PickupRecord;
  readonly tools: PanelTools;
  readonly refetch: () => unknown;
}) {
  const client = useApiClient();
  const me = useSignedInSession();
  const [open, setOpen] = useState<Act | undefined>(undefined);
  if (me === undefined) return null;
  const { request, etag } = record;
  const id = request.id;
  const code = failure.request_code;
  const confirmed = request.state === 'CONFIRMED';

  if (!confirmed) {
    return (
      <section className="work-panel__section" aria-label="Acts">
        <p>This request is no longer confirmed, so there is nothing left to decide here.</p>
        <Button type="button" variant="secondary" onClick={() => void tools.reload()}>
          Read the list again
        </Button>
      </section>
    );
  }

  const mayCancel = me.holds('pickup.request.cancel');
  const mayEscalate = me.holds('pickup.failure.resolve') && failure.decision === 'PENDING';
  const mayExtend = me.holds('pickup.attempt.extend');
  // Once a rider holds the request's run, its cancellation records a charge decision either way (cancelPickupRequest); before, none.
  const decidesCharge = request.rider_assigned === true;
  const lacking = lackedText((key) => me.holds(key), ['pickup.request.cancel']);

  const close = (): void => {
    setOpen(undefined);
  };
  const reload = (): Promise<unknown> => {
    close();
    void refetch();
    return tools.reload();
  };
  const done = (text: ReactNode): void => {
    close();
    tools.acted(text);
  };
  const outcomeOf = (answer: PickupRequestView): string =>
    answer.cancellation_charge_outcome === undefined
      ? ''
      : ` ${CHARGE_OUTCOME_LABELS[answer.cancellation_charge_outcome]}`;

  return (
    <section className="work-panel__section" aria-label="Acts">
      <h3 className="work-panel__heading">What to do</h3>
      <div className="work-panel__acts">
        {mayCancel ? (
          <Button
            type="button"
            onClick={() => {
              setOpen('reschedule');
            }}
          >
            Reschedule
          </Button>
        ) : null}
        {mayEscalate ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen('escalate');
            }}
          >
            Escalate
          </Button>
        ) : null}
        {mayExtend ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen('extend');
            }}
          >
            Extend the attempts
          </Button>
        ) : null}
        {mayCancel ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setOpen('cancel');
            }}
          >
            Cancel the pickup
          </Button>
        ) : null}
      </div>
      {mayCancel ? null : <p className="work-panel__support">{lacking}</p>}
      {failure.decision === 'ESCALATED' ? (
        <p className="work-panel__support">
          It is escalated already. Escalating marks it out of the hub’s hands and decides nothing,
          so it still waits for one of the other acts.
        </p>
      ) : null}

      <CancelRequestDialog<PickupRequestView>
        open={open === 'reschedule'}
        mode="reschedule"
        decidesCharge={decidesCharge}
        mayCharge={me.holds('pickup.request.cancel_chargeable')}
        canExtend={mayExtend}
        version={etag}
        send={(fields, version, key) => cancelPickupRequest(client, id, version, fields, key)}
        onDone={(answer) => {
          done(
            <>
              <p>
                {`The pickup ${code} is rescheduled: its request is cancelled and its next attempt is booked.${outcomeOf(answer)}`}
              </p>
              {answer.replacement_request_id === undefined ? null : (
                <p>
                  <Link to={`/pickup-requests/${answer.replacement_request_id}`}>
                    Open the new request
                  </Link>
                </p>
              )}
            </>,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
      <CancelRequestDialog<PickupRequestView>
        open={open === 'cancel'}
        mode="cancel"
        decidesCharge={decidesCharge}
        mayCharge={me.holds('pickup.request.cancel_chargeable')}
        canExtend={mayExtend}
        version={etag}
        send={(fields, version, key) => cancelPickupRequest(client, id, version, fields, key)}
        onDone={(answer) => {
          done(<p>{`The request ${code} is cancelled.${outcomeOf(answer)}`}</p>);
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
            with your note, and is not taken back. Nothing else changes: the request still waits,
            and can be rescheduled or cancelled.
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
        onDone={() => {
          done(<p>{`The request ${code} is escalated. It still waits for a decision.`}</p>);
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
        onDone={() => {
          done(
            <p>
              {`The attempts of ${code} are extended: it may have one further attempt. Reschedule it to make that attempt.`}
            </p>,
          );
        }}
        onCancel={close}
        onReload={reload}
      />
    </section>
  );
}

/**
 * A failure open beside the queue: what the failure says, the stop it was, and, while its request waits, the acts of the office. The acts are those of the pickup request and are sent on the version
 * of the request **as it is read now** (`If-Match`; a stale version is a conflict, never an overwrite), which the panel reads when it opens; until that read answers the facts are drawn and the
 * acts are not, and a request that was read and is no longer confirmed offers none.
 */
export function FailurePanel({
  failure,
  tools,
}: {
  readonly failure: PickupFailureView;
  readonly tools: PanelTools;
}) {
  const me = useSignedInSession();
  const waiting = isWaiting(failure.decision);
  const request = usePickupRequest(failure.pickup_request_id, waiting);
  if (me === undefined) return null;
  return (
    <div className="work-panel">
      <Facts failure={failure} />
      {waiting ? (
        <ReadState<PickupRecord>
          query={request}
          isEmpty={() => false}
          empty={null}
          loadingLabel="Reading the request…"
          skeleton={<Skeleton lines={2} />}
          permission="pickup.read"
          operation="getPickupRequest"
        >
          {(record) => (
            <Acts failure={failure} record={record} tools={tools} refetch={request.refetch} />
          )}
        </ReadState>
      ) : null}
    </div>
  );
}

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { LockIndicator } from '../../../components/ui/lock-indicator/LockIndicator';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  submitBlindCount,
  type CountedWithVersion,
} from '../../../platform/hub-intake/hub-intake-commands';
import {
  MAX_PARCELS,
  receiverHoldOf,
  type IntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import {
  useIntakeLock,
  type IntakeLock,
  type IntakeRecord,
} from '../../../platform/hub-intake/use-hub-intake-queries';
import { problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { actBreadcrumb, WithIntake } from './WithIntake';
import { holderWords, intakePath, parcelsText, type DoneState } from './intake-presentation';

/** The count as a person types it: whole digits, nothing else, and no more than the platform can hold (a limit of representation, not of parcels). A field that is empty is not a count of zero. */
const WHOLE_COUNT = /^\d{1,10}$/;

const FIELD_ERROR = 'Enter the number of parcels you counted, as a whole number from 0.';

/** What the lock says of the page that is keeping it, and what a person may do about another receiver's. */
function Lock({ record, lock }: { readonly record: IntakeRecord; readonly lock: IntakeLock }) {
  const me = useSignedInSession();
  const [asked, setAsked] = useState<'idle' | 'asking' | 'asked'>('idle');
  // The freshest answer of the server: the lock's own, and until it has answered, the read's.
  const intake: IntakeView = lock.intake ?? record.intake;
  const hold = receiverHoldOf(intake, me?.session.principal_id);
  const words = holderWords(hold);

  if (lock.failure !== undefined && lock.intake === undefined) {
    return (
      <LockIndicator
        holder="unknown"
        subject="this intake"
        note={problemOf(lock.failure, { operation: 'acquireIntakeLock' }).message}
      />
    );
  }
  const ADVISORY =
    'A lock only shows who is working on an intake. It never stops a second count: if two receivers count, the first count is kept and the other is refused.';
  if (hold.kind === 'another') {
    return (
      <LockIndicator
        holder="other"
        subject="this intake"
        who={words.who}
        {...(words.since === undefined ? {} : { since: words.since })}
        note={
          asked === 'asked'
            ? `Asked again. Another receiver still holds it: the server gives it to you only once they have been idle for the hub’s idle time. ${ADVISORY}`
            : `You can wait, or ask again: the server gives you the lock only once they have been idle for the hub’s idle time. ${ADVISORY}`
        }
        action={
          <Button
            type="button"
            variant="secondary"
            loading={asked === 'asking'}
            onClick={() => {
              setAsked('asking');
              void lock.askAgain().then(() => {
                setAsked('asked');
              });
            }}
          >
            Ask again
          </Button>
        }
      />
    );
  }
  return (
    <LockIndicator
      holder={hold.kind === 'you' ? 'yours' : 'free'}
      subject="this intake"
      {...(words.since === undefined ? {} : { since: words.since })}
      note={
        hold.kind === 'you' ? `The page keeps the lock while it is open. ${ADVISORY}` : ADVISORY
      }
    />
  );
}

function CountForm({
  record,
  reload,
}: {
  readonly record: IntakeRecord;
  readonly reload: () => Promise<unknown>;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState<number | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);
  const { intake, etag } = record;

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const typed = text.trim();
    if (!WHOLE_COUNT.test(typed) || Number(typed) > MAX_PARCELS) {
      setInvalid(FIELD_ERROR);
      setAttempts((count) => count + 1);
      return;
    }
    setInvalid(undefined);
    setConfirming(Number(typed));
  }

  return (
    <>
      <TaskForm
        formRef={form}
        onSubmit={review}
        actions={
          <>
            <Button type="submit">Review the count</Button>
            <Link to={intakePath(intake.id)}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection title="What you counted">
          <TaskFormWide>
            <p className="pickup-form-note">
              <strong>Count every parcel on the table before you type the number.</strong> The count
              is blind: the number the rider declared is not shown to you, and it is shown once your
              count is recorded.
            </p>
          </TaskFormWide>
          <TaskFormWide>
            <Field
              label="Parcels counted"
              required
              help="A whole number, 0 or more. Count what is in front of you, not what you expect."
              {...(invalid === undefined ? {} : { error: invalid })}
            >
              <Input
                name="physical_count"
                value={text}
                inputMode="numeric"
                autoComplete="off"
                onChange={(event) => {
                  setText(event.target.value);
                  setInvalid(undefined);
                }}
              />
            </Field>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<{ readonly count: number }, CountedWithVersion>
        open={confirming !== undefined}
        title={`Record a count of ${parcelsText(confirming ?? 0)}?`}
        consequence={
          <p>
            This is the count of the parcels you received. It is recorded once and cannot be changed
            here: after it, the rider’s declared number is shown with the comparison. If another
            receiver counts this intake first, theirs is kept and yours is not.
          </p>
        }
        confirmLabel="Record the count"
        operation="submitBlindCount"
        retryable
        build={() => (confirming === undefined ? undefined : { count: confirming })}
        send={(command, key) => submitBlindCount(client, intake.id, command.count, etag, key)}
        onDone={() => {
          void navigate(intakePath(intake.id), { state: { done: 'counted' } satisfies DoneState });
        }}
        onCancel={() => {
          setConfirming(undefined);
        }}
        onReload={() => {
          // The intake changed under the receiver: it is read again, and what it says now is what the page shows (a counted intake is the other receiver's, and says so).
          setConfirming(undefined);
          void reload();
        }}
      />
    </>
  );
}

function Counting({
  record,
  reload,
}: {
  readonly record: IntakeRecord;
  readonly reload: () => Promise<unknown>;
}) {
  const { intake } = record;
  // The lock is kept for as long as this page is open and the intake has not been counted; its own answer can say that another receiver counted it meanwhile.
  const lock = useIntakeLock(intake.id, intake.count_phase === 'PRE_COUNT');
  if (intake.count_phase === 'POST_COUNT' || lock.intake?.count_phase === 'POST_COUNT') {
    return (
      <div className="pickup-status">
        <Alert variant="danger">
          <p>
            This intake has been counted: another receiver’s count is the one that was recorded, and
            nothing was changed by this page. Open the intake to see it.
          </p>
        </Alert>
        <p>
          <ButtonLink to={intakePath(intake.id)}>Open the intake</ButtonLink>
        </p>
      </div>
    );
  }
  return (
    <>
      <Lock record={record} lock={lock} />
      <CountForm record={record} reload={reload} />
    </>
  );
}

/**
 * Count the parcels (surfaces/ops-portal.md section 7, `/intakes/{id}/count`; S1.35): **the blind page**. The rider's declared count is on it in no form (not greyed, not in a tooltip, not in a response the page
 * discards): the intake it reads is an intake that has not been counted, whose shape has no place for the declaration and refuses an answer that carries one (`hub-intake-shape.ts`), and the form
 * takes the physical count and sends that and nothing else. Opening the page takes the receiver's **advisory** lock and keeps it while the page is open and visible (`useIntakeLock`); another receiver's
 * lock is told as what it is (who is working, never a gate): the count form stays, and the words say that a lock stops nobody and that, if two receivers count, the first count is kept. The count is
 * reviewed in a dialog and recorded once (`Idempotency-Key` and the version read); `STATE_CONFLICT` says what happened and what to do instead of a bare failure. An intake that has been counted is
 * the record's page: this one tells so and offers it.
 */
export function IntakeCountPage() {
  const { id = '' } = useParams();
  return (
    <WithIntake
      id={id}
      heading={(record) => ({
        title: 'Count the parcels',
        documentTitle: 'Count the parcels',
        description:
          record === undefined
            ? 'Count what has been handed over, then enter the number.'
            : `Intake ${record.intake.code}. Count what has been handed over, then enter the number.`,
      })}
      breadcrumb={(record) => actBreadcrumb(record, id)}
    >
      {(record, query) => <Counting record={record} reload={query.refetch} />}
    </WithIntake>
  );
}

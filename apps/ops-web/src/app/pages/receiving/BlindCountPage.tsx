import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { TaskForm, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  submitBlindCount,
  type CountedWithVersion,
} from '../../../platform/hub-intake/hub-intake-commands';
import {
  MAX_PARCELS,
  receiverHoldOf,
  type PreCountIntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import { useReceivingLocks } from '../../../platform/hub-receiving/use-receiving-locks';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { LOCK_WORDS, RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { formatClock } from '../../../platform/time/format-time';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { recordPath, runPath, type DoneState } from './receiving-presentation';
import { actBreadcrumb, codeOfRecord, WithRecord } from './WithRecord';
import './receiving-pages.css';

/** The count as a person types it: whole digits, nothing else, and no more than the platform can hold (a limit of representation, not of parcels). A field that is empty is not a count of zero. */
const WHOLE_COUNT = /^\d{1,10}$/;

/** What the lock says: who opened this and when, from what the read of the vendor stated (a person is an identifier there, so *Someone else*), or that the page cannot check. Nothing when nobody has. */
function LockLine({
  intake,
  cannotCheck,
}: {
  readonly intake: PreCountIntakeView;
  readonly cannotCheck: boolean;
}) {
  const me = useSignedInSession();
  if (cannotCheck) return <p className="receiving-lock">{LOCK_WORDS.cannotCheck}</p>;
  const hold = receiverHoldOf(intake, me?.session.principal_id);
  if (hold.kind !== 'another') return null;
  const at = formatClock(hold.since) ?? '';
  return <p className="receiving-lock">{LOCK_WORDS.opened(WORDS.blindCount.someoneElse, at)}</p>;
}

function CountForm({
  intake,
  version,
  reload,
}: {
  readonly intake: PreCountIntakeView;
  readonly version: string;
  readonly reload: () => Promise<unknown>;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  // **The lock is taken on the first act, never by opening the page** (as on the run's page): the first digit typed starts it.
  const locks = useReceivingLocks();
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState<number | undefined>(undefined);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const typed = text.trim();
    if (!WHOLE_COUNT.test(typed) || Number(typed) > MAX_PARCELS) {
      setInvalid(WORDS.blindCount.invalid);
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
            <Button type="submit" size="lg">
              {WORDS.blindCount.review}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => {
                void navigate(recordPath(intake.id));
              }}
            >
              {WORDS.blindCount.cancel}
            </Button>
          </>
        }
      >
        <div className="receiving-count">
          <TaskFormWide>
            <p className="receiving-note">{WORDS.vendor.blind.explain}</p>
          </TaskFormWide>
          <TaskFormWide>
            <Field
              label={WORDS.blindCount.fieldLabel}
              required
              help={WORDS.blindCount.fieldHelp}
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
                  if (event.target.value.trim() !== '') void locks.ensure(intake.id);
                }}
              />
            </Field>
            <LockLine intake={intake} cannotCheck={locks.status(intake.id) === 'cannot-check'} />
          </TaskFormWide>
        </div>
      </TaskForm>

      <ActDialog<{ readonly count: number }, CountedWithVersion>
        open={confirming !== undefined}
        title={WORDS.blindCount.confirmTitle(confirming ?? 0)}
        consequence={<p>{WORDS.blindCount.consequence}</p>}
        confirmLabel={WORDS.blindCount.confirm}
        confirmVariant="primary"
        size="lg"
        operation="submitBlindCount"
        retryable
        build={() => (confirming === undefined ? undefined : { count: confirming })}
        send={async (command, key) => {
          await locks.ensure(intake.id);
          return submitBlindCount(client, intake.id, command.count, version, key);
        }}
        onDone={() => {
          void navigate(recordPath(intake.id), { state: { done: 'counted' } satisfies DoneState });
        }}
        onCancel={() => {
          setConfirming(undefined);
        }}
        onReload={() => {
          // The vendor changed under the receiver: it is read again, and what it says now is what the page shows (a counted vendor is the other receiver's, and says so).
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
  readonly record: IntakeRecordView;
  readonly reload: () => Promise<unknown>;
}) {
  // A vendor photographed at the door is checked in on its run's page and never counted: the officer is sent there, and told why when they arrive.
  if (record.kind === 'check-in') {
    return (
      <Navigate
        to={runPath(record.view.pickup_manifest_id)}
        replace
        state={{ told: 'photographed' }}
      />
    );
  }
  const { intake } = record;
  if (intake.count_phase === 'POST_COUNT') {
    return (
      <div className="receiving-note">
        <Alert variant="danger">
          <p>{WORDS.blindCount.counted}</p>
        </Alert>
        <p>
          <ButtonLink to={recordPath(intake.id)}>{WORDS.blindCount.openVendor}</ButtonLink>
        </p>
      </div>
    );
  }
  return <CountForm intake={intake} version={record.etag} reload={reload} />;
}

/**
 * Count the parcels (surfaces/ops-portal.md section 7, `/intakes/{id}/count`; S1.35; D-D3): **the blind page, for a vendor whose parcels were not photographed at the door**, and the one place a number is typed.
 * It keeps one line of its own: *count first, the rider's number is shown after*. The rider's number is on it in no form (not greyed, not in a tooltip, not in a response the page discards): the vendor it
 * reads before its count has no place for it, and a read that carries it is refused whole (`hub-intake-shape.ts`). The form takes the number of parcels and sends that and nothing else. **The lock is taken on
 * the first digit typed, never by opening the page**, and another receiver's is told as what it is (who opened this, never a gate). The count is reviewed in a dialog and recorded once (`Idempotency-Key` and the
 * version read). **A vendor photographed at the door is never counted**: it is sent to its run's page, which tells the officer why. A vendor that has been counted is the record's page: this one says so and offers it.
 */
export function BlindCountPage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      named
      heading={(record, vendor) => ({
        title: WORDS.blindCount.title,
        documentTitle: WORDS.blindCount.documentTitle,
        ...(record === undefined
          ? {}
          : {
              // The vendor is said by its name (its run's), and by its code only until the name is known.
              description: WORDS.blindCount.description(
                vendor ?? WORDS.record.byCode(codeOfRecord(record)),
              ),
            }),
      })}
      breadcrumb={(record, vendor) => actBreadcrumb(record, id, vendor)}
    >
      {(record, query) => <Counting record={record} reload={query.refetch} />}
    </WithRecord>
  );
}

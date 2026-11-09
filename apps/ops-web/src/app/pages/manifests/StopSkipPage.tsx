import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader, type PageHeaderProps } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Select } from '../../../components/ui/select/Select';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import { skipPickupStop, type StopRecord } from '../../../platform/manifest/manifest-commands';
import type { StopView } from '../../../platform/manifest/manifest-shape';
import { useStop } from '../../../platform/manifest/use-manifest-queries';
import type { AttributedReason } from '../../../platform/pickup/pickup-shape';
import { usePickupReasons, usePickupRequest } from '../../../platform/pickup/use-pickup-queries';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { UUID } from '../staff/WithProfile';
import { ActDialog } from './ManifestActDialogs';
import { isToBeWorked, STOP_STATUS_MAP, stopStatusOf } from './manifest-presentation';
import { useFocusFallenToHeading } from './WithManifest';
import '../pickup/pickup-pages.css';
import './manifests-pages.css';

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** What the skip page tells the manifest page it brings the officer to, once. */
export interface SkippedState {
  readonly skipped?: true;
}

interface Fields {
  readonly reasonCode: string;
  readonly note: string;
}

function BackToRun({ manifestId }: { readonly manifestId: string }) {
  return (
    <p className="pickup-back">
      {manifestId === '' ? (
        <Link to="/manifests">Back to pickup runs</Link>
      ) : (
        <Link to={`/manifests/${manifestId}`}>Back to the manifest</Link>
      )}
    </p>
  );
}

function StopNotFound({ manifestId }: { readonly manifestId: string }) {
  useFocusFallenToHeading();
  return (
    <>
      <title>Stop not found · Melarc Ops Portal</title>
      <PageHeading>Stop not found</PageHeading>
      <p>{copyFor({ operation: 'getPickupStop', code: 'NOT_FOUND' })}</p>
      <BackToRun manifestId={manifestId} />
    </>
  );
}

function Form({
  header,
  manifestId,
  record,
  code,
  reasons,
  refetchReasons,
  reloadStop,
}: {
  /** The page's header, which the task form draws (every other state of the page draws it itself). */
  readonly header: Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'>;
  readonly manifestId: string;
  readonly record: StopRecord;
  readonly code: string | undefined;
  readonly reasons: readonly AttributedReason[];
  readonly refetchReasons: () => unknown;
  /** Reads the stop again, for the version a new skip takes. */
  readonly reloadStop: () => unknown;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const stop = record.stop;
  const [values, setValues] = useState<Fields>({ reasonCode: '', note: '' });
  const [invalid, setInvalid] = useState<{ reason?: string; note?: string }>({});
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const reasonDone = reasons.find((reason) => reason.code === values.reasonCode);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const found: { reason?: string; note?: string } = {};
    if (reasonDone === undefined) found.reason = 'Choose a reason.';
    if (hasControlCharacter(values.note)) found.note = 'The note must be one line.';
    else if (reasonDone?.requiresNote === true && values.note.trim() === '') {
      found.note = 'This reason needs a note.';
    }
    setInvalid(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    setConfirming(true);
  }

  const label = `stop ${String(stop.sequence)}${code === undefined ? '' : `, ${code}`}`;
  return (
    <>
      <TaskForm
        header={header}
        formRef={form}
        onSubmit={review}
        actions={
          <>
            <Button type="submit">Skip this stop</Button>
            <Link to={`/manifests/${manifestId}`}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection title="Why it is skipped">
          <TaskFormWide>
            <p className="pickup-form-note">
              Ops skips a stop that cannot be worked, so that the run can close. A skip is Melarc’s
              decision and not a failed collection: it uses up no pickup attempt, and the request
              keeps the state it has. <strong>The vendor is always told</strong> that the stop was
              skipped, and why.
            </p>
            <p className="pickup-form-note">
              This is not the way to clear a failed pickup. A failed pickup is decided in the pickup
              request itself, by someone who can escalate or reschedule it.
            </p>
          </TaskFormWide>
          <Field
            label="Reason"
            required
            {...(invalid.reason === undefined ? {} : { error: invalid.reason })}
          >
            <Select
              name="reason"
              value={reasonDone === undefined ? '' : values.reasonCode}
              onChange={(event) => {
                setValues((current) => ({ ...current, reasonCode: event.target.value }));
                setInvalid((current) => ({ ...current, reason: undefined }));
              }}
            >
              <option value="">Choose a reason</option>
              {reasons.map((reason) => (
                <option key={reason.code} value={reason.code}>
                  {reason.label}
                </option>
              ))}
            </Select>
          </Field>
          <TaskFormWide>
            <Field
              label="Note"
              required={reasonDone?.requiresNote === true}
              help="One line, kept with the skip and shown to staff only. Leave out phone numbers and email addresses."
              {...(invalid.note === undefined ? {} : { error: invalid.note })}
            >
              <Input
                name="note"
                value={values.note}
                autoComplete="off"
                onChange={(event) => {
                  setValues((current) => ({ ...current, note: event.target.value }));
                  setInvalid((current) => ({ ...current, note: undefined }));
                }}
              />
            </Field>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<{ readonly fields: Fields; readonly version: string }, StopView>
        open={confirming}
        title={`Skip ${label}?`}
        consequence={
          <>
            <p>
              The stop is skipped with the reason you chose, and it keeps its place and its claim on
              the request. <strong>The vendor is notified</strong>, with the request, the reason and
              what the vendor can do to unblock it. No pickup attempt is used up.
            </p>
            <p>
              If this leaves a run in progress with every stop done and nothing collected, the
              system completes the run.
            </p>
          </>
        }
        confirmLabel="Skip the stop"
        confirmVariant="danger"
        operation="skipPickupStop"
        retryable
        build={() => ({ fields: values, version: record.etag })}
        send={(command, key) =>
          skipPickupStop(
            client,
            stop.id,
            command.version,
            {
              reasonCode: command.fields.reasonCode,
              ...(command.fields.note.trim() === '' ? {} : { note: command.fields.note.trim() }),
            },
            key,
          )
        }
        onDone={() => {
          // The manifest is read again on arrival: the system may have completed the run in the same act.
          void navigate(`/manifests/${manifestId}`, {
            state: { skipped: true } satisfies SkippedState,
          });
        }}
        onCancel={() => {
          setConfirming(false);
        }}
        onReload={() => {
          setConfirming(false);
          return reloadStop();
        }}
        onRefused={(problem) => {
          if (problem.code === 'REASON_NOT_ACTIVE') void refetchReasons();
        }}
      />
    </>
  );
}

function Skip({ manifestId, stopId }: { readonly manifestId: string; readonly stopId: string }) {
  const stopQuery = useStop(stopId);
  const stop = stopQuery.data?.stop;
  const request = usePickupRequest(
    stop?.pickup_request_id ?? '',
    stop !== undefined && stop.pickup_summary === undefined,
  );
  const reasons = usePickupReasons('PICKUP_STOP_SKIP', stop !== undefined && isToBeWorked(stop));

  if (stopQuery.status === 'error') {
    const problem = problemOf(stopQuery.error, { operation: 'getPickupStop' });
    if (problem.kind === 'not-found') return <StopNotFound manifestId={manifestId} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return (
        <>
          <ForbiddenPage kind="outside-hubs" />
          <BackToRun manifestId={manifestId} />
        </>
      );
    }
  }
  // An address that pairs a stop with a manifest that is not its own is a stop that is not there.
  if (
    stopQuery.status === 'success' &&
    stopQuery.data.stop.pickup_manifest_id.toLowerCase() !== manifestId.toLowerCase()
  ) {
    return <StopNotFound manifestId={manifestId} />;
  }

  const code = stop?.pickup_summary?.reference ?? request.data?.request.code;
  const header: Pick<PageHeaderProps, 'title' | 'description' | 'breadcrumb'> = {
    title: 'Skip a stop',
    ...(stop === undefined
      ? {}
      : {
          description: `Stop ${String(stop.sequence)}${code === undefined ? '' : `, ${code}`}.`,
        }),
    breadcrumb: [
      { label: 'Pickup runs', to: '/manifests' },
      { label: 'The pickup run', to: `/manifests/${manifestId}` },
    ],
  };
  // The form is shown once the stop is read, waits to be worked and the catalogue has a reason: the task form draws the header then, and every other state (loading, a failure, a stop
  // that cannot be skipped, no reason configured) draws it here, so that the page has its one heading in each of them.
  const formShown =
    stopQuery.isSuccess &&
    isToBeWorked(stopQuery.data.stop) &&
    reasons.isSuccess &&
    reasons.data.length > 0;
  return (
    <>
      <title>Skip a stop · Melarc Ops Portal</title>
      {formShown ? null : <PageHeader {...header} />}
      <ReadState<StopRecord>
        query={stopQuery}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Loading the stop…"
        skeleton={<Skeleton lines={4} />}
        permission="pickup.read"
        operation="getPickupStop"
      >
        {(record) =>
          !isToBeWorked(record.stop) ? (
            <>
              <p className="pickup-status">
                <StatusBadge status={stopStatusOf(record.stop)} map={STOP_STATUS_MAP} />{' '}
                <span>This stop is not waiting to be worked, so it cannot be skipped.</span>
              </p>
              <BackToRun manifestId={manifestId} />
            </>
          ) : (
            <>
              <ReadState<readonly AttributedReason[]>
                query={reasons}
                operation="listReasonDefinitions"
                context="stop-skip"
                permission="settings.reason.read"
                loadingLabel="Loading the reasons…"
                isEmpty={(list) => list.length === 0}
                empty={
                  <Alert variant="danger">
                    <p>
                      No reason for skipping a stop is configured yet, so a stop cannot be skipped
                      here. An administrator adds the reasons to the reason catalogue.
                    </p>
                  </Alert>
                }
              >
                {(list) => (
                  <Form
                    header={header}
                    manifestId={manifestId}
                    record={record}
                    code={code}
                    reasons={list}
                    refetchReasons={reasons.refetch}
                    reloadStop={stopQuery.refetch}
                  />
                )}
              </ReadState>
            </>
          )
        }
      </ReadState>
    </>
  );
}

/**
 * Skip a stop (surfaces/ops-portal.md section 7, `/manifests/{id}/stops/{stopId}/skip`; S1.25): the Ops act that lets a run with a stop nobody can
 * work reach its end (`skipPickupStop`, `pickup.stop.skip`). **The reason is a code of the `PICKUP_STOP_SKIP` catalogue** read from the server
 * (four codes at the time of writing, none written in the page), and the note is mandatory exactly where the reason's own `requires_note` says,
 * read from the answer and never assumed. The act sends the version of the stop read (`If-Match`, from `getPickupStop`) and a fresh
 * `Idempotency-Key`. **The page says the vendor is notified**, because it always is, and does not offer the skip as a way to clear a failed
 * stop. When it is done the officer is taken back to the manifest, which is read again, because the API may have completed the run in the same act.
 */
export function StopSkipPage() {
  const { id = '', stopId = '' } = useParams();
  if (!UUID.test(id) || !UUID.test(stopId))
    return <StopNotFound manifestId={UUID.test(id) ? id : ''} />;
  return <Skip key={stopId} manifestId={id} stopId={stopId} />;
}

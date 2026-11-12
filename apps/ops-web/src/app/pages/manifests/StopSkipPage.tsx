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
import { useManifest, useStop } from '../../../platform/manifest/use-manifest-queries';
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
        <Link to={`/manifests/${manifestId}`}>Back to the pickup run</Link>
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
  manifestId,
  record,
  code,
  reasons,
  refetchReasons,
  reloadStop,
}: {
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
              <strong>The vendor is always told</strong> that the stop was skipped, and why. This is
              not the way to clear a failed pickup: that is decided in the pickup request.
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
  // The run is read for its code, which the way back names (a stop carries only the run's id). A run that cannot be read leaves the words: the page does not wait for it or depend on it.
  const run = useManifest(
    manifestId,
    stop?.pickup_manifest_id.toLowerCase() === manifestId.toLowerCase(),
  );

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
      { label: run.data?.manifest.code ?? 'The pickup run', to: `/manifests/${manifestId}` },
    ],
  };
  return (
    <>
      <title>Skip a stop · Melarc Ops Portal</title>
      {/* The page's one heading, drawn here for every state (loading, a failure, a stop that cannot be skipped, no reason configured, the form), so that it is the same element while the stop is read
          and after, and the focus the frame put on it is not lost when the form arrives (run 7, Stage 4.3). */}
      <PageHeader {...header} />
      <ReadState<StopRecord>
        query={stopQuery}
        isEmpty={() => false}
        empty={null}
        loadingLabel="Loading the stop…"
        skeleton={<Skeleton lines={4} />}
        permission="pickup.read"
        capability="see pickup runs"
        operation="getPickupStop"
      >
        {(record) =>
          !isToBeWorked(record.stop) ? (
            // The page's header above has the breadcrumb of its parents, which is the way back: no link of its own beside it.
            <p className="pickup-status">
              <StatusBadge status={stopStatusOf(record.stop)} map={STOP_STATUS_MAP} />{' '}
              <span>This stop is not waiting to be worked, so it cannot be skipped.</span>
            </p>
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

import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { PageHeading } from '../../../components/PageHeading';
import { Button } from '../../../components/ui/button/Button';
import { Field } from '../../../components/ui/field/Field';
import { ForbiddenPage } from '../../../components/ui/forbidden-state/ForbiddenState';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Input } from '../../../components/ui/input/Input';
import { Link } from '../../../components/ui/link/Link';
import { PageHeader } from '../../../components/ui/page-header/PageHeader';
import { ReadState } from '../../../components/ui/read-state/ReadState';
import { Skeleton } from '../../../components/ui/skeleton/Skeleton';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import type { StopRecord } from '../../../platform/manifest/manifest-commands';
import { useManifest, useStop } from '../../../platform/manifest/use-manifest-queries';
import { usePickupRequest } from '../../../platform/pickup/use-pickup-queries';
import { authoriseParcelPhotoException } from '../../../platform/pickup-work/pickup-work-commands';
import type { ParcelPhotoExceptionView } from '../../../platform/pickup-work/pickup-work-shape';
import { useStopEvidence } from '../../../platform/pickup-work/use-pickup-work-queries';
import { copyFor, problemOf } from '../../../platform/problem/problem-copy';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { UUID } from '../staff/WithProfile';
import { ActDialog } from './ManifestActDialogs';
import { STOP_STATUS_MAP, stopStatusOf } from './manifest-presentation';
import type { LetThroughState } from './StopPage';
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

function BackToStop({
  manifestId,
  stopId,
}: {
  readonly manifestId: string;
  readonly stopId: string;
}) {
  return (
    <p className="pickup-back">
      {stopId === '' ? (
        <Link to={manifestId === '' ? '/manifests' : `/manifests/${manifestId}`}>
          Back to the pickup run
        </Link>
      ) : (
        <Link to={`/manifests/${manifestId}/stops/${stopId}`}>Back to the stop</Link>
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
      <BackToStop manifestId={manifestId} stopId="" />
    </>
  );
}

function Form({
  manifestId,
  record,
  code,
}: {
  readonly manifestId: string;
  readonly record: StopRecord;
  readonly code: string | undefined;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const stop = record.stop;
  const [note, setNote] = useState('');
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const found =
      note.trim() === ''
        ? 'Write a note saying why.'
        : hasControlCharacter(note)
          ? 'The note must be one line.'
          : undefined;
    setInvalid(found);
    if (found !== undefined) {
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
            <Button type="submit">Let the count through</Button>
            <Link to={`/manifests/${manifestId}/stops/${stop.id}`}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection title="Why there are no parcel photos">
          <TaskFormWide>
            <p className="pickup-form-note">
              <strong>The rider counts this stop without photographing the parcels.</strong> Use
              this when the camera failed or the photos cannot be sent. It is recorded once, with
              your note, before the count, and it is not taken back.
            </p>
          </TaskFormWide>
          <TaskFormWide>
            <Field
              label="Note"
              required
              help="One line: what went wrong with the camera or the upload. Leave out phone numbers and email addresses."
              {...(invalid === undefined ? {} : { error: invalid })}
            >
              <Input
                name="note"
                value={note}
                autoComplete="off"
                onChange={(event) => {
                  setNote(event.target.value);
                  setInvalid(undefined);
                }}
              />
            </Field>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<{ readonly note: string }, ParcelPhotoExceptionView>
        open={confirming}
        title={`Let the count of ${label} through without photos?`}
        consequence={
          <p>
            The rider can then count this stop without a photo of each parcel. It is recorded once,
            with your note and the moment, and it is never changed or removed.
          </p>
        }
        confirmLabel="Let the count through"
        operation="authoriseParcelPhotoException"
        retryable
        build={() => ({ note: note.trim() })}
        send={(command, key) => authoriseParcelPhotoException(client, stop.id, command.note, key)}
        onDone={() => {
          void navigate(`/manifests/${manifestId}/stops/${stop.id}`, {
            state: { letThrough: true } satisfies LetThroughState,
          });
        }}
        onCancel={() => {
          setConfirming(false);
        }}
        onReload={() => {
          // The stop changed under the officer: back to its page, which reads it again and says where it stands.
          void navigate(`/manifests/${manifestId}/stops/${stop.id}`);
        }}
        onRefused={(problem) => {
          // A note the server would not accept is told at the note, in words; a rule is told in the dialog.
          if (problem.code === 'REASON_REQUIRED') setInvalid('Write a note saying why.');
        }}
      />
    </>
  );
}

function Exception({
  manifestId,
  stopId,
}: {
  readonly manifestId: string;
  readonly stopId: string;
}) {
  const me = useSignedInSession();
  const stopQuery = useStop(stopId);
  const stop = stopQuery.data?.stop;
  const request = usePickupRequest(
    stop?.pickup_request_id ?? '',
    stop !== undefined && stop.pickup_summary === undefined,
  );
  const run = useManifest(
    manifestId,
    stop?.pickup_manifest_id.toLowerCase() === manifestId.toLowerCase(),
  );
  // Whether the stop has been let through already is on its evidence: told before the form, in words, and not as a refusal after it.
  const evidence = useStopEvidence(
    stopId,
    undefined,
    stop !== undefined && me?.holds('pickup.read') === true,
  );

  if (stopQuery.status === 'error') {
    const problem = problemOf(stopQuery.error, { operation: 'getPickupStop' });
    if (problem.kind === 'not-found') return <StopNotFound manifestId={manifestId} />;
    if (problem.kind === 'forbidden' && problem.forbidden === 'outside-hubs') {
      return (
        <>
          <ForbiddenPage kind="outside-hubs" />
          <BackToStop manifestId={manifestId} stopId="" />
        </>
      );
    }
  }
  if (
    stopQuery.status === 'success' &&
    stopQuery.data.stop.pickup_manifest_id.toLowerCase() !== manifestId.toLowerCase()
  ) {
    return <StopNotFound manifestId={manifestId} />;
  }

  const code = stop?.pickup_summary?.reference ?? request.data?.request.code;
  const existing = evidence.data?.pages.at(-1)?.parcel_photo_exception;
  return (
    <>
      <title>Let a count through without photos · Melarc Ops Portal</title>
      <PageHeader
        title="Let a count through without photos"
        {...(stop === undefined
          ? {}
          : {
              description: `Stop ${String(stop.sequence)}${code === undefined ? '' : `, ${code}`}.`,
            })}
        breadcrumb={[
          { label: 'Pickup runs', to: '/manifests' },
          { label: run.data?.manifest.code ?? 'The pickup run', to: `/manifests/${manifestId}` },
          {
            label: stop === undefined ? 'The stop' : `Stop ${String(stop.sequence)}`,
            to: `/manifests/${manifestId}/stops/${stopId}`,
          },
        ]}
      />
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
          record.stop.state !== 'ARRIVED' ? (
            <p className="pickup-status">
              <StatusBadge status={stopStatusOf(record.stop)} map={STOP_STATUS_MAP} />{' '}
              <span>
                The rider has not arrived at this stop, or the stop is already closed, so its count
                cannot be let through without photos now.
              </span>
            </p>
          ) : existing !== undefined && existing !== null ? (
            <p className="pickup-status">
              <span>
                This stop has already been let through without photos. It is on the stop’s page.
              </span>
            </p>
          ) : (
            <Form manifestId={manifestId} record={record} code={code} />
          )
        }
      </ReadState>
    </>
  );
}

/**
 * Let a count through without parcel photos (surfaces/ops-portal.md section 7, `/manifests/{id}/stops/{stopId}/photo-exception`; S1.30): the task form of the one act (`authoriseParcelPhotoException`,
 * `pickup.handshake.override`). **Offered only before the count**: a stop the rider has not arrived at, one already closed and one already let through are told in plain words, and a stop that has a count
 * is refused by the server in words of its own (`STATE_CONFLICT`, rule `collection_recorded`). The note is required (the camera failed, the photos cannot be sent) and held to the same screening as every
 * note. The act is sent under a fresh `Idempotency-Key` and, once done, brings the officer to the stop's page. **The act is never offered a way back**: the exception is made once for a stop and never
 * changed or removed.
 */
export function StopExceptionPage() {
  const { id = '', stopId = '' } = useParams();
  if (!UUID.test(id) || !UUID.test(stopId)) {
    return <StopNotFound manifestId={UUID.test(id) ? id : ''} />;
  }
  return <Exception key={stopId} manifestId={id} stopId={stopId} />;
}

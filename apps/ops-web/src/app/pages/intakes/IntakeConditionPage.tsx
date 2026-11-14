import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  recordIntakeCondition,
  type CountedWithVersion,
} from '../../../platform/hub-intake/hub-intake-commands';
import {
  INTAKE_CONDITIONS,
  type IntakeCondition,
  type PostCountIntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import type { IntakeRecord } from '../../../platform/hub-intake/use-hub-intake-queries';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { IntakeEvidence } from './IntakeEvidence';
import { actBreadcrumb, WithIntake } from './WithIntake';
import { CONDITION_CHOICES, countPath, intakePath, type DoneState } from './intake-presentation';

const NEEDS_PHOTO: readonly IntakeCondition[] = ['DAMAGED', 'TAMPERED'];
const CHOOSE = 'Choose what you found.';
const PHOTO_NEEDED = 'Add at least one photo of what you found.';
const PHOTOS_BUSY = 'Wait until every photo has been sent, or leave it out.';

const isCondition = (value: string | null): value is IntakeCondition =>
  value !== null && (INTAKE_CONDITIONS as readonly string[]).includes(value);

function Form({
  record,
  intake,
  reload,
}: {
  readonly record: IntakeRecord;
  readonly intake: PostCountIntakeView;
  readonly reload: () => Promise<unknown>;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [conditionError, setConditionError] = useState<string | undefined>(undefined);
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  const condition = isCondition(chosen) ? chosen : undefined;
  const needsPhoto = condition !== undefined && NEEDS_PHOTO.includes(condition);
  const photosShown = condition !== undefined && condition !== 'OK';

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const missing = condition === undefined ? CHOOSE : undefined;
    const photoProblem = uploading
      ? PHOTOS_BUSY
      : needsPhoto && photos.length === 0
        ? PHOTO_NEEDED
        : undefined;
    setConditionError(missing);
    setPhotoError(photoProblem);
    if (missing !== undefined || photoProblem !== undefined) {
      setAttempts((count) => count + 1);
      return;
    }
    setConfirming(true);
  }

  const label = CONDITION_CHOICES.find((choice) => choice.value === condition)?.label.toLowerCase();
  return (
    <>
      <TaskForm
        formRef={form}
        onSubmit={review}
        actions={
          <>
            <Button type="submit">Review</Button>
            <Link to={intakePath(intake.id)}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection
          title="What you found"
          description="Independent of the count: a count that matches can still be damaged."
        >
          <TaskFormWide>
            <RadioGroup
              legend="Condition of the parcels"
              name="condition"
              required
              value={chosen}
              options={CONDITION_CHOICES.map((choice) => ({
                value: choice.value,
                label: choice.label,
                help: choice.help,
              }))}
              onChange={(value) => {
                setChosen(value);
                setConditionError(undefined);
                setPhotoError(undefined);
              }}
              {...(conditionError === undefined ? {} : { error: conditionError })}
            />
          </TaskFormWide>
          <TaskFormWide>
            <Field
              label="Note"
              help="What you saw, in a few words. Leave out phone numbers and email addresses."
            >
              <Textarea
                name="note"
                value={note}
                rows={3}
                onChange={(event) => {
                  setNote(event.target.value);
                }}
              />
            </Field>
          </TaskFormWide>
          <TaskFormWide>
            <div hidden={!photosShown}>
              <IntakeEvidence
                intakeId={intake.id}
                purpose="CONDITION"
                required={needsPhoto}
                error={photoError}
                onChange={(stored) => {
                  setPhotos(stored);
                  setPhotoError(undefined);
                }}
                onBusyChange={setUploading}
              />
            </div>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<
        {
          readonly condition: IntakeCondition;
          readonly note: string;
          readonly photos: readonly string[];
        },
        CountedWithVersion
      >
        open={confirming}
        title="Record this condition?"
        consequence={
          <p>
            {condition === 'OK'
              ? 'This records that you found nothing wrong. It changes nothing else, and a condition is recorded once.'
              : `This records that you found the parcels ${label ?? 'in this condition'}. A condition is recorded once, and the intake goes to a senior officer’s review. No count changes.`}
          </p>
        }
        confirmLabel="Record the condition"
        operation="recordIntakeCondition"
        retryable
        build={() =>
          condition === undefined
            ? undefined
            : { condition, note: note.trim(), photos: condition === 'OK' ? [] : photos }
        }
        send={(command, key) =>
          recordIntakeCondition(
            client,
            intake.id,
            {
              condition: command.condition,
              ...(command.note === '' ? {} : { note: command.note }),
              evidenceIds: command.photos,
            },
            record.etag,
            key,
          )
        }
        onDone={() => {
          void navigate(intakePath(intake.id), {
            state: { done: 'condition' } satisfies DoneState,
          });
        }}
        onCancel={() => {
          setConfirming(false);
        }}
        onReload={() => {
          setConfirming(false);
          void reload();
        }}
        onRefused={(problem) => {
          // A missing or unstored photo is told at the photos, in words; every other refusal is told in the dialog.
          if (problem.code === 'REASON_REQUIRED') setPhotoError(PHOTO_NEEDED);
          if (problem.code === 'EVIDENCE_NOT_STORED')
            setPhotoError('Add the photos again: one was not stored.');
        }}
      />
    </>
  );
}

function Body({
  record,
  reload,
}: {
  readonly record: IntakeRecord;
  readonly reload: () => Promise<unknown>;
}) {
  const me = useSignedInSession();
  const { intake } = record;
  if (intake.count_phase === 'PRE_COUNT') {
    return (
      <div className="pickup-status">
        <p>This intake has not been counted yet. A condition is recorded after the count.</p>
        {me?.holds('hub.intake.count') === true ? (
          <p>
            <ButtonLink to={countPath(intake.id)}>Count the parcels</ButtonLink>
          </p>
        ) : null}
      </div>
    );
  }
  if (intake.state !== 'RECONCILIATION_REQUIRED' && intake.state !== 'READY_FOR_ITEMIZATION') {
    return (
      <p className="pickup-status">
        Itemising this intake has begun, so its condition can no longer be recorded here.{' '}
        <Link to={intakePath(intake.id)}>Open the intake</Link>
      </p>
    );
  }
  if (intake.condition_findings.some((finding) => finding.kind === 'CONDITION')) {
    return (
      <p className="pickup-status">
        A condition has already been recorded for this intake. It is recorded once.{' '}
        <Link to={intakePath(intake.id)}>Open the intake</Link>
      </p>
    );
  }
  return <Form record={record} intake={intake} reload={reload} />;
}

/**
 * Record the condition (surfaces/ops-portal.md section 7, `/intakes/{id}/condition`; S1.35; the task form of `recordIntakeCondition`, `hub.intake.count`): what the receiver found, apart from the count. **It
 * is offered only for an intake that has been counted, whose itemising has not begun and whose condition is not recorded yet** (a condition is recorded once); the page says so in plain words for each of the
 * others and the server judges all the same (`STATE_CONFLICT` and its rule). A condition is **chosen, never defaulted**; `DAMAGED` and `TAMPERED` need at least one stored photo of this intake, which the form uploads
 * (`EvidenceUpload`) and cites; the form does not send while a photo is on its way. The act is sent under a fresh `Idempotency-Key` and the version read, and brings the officer to the record.
 */
export function IntakeConditionPage() {
  const { id = '' } = useParams();
  const me = useSignedInSession();
  return (
    <WithIntake
      id={id}
      heading={(record) => ({
        title: 'Record the condition',
        documentTitle: 'Record the condition',
        description:
          record === undefined
            ? 'What you found when you received the parcels.'
            : `Intake ${record.intake.code}. What you found when you received the parcels.`,
      })}
      breadcrumb={(record) => actBreadcrumb(record, id)}
    >
      {(record, query) =>
        me === undefined ? null : <Body record={record} reload={query.refetch} />
      }
    </WithIntake>
  );
}

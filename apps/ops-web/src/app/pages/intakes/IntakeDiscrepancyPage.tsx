import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { Checkbox } from '../../../components/ui/checkbox/Checkbox';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  adjudicateDiscrepancy,
  type CountedWithVersion,
} from '../../../platform/hub-intake/hub-intake-commands';
import {
  ADJUDICATION_OUTCOMES,
  INTAKE_CONDITIONS,
  type AdjudicationOutcome,
  type IntakeCondition,
  type PostCountIntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import type { IntakeRecord } from '../../../platform/hub-intake/use-hub-intake-queries';
import { IntakeEvidence } from './IntakeEvidence';
import { actBreadcrumb, WithIntake } from './WithIntake';
import {
  CONDITION_CHOICES,
  OUTCOME_CHOICES,
  VARIANCE_MAP,
  differenceText,
  intakePath,
  parcelsText,
  type DoneState,
} from './intake-presentation';
import { ActDialog } from '../manifests/ManifestActDialogs';

const NEEDS_PHOTO: readonly IntakeCondition[] = ['DAMAGED', 'TAMPERED'];
const CHOOSE_OUTCOME = 'Choose the outcome.';
const CHOOSE_CONDITION = 'Choose what you found.';
const WRITE_REASON = 'Write why you decided this.';
const PHOTO_NEEDED = 'Add at least one photo of what you found.';
const PHOTOS_BUSY = 'Wait until every photo has been sent, or leave it out.';

const isOutcome = (value: string | null): value is AdjudicationOutcome =>
  value !== null && (ADJUDICATION_OUTCOMES as readonly string[]).includes(value);
const isCondition = (value: string | null): value is IntakeCondition =>
  value !== null && (INTAKE_CONDITIONS as readonly string[]).includes(value);

/** What the server stated of the count, beside the form: the adjudication is made against it and changes none of it. */
function Committed({ intake }: { readonly intake: PostCountIntakeView }) {
  return (
    <DescriptionList
      heading="What was counted"
      headingLevel={3}
      items={[
        { label: 'Declared by the rider', value: parcelsText(intake.rider_declared_count) },
        { label: 'Counted at the hub', value: parcelsText(intake.physical_count) },
        {
          label: 'Comparison',
          value: (
            <>
              <StatusBadge status={intake.count_variance} map={VARIANCE_MAP} />{' '}
              {differenceText(intake.count_variance, intake.count_difference)}
            </>
          ),
        },
      ]}
    />
  );
}

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
  const [outcome, setOutcome] = useState<string | null>(null);
  const [settingCondition, setSettingCondition] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<{
    outcome?: string;
    condition?: string;
    note?: string;
    photos?: string;
  }>({});
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  const decided = isOutcome(outcome) ? outcome : undefined;
  const condition = settingCondition && isCondition(chosen) ? chosen : undefined;
  const needsPhoto = condition !== undefined && NEEDS_PHOTO.includes(condition);
  const photosShown = condition !== undefined && condition !== 'OK';

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    const found = {
      ...(decided === undefined ? { outcome: CHOOSE_OUTCOME } : {}),
      ...(settingCondition && condition === undefined ? { condition: CHOOSE_CONDITION } : {}),
      ...(note.trim() === '' ? { note: WRITE_REASON } : {}),
      ...(uploading
        ? { photos: PHOTOS_BUSY }
        : needsPhoto && photos.length === 0
          ? { photos: PHOTO_NEEDED }
          : {}),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    setConfirming(true);
  }

  const choice = OUTCOME_CHOICES.find((entry) => entry.value === decided);
  return (
    <>
      <TaskForm
        formRef={form}
        onSubmit={review}
        summary={{
          title: 'What was counted',
          children: (
            <>
              <Committed intake={intake} />
              <p className="pickup-form-note">
                A decision explains the difference and never changes a count: the declared number,
                the counted number and the comparison stay as they are.
              </p>
            </>
          ),
        }}
        actions={
          <>
            <Button type="submit">Review</Button>
            <Link to={intakePath(intake.id)}>Cancel</Link>
          </>
        }
      >
        <TaskFormSection title="Your decision">
          <TaskFormWide>
            <RadioGroup
              legend="Outcome"
              name="outcome"
              required
              value={outcome}
              options={OUTCOME_CHOICES.map((entry) => ({
                value: entry.value,
                label: entry.label,
                help: entry.help,
              }))}
              onChange={(value) => {
                setOutcome(value);
                setErrors((current) => ({ ...current, outcome: undefined }));
              }}
              {...(errors.outcome === undefined ? {} : { error: errors.outcome })}
            />
          </TaskFormWide>
          <TaskFormWide>
            <Field
              label="Reason"
              required
              help="Why you decided this, in a few words. Leave out phone numbers and email addresses."
              {...(errors.note === undefined ? {} : { error: errors.note })}
            >
              <Textarea
                name="note"
                value={note}
                rows={3}
                onChange={(event) => {
                  setNote(event.target.value);
                  setErrors((current) => ({ ...current, note: undefined }));
                }}
              />
            </Field>
          </TaskFormWide>
        </TaskFormSection>
        <TaskFormSection
          title="What you found"
          description="Only if you found something you want to record against the intake."
        >
          <TaskFormWide>
            <Checkbox
              label="Also record the condition of the parcels"
              help="Damage and tampering are independent of the count: they can be recorded on a count that matches."
              checked={settingCondition}
              onChange={(event) => {
                setSettingCondition(event.target.checked);
                setErrors((current) => ({ ...current, condition: undefined, photos: undefined }));
              }}
            />
          </TaskFormWide>
          {settingCondition ? (
            <TaskFormWide>
              <RadioGroup
                legend="Condition of the parcels"
                name="condition"
                required
                value={chosen}
                options={CONDITION_CHOICES.map((entry) => ({
                  value: entry.value,
                  label: entry.label,
                  help: entry.help,
                }))}
                onChange={(value) => {
                  setChosen(value);
                  setErrors((current) => ({ ...current, condition: undefined, photos: undefined }));
                }}
                {...(errors.condition === undefined ? {} : { error: errors.condition })}
              />
            </TaskFormWide>
          ) : null}
          <TaskFormWide>
            <div hidden={!photosShown}>
              <IntakeEvidence
                intakeId={intake.id}
                purpose="OSD"
                use="decision"
                required={needsPhoto}
                error={errors.photos}
                onChange={(stored) => {
                  setPhotos(stored);
                  setErrors((current) => ({ ...current, photos: undefined }));
                }}
                onBusyChange={setUploading}
              />
            </div>
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<
        {
          readonly outcome: AdjudicationOutcome;
          readonly note: string;
          readonly condition?: IntakeCondition;
          readonly photos: readonly string[];
        },
        CountedWithVersion
      >
        open={confirming}
        title={`Record this decision: ${choice?.label.toLowerCase() ?? 'the outcome'}?`}
        consequence={
          <p>
            This records your decision and your reason against the count. It changes no count.{' '}
            {decided === 'ESCALATED'
              ? 'The case stays open for a later decision.'
              : 'The intake is then cleared for itemising.'}
          </p>
        }
        confirmLabel="Record the decision"
        operation="adjudicateDiscrepancy"
        retryable={false}
        build={() =>
          decided === undefined
            ? undefined
            : {
                outcome: decided,
                note: note.trim(),
                ...(condition === undefined ? {} : { condition }),
                photos: condition === undefined || condition === 'OK' ? [] : photos,
              }
        }
        send={(command) =>
          adjudicateDiscrepancy(
            client,
            intake.id,
            {
              outcome: command.outcome,
              note: command.note,
              ...(command.condition === undefined ? {} : { condition: command.condition }),
              evidenceIds: command.photos,
            },
            record.etag,
          )
        }
        onDone={() => {
          void navigate(intakePath(intake.id), {
            state: { done: 'adjudicated' } satisfies DoneState,
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
          if (problem.code === 'REASON_REQUIRED') {
            setErrors((current) =>
              note.trim() === ''
                ? { ...current, note: WRITE_REASON }
                : { ...current, photos: PHOTO_NEEDED },
            );
          }
          if (problem.code === 'EVIDENCE_NOT_STORED') {
            setErrors((current) => ({
              ...current,
              photos: 'Add the photos again: one was not stored.',
            }));
          }
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
  const { intake } = record;
  if (intake.count_phase === 'PRE_COUNT') {
    return (
      <p className="pickup-status">
        This intake has not been counted yet, so there is nothing to decide.{' '}
        <Link to={intakePath(intake.id)}>Open the intake</Link>
      </p>
    );
  }
  if (intake.state !== 'RECONCILIATION_REQUIRED') {
    return (
      <p className="pickup-status">
        This intake is not waiting for a decision: it may have been resolved already.{' '}
        <Link to={intakePath(intake.id)}>Open the intake</Link>
      </p>
    );
  }
  return <Form record={record} intake={intake} reload={reload} />;
}

/**
 * Adjudicate (surfaces/ops-portal.md section 7, `/intakes/{id}/discrepancy`; S1.35; the task form of `adjudicateDiscrepancy`, `hub.osd.adjudicate`: Senior Ops and Platform Admin, **never offered to a session
 * without the key**: the route is behind it and the record offers the act to a holder alone). **Reachable on a count that matches**: damage is independent of the count, so the form is offered for an intake in
 * review whatever its variance. The outcome is chosen, never defaulted, and the reason is mandatory. **A condition can be set with it** (`DAMAGED` and `TAMPERED` need at least one stored photo of this intake,
 * of the adjudicator's own, which the form uploads for the purpose `OSD`). The counts the server stated are beside the form, and the words say that a decision changes none of them. `ESCALATED` leaves the case
 * open and says so. The act is sent on the version read and under no key (the operation declares none), so a lost answer offers only a look at the record.
 */
export function IntakeDiscrepancyPage() {
  const { id = '' } = useParams();
  return (
    <WithIntake
      id={id}
      heading={(record) => ({
        title: 'Adjudicate',
        documentTitle: 'Adjudicate an intake',
        description:
          record === undefined
            ? 'Decide what becomes of a count or a condition that needs a senior officer.'
            : `Intake ${record.intake.code}. Decide what becomes of a count or a condition that needs a senior officer.`,
      })}
      breadcrumb={(record) => actBreadcrumb(record, id)}
    >
      {(record, query) => <Body record={record} reload={query.refetch} />}
    </WithIntake>
  );
}

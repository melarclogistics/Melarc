import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { useNavigate, useParams } from 'react-router';

import { Button } from '../../../components/ui/button/Button';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { useUploadGate, UploadGateNotice } from '../../../components/ui/evidence-upload/UploadGate';
import { Field } from '../../../components/ui/field/Field';
import { focusFirstInvalid } from '../../../components/ui/form/use-submission';
import { Link } from '../../../components/ui/link/Link';
import { RadioGroup } from '../../../components/ui/radio/RadioGroup';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { TaskForm, TaskFormSection, TaskFormWide } from '../../../components/ui/templates/TaskForm';
import { useApiClient } from '../../../platform/api/api-client';
import {
  decideCase,
  type CaseDecision,
  type Decided,
} from '../../../platform/hub-receiving/receiving-decisions';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import {
  blindFindings,
  checkInFindings,
  comparisonText,
  recordPath,
  vendorTold,
  type DoneState,
} from './receiving-presentation';
import { ReceivingPhoto } from './ReceivingPhoto';
import { FindingsList, ParcelsThatNeedSomeone } from './RecordParts';
import { actBreadcrumb, codeOfRecord, WithRecord } from './WithRecord';
import { useSignedInSession } from '../../../platform/session/use-permissions';
import './receiving-pages.css';

type Outcome = CaseDecision['outcome'];

/** The outcomes in the order a senior officer is offered them: *Still searching* first (D-D4). */
const OUTCOME_ORDER: readonly Outcome[] = [
  'ESCALATED',
  'ACCEPTED',
  'WRITTEN_OFF',
  'VENDOR_NOTIFIED',
];

const isOutcome = (value: string | null): value is Outcome =>
  value !== null && (OUTCOME_ORDER as readonly string[]).includes(value);

interface Errors {
  readonly outcome?: string;
  readonly note?: string;
  readonly photos?: string;
}

/** What the API stated of the vendor, beside the decision: the decision is made against it and changes none of it. */
function Facts({
  record,
  principalId,
}: {
  readonly record: IntakeRecordView;
  readonly principalId: string | undefined;
}) {
  if (record.kind === 'check-in') {
    const view = record.view;
    const comparison = comparisonText(view.count_variance, view.count_difference);
    return (
      <>
        <DescriptionList
          items={[
            { label: WORDS.record.came.photographed, value: String(view.parcels_expected ?? 0) },
            { label: WORDS.record.came.checkedIn, value: String(view.arrived_count ?? 0) },
            { label: WORDS.record.came.missing, value: String(view.missing_count) },
            { label: WORDS.record.came.extra, value: String(view.extra_count) },
            { label: WORDS.record.came.damaged, value: String(view.damaged_count) },
            ...(comparison === undefined
              ? []
              : [{ label: WORDS.record.came.comparison, value: comparison }]),
          ]}
        />
        <h3 className="receiving-record__group-title">{WORDS.record.needsSomeone.title}</h3>
        <ParcelsThatNeedSomeone vendorName={view.vendor_name} parcels={view.parcels} />
        <h3 className="receiving-record__group-title">{WORDS.record.found.title}</h3>
        <FindingsList findings={checkInFindings(view)} />
      </>
    );
  }
  const intake = record.intake;
  if (intake.count_phase === 'PRE_COUNT') return null;
  return (
    <>
      <DescriptionList
        items={[
          { label: WORDS.record.came.riderSaid, value: String(intake.rider_declared_count) },
          { label: WORDS.record.came.counted, value: String(intake.physical_count) },
          {
            label: WORDS.record.came.comparisonBlind,
            value: comparisonText(intake.count_variance, intake.count_difference) ?? '',
          },
        ]}
      />
      <h3 className="receiving-record__group-title">{WORDS.record.found.title}</h3>
      <FindingsList findings={blindFindings(intake.condition_findings, principalId)} />
    </>
  );
}

function Form({
  record,
  offered,
  reload,
}: {
  readonly record: IntakeRecordView;
  /** The outcomes this vendor can be given now. */
  readonly offered: readonly Outcome[];
  readonly reload: () => Promise<unknown>;
}) {
  const client = useApiClient();
  const navigate = useNavigate();
  const me = useSignedInSession();
  const id = record.kind === 'check-in' ? record.view.id : record.intake.id;
  const [outcome, setOutcome] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const gate = useUploadGate();
  const [errors, setErrors] = useState<Errors>({});
  const [attempts, setAttempts] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (attempts > 0) focusFirstInvalid(form.current);
  }, [attempts]);

  const decided = isOutcome(outcome) && offered.includes(outcome) ? outcome : undefined;

  function review(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault();
    // A photo on its way is told by the gate's own line beside the field, which is on the screen already: nothing is reviewed until it is stored.
    if (gate.busy) return;
    const found = {
      ...(decided === undefined ? { outcome: WORDS.decision.chooseOutcome } : {}),
      ...(note.trim() === '' ? { note: WORDS.decision.writeReason } : {}),
    };
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setAttempts((count) => count + 1);
      return;
    }
    setConfirming(true);
  }

  return (
    <>
      <TaskForm
        formRef={form}
        onSubmit={review}
        summary={{
          title: WORDS.decision.facts,
          children: <Facts record={record} principalId={me?.session.principal_id} />,
        }}
        actions={
          <>
            <Button type="submit" size="lg">
              {WORDS.decision.review}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              onClick={() => {
                void navigate(recordPath(id));
              }}
            >
              {WORDS.decision.cancel}
            </Button>
          </>
        }
      >
        <TaskFormSection title={WORDS.decision.section}>
          <TaskFormWide>
            <RadioGroup
              legend={WORDS.decision.outcomeLegend}
              name="outcome"
              required
              value={outcome}
              options={offered.map((value) => ({
                value,
                label: WORDS.decision.outcomes[value].label,
                help: WORDS.decision.outcomes[value].help,
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
              label={WORDS.decision.reasonLabel}
              required
              help={WORDS.decision.reasonHelp}
              {...(errors.note === undefined ? {} : { error: errors.note })}
            >
              <Textarea
                name="note"
                value={note}
                rows={3}
                maxLength={1000}
                onChange={(event) => {
                  setNote(event.target.value);
                  setErrors((current) => ({ ...current, note: undefined }));
                }}
              />
            </Field>
          </TaskFormWide>
          <TaskFormWide>
            <ReceivingPhoto
              intakeId={id}
              purpose="OSD"
              use="decision"
              label={WORDS.decision.photosLabel}
              help={WORDS.decision.photosHelp}
              required={false}
              error={errors.photos}
              onChange={(stored) => {
                setPhotos(stored);
                setErrors((current) => ({ ...current, photos: undefined }));
              }}
              onBusyChange={gate.watch(WORDS.decision.photosBusyLabel)}
            />
            <UploadGateNotice gate={gate} />
          </TaskFormWide>
        </TaskFormSection>
      </TaskForm>

      <ActDialog<CaseDecision, Decided>
        open={confirming}
        title={WORDS.decision.confirmTitle(
          decided === undefined ? '' : WORDS.decision.outcomes[decided].label.toLowerCase(),
        )}
        consequence={<p>{decided === undefined ? '' : WORDS.decision.consequence[decided]}</p>}
        confirmLabel={WORDS.decision.confirm}
        confirmVariant="primary"
        size="lg"
        operation="adjudicateDiscrepancy"
        retryable={false}
        build={() => {
          if (gate.busy || decided === undefined) return undefined;
          return {
            outcome: decided,
            note: note.trim(),
            evidenceIds: photos,
          };
        }}
        send={(command) => decideCase(client, id, command, record.etag)}
        onDone={() => {
          void navigate(recordPath(id), { state: { done: 'decided' } satisfies DoneState });
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
            setErrors((current) => ({ ...current, note: WORDS.decision.writeReason }));
          }
          if (problem.code === 'EVIDENCE_NOT_STORED') {
            setErrors((current) => ({ ...current, photos: problem.message }));
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
  readonly record: IntakeRecordView;
  readonly reload: () => Promise<unknown>;
}) {
  const id = record.kind === 'check-in' ? record.view.id : record.intake.id;
  const findings =
    record.kind === 'check-in'
      ? record.view.condition_findings
      : record.intake.count_phase === 'POST_COUNT'
        ? record.intake.condition_findings
        : [];
  const state = record.kind === 'check-in' ? record.view.state : record.intake.state;
  const counted =
    record.kind === 'check-in'
      ? record.view.state !== 'AWAITING_COUNT'
      : record.intake.count_phase === 'POST_COUNT';

  if (!counted) {
    return (
      <p className="receiving-note">
        {WORDS.decision.notCounted} <Link to={recordPath(id)}>{WORDS.decision.openVendor}</Link>
      </p>
    );
  }
  // A vendor in review is given the three outcomes that decide it. *Vendor told* is a record after a write-off and moves nothing: it is the one outcome offered to a vendor past review that was written off and not
  // yet recorded as told. The API judges both, and says so when the page was stale.
  if (state === 'RECONCILIATION_REQUIRED') {
    return (
      <Form record={record} offered={['ESCALATED', 'ACCEPTED', 'WRITTEN_OFF']} reload={reload} />
    );
  }
  const { writtenOff, told } = vendorTold(findings);
  if (writtenOff && !told) {
    return <Form record={record} offered={['VENDOR_NOTIFIED']} reload={reload} />;
  }
  return (
    <p className="receiving-note">
      {WORDS.decision.notWaiting} <Link to={recordPath(id)}>{WORDS.decision.openVendor}</Link>
    </p>
  );
}

/**
 * The senior officer's decision (surfaces/ops-portal.md section 7, `/intakes/{id}/discrepancy`; S1.35c; D-D4; the task form of `adjudicateDiscrepancy`, `hub.osd.adjudicate`: **never offered to a session without
 * the key**, the route is behind it and the record offers the act to a holder alone). **The facts come first**: the counts the API stated, the parcels that are missing, extra or damaged as their photos, and what was
 * found, so that the officer decides against what happened and not from a form. The outcomes are chosen, never defaulted, in the order *Still searching* (the case stays open and the missing parcels stay on the list of
 * those being searched for), *Accept what arrived* and *Write off what is missing*; ***Vendor told* is a record that someone told the vendor, offered only after a write-off and once**, and the page says that it sends
 * nothing. The reason is required, and photos for the decision are optional and stored before they are cited. It is confirmed before it is sent, and sent on the version read and under no key (the operation takes
 * none), so a lost answer offers only a look at the vendor. **The page decides nothing about a count**: a decision explains, a correction (the record's) changes.
 */
export function DecisionPage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      heading={(record) => ({
        title: WORDS.decision.title,
        documentTitle: WORDS.decision.documentTitle,
        ...(record === undefined
          ? {}
          : { description: WORDS.decision.description(codeOfRecord(record)) }),
      })}
      breadcrumb={(record) => actBreadcrumb(record, id)}
    >
      {(record, query) => <Body record={record} reload={query.refetch} />}
    </WithRecord>
  );
}

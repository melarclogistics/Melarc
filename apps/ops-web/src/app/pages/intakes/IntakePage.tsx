import { useEffect, useRef } from 'react';
import { useLocation, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { Panel } from '../../../components/ui/panel/Panel';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import type {
  FindingView,
  IntakeView,
  PostCountIntakeView,
} from '../../../platform/hub-intake/hub-intake-shape';
import type { IntakeRecord } from '../../../platform/hub-intake/use-hub-intake-queries';
import { cannotText } from '../../../platform/problem/capability-words';
import {
  useSignedInSession,
  type SignedInSession,
} from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { IntakePhotos } from './IntakePhotos';
import {
  CONDITION_MAP,
  FINDING_KIND_WORDS,
  INTAKE_STATE_MAP,
  OUTCOME_WORDS,
  STATE_SENTENCES,
  VARIANCE_MAP,
  conditionPath,
  countPath,
  differenceText,
  discrepancyPath,
  findingByline,
  parcelsText,
  receivingNowText,
  type DoneState,
} from './intake-presentation';
import { useFocusFallenToHeading, WithIntake } from './WithIntake';
import './intake-pages.css';

const DONE_WORDS: Readonly<Record<NonNullable<DoneState['done']>, string>> = {
  counted:
    'Your count is recorded. The number the rider declared is shown below, with the comparison.',
  condition: 'The condition is recorded.',
  adjudicated: 'Your decision is recorded.',
};

/** The count of an intake that has been counted, as the server stated it: the declaration, the physical count and the comparison, with the difference in words. The page works out none of it. */
function CountPanel({ intake }: { readonly intake: PostCountIntakeView }) {
  return (
    <Panel title="The count" headingLevel={2} region>
      <DescriptionList
        items={[
          { label: 'Declared by the rider', value: parcelsText(intake.rider_declared_count) },
          { label: 'Counted at the hub', value: parcelsText(intake.physical_count) },
          {
            label: 'Comparison',
            value: (
              <span className="intake-comparison">
                <StatusBadge status={intake.count_variance} map={VARIANCE_MAP} />
                <span>{differenceText(intake.count_variance, intake.count_difference)}</span>
              </span>
            ),
          },
        ]}
      />
    </Panel>
  );
}

/** An intake that has not been counted shows **no comparison**, and says why: the count is blind, and the rider's declaration is revealed only once the count is recorded. */
function NotCountedPanel() {
  return (
    <Panel title="The count" headingLevel={2} region>
      <p>
        This intake has not been counted. The count is blind: nothing of the rider’s declaration is
        shown, here or anywhere, until your count is recorded.
      </p>
    </Panel>
  );
}

function Finding({
  finding,
  principal,
}: {
  readonly finding: FindingView;
  readonly principal: string | undefined;
}) {
  return (
    <li className="intake-finding">
      <p className="intake-finding__title">{FINDING_KIND_WORDS[finding.kind]}</p>
      <p className="intake-finding__facts">
        {finding.condition === null ? null : (
          <StatusBadge status={finding.condition} map={CONDITION_MAP} />
        )}
        {finding.outcome === null ? null : <span>{OUTCOME_WORDS[finding.outcome]}</span>}
      </p>
      {finding.note === null ? null : <p className="intake-finding__note">{finding.note}</p>}
      {finding.evidence_ids.length === 0 ? null : (
        <IntakePhotos ids={finding.evidence_ids} noun="Photo" label="Photos of this finding" />
      )}
      <p className="intake-finding__by">{findingByline(finding, principal)}</p>
    </li>
  );
}

/** What the receiver found, apart from the count (the three dimensions of what is found at receiving are never one), with each finding in the order it was made and its photos. */
function ConditionPanel({
  intake,
  principal,
}: {
  readonly intake: PostCountIntakeView;
  readonly principal: string | undefined;
}) {
  return (
    <Panel title="Condition" headingLevel={2} region>
      <p>
        <StatusBadge status={intake.condition} map={CONDITION_MAP} />
      </p>
      {intake.condition_findings.length === 0 ? (
        <p>No finding has been recorded.</p>
      ) : (
        <ol className="intake-findings" aria-label="Findings, in the order they were made">
          {intake.condition_findings.map((finding) => (
            <Finding key={finding.id} finding={finding} principal={principal} />
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** The photos of the parcels at the door: told only for a counted intake, and opened one at a time. */
function CollectionPhotosPanel({ intake }: { readonly intake: PostCountIntakeView }) {
  return (
    <Panel title="Photos of the collection" headingLevel={2} region>
      {intake.parcel_photo_ids.length === 0 ? (
        <p>No photos of the collection are attached to this intake.</p>
      ) : (
        <>
          <p>
            Taken by the rider at the door. A photo is opened one at a time, and is read only while
            it is open.
          </p>
          <IntakePhotos
            ids={intake.parcel_photo_ids}
            noun="Photo of the collection"
            label="Photos of the collection"
          />
        </>
      )}
    </Panel>
  );
}

function Facts({ intake, me }: { readonly intake: IntakeView; readonly me: SignedInSession }) {
  return (
    <Panel title="The intake" headingLevel={2}>
      <DescriptionList
        items={[
          { label: 'State', value: <StatusBadge status={intake.state} map={INTAKE_STATE_MAP} /> },
          { label: 'Hub', value: hubNameOf(intake.hub_id, me.session.authorized_hubs) },
          {
            label: 'Pickup run',
            value: <Link to={`/manifests/${intake.pickup_manifest_id}`}>Open the run</Link>,
          },
          {
            label: 'Pickup request',
            value: (
              <Link to={`/pickup-requests/${intake.pickup_request_id}`}>Open the request</Link>
            ),
          },
          { label: 'Handed over', value: formatInstant(intake.handed_over_at) ?? '' },
          { label: 'Handed over by', value: 'A rider' },
          ...(intake.count_phase === 'PRE_COUNT'
            ? [{ label: 'Receiving now', value: receivingNowText(intake, me.session.principal_id) }]
            : []),
        ]}
      />
    </Panel>
  );
}

function Intake({ record }: { readonly record: IntakeRecord }) {
  const me = useSignedInSession();
  const location = useLocation();
  const done = (location.state as DoneState | null)?.done;
  const noticeBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done !== undefined) noticeBox.current?.focus();
  }, [done]);
  useFocusFallenToHeading();
  if (me === undefined) return null;
  const { intake } = record;
  const counted = intake.count_phase === 'POST_COUNT';
  const mayCount = me.holds('hub.intake.count');
  const mayAdjudicate = me.holds('hub.osd.adjudicate');
  const inReview = intake.state === 'RECONCILIATION_REQUIRED';
  // What the server will allow, as far as the record says: a condition is recorded once, after the count and before itemising starts. The server judges all the same.
  const mayRecordCondition =
    counted &&
    mayCount &&
    (intake.state === 'RECONCILIATION_REQUIRED' || intake.state === 'READY_FOR_ITEMIZATION') &&
    !intake.condition_findings.some((finding) => finding.kind === 'CONDITION');

  return (
    <RecordPage
      breadcrumb={[{ label: 'Receiving', to: '/intakes' }]}
      header={{
        code: intake.code,
        status: <StatusBadge status={intake.state} map={INTAKE_STATE_MAP} />,
        sentence: STATE_SENTENCES[intake.state],
      }}
      acts={{
        ...(!counted && mayCount
          ? { primary: <ButtonLink to={countPath(intake.id)}>Count the parcels</ButtonLink> }
          : {}),
        ...(counted && inReview && mayAdjudicate
          ? { primary: <ButtonLink to={discrepancyPath(intake.id)}>Adjudicate</ButtonLink> }
          : {}),
        ...(mayRecordCondition
          ? {
              secondary: (
                <ButtonLink to={conditionPath(intake.id)} variant="secondary">
                  Record the condition
                </ButtonLink>
              ),
            }
          : {}),
        ...(counted && inReview && !mayAdjudicate
          ? { note: `A senior officer decides this. ${cannotText('hub.osd.adjudicate')}` }
          : {}),
      }}
      notice={
        done === undefined ? undefined : (
          <div className="pickup-notice" ref={noticeBox} tabIndex={-1}>
            <Alert variant="success">
              <p>{DONE_WORDS[done]}</p>
            </Alert>
          </div>
        )
      }
      main={
        counted ? (
          <>
            <CountPanel intake={intake} />
            <ConditionPanel intake={intake} principal={me.session.principal_id} />
            <CollectionPhotosPanel intake={intake} />
          </>
        ) : (
          <NotCountedPanel />
        )
      }
      side={<Facts intake={intake} me={me} />}
    />
  );
}

/**
 * An intake's record (surfaces/ops-portal.md section 7, `/intakes/{id}`; S1.35): the record template. **Before the count it is the pre-count facts and a way to the count page, and shows no comparison**: it
 * has no declaration, count, variance, condition or photo to show (the shape of an intake that has not been counted has no place for them). **After the count it shows the comparison as the server stated it**
 * (the rider's declaration, the physical count, `count_variance`, and the difference in words), the condition and the findings in the order they were made with their photos, and the photos of the collection,
 * each opened one at a time. Acts are offered by key and by what the record says, and decide nothing: *Count the parcels* to a holder of the count key for an intake awaiting its count, *Record the condition*
 * to the same key once, and *Adjudicate* to a holder of the adjudication key while the intake is in review (a session without it is told, in plain words, that a senior officer decides). **Itemising and
 * closing are not offered**: they are later work, and the page says so.
 */
export function IntakePage() {
  const { id = '' } = useParams();
  return (
    <WithIntake
      id={id}
      ownsHeading
      heading={(record) => ({
        title: record === undefined ? 'Intake' : record.intake.code,
        documentTitle: record === undefined ? 'Intake' : `Intake ${record.intake.code}`,
      })}
      breadcrumb={() => [{ label: 'Receiving', to: '/intakes' }]}
    >
      {(record) => <Intake record={record} />}
    </WithIntake>
  );
}

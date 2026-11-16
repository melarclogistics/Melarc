import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useParams } from 'react-router';

import { Alert } from '../../../components/ui/alert/Alert';
import { Button } from '../../../components/ui/button/Button';
import { ButtonLink } from '../../../components/ui/button/ButtonLink';
import { DescriptionList } from '../../../components/ui/description-list/DescriptionList';
import { Link } from '../../../components/ui/link/Link';
import { Panel } from '../../../components/ui/panel/Panel';
import { StatusBadge } from '../../../components/ui/status-badge/StatusBadge';
import { RecordPage } from '../../../components/ui/templates/RecordPage';
import type { IntakeState } from '../../../platform/hub-intake/hub-intake-shape';
import type { CheckInView } from '../../../platform/hub-receiving/receiving-shape';
import type { IntakeRecordView } from '../../../platform/hub-receiving/use-intake-record';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import {
  useSignedInSession,
  type SignedInSession,
} from '../../../platform/session/use-permissions';
import { formatInstant } from '../../../platform/time/format-time';
import { hubNameOf } from '../staff/staff-presentation';
import { BlindDamageDialog } from './BlindDamageDialog';
import { CorrectionDialog, type CorrectionTarget } from './CorrectionDialog';
import {
  blindFindings,
  checkInComparison,
  checkInFindings,
  comparisonText,
  countPath,
  decisionPath,
  RECEIVING_QUEUE_PATH,
  runPath,
  VENDOR_STATE_MAP,
  vendorTold,
  type DoneState,
} from './receiving-presentation';
import { CountedDoorPhotos, DoorPhotos, FindingsList, ParcelsThatNeedSomeone } from './RecordParts';
import { useFocusFallenToHeading, WithRecord } from './WithRecord';
import './receiving-pages.css';

const DONE_WORDS: Readonly<Record<NonNullable<DoneState['done']>, string>> = {
  counted: WORDS.record.done.counted,
  damage: WORDS.record.done.damage,
  decided: WORDS.record.done.decided,
};

/** The states in which a vendor has been checked in or counted and its listing of orders has not begun: the ones a correction and a vendor's damage can still change. */
const OPEN_TO_CHANGE: readonly IntakeState[] = [
  'COUNTED',
  'RECONCILIATION_REQUIRED',
  'READY_FOR_ITEMIZATION',
];

/** The sentence under the vendor's code: where it stands, in the floor's words. */
function sentenceOf(state: IntakeState, blindWaiting: boolean): string {
  if (state === 'AWAITING_COUNT')
    return blindWaiting ? WORDS.record.blindWaiting : WORDS.record.waiting;
  return WORDS.vendor.standing[state];
}

/** What came of a vendor checked in against its door photos: the API's counts, said, with the comparison. */
function CheckInCame({ view }: { readonly view: CheckInView }) {
  const waiting = view.state === 'AWAITING_COUNT';
  const comparison = checkInComparison(view, view.count_difference);
  return (
    <>
      <DescriptionList
        items={[
          {
            label: WORDS.record.came.photographed,
            value: String(view.parcels_expected ?? 0),
          },
          ...(waiting
            ? []
            : [
                { label: WORDS.record.came.checkedIn, value: String(view.arrived_count ?? 0) },
                { label: WORDS.record.came.missing, value: String(view.missing_count) },
                { label: WORDS.record.came.extra, value: String(view.extra_count) },
                { label: WORDS.record.came.damaged, value: String(view.damaged_count) },
              ]),
          ...(comparison === undefined
            ? []
            : [{ label: WORDS.record.came.comparison, value: comparison }]),
        ]}
      />
    </>
  );
}

function Facts({
  me,
  record,
}: {
  readonly me: SignedInSession;
  readonly record: IntakeRecordView;
}) {
  const hub = hubNameOf(
    record.kind === 'check-in' ? record.view.hub_id : record.intake.hub_id,
    me.session.authorized_hubs,
  );
  const handedOver = formatInstant(
    record.kind === 'check-in' ? record.view.handed_over_at : record.intake.handed_over_at,
  );
  const manifestId =
    record.kind === 'check-in' ? record.view.pickup_manifest_id : record.intake.pickup_manifest_id;
  const state = record.kind === 'check-in' ? record.view.state : record.intake.state;
  const view = record.kind === 'check-in' ? record.view : undefined;
  const checkedInBy = view?.counted_by_name ?? null;
  const checkedInAt = view?.counted_at ?? null;
  return (
    <Panel title={WORDS.record.facts.title} headingLevel={2}>
      <DescriptionList
        items={[
          {
            label: WORDS.record.facts.state,
            value: <StatusBadge status={state} map={VENDOR_STATE_MAP} />,
          },
          { label: WORDS.record.facts.hub, value: hub },
          {
            label: WORDS.record.facts.run,
            value: (
              <Link to={runPath(manifestId)}>
                {view === undefined ? WORDS.record.facts.openRun : view.run_code}
              </Link>
            ),
          },
          { label: WORDS.record.facts.handedOver, value: handedOver ?? '' },
          {
            label: WORDS.record.facts.handedOverBy,
            value: view === undefined ? WORDS.record.facts.blindRider : view.handed_over_by_name,
          },
          ...(checkedInBy === null || checkedInAt === null
            ? []
            : [
                {
                  label: WORDS.record.facts.checkedInBy,
                  value: WORDS.record.found.by(checkedInBy, formatInstant(checkedInAt) ?? ''),
                },
              ]),
        ]}
      />
    </Panel>
  );
}

function RecordBody({
  record,
  query,
}: {
  readonly record: IntakeRecordView;
  readonly query: UseQueryResult<IntakeRecordView>;
}) {
  const me = useSignedInSession();
  const location = useLocation();
  const done = (location.state as DoneState | null)?.done;
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<'correct' | 'damage' | undefined>(undefined);
  const noticeBox = useRef<HTMLDivElement>(null);
  const said = notice ?? (done === undefined ? undefined : DONE_WORDS[done]);
  useEffect(() => {
    if (said !== undefined) noticeBox.current?.focus();
  }, [said]);
  useFocusFallenToHeading();
  if (me === undefined) return null;

  const mayCount = me.holds('hub.intake.count');
  const mayDecide = me.holds('hub.osd.adjudicate');
  const checkIn = record.kind === 'check-in' ? record.view : undefined;
  const intake = record.kind === 'blind' ? record.intake : undefined;
  const counted = intake?.count_phase === 'POST_COUNT' ? intake : undefined;
  const id = checkIn?.id ?? intake?.id ?? '';
  const code = checkIn?.code ?? intake?.code ?? '';
  const state = checkIn?.state ?? intake?.state ?? 'AWAITING_COUNT';
  const inReview = state === 'RECONCILIATION_REQUIRED';
  const finished = checkIn !== undefined ? state !== 'AWAITING_COUNT' : counted !== undefined;
  const mayCorrect = mayDecide && finished && OPEN_TO_CHANGE.includes(state);
  // A vendor whose missing parcels were written off is recorded as told once, after the write-off: the decision's page offers that alone.
  const { writtenOff, told } = vendorTold(
    checkIn?.condition_findings ?? counted?.condition_findings ?? [],
  );
  const mayRecordTold = finished && mayDecide && !inReview && writtenOff && !told;
  // What the API will allow, as far as the record says: damage of the whole vendor is recorded once, after the count and before the orders are listed. The API judges all the same.
  const mayRecordDamage =
    counted !== undefined &&
    mayCount &&
    (state === 'RECONCILIATION_REQUIRED' || state === 'READY_FOR_ITEMIZATION') &&
    !counted.condition_findings.some((finding) => finding.kind === 'CONDITION');

  const primary: ReactNode =
    checkIn !== undefined && state === 'AWAITING_COUNT' && mayCount ? (
      <ButtonLink to={runPath(checkIn.pickup_manifest_id)}>{WORDS.record.acts.checkIn}</ButtonLink>
    ) : intake?.count_phase === 'PRE_COUNT' && mayCount ? (
      <ButtonLink to={countPath(id)}>{WORDS.record.acts.count}</ButtonLink>
    ) : finished && inReview && mayDecide ? (
      <ButtonLink to={decisionPath(id)}>{WORDS.record.acts.decide}</ButtonLink>
    ) : mayRecordTold ? (
      <ButtonLink to={decisionPath(id)}>{WORDS.record.acts.vendorTold}</ButtonLink>
    ) : undefined;
  const secondary: ReactNode =
    mayCorrect || mayRecordDamage ? (
      <>
        {mayRecordDamage ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDialog('damage');
            }}
          >
            {WORDS.record.acts.recordDamage}
          </Button>
        ) : null}
        {mayCorrect ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setDialog('correct');
            }}
          >
            {WORDS.record.acts.correct}
          </Button>
        ) : null}
      </>
    ) : undefined;
  const note = finished && inReview && !mayDecide ? WORDS.record.acts.seniorDecides : undefined;

  const target: CorrectionTarget | undefined =
    checkIn !== undefined
      ? { kind: 'check-in', view: checkIn }
      : counted !== undefined
        ? { kind: 'blind', intake: counted }
        : undefined;
  const vendorName = checkIn?.vendor_name ?? WORDS.record.loadingTitle;

  return (
    <>
      <RecordPage
        breadcrumb={[{ label: WORDS.record.receiving, to: RECEIVING_QUEUE_PATH }]}
        header={{
          code,
          status: <StatusBadge status={state} map={VENDOR_STATE_MAP} />,
          sentence: sentenceOf(state, intake !== undefined),
        }}
        acts={{
          ...(primary === undefined ? {} : { primary }),
          ...(secondary === undefined ? {} : { secondary }),
          ...(note === undefined ? {} : { note }),
        }}
        notice={
          said === undefined ? undefined : (
            <div className="receiving-notice" ref={noticeBox} tabIndex={-1}>
              <Alert variant="success">
                <p>{said}</p>
              </Alert>
            </div>
          )
        }
        main={
          checkIn !== undefined ? (
            <>
              <Panel title={WORDS.record.came.title} headingLevel={2} region>
                <CheckInCame view={checkIn} />
              </Panel>
              {state === 'AWAITING_COUNT' ? null : (
                <Panel title={WORDS.record.needsSomeone.title} headingLevel={2} region>
                  <ParcelsThatNeedSomeone vendorName={vendorName} parcels={checkIn.parcels} />
                </Panel>
              )}
              <Panel title={WORDS.record.found.title} headingLevel={2} region>
                <FindingsList findings={checkInFindings(checkIn)} />
              </Panel>
              <Panel title={WORDS.record.photos.title} headingLevel={2} region>
                <DoorPhotos vendorName={vendorName} parcels={checkIn.parcels} />
              </Panel>
            </>
          ) : counted !== undefined ? (
            <>
              <Panel title={WORDS.record.came.title} headingLevel={2} region>
                <DescriptionList
                  items={[
                    {
                      label: WORDS.record.came.riderSaid,
                      value: String(counted.rider_declared_count),
                    },
                    { label: WORDS.record.came.counted, value: String(counted.physical_count) },
                    {
                      label: WORDS.record.came.comparisonBlind,
                      value: comparisonText(counted.count_variance, counted.count_difference) ?? '',
                    },
                  ]}
                />
              </Panel>
              <Panel title={WORDS.record.found.title} headingLevel={2} region>
                <FindingsList
                  findings={blindFindings(counted.condition_findings, me.session.principal_id)}
                />
              </Panel>
              <Panel title={WORDS.record.photos.title} headingLevel={2} region>
                <CountedDoorPhotos ids={counted.parcel_photo_ids} />
              </Panel>
            </>
          ) : (
            <Panel title={WORDS.record.came.title} headingLevel={2} region>
              <p>{WORDS.record.blindWaiting}</p>
            </Panel>
          )
        }
        side={<Facts me={me} record={record} />}
      />
      {dialog === 'correct' && target !== undefined ? (
        <CorrectionDialog
          target={target}
          version={record.etag}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={(result) => {
            setDialog(undefined);
            setNotice(WORDS.record.done.corrected(result.before, result.now));
            void query.refetch();
          }}
          onReload={() => {
            setDialog(undefined);
            return query.refetch();
          }}
        />
      ) : null}
      {dialog === 'damage' && counted !== undefined ? (
        <BlindDamageDialog
          intake={counted}
          version={record.etag}
          onCancel={() => {
            setDialog(undefined);
          }}
          onDone={() => {
            setDialog(undefined);
            setNotice(WORDS.record.done.damage);
            void query.refetch();
          }}
          onReload={() => {
            setDialog(undefined);
            return query.refetch();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * A vendor's record (surfaces/ops-portal.md section 7, `/intakes/{id}`; S1.35c; D-D1, D-D2, D-D8): **what came of the vendor**, in the floor's words. A vendor checked in against its door photos shows the
 * photos it was photographed with, what was checked in and what is missing, extra or damaged (each group as the photos of its parcels, opened one at a time), and the comparison with the photos; a vendor
 * counted without photos shows the rider's number only once it has been counted, with the comparison. **What was found** is every finding in the order it was made, with its photos and who made it. The page
 * works out none of it: the counts, the state and the comparison are the API's. Acts are offered by key and by what the record says, and decide nothing: *Check in this vendor* (to its run) or *Count the
 * parcels* to a holder of the count key, *Decide* to a holder of the decision key while the vendor needs a decision (anyone else is told a senior officer will decide), *Record damage* once for a vendor
 * counted without photos, and *Correct the count* to a holder of the decision key until the orders are being listed. **Listing the orders and closing are not offered**: they are later work.
 */
export function IntakeRecordPage() {
  const { id = '' } = useParams();
  return (
    <WithRecord
      id={id}
      ownsHeading
      heading={(record) => ({
        title:
          record === undefined
            ? WORDS.record.loadingTitle
            : record.kind === 'check-in'
              ? record.view.code
              : record.intake.code,
        documentTitle:
          record === undefined
            ? WORDS.record.loadingTitle
            : WORDS.record.documentTitle(
                record.kind === 'check-in' ? record.view.code : record.intake.code,
              ),
      })}
      breadcrumb={() => [{ label: WORDS.record.receiving, to: RECEIVING_QUEUE_PATH }]}
    >
      {(record, query) => <RecordBody record={record} query={query} />}
    </WithRecord>
  );
}

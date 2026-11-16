import type { components } from '@melarc/api-client';

import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseIntake,
  type IntakeCondition,
  type PostCountIntakeView,
} from '../hub-intake/hub-intake-shape';
import { isRecord } from '../staff/staff-shape';
import {
  parseCheckIn,
  parseParcelAnswer,
  type CheckInView,
  type ParcelAnswerView,
} from './receiving-shape';

/**
 * The acts of the receiving screens of a run (S1.35c), each sending one request and answering with what the API answered, judged (`receiving-shape.ts`): a success status with a body that is not the parcel or
 * the vendor asked about is an answer that is not the API's (`unexpected-response`), which a confirmed command reads as an outcome that is not known, because the act may have been done. **The headers are the
 * contract's, operation by operation, and no other**: a tap (`recordParcelArrival`) takes neither a key nor a version (it states the parcel's desired state, so it is idempotent by nature, and it does not move the
 * vendor's `ETag`); the finish of a vendor takes an `Idempotency-Key` and the vendor's `ETag`; an extra takes a key and no version; the condition takes both; a senior's correction takes both.
 */

/** The advisory lock: taken on the officer's first act on a vendor and kept while the page is open and visible. It decides nothing; the answer is only judged to be this intake's. */
export async function acquireReceivingLock(client: ApiClient, intakeId: string): Promise<void> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/lock', { params: { path: { id: intakeId } } }),
  );
  if (
    !isRecord(answer.data) ||
    typeof answer.data.id !== 'string' ||
    answer.data.id.toLowerCase() !== intakeId.toLowerCase()
  ) {
    throw unexpectedResponse(answer.status);
  }
}

/**
 * `recordParcelArrival` (`hub.intake.count`): a tap on a parcel's photo. `arrived: true` checks a parcel in, or finds a missing one while the case is open; `arrived: false` takes the tap back or voids an extra
 * while the vendor is open. The answer is the parcel as it now is, the vendor's token and its counts: it must be this parcel, in a state that is what was asked.
 */
export async function recordParcelArrival(
  client: ApiClient,
  parcelId: string,
  arrived: boolean,
): Promise<ParcelAnswerView> {
  const answer = answerOf(
    await client.PUT('/intake-parcels/{parcel_id}/arrival', {
      params: { path: { parcel_id: parcelId } },
      body: { arrived },
    }),
  );
  const view = parseParcelAnswer(answer.data);
  if (
    view?.parcel.id.toLowerCase() !== parcelId.toLowerCase() ||
    (arrived ? view.parcel.state !== 'ARRIVED' : view.parcel.state === 'ARRIVED')
  ) {
    throw unexpectedResponse(answer.status);
  }
  return view;
}

/** A vendor's record with the token to take its next act on: the `ETag` exactly as the API sent it. */
export interface CheckInWithVersion {
  readonly intake: CheckInView;
  readonly version: string;
}

/** How a vendor is finished: "All N here" (the number the officer counted, a statement and never a default) or as tapped (every parcel not tapped is missing). */
export type CheckInFinish =
  { readonly allArrived: true; readonly confirmedCount: number } | { readonly allArrived: false };

/**
 * `finishCheckIn` (`hub.intake.count`; `Idempotency-Key` and the vendor's `ETag` as `If-Match`): "All N here" or as tapped. The body is `{ all_arrived, confirmed_count }` and nothing else. The answer is the
 * vendor's record as the third intake shape, finished: it must be this vendor's and, for "All N here", counted at the number the officer confirmed.
 */
export async function finishCheckIn(
  client: ApiClient,
  intakeId: string,
  finish: CheckInFinish,
  version: string,
  idempotencyKey: string,
): Promise<CheckInWithVersion> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/check-in', {
      params: {
        path: { id: intakeId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: finish.allArrived
        ? { all_arrived: true, confirmed_count: finish.confirmedCount }
        : { all_arrived: false },
    }),
  );
  const intake = parseCheckIn(answer.data);
  if (
    intake?.id.toLowerCase() !== intakeId.toLowerCase() ||
    answer.etag === undefined ||
    intake.state === 'AWAITING_COUNT' ||
    (finish.allArrived && intake.received_count !== finish.confirmedCount)
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { intake, version: answer.etag };
}

/**
 * `addExtraParcel` (`hub.intake.count`; an `Idempotency-Key` and no version): a parcel on the table with no door photo, recorded with the photo the officer took at the hub (a stored evidence record of this
 * intake). The answer is the new parcel, an extra, with that photo.
 */
export async function addExtraParcel(
  client: ApiClient,
  intakeId: string,
  photoEvidenceId: string,
  note: string | undefined,
  idempotencyKey: string,
): Promise<ParcelAnswerView> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/extra-parcels', {
      params: { path: { id: intakeId }, header: { 'Idempotency-Key': idempotencyKey } },
      body: { photo_evidence_id: photoEvidenceId, ...(note === undefined ? {} : { note }) },
    }),
  );
  const view = parseParcelAnswer(answer.data);
  if (
    view?.parcel.origin !== 'HUB_EXTRA' ||
    view.parcel.state !== 'ARRIVED' ||
    view.parcel.photo_evidence_id.toLowerCase() !== photoEvidenceId.toLowerCase()
  ) {
    throw unexpectedResponse(answer.status);
  }
  return view;
}

export interface ParcelConditionRecord {
  readonly parcelId: string;
  readonly condition: IntakeCondition;
  readonly note?: string;
  readonly evidenceIds?: readonly string[];
}

/** The generated body of the condition, widened by the parcel it is about. TODO(S1.35b-2): the generated body gains `parcel_id`, and this type goes. */
type ConditionBody = components['schemas']['IntakeConditionRecord'] & { parcel_id?: string };

/**
 * `recordIntakeCondition` for one parcel (`hub.intake.count`; `Idempotency-Key` and the vendor's `ETag`): damage is recorded on the parcel's own photo, once for each parcel. `DAMAGED` and `TAMPERED` carry the
 * identifiers of stored photos taken at the hub. The answer is the vendor's record, in which that parcel carries the condition.
 */
export async function recordParcelCondition(
  client: ApiClient,
  intakeId: string,
  record: ParcelConditionRecord,
  version: string,
  idempotencyKey: string,
): Promise<CheckInWithVersion> {
  const body: ConditionBody = {
    condition: record.condition,
    parcel_id: record.parcelId,
    ...(record.note === undefined ? {} : { note: record.note }),
    ...(record.evidenceIds === undefined || record.evidenceIds.length === 0
      ? {}
      : { evidence_ids: [...record.evidenceIds] }),
  };
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/condition', {
      params: {
        path: { id: intakeId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body,
    }),
  );
  const intake = parseCheckIn(answer.data);
  const parcel = intake?.parcels.find(
    (candidate) => candidate.id.toLowerCase() === record.parcelId.toLowerCase(),
  );
  if (
    intake?.id.toLowerCase() !== intakeId.toLowerCase() ||
    parcel?.condition?.condition !== record.condition ||
    answer.etag === undefined
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { intake, version: answer.etag };
}

/** What a senior officer corrects: a reason and, by the intake's mode, the parcels' new states (photo mode) or the corrected count (blind-count mode). */
export type IntakeCorrection =
  | {
      readonly reason: string;
      readonly parcelChanges: readonly {
        readonly parcelId: string;
        readonly state: 'ARRIVED' | 'MISSING' | 'VOID';
      }[];
    }
  | { readonly reason: string; readonly physicalCount: number };

/** The intake as a correction leaves it: the vendor's record in photo mode, the counted intake in blind-count mode, with the new token. */
export type CorrectedIntake =
  | { readonly checkIn: CheckInView; readonly counted?: undefined; readonly version: string }
  | {
      readonly counted: PostCountIntakeView;
      readonly checkIn?: undefined;
      readonly version: string;
    };

/**
 * `correctIntakeCount` (`hub.osd.adjudicate`: a senior officer, never Ops Staff; `Idempotency-Key` and the `ETag` as `If-Match`): the safety net for a mistaken count or check-in, with a reason in words. The body
 * names exactly one correction by the intake's mode. The old and the new numbers are recorded by the database and the ledger; nothing of them is sent.
 */
export async function correctIntakeCount(
  client: ApiClient,
  intakeId: string,
  correction: IntakeCorrection,
  version: string,
  idempotencyKey: string,
): Promise<CorrectedIntake> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/correction', {
      params: {
        path: { id: intakeId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body:
        'parcelChanges' in correction
          ? {
              reason: correction.reason,
              parcel_changes: correction.parcelChanges.map((change) => ({
                parcel_id: change.parcelId,
                state: change.state,
              })),
            }
          : { reason: correction.reason, physical_count: correction.physicalCount },
    }),
  );
  if (answer.etag === undefined) throw unexpectedResponse(answer.status);
  const checkIn = parseCheckIn(answer.data);
  if (checkIn !== undefined) {
    if (checkIn.id.toLowerCase() !== intakeId.toLowerCase() || !('parcelChanges' in correction)) {
      throw unexpectedResponse(answer.status);
    }
    return { checkIn, version: answer.etag };
  }
  const counted = parseIntake(answer.data);
  if (
    counted?.count_phase !== 'POST_COUNT' ||
    counted.id.toLowerCase() !== intakeId.toLowerCase() ||
    'parcelChanges' in correction ||
    counted.physical_count !== correction.physicalCount
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { counted, version: answer.etag };
}

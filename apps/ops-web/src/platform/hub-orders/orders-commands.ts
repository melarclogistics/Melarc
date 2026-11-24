import type { components } from '@melarc/api-client';

import type { ApiClient } from '../api/api-client';
import { answerOf, OperationFailure, unexpectedResponse } from '../api/api-response';
import { instantOf, isRecord, lineOf, uuidOf } from '../staff/staff-shape';
import {
  parseCandidates,
  parseClosed,
  parseClosure,
  parseCorrection,
  parseReversal,
  parseTerms,
  type ClosureView,
  type CorrectionView,
  type ReversalView,
  type TermsView,
  type ZoneCandidateView,
} from './orders-shape';

/**
 * The acts of the order screens (S1.40), each sending one request with the headers the contract declares for the operation and no other, and answering with what the API answered, judged
 * (`orders-shape.ts`): a success status with a body that is not what the act answers with is an answer that is not the API's (`unexpected-response`), which a confirmed command reads as an outcome that is
 * not known, because the act may have been done.
 *
 * **Two refusals are not failures of the screen but the answer it was built to meet, so they come back as results and not as errors.** A save whose terms are not the terms the officer reviewed
 * (`STATE_CONFLICT`, rule `terms_changed`) answers with the terms as they are now (`details.current_terms`, judged as a preview is), for the officer to read and confirm again; a close whose assessment is not
 * what the senior read (`assessment_changed`, `details.current_assessment`) answers with the assessment as it is. **A refusal for an address that matches more than one zone** (`destination_zone_ambiguous`)
 * names the zones it matched (`details.candidates`), for the officer to choose one and say why. Nothing else of a refusal's details is read.
 */

type Schemas = components['schemas'];
export type OrderPreviewBody = Schemas['OrderItemizePreview'];
export type OrderSaveBody = Schemas['OrderItemize'];
export type AmendPreviewBody = Schemas['OrderAmendPreview'];
export type AmendSaveBody = Schemas['OrderAmend'];
export type PayerChoiceBody = Schemas['PayerAllocationInput'];
export type RecipientCorrectionBody = Schemas['OrderRecipientCorrection'];

/** What a save of an order answers: the order as the API says it stands now (its identity and where it stands: the page reads the record again). */
export interface SavedOrderView {
  readonly id: string;
  readonly code: string;
  readonly intake_parcel_id: string | null;
  readonly commercial_state: string | null;
  readonly price_status: 'EARLY_QUOTE' | 'FROZEN' | null;
}

function parseSavedOrder(body: unknown): SavedOrderView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  if (id === undefined || typeof body.code !== 'string' || body.code === '') return undefined;
  const parcel =
    body.intake_parcel_id === undefined || body.intake_parcel_id === null
      ? null
      : uuidOf(body.intake_parcel_id);
  if (parcel === undefined) return undefined;
  const state = typeof body.commercial_state === 'string' ? body.commercial_state : null;
  const status =
    body.price_status === 'EARLY_QUOTE' || body.price_status === 'FROZEN'
      ? body.price_status
      : null;
  return {
    id,
    code: body.code,
    intake_parcel_id: parcel,
    commercial_state: state,
    price_status: status,
  };
}

/** What a refusal carries in `details`, read as data: nothing of it is believed until a shape has judged it. */
function detailsOf(error: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(error) || !isRecord(error.details)) return {};
  return error.details;
}

/** Whether a refusal names this rule, as a validation does (`details.violations`) or as a conflict does (`details.rule`). */
const namesRule = (failure: OperationFailure, rule: string): boolean =>
  failure.rule === rule || failure.violations.some((violation) => violation.rule === rule);

// ---- Previews ----------------------------------------------------------------------------------------------------------------------------------

/** What a preview answers: the terms, or, for an address that matches more than one zone, the zones to choose from. */
export type PreviewOutcome =
  | { readonly kind: 'terms'; readonly terms: TermsView }
  | { readonly kind: 'zone-choice'; readonly candidates: readonly ZoneCandidateView[] };

function previewOutcome(result: Parameters<typeof answerOf>[0], intakeId: string): PreviewOutcome {
  try {
    const answer = answerOf(result);
    const terms = parseTerms(answer.data);
    if (terms?.intake_id.toLowerCase() !== intakeId.toLowerCase()) {
      throw unexpectedResponse(answer.status);
    }
    return { kind: 'terms', terms };
  } catch (error) {
    if (error instanceof OperationFailure && namesRule(error, 'destination_zone_ambiguous')) {
      const candidates = parseCandidates(detailsOf(result.error).candidates);
      if (candidates !== undefined) return { kind: 'zone-choice', candidates };
    }
    throw error;
  }
}

/**
 * `previewOrder` (`hub.intake.itemize`): **what confirming an order would give**, calculated by the server and written nowhere (no key and no version are sent: nothing changes). The answer is the terms the officer
 * reviews and the `terms_token` the save is given back; it judges the body as the save does, so every refusal an officer would meet is met here first.
 */
export async function previewOrder(
  client: ApiClient,
  intakeId: string,
  body: OrderPreviewBody,
): Promise<PreviewOutcome> {
  const result = await client.POST('/hub-intakes/{id}/orders/preview', {
    params: { path: { id: intakeId } },
    body,
  });
  return previewOutcome(result, intakeId);
}

/** `previewOrderAmendment` (`hub.intake.itemize`): what an amendment would give, beside the quote the order holds. No key, no version and no reason are sent. */
export async function previewOrderAmendment(
  client: ApiClient,
  orderId: string,
  intakeId: string,
  patch: AmendPreviewBody,
): Promise<PreviewOutcome> {
  const result = await client.POST('/orders/{id}/amendment-preview', {
    params: { path: { id: orderId } },
    body: patch,
  });
  return previewOutcome(result, intakeId);
}

// ---- Saves -------------------------------------------------------------------------------------------------------------------------------------

/** What a save answers: the order, or the terms as they are now when they are not the terms the officer reviewed. */
export type SaveOutcome =
  | { readonly kind: 'saved'; readonly order: SavedOrderView; readonly version: string | undefined }
  | { readonly kind: 'terms-changed'; readonly current: TermsView }
  /** The address now matches more than one zone (the hub's aliases moved since the check): the zones the server named, for the officer to choose one and say why. */
  | { readonly kind: 'zone-choice'; readonly candidates: readonly ZoneCandidateView[] };

function saveOutcome(result: Parameters<typeof answerOf>[0]): SaveOutcome {
  try {
    const answer = answerOf(result);
    const order = parseSavedOrder(answer.data);
    if (order === undefined) throw unexpectedResponse(answer.status);
    return { kind: 'saved', order, version: answer.etag };
  } catch (error) {
    if (error instanceof OperationFailure && namesRule(error, 'terms_changed')) {
      const current = parseTerms(detailsOf(result.error).current_terms);
      // A refusal that says the terms changed and does not give them is a refusal the officer can only read again from the start: the page words it as a conflict.
      if (current !== undefined) return { kind: 'terms-changed', current };
    }
    if (error instanceof OperationFailure && namesRule(error, 'destination_zone_ambiguous')) {
      const candidates = parseCandidates(detailsOf(result.error).candidates);
      if (candidates !== undefined) return { kind: 'zone-choice', candidates };
    }
    throw error;
  }
}

/**
 * `itemizeOrder` (`hub.intake.itemize`): makes the order, on the terms the officer reviewed (`reviewed_terms`, the preview's `terms_token`), under an `Idempotency-Key` and the vendor's `If-Match` (the version
 * of the read, exactly as sent). A retry under the same key makes nothing twice. When the terms are not the ones reviewed the answer is those terms, and nothing was made.
 */
export async function itemizeOrder(
  client: ApiClient,
  intakeId: string,
  body: OrderSaveBody,
  version: string,
  idempotencyKey: string,
): Promise<SaveOutcome> {
  const result = await client.POST('/hub-intakes/{id}/orders', {
    params: {
      path: { id: intakeId },
      header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
    },
    body,
  });
  return saveOutcome(result);
}

/** `amendOrder` (`hub.intake.itemize`): corrects an order that is not yet confirmed, on the version of the order that was read (`If-Match`, the `ETag` of `getOrder`), with a reason and the amendment's reviewed terms. */
export async function amendOrder(
  client: ApiClient,
  orderId: string,
  patch: AmendSaveBody,
  version: string,
  idempotencyKey: string,
): Promise<SaveOutcome> {
  const result = await client.PATCH('/orders/{id}', {
    params: {
      path: { id: orderId },
      header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
    },
    body: patch,
  });
  return saveOutcome(result);
}

// ---- The recipient of a confirmed order ---------------------------------------------------------------------------------------------------------

/**
 * `correctOrderRecipient` (`hub.intake.itemize`, D-S7-1): corrects the name, the phone or the address of a confirmed order, with a reason in words, on the version of the order that was read (`If-Match`) and
 * under an `Idempotency-Key`. Only the members that change are sent. The price, the zone and the promise never move: an address that would move the zone or the price is refused (`STATE_CONFLICT`, rule
 * `address_changes_zone`) and nothing changes. The answer is the order as it stands now; the page reads the record again.
 */
export async function correctOrderRecipient(
  client: ApiClient,
  orderId: string,
  body: RecipientCorrectionBody,
  version: string,
  idempotencyKey: string,
): Promise<SavedOrderView> {
  const answer = answerOf(
    await client.POST('/orders/{id}/recipient-correction', {
      params: {
        path: { id: orderId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body,
    }),
  );
  const order = parseSavedOrder(answer.data);
  if (order?.id.toLowerCase() !== orderId.toLowerCase()) throw unexpectedResponse(answer.status);
  return order;
}

// ---- A parcel the officer is waiting on ---------------------------------------------------------------------------------------------------------

/** The mark as it stands after the act (`ParcelWaitingForVendor`): whether the parcel is waiting, since when and with what note. */
export interface ParcelWaitView {
  readonly parcel_id: string;
  readonly waiting: boolean;
  readonly since: string | null;
  readonly note: string | null;
}

function parseParcelWait(body: unknown): ParcelWaitView | undefined {
  if (!isRecord(body)) return undefined;
  const parcel = uuidOf(body.parcel_id);
  const since = body.since === null ? null : instantOf(body.since);
  const note = body.note === null ? null : lineOf(body.note);
  if (
    parcel === undefined ||
    typeof body.waiting !== 'boolean' ||
    since === undefined ||
    note === undefined
  ) {
    return undefined;
  }
  // A mark has its moment and an end of one has none, as the contract says.
  if (body.waiting === (since === null)) return undefined;
  return { parcel_id: parcel, waiting: body.waiting, since, note };
}

/**
 * `setParcelWaitingForVendor` (`hub.intake.itemize`, D-S7-12): marks a parcel as waiting for the vendor's details, with an optional note of one short line, or takes the mark off. It states the parcel's desired
 * state, so it is idempotent by nature and **takes no `Idempotency-Key`**, and it takes the vendor's version as `If-Match` (which it does not move). The note is sent only with a mark and only when there is one. The
 * answer is the mark as it now stands: it must be this parcel and the state that was asked.
 */
export async function setParcelWaiting(
  client: ApiClient,
  parcelId: string,
  waiting: boolean,
  note: string | undefined,
  version: string,
): Promise<ParcelWaitView> {
  const answer = answerOf(
    await client.PUT('/intake-parcels/{parcel_id}/waiting-for-vendor', {
      params: { path: { parcel_id: parcelId }, header: { 'If-Match': version } },
      body: waiting && note !== undefined ? { waiting, note } : { waiting },
    }),
  );
  const mark = parseParcelWait(answer.data);
  if (mark?.parcel_id.toLowerCase() !== parcelId.toLowerCase() || mark.waiting !== waiting) {
    throw unexpectedResponse(answer.status);
  }
  return mark;
}

// ---- A mistaken arrival ------------------------------------------------------------------------------------------------------------------------

/** `reverseOrderArrival` (`hub.osd.adjudicate`): a senior takes back a mistaken arrival, with a reason, while nothing has been paid for, reserved or dispatched. */
export async function reverseOrderArrival(
  client: ApiClient,
  orderId: string,
  note: string,
  version: string,
  idempotencyKey: string,
): Promise<ReversalView> {
  const answer = answerOf(
    await client.POST('/orders/{id}/arrival-reversal', {
      params: {
        path: { id: orderId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: { note },
    }),
  );
  const reversal = parseReversal(answer.data);
  if (reversal?.order_id.toLowerCase() !== orderId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return reversal;
}

// ---- The close ----------------------------------------------------------------------------------------------------------------------------------

/** What a close answers: the vendor, closed; or, for the approved exception, the assessment as it is when it is not the one the senior read. */
export type CloseOutcome =
  | { readonly kind: 'closed' }
  | { readonly kind: 'assessment-changed'; readonly current: ClosureView };

export interface CloseRequest {
  /** The `assessment_token` of the closure the officer read. Required with the exception, optional (and judged when given) for a close that has parity. */
  readonly reviewedAssessment: string;
  /** The reason in words: present only for the approved exception. */
  readonly exceptionNote?: string;
}

/**
 * `closeHubIntake` (`hub.intake.close`; the exception under `hub.intake.close_exception` besides): closes a vendor whose orders are made, under an `Idempotency-Key` and the vendor's `If-Match`. **A close with
 * parity carries the assessment the officer read** (judged when given), and the approved exception carries the reason **and** the assessment it is written for: when that is not what a close would find now, the answer
 * is the assessment as it is and nothing was closed, and the senior reads it and writes the reason again.
 */
export async function closeIntake(
  client: ApiClient,
  intakeId: string,
  request: CloseRequest,
  version: string,
  idempotencyKey: string,
): Promise<CloseOutcome> {
  const body: Schemas['IntakeClose'] =
    request.exceptionNote === undefined
      ? { reviewed_assessment: request.reviewedAssessment }
      : {
          reviewed_assessment: request.reviewedAssessment,
          parity_exception: { note: request.exceptionNote },
        };
  const result = await client.POST('/hub-intakes/{id}/close', {
    params: {
      path: { id: intakeId },
      header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
    },
    body,
  });
  try {
    const answer = answerOf(result);
    const closed = parseClosed(answer.data);
    if (closed?.id.toLowerCase() !== intakeId.toLowerCase())
      throw unexpectedResponse(answer.status);
    return { kind: 'closed' };
  } catch (error) {
    if (error instanceof OperationFailure && namesRule(error, 'assessment_changed')) {
      const current = parseClosure(detailsOf(result.error).current_assessment);
      if (current?.intake_id.toLowerCase() === intakeId.toLowerCase()) {
        return { kind: 'assessment-changed', current };
      }
    }
    throw error;
  }
}

// ---- Who pays after the freeze -------------------------------------------------------------------------------------------------------------------

export interface CorrectionWithVersion {
  readonly correction: CorrectionView;
  readonly version: string;
}

function correctionOf(answer: {
  readonly data: unknown;
  readonly status: number;
  readonly etag: string | undefined;
}): CorrectionWithVersion {
  const correction = parseCorrection(answer.data);
  if (correction === undefined || answer.etag === undefined)
    throw unexpectedResponse(answer.status);
  return { correction, version: answer.etag };
}

/** `requestPayerCorrection` (`pricing.correction.create`): asks to change how the locked price of a frozen order is shared, with a reason, on the order's version. The intent is proposed, never a portion. */
export async function requestPayerCorrection(
  client: ApiClient,
  orderId: string,
  proposed: PayerChoiceBody,
  note: string,
  version: string,
  idempotencyKey: string,
): Promise<CorrectionWithVersion> {
  const answer = answerOf(
    await client.POST('/orders/{id}/payer-correction', {
      params: {
        path: { id: orderId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: { proposed, note },
    }),
  );
  const made = correctionOf(answer);
  if (made.correction.order_id.toLowerCase() !== orderId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return made;
}

/** `approvePayerCorrection` (`pricing.correction.approve`): a checker approves or rejects a correction, on the version of the correction that was read. An approval re-runs the commercial gate from the new portions. */
export async function decidePayerCorrection(
  client: ApiClient,
  correctionId: string,
  decision: 'APPROVE' | 'REJECT',
  note: string | undefined,
  version: string,
  idempotencyKey: string,
): Promise<CorrectionWithVersion> {
  const answer = answerOf(
    await client.POST('/payer-corrections/{id}/decision', {
      params: {
        path: { id: correctionId },
        header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version },
      },
      body: { decision, ...(note === undefined ? {} : { note }) },
    }),
  );
  const decided = correctionOf(answer);
  if (decided.correction.id.toLowerCase() !== correctionId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return decided;
}

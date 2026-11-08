import type { components } from '@melarc/api-client';

import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseApproval,
  parsePickupRequest,
  type ApprovalView,
  type CutoffDecision,
  type PickupRequestView,
} from './pickup-shape';

/**
 * The acts of the pickup screens (S1.19). Each sends one request and answers with what the API answered, judged (`pickup-shape.ts`): a success
 * status with a body that is not the request asked about is an answer that is not the API's (`unexpected-response`), which a confirmed command
 * reads as an outcome that is not known, because the act may have been done.
 *
 * The headers are the contract's, operation by operation, and no other: the version an act takes (`If-Match`) is the `ETag` of the read,
 * passed exactly as it was kept; an `Idempotency-Key` goes only where the operation declares one (`createPickupRequest`, `cancelPickupRequest`,
 * `resolveCutoffException`, `escalatePickupRequest`, `extendPickupAttempts`). `confirmPickupRequest` and `waiveCancellationCharge` take a
 * version and no key, and the exception's two acts (`requestOnePackageException`, `approveOnePackageException`) take neither. No act sends a
 * price, a total, a fee or a zone: the server computes them.
 */
export type NewPickupRequest = components['schemas']['PickupRequestCreate'];
export type OnePackageExceptionFields = components['schemas']['OnePackageExceptionRequest'];

/** The request an act answered with, if it is the one acted on. */
function actedOn(data: unknown, status: number, id: string): PickupRequestView {
  const request = parsePickupRequest(data);
  if (request?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(status);
  return request;
}

/** `createPickupRequest`: the booking, created `PENDING`, with the server's indicative estimate in the answer. */
export async function createPickupRequest(
  client: ApiClient,
  body: NewPickupRequest,
  idempotencyKey: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body,
    }),
  );
  const request = parsePickupRequest(answer.data);
  // A booking is created waiting for confirmation, and nothing else is the answer to one.
  if (request?.state !== 'PENDING') throw unexpectedResponse(answer.status);
  return request;
}

/** `confirmPickupRequest`: `PENDING` to `CONFIRMED` on the version read. Its answer carries the indicative estimate. */
export async function confirmPickupRequest(
  client: ApiClient,
  id: string,
  version: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/confirm', {
      params: { path: { id }, header: { 'If-Match': version } },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** What a cancellation takes of the person, as the dialog collected it. */
export interface CancellationFields {
  /** A reason of the `PICKUP_CANCELLATION` catalogue. */
  readonly reasonCode: string;
  /** As typed; left out when blank. */
  readonly note?: string;
  /** A reschedule: the new attempt is created in the same act (§21.6, cancel-plus-clone). */
  readonly createReplacement: boolean;
  /** The charge decision, made explicitly or not at all: there is no default (`apply_charge`). */
  readonly applyCharge?: boolean;
  readonly chargeReasonCode?: string;
}

/** `cancelPickupRequest`: with or without a replacement, and with the charge decision when one was made. */
export async function cancelPickupRequest(
  client: ApiClient,
  id: string,
  version: string,
  fields: CancellationFields,
  idempotencyKey: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/cancel', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: {
        reason_code: fields.reasonCode,
        ...(fields.note === undefined ? {} : { note: fields.note }),
        create_replacement: fields.createReplacement,
        ...(fields.applyCharge === undefined ? {} : { apply_charge: fields.applyCharge }),
        ...(fields.chargeReasonCode === undefined
          ? {}
          : { charge_reason_code: fields.chargeReasonCode }),
      },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** `resolveCutoffException`: a late booking approved for the same day, or moved to the next operating day, with a note of why. */
export async function resolveCutoffException(
  client: ApiClient,
  id: string,
  version: string,
  resolution: { readonly decision: CutoffDecision; readonly note: string },
  idempotencyKey: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/cutoff-exception', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { decision: resolution.decision, note: resolution.note },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** `escalatePickupRequest`: the terminal Ops resolution of a failed request, with a note of why (no reason catalogue, D-05). */
export async function escalatePickupRequest(
  client: ApiClient,
  id: string,
  version: string,
  note: string,
  idempotencyKey: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/escalate', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { note },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** `extendPickupAttempts`: the attempt cap raised for this request alone, with the reason the schema makes mandatory. */
export async function extendPickupAttempts(
  client: ApiClient,
  id: string,
  version: string,
  reason: string,
  idempotencyKey: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/attempt-extension', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { reason },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** `waiveCancellationCharge`: an applied charge relieved in full (a waiver has no amount), with a note of why. */
export async function waiveCancellationCharge(
  client: ApiClient,
  id: string,
  version: string,
  note: string,
): Promise<PickupRequestView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/cancellation-charge/waiver', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: { note },
    }),
  );
  return actedOn(answer.data, answer.status, id);
}

/** `requestOnePackageException`: the maker's half of the exception, with the recipient the single package travels to. */
export async function requestOnePackageException(
  client: ApiClient,
  id: string,
  body: OnePackageExceptionFields,
): Promise<ApprovalView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/one-package-exception', {
      params: { path: { id } },
      body,
    }),
  );
  const approval = parseApproval(answer.data);
  if (approval === undefined) throw unexpectedResponse(answer.status);
  return approval;
}

/**
 * `approveOnePackageException`: the checker's half. It sends nothing but the request's id: no body, no version and no key, and **the
 * maker-checker rule is the server's** (`SELF_APPROVAL_FORBIDDEN`), never judged here. The answer is the approval of the exception asked about
 * (the exception is that approval, so it has its id), approved and naming its checker; anything else is not the answer to this act.
 */
export async function approveOnePackageException(
  client: ApiClient,
  id: string,
  exceptionId: string,
): Promise<ApprovalView> {
  const answer = answerOf(
    await client.POST('/pickup-requests/{id}/one-package-exception/approve', {
      params: { path: { id } },
    }),
  );
  const approval = parseApproval(answer.data);
  if (
    approval?.state !== 'APPROVED' ||
    approval.approved_by === undefined ||
    approval.id.toLowerCase() !== exceptionId.toLowerCase()
  ) {
    throw unexpectedResponse(answer.status);
  }
  return approval;
}

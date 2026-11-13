import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseHandshake,
  parseParcelPhotoException,
  parseRetrievalAuthorization,
  type HandshakeView,
  type ParcelPhotoExceptionView,
  type RetrievalAuthorizationView,
} from './pickup-work-shape';

/**
 * The acts of the screens of the door (S1.30) and the one read that is a `POST`. Each sends one request and answers with what the API answered, judged (`pickup-work-shape.ts`): a success
 * status with a body that is not the stop asked about is an answer that is not the API's (`unexpected-response`), which a confirmed command reads as an outcome that is not known, because the
 * act may have been done. The headers are the contract's, operation by operation, and no other: each act takes an `Idempotency-Key` and no version (`authoriseHandshakeOverride`,
 * `resolveHandshake`, `authoriseParcelPhotoException` declare none). The note an officer writes is the act's reason and the server's to screen; no act sends a code, a count or a figure.
 */

/** The handshake an act answered with, if it is the one of the stop acted on. */
function handshakeOf(data: unknown, status: number, stopId: string): HandshakeView {
  const handshake = parseHandshake(data);
  if (handshake?.stop_id.toLowerCase() !== stopId.toLowerCase()) throw unexpectedResponse(status);
  return handshake;
}

/**
 * `authoriseHandshakeOverride` (`pickup.handshake.override`): Ops establishes the collection from a counted stop by an exception (channel `OPS_OVERRIDE`), with how Ops verified the vendor
 * by other means as the note. The answer is the handshake as it now stands.
 */
export async function authoriseHandshakeOverride(
  client: ApiClient,
  stopId: string,
  note: string,
  idempotencyKey: string,
): Promise<HandshakeView> {
  const answer = answerOf(
    await client.POST('/pickup-stops/{id}/handshake/ops-override', {
      params: { path: { id: stopId }, header: { 'Idempotency-Key': idempotencyKey } },
      body: { verification_note: note },
    }),
  );
  return handshakeOf(answer.data, answer.status, stopId);
}

/** `resolveHandshake` (`pickup.handshake.resolve`): an expired or exhausted handshake resolved by hand, with how the collection was established as the note. */
export async function resolveHandshake(
  client: ApiClient,
  stopId: string,
  note: string,
  idempotencyKey: string,
): Promise<HandshakeView> {
  const answer = answerOf(
    await client.POST('/pickup-stops/{id}/handshake/resolve', {
      params: { path: { id: stopId }, header: { 'Idempotency-Key': idempotencyKey } },
      body: { note },
    }),
  );
  return handshakeOf(answer.data, answer.status, stopId);
}

/**
 * `authoriseParcelPhotoException` (`pickup.handshake.override`): Ops lets the stop's count through without parcel photos, once, before the count, with a note. The answer is the exception,
 * and it must be the exception of the stop acted on.
 */
export async function authoriseParcelPhotoException(
  client: ApiClient,
  stopId: string,
  note: string,
  idempotencyKey: string,
): Promise<ParcelPhotoExceptionView> {
  const answer = answerOf(
    await client.POST('/pickup-stops/{id}/parcel-photo-exception', {
      params: { path: { id: stopId }, header: { 'Idempotency-Key': idempotencyKey } },
      body: { note },
    }),
  );
  const exception = parseParcelPhotoException(answer.data);
  if (exception?.pickup_stop_id.toLowerCase() !== stopId.toLowerCase()) {
    throw unexpectedResponse(answer.status);
  }
  return exception;
}

/**
 * `createEvidenceRetrievalAuthorization` (`pickup.read`): the short-lived authorization to read **one** stored photo, asked for when it is opened. The answer is a bearer capability that
 * the caller alone holds; it is never logged, cached or stored by this code, and the page that asked drops it when the photo is closed.
 */
export async function createRetrievalAuthorization(
  client: ApiClient,
  evidenceId: string,
): Promise<RetrievalAuthorizationView> {
  const answer = answerOf(
    await client.POST('/evidence/{id}/retrieval-authorization', {
      params: { path: { id: evidenceId } },
    }),
  );
  const authorization = parseRetrievalAuthorization(answer.data);
  if (authorization === undefined) throw unexpectedResponse(answer.status);
  return authorization;
}

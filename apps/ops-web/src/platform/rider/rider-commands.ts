import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { parseEnrolmentGrant, type EnrolmentGrantView } from './rider-shape';

/**
 * The three acts of the rider screens (S0.60) on a rider's device. Each sends one request and answers with what the API answered, judged
 * (`rider-shape.ts`): a success status with a body that is not what the contract describes is an answer that is not the API's
 * (`unexpected-response`), which a confirmed command reads as an outcome that is not known, because the act may have been done.
 *
 * - `registerRiderDevice` carries an `Idempotency-Key` and **no version**: the first binding of a rider creates one grant and nothing else, and a
 *   retry under the same key replays the grant while it stands. Its answer holds the QR code's credential, which the caller keeps in memory.
 * - `reregisterRiderDevice` carries the version of the roster read (`If-Match`), a reason of the catalogue and the note on how the rider's identity
 *   was verified in person. It takes no `Idempotency-Key` (a new grant ends the earlier one). Its answer holds a credential too.
 * - `revokeRiderDevice` carries a reason and **no version and no verification**: it is the report of a loss, and it is not made slower.
 */

/** `registerRiderDevice`: the first binding of a rider, in person. The signal ends the request when the screen lets go of the answer. */
export async function registerRiderDevice(
  client: ApiClient,
  riderId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<EnrolmentGrantView> {
  const answer = answerOf(
    await client.POST('/ops/riders/{riderId}/device/register', {
      params: { path: { riderId }, header: { 'Idempotency-Key': idempotencyKey } },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const grant = parseEnrolmentGrant(answer.data, riderId);
  if (grant === undefined) throw unexpectedResponse(answer.status);
  return grant;
}

/** What `reregisterRiderDevice` takes of the person: a reason of the catalogue and how the rider's identity was verified in person. */
export interface ReregistrationFields {
  readonly reasonCode: string;
  readonly verificationNote: string;
}

/** `reregisterRiderDevice`: a replacement handset, bound by an officer who has verified the rider in person. */
export async function reregisterRiderDevice(
  client: ApiClient,
  riderId: string,
  version: string,
  command: ReregistrationFields,
  signal?: AbortSignal,
): Promise<EnrolmentGrantView> {
  const answer = answerOf(
    await client.POST('/ops/riders/{riderId}/device/reregister', {
      params: { path: { riderId }, header: { 'If-Match': version } },
      body: { reason_code: command.reasonCode, verification_note: command.verificationNote },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const grant = parseEnrolmentGrant(answer.data, riderId);
  if (grant === undefined) throw unexpectedResponse(answer.status);
  return grant;
}

/** `revokeRiderDevice`: the rider's `ACTIVE` device is ended on report, and the rider's live session with it. Answers when it is done. */
export async function revokeRiderDevice(
  client: ApiClient,
  riderId: string,
  reasonCode: string,
): Promise<void> {
  const answer = answerOf(
    await client.POST('/ops/riders/{riderId}/device/revoke', {
      params: { path: { riderId } },
      body: { reason_code: reasonCode },
    }),
  );
  if (answer.status !== 204) throw unexpectedResponse(answer.status);
}

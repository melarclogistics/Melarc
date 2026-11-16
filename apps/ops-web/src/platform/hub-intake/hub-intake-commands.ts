import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parsePostCountIntake,
  type IntakeCondition,
  type PostCountIntakeView,
} from './hub-intake-shape';

/**
 * The acts on a vendor **counted without photos** (S1.35; D-D3, D-D7), each sending one request and answering with what the API answered, judged (`hub-intake-shape.ts`): a success status with a body that is
 * not the counted intake an act answers with is an answer that is not the API's (`unexpected-response`), which a confirmed command reads as an outcome that is not known, because the act may have been done. The
 * headers are the contract's, operation by operation, and no other: the count and the condition take an `Idempotency-Key` and the version of the read (`If-Match`, exactly as the read gave it). **The body of
 * the count is the physical count and nothing else**: no declaration, which the page does not have and the contract's schema refuses. (The lock of a vendor is `receiving-commands.ts`'s, and a senior
 * officer's decision is `receiving-decisions.ts`'s.)
 */

/** The counted intake of an act's answer, if it is the one acted on. */
function countedOf(data: unknown, status: number, id: string): PostCountIntakeView {
  const intake = parsePostCountIntake(data);
  if (intake?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(status);
  return intake;
}

/** A counted intake with the version to take the next act on: the `ETag` exactly as the API sent it. */
export interface CountedWithVersion {
  readonly intake: PostCountIntakeView;
  readonly version: string;
}

/**
 * `submitBlindCount` (`hub.intake.count`): the receiver's physical count, committed once (`Idempotency-Key`, and `If-Match` of the read), the first answer that carries the comparison. The body is
 * `{ physical_count }` and nothing else. An answer that is not for this intake, or that counts another number, is an answer that is not the API's.
 */
export async function submitBlindCount(
  client: ApiClient,
  id: string,
  physicalCount: number,
  version: string,
  idempotencyKey: string,
): Promise<CountedWithVersion> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/count', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: { physical_count: physicalCount },
    }),
  );
  const intake = countedOf(answer.data, answer.status, id);
  if (intake.physical_count !== physicalCount || answer.etag === undefined) {
    throw unexpectedResponse(answer.status);
  }
  return { intake, version: answer.etag };
}

export interface ConditionRecord {
  readonly condition: IntakeCondition;
  readonly note?: string;
  readonly evidenceIds?: readonly string[];
}

/**
 * `recordIntakeCondition` (`hub.intake.count`): the receiver's recording of the one condition of a vendor counted without photos, once, after the count and before the orders are listed
 * (`Idempotency-Key`, and `If-Match` of the read). `DAMAGED` and `TAMPERED` carry the identifiers of stored evidence of this intake. The answer is the intake as counted, with its findings: a condition other
 * than `OK` is the intake's condition now.
 */
export async function recordIntakeCondition(
  client: ApiClient,
  id: string,
  record: ConditionRecord,
  version: string,
  idempotencyKey: string,
): Promise<CountedWithVersion> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/condition', {
      params: { path: { id }, header: { 'Idempotency-Key': idempotencyKey, 'If-Match': version } },
      body: {
        condition: record.condition,
        ...(record.note === undefined ? {} : { note: record.note }),
        ...(record.evidenceIds === undefined || record.evidenceIds.length === 0
          ? {}
          : { evidence_ids: [...record.evidenceIds] }),
      },
    }),
  );
  const intake = countedOf(answer.data, answer.status, id);
  if (
    (record.condition !== 'OK' && intake.condition !== record.condition) ||
    answer.etag === undefined
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { intake, version: answer.etag };
}

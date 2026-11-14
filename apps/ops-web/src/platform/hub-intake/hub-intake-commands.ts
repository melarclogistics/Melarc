import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseIntake,
  parsePostCountIntake,
  type AdjudicationOutcome,
  type IntakeCondition,
  type IntakeView,
  type PostCountIntakeView,
} from './hub-intake-shape';

/**
 * The acts of the receiving screens (S1.35) and the lock, each sending one request and answering with what the API answered, judged (`hub-intake-shape.ts`): a success status with a body that is not
 * the intake asked about, or not the counted intake an act answers with, is an answer that is not the API's (`unexpected-response`), which a confirmed command reads as an outcome that is not known,
 * because the act may have been done. The headers are the contract's, operation by operation, and no other: the lock takes neither a key nor a version; the count and the condition take an
 * `Idempotency-Key` and the version of the read (`If-Match`, exactly as the read gave it); the adjudication takes the version and no key. **The body of the count is the physical count and
 * nothing else**: no declaration, which the page does not have and the contract's schema refuses.
 */

/** The intake of an answer, if it is the one asked about. */
function intakeOf(data: unknown, status: number, id: string): IntakeView {
  const intake = parseIntake(data);
  if (intake?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(status);
  return intake;
}

/** The counted intake of an act's answer, if it is the one acted on. */
function countedOf(data: unknown, status: number, id: string): PostCountIntakeView {
  const intake = parsePostCountIntake(data);
  if (intake?.id.toLowerCase() !== id.toLowerCase()) throw unexpectedResponse(status);
  return intake;
}

/**
 * `acquireIntakeLock` (`hub.intake.count`): the advisory lock of the receiver, taken when it is free, refreshed when the caller holds it and taken over when the holder has been idle past the hub's idle
 * time; otherwise the intake comes back showing who holds it and nothing changes. **Advisory**: it never decides whether a count is accepted. The answer is the intake, counted or not (a counted one
 * is returned as it is, and no lock is taken on it). The request is `background` activity: it is the page keeping its own lock, so it never extends a session.
 */
export async function acquireIntakeLock(client: ApiClient, id: string): Promise<IntakeView> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/lock', { params: { path: { id } } }),
  );
  return intakeOf(answer.data, answer.status, id);
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
 * `recordIntakeCondition` (`hub.intake.count`): the receiver's recording of a condition, once, after the count and before itemization (`Idempotency-Key`, and `If-Match` of the read). `DAMAGED` and
 * `TAMPERED` carry the identifiers of stored evidence of this intake. The answer is the intake as counted, with its findings: a condition other than `OK` is the intake's condition now.
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

export interface Adjudication {
  readonly outcome: AdjudicationOutcome;
  /** What the adjudicator found, when it is to be set: `DAMAGED` and `TAMPERED` carry stored evidence. */
  readonly condition?: IntakeCondition;
  readonly evidenceIds?: readonly string[];
  /** The reason, in words: mandatory. */
  readonly note: string;
}

/**
 * `adjudicateDiscrepancy` (`hub.osd.adjudicate`: Senior Ops and Platform Admin; Ops Staff do not hold the key): an outcome and a reason, recorded against the committed comparison and never in place of
 * it (`If-Match` of the read, and no `Idempotency-Key`). It changes no count. `ACCEPTED`, `WRITTEN_OFF` and `VENDOR_NOTIFIED` resolve the case; `ESCALATED` records it and leaves it open.
 */
export async function adjudicateDiscrepancy(
  client: ApiClient,
  id: string,
  adjudication: Adjudication,
  version: string,
): Promise<CountedWithVersion> {
  const answer = answerOf(
    await client.POST('/hub-intakes/{id}/discrepancy', {
      params: { path: { id }, header: { 'If-Match': version } },
      body: {
        outcome: adjudication.outcome,
        note: adjudication.note,
        ...(adjudication.condition === undefined ? {} : { condition: adjudication.condition }),
        ...(adjudication.evidenceIds === undefined || adjudication.evidenceIds.length === 0
          ? {}
          : { evidence_ids: [...adjudication.evidenceIds] }),
      },
    }),
  );
  const intake = countedOf(answer.data, answer.status, id);
  if (
    (adjudication.condition !== undefined && intake.condition !== adjudication.condition) ||
    answer.etag === undefined
  ) {
    throw unexpectedResponse(answer.status);
  }
  return { intake, version: answer.etag };
}

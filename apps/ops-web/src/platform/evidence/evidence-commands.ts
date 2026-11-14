import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import { parseEvidenceTicket, parseStoredEvidence, type EvidenceTicket } from './evidence-shape';

/**
 * The two calls that make one file of evidence a record the platform can be told about (`createEvidence`, then `completeEvidenceUpload`), and nothing else of it: the bytes go between them
 * (`object-store-upload.ts`) and the order of the three is `upload-evidence.ts`'s. The headers are the contract's, operation by operation: the declaration takes an `Idempotency-Key` and no version,
 * the completion takes the version of the record the declaration answered with (`If-Match`) and no key. An answer for another record is an answer that is not the API's.
 */

/** What the portal declares evidence for: the receiving side's, and the owner is always an intake. */
export type EvidenceOwnerType = 'PICKUP_INTAKE';
/** `CONDITION` is the receiver's photo of what was found (under the key of the count), `OSD` is the adjudicator's (under the key of the adjudication). */
export type IntakeEvidencePurpose = 'CONDITION' | 'OSD';

export interface EvidenceDeclaration {
  readonly ownerId: string;
  readonly purpose: IntakeEvidencePurpose;
  /** When the file was made, as an instant; never in the future. */
  readonly capturedAt: string;
  readonly contentType: string;
  readonly byteSize: number;
  /** The 64 hexadecimal digits of the SHA-256 of the bytes. */
  readonly checksumSha256: string;
}

/** The record declared, with the instruction to send its bytes and the version to complete it on. */
export interface DeclaredEvidence {
  readonly ticket: EvidenceTicket;
  readonly version: string;
}

/** `createEvidence` (the key of the act): step one of two. The answer carries a bearer capability to write one object, which the caller uses once and does not keep. */
export async function declareEvidence(
  client: ApiClient,
  declaration: EvidenceDeclaration,
  idempotencyKey: string,
): Promise<DeclaredEvidence> {
  const answer = answerOf(
    await client.POST('/evidence', {
      params: { header: { 'Idempotency-Key': idempotencyKey } },
      body: {
        owner_type: 'PICKUP_INTAKE',
        owner_id: declaration.ownerId,
        purpose: declaration.purpose,
        captured_at: declaration.capturedAt,
        content_type: declaration.contentType,
        byte_size: declaration.byteSize,
        checksum_sha256: declaration.checksumSha256,
      },
    }),
  );
  const ticket = parseEvidenceTicket(answer.data, {
    owner_id: declaration.ownerId,
    purpose: declaration.purpose,
  });
  if (ticket === undefined || answer.etag === undefined) throw unexpectedResponse(answer.status);
  return { ticket, version: answer.etag };
}

/** `completeEvidenceUpload`: step two of two, which the server answers only for bytes it finds as declared. The answer is the identifier of the stored record. */
export async function completeEvidence(
  client: ApiClient,
  evidenceId: string,
  version: string,
): Promise<string> {
  const answer = answerOf(
    await client.POST('/evidence/{id}/complete', {
      params: { path: { id: evidenceId }, header: { 'If-Match': version } },
    }),
  );
  const stored = parseStoredEvidence(answer.data, evidenceId);
  if (stored === undefined) throw unexpectedResponse(answer.status);
  return stored;
}

import type { ApiClient } from '../api/api-client';
import { answerOf, unexpectedResponse } from '../api/api-response';
import {
  parseEvidenceDeclaration,
  parseStoredEvidence,
  type EvidenceTicket,
} from './evidence-shape';

/**
 * The two calls that make one file of evidence a record the platform can be told about (`createEvidence`, then `completeEvidenceUpload`), and nothing else of it: the bytes go between them
 * (`object-store-upload.ts`) and the order of the three is `upload-evidence.ts`'s. The headers are the contract's, operation by operation: the declaration takes an `Idempotency-Key` and no version,
 * the completion takes the version of the record the declaration answered with (`If-Match`) and no key. An answer for another record is an answer that is not the API's.
 */

/** What the portal declares evidence for: the receiving side's, and the owner is always an intake. */
export type EvidenceOwnerType = 'PICKUP_INTAKE';
/**
 * `CONDITION` is the receiver's photo of what was found (under the key of the count), `OSD` is the adjudicator's (under the key of the adjudication), and `ITEMIZATION` is what an order cites: the photos a
 * high-value parcel needs and the photo of a carrier's waybill (under the key that makes orders). Their owner is the vendor's intake, for an order does not exist when its evidence is declared.
 */
export type IntakeEvidencePurpose = 'CONDITION' | 'OSD' | 'ITEMIZATION';

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

/**
 * What the declaration came back as. **A record that waits for its bytes** carries the instruction to send them and the version to complete it on. A retry under the key an earlier attempt used is told the
 * record as it is now: **`STORED`** (the completion was done and its answer was lost: the file is a success and there is nothing to send) or **`EXPIRED`** (its address is of no use: a new record is asked for).
 */
export type DeclaredEvidence =
  | {
      readonly state: 'PENDING_UPLOAD';
      readonly ticket: EvidenceTicket;
      readonly version: string;
      /** The server's own moment when it answered (the `Date` header), which the end of the upload address is judged against; nothing when the answer had none. */
      readonly serverTime: number | undefined;
    }
  | { readonly state: 'STORED'; readonly evidenceId: string }
  | { readonly state: 'EXPIRED'; readonly evidenceId: string };

/**
 * `createEvidence` (the key of the act): step one of two. The answer carries a bearer capability to write one object, which the caller uses once and does not keep. `signal` abandons the request (the person
 * left the file out, or its time ran out).
 */
export async function declareEvidence(
  client: ApiClient,
  declaration: EvidenceDeclaration,
  idempotencyKey: string,
  signal?: AbortSignal,
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
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const declared = parseEvidenceDeclaration(answer.data, {
    owner_id: declaration.ownerId,
    purpose: declaration.purpose,
  });
  if (declared === undefined) throw unexpectedResponse(answer.status);
  if (declared.state !== 'PENDING_UPLOAD') return declared;
  // A record that waits for its bytes is completed on the version this answer carries: without one the bytes would be sent and could never be confirmed.
  if (answer.etag === undefined) throw unexpectedResponse(answer.status);
  return {
    state: 'PENDING_UPLOAD',
    ticket: declared.ticket,
    version: answer.etag,
    serverTime: answer.serverTime,
  };
}

/** `completeEvidenceUpload`: step two of two, which the server answers only for bytes it finds as declared. The answer is the identifier of the stored record. */
export async function completeEvidence(
  client: ApiClient,
  evidenceId: string,
  version: string,
  signal?: AbortSignal,
): Promise<string> {
  const answer = answerOf(
    await client.POST('/evidence/{id}/complete', {
      params: { path: { id: evidenceId }, header: { 'If-Match': version } },
      ...(signal === undefined ? {} : { signal }),
    }),
  );
  const stored = parseStoredEvidence(answer.data, evidenceId);
  if (stored === undefined) throw unexpectedResponse(answer.status);
  return stored;
}

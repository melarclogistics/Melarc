import type { ApiClient } from '../api/api-client';
import { failureOf, newIdempotencyKey } from '../api/idempotency';
import { completeEvidence, declareEvidence, type IntakeEvidencePurpose } from './evidence-commands';
import { sha256Hex } from './file-checksum';
import { putBytes } from './object-store-upload';

/**
 * One file of evidence, from the file the person chose to a record the platform has stored: its checksum is computed, the record is declared, the bytes are sent to the address the platform issued, and
 * the upload is completed (`completeEvidenceUpload`), which the server answers only for bytes it finds as declared. **The address of the upload is a local of one call**: it lives from the answer of the
 * declaration to the end of the `PUT`, and nothing else holds it (a retry declares again, and the platform says the same record and a new address). `steps` tells a screen where the file is, in words
 * it chooses; it is told nothing of the address.
 *
 * **Retry is safe, and does not make a second record.** The declaration takes an `Idempotency-Key`: a file whose attempt failed with an outcome nobody knows (no answer) keeps its key and is declared
 * again under it, so that the platform answers the record it made; a file the platform refused, or whose upload was done, is forgotten and any later attempt is new.
 */
export type UploadStep = 'hashing' | 'declaring' | 'sending' | 'confirming';

export type EvidenceUploader = (
  file: File,
  steps?: (step: UploadStep) => void,
  signal?: AbortSignal,
) => Promise<string>;

/** The moment a file was made, which the platform records as the capture time and refuses in the future: the file's own, and never later than now. */
function capturedAt(file: File): string {
  const made =
    Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : Date.now();
  return new Date(Math.min(made, Date.now())).toISOString();
}

/** Makes the uploader of one owner (an intake) and one purpose, which a screen calls once for each file the person adds. */
export function createEvidenceUploader(
  client: ApiClient,
  target: { readonly ownerId: string; readonly purpose: IntakeEvidencePurpose },
): EvidenceUploader {
  const keys = new WeakMap<File, string>();
  return async (file, steps, signal) => {
    steps?.('hashing');
    const checksum = await sha256Hex(file);
    const key = keys.get(file) ?? newIdempotencyKey();
    keys.set(file, key);
    try {
      steps?.('declaring');
      const declared = await declareEvidence(
        client,
        {
          ownerId: target.ownerId,
          purpose: target.purpose,
          capturedAt: capturedAt(file),
          contentType: file.type,
          byteSize: file.size,
          checksumSha256: checksum,
        },
        key,
      );
      steps?.('sending');
      await putBytes(declared.ticket.upload, file, signal);
      steps?.('confirming');
      const stored = await completeEvidence(client, declared.ticket.evidenceId, declared.version);
      keys.delete(file);
      return stored;
    } catch (error) {
      // An answer that declined this attempt says nothing of an earlier one, and the next attempt is a new one; only an outcome nobody knows is tried again under the same key.
      if (failureOf(error) !== 'unknown') keys.delete(file);
      throw error;
    }
  };
}

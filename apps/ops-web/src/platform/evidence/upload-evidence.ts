import type { ApiClient } from '../api/api-client';
import { failureOf, newIdempotencyKey } from '../api/idempotency';
import { completeEvidence, declareEvidence, type IntakeEvidencePurpose } from './evidence-commands';
import { refusalOfFile, type EvidenceLimitsView, type LimitRefusal } from './evidence-limits';
import { sha256Hex } from './file-checksum';
import { putBytes } from './object-store-upload';

/**
 * One file of evidence, from the file the person chose to a record the platform has stored: its checksum is computed, the record is declared, the bytes are sent to the address the platform issued, and
 * the upload is completed (`completeEvidenceUpload`), which the server answers only for bytes it finds as declared. **The address of the upload is a local of one call**: it lives from the answer of the
 * declaration to the end of the `PUT`, and nothing else holds it (a retry declares again, and the platform says the same record and a new address). `steps` tells a screen where the file is, in words
 * it chooses; it is told nothing of the address.
 *
 * **Retry is safe, and does not make a second record.** The declaration takes an `Idempotency-Key`: a file whose attempt failed with an outcome nobody knows (no answer, a time that ran out) keeps its key and is
 * declared again under it, so that the platform answers the record it made; a file the platform refused, or whose upload was done, is forgotten and any later attempt is new.
 *
 * **What the retry is told is acted on, and never looped on** (the review of Run B and the UX audit of Stage 6): a record that is **already stored** (the answer to its completion was lost) is the file's success;
 * a record whose **upload address has run out** (or that the platform says expired) is asked for again **once**, as a new record under a new key, and told if the fresh one has run out too; and **a file that the
 * platform's limits would refuse is refused before it is read whole** (the checksum reads every byte), when the limits are known. **Every step has its time** (`UPLOAD_BUDGETS`): a step that gets no answer is
 * told as the timeout of that step, never retried by itself.
 */
export type UploadStep = 'hashing' | 'declaring' | 'sending' | 'confirming';

export type EvidenceUploader = (
  file: File,
  steps?: (step: UploadStep) => void,
  signal?: AbortSignal,
) => Promise<string>;

/** The time a step may take, in milliseconds: provisional values (the platform sets none), held in one place. The bytes have a budget of their own that grows with the file. */
export const UPLOAD_BUDGETS = {
  /** The declaration: a short call to the platform. */
  declareMs: 20_000,
  /** The completion: the platform reads the object back and scans it, so it is allowed as long as the declaration. */
  confirmMs: 20_000,
  /** The least the bytes are given, however small the file. */
  sendMinMs: 30_000,
  /** The slowest link the budget still counts on: a file is given `size / sendBytesPerSecond` seconds, at least `sendMinMs`. */
  sendBytesPerSecond: 64 * 1024,
  /** The most the bytes are ever given, however large the file claims to be. */
  sendMaxMs: 300_000,
} as const;

/** An address with less than this left is as good as run out: the bytes would reach the store after it had stopped taking them. */
const ADDRESS_MARGIN_MS = 10_000;

/** What the uploader needs beyond its owner and purpose. */
export interface UploaderOptions {
  /** The platform's limits (`getEvidenceLimits`), where they were read: a file they refuse is refused before it is read. Left out when the read failed, and then nothing is judged here. */
  readonly limits?: EvidenceLimitsView | undefined;
}

/** A file the platform's limits refuse, told before anything is read or sent: its type is not one the platform takes, or it is larger than the largest file. */
export class EvidenceRefusedError extends Error {
  override name = 'EvidenceRefusedError';
  readonly kind: LimitRefusal['kind'];
  /** The file's size, for a file that is too large. */
  readonly size: number | undefined;
  /** The largest size, for a file that is too large. */
  readonly limit: number | undefined;
  /** The file's type, for one the platform does not take. */
  readonly type: string | undefined;

  constructor(refusal: LimitRefusal) {
    super('The file is not one the platform takes.');
    this.kind = refusal.kind;
    this.size = refusal.kind === 'too_large' ? refusal.size : undefined;
    this.limit = refusal.kind === 'too_large' ? refusal.limit : undefined;
    this.type = refusal.kind === 'type_not_allowed' ? refusal.type : undefined;
  }
}

/** A step that got no answer in its time (`UPLOAD_BUDGETS`). The outcome is not known (the platform may have done it), so the file keeps its key and the retry is the person's. */
export class UploadTimeoutError extends Error {
  override name = 'UploadTimeoutError';
  readonly step: UploadStep;
  constructor(step: UploadStep) {
    super('A step of the upload did not finish in its time.');
    this.step = step;
  }
}

/** The platform made an upload address for the file twice and both had run out as they were read: the person is told, and the next attempt is theirs. */
export class UploadAddressExpiredError extends Error {
  override name = 'UploadAddressExpiredError';
  constructor() {
    super('The upload address of the file had run out.');
  }
}

/** The moment a file was made, which the platform records as the capture time and refuses in the future: the file's own, and never later than now. */
function capturedAt(file: File): string {
  const made =
    Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : Date.now();
  return new Date(Math.min(made, Date.now())).toISOString();
}

/** The time the bytes of a file of this size are given. */
function sendBudgetMs(bytes: number): number {
  const wanted = Math.ceil((bytes / UPLOAD_BUDGETS.sendBytesPerSecond) * 1000);
  return Math.min(UPLOAD_BUDGETS.sendMaxMs, Math.max(UPLOAD_BUDGETS.sendMinMs, wanted));
}

/**
 * One step, in its time. The step is given a signal that is aborted when the person abandons the file (the caller's `parent`) or when the step's time runs out, and a step that ran out is the one
 * `UploadTimeoutError` whatever the abandoned request said (a request that is aborted fails in a way of its own). The timer is cleared however the step ends.
 */
async function within<Result>(
  step: UploadStep,
  budgetMs: number,
  parent: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const own = new AbortController();
  const timer = setTimeout(() => {
    own.abort();
  }, budgetMs);
  const abandon = (): void => {
    own.abort();
  };
  if (parent?.aborted === true) own.abort();
  else parent?.addEventListener('abort', abandon, { once: true });
  try {
    return await run(own.signal);
  } catch (error) {
    // The step's own signal was aborted and the person did not abandon the file: its time ran out.
    if (own.signal.aborted && parent?.aborted !== true) throw new UploadTimeoutError(step);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', abandon);
  }
}

/** Makes the uploader of one owner (an intake) and one purpose, which a screen calls once for each file the person adds. */
export function createEvidenceUploader(
  client: ApiClient,
  target: { readonly ownerId: string; readonly purpose: IntakeEvidencePurpose },
  options: UploaderOptions = {},
): EvidenceUploader {
  const keys = new WeakMap<File, string>();
  return async (file, steps, signal) => {
    // What the platform would refuse is told before the file is read whole, and before anything is sent: a tablet is not made to hold a file in memory to be told it is too large.
    const limits = options.limits;
    const refusal = limits === undefined ? undefined : refusalOfFile(file, limits);
    if (refusal !== undefined) throw new EvidenceRefusedError(refusal);

    steps?.('hashing');
    const checksum = await sha256Hex(file);
    let key = keys.get(file) ?? newIdempotencyKey();
    keys.set(file, key);
    // A fresh record is asked for once when the address of the one the platform answers with has run out; the second is judged as it comes.
    let renewals = 0;
    try {
      for (;;) {
        steps?.('declaring');
        const declared = await within('declaring', UPLOAD_BUDGETS.declareMs, signal, (step) =>
          declareEvidence(
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
            step,
          ),
        );
        // The completion was done and its answer was lost: the retry is told the record as it is now, and that is the file's success.
        if (declared.state === 'STORED') {
          keys.delete(file);
          return declared.evidenceId;
        }
        if (
          declared.state === 'EXPIRED' ||
          Date.parse(declared.ticket.upload.expires_at) - Date.now() <= ADDRESS_MARGIN_MS
        ) {
          if (renewals >= 1) throw new UploadAddressExpiredError();
          renewals += 1;
          key = newIdempotencyKey();
          keys.set(file, key);
          continue;
        }
        steps?.('sending');
        await within('sending', sendBudgetMs(file.size), signal, (step) =>
          putBytes(declared.ticket.upload, file, step),
        );
        steps?.('confirming');
        const stored = await within('confirming', UPLOAD_BUDGETS.confirmMs, signal, (step) =>
          completeEvidence(client, declared.ticket.evidenceId, declared.version, step),
        );
        keys.delete(file);
        return stored;
      }
    } catch (error) {
      // An answer that declined this attempt says nothing of an earlier one, and the next attempt is a new one; only an outcome nobody knows is tried again under the same key.
      if (failureOf(error) !== 'unknown') keys.delete(file);
      throw error;
    }
  };
}

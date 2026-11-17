import {
  CHECKSUM_UNAVAILABLE,
  FILE_EMPTY,
  FILE_TYPE_NOT_TAKEN,
  STORE_BLOCKED,
  STORE_DECLINED,
  STORE_UNREACHABLE,
  UPLOAD_ADDRESS_RAN_OUT,
  UPLOAD_TIMED_OUT,
  fileTooLarge,
} from '../problem/hub-intake-copy';
import { problemOf } from '../problem/problem-copy';
import { ChecksumUnavailableError } from './file-checksum';
import { ObjectStoreError } from './object-store-upload';
import {
  EvidenceRefusedError,
  UploadAddressExpiredError,
  UploadTimeoutError,
  type EvidenceUploader,
  type UploadStep,
} from './upload-evidence';

/**
 * What a file of evidence says on its way, and when it could not be stored, **in the one table's words** (`problem/hub-intake-copy.ts`): the step it is at, and the failure it ended with. A screen that
 * draws an upload (`components/ui/evidence-upload`) passes it `uploadWithSteps` and `evidenceFailureWords`, so that no page words a refusal of its own and every upload says the same thing for the same
 * outcome. Never an address, a key, a status or the platform's own text.
 */

/** What a file is doing, in words, at each step of its trip to a stored record. */
export const UPLOAD_STEP_WORDS: Readonly<Record<UploadStep, string>> = {
  waiting: 'Waiting for its turn…',
  hashing: 'Checking the file…',
  declaring: 'Preparing the photo…',
  sending: 'Sending the photo…',
  confirming: 'Confirming it arrived…',
};

/**
 * Whose act the photo is made for, which is what decides the capability a refusal names: the receiver's (`count`: the key of the check-in and of a condition) or the senior's decision (`decision`: the key of
 * the adjudication). The platform asks for the key of the act the photo belongs to, so a refusal of a photo for a decision names the decision, never the receiver's work.
 */
export type EvidenceUse = 'count' | 'decision';

/** A file that could not be stored, with the step it was at, so that the words are the step's: the platform's for the two calls, the store's for the bytes. */
export class UploadFailure extends Error {
  override name = 'UploadFailure';
  readonly step: UploadStep | 'empty';
  readonly reason: unknown;
  constructor(step: UploadStep | 'empty', reason: unknown) {
    super('The photo could not be stored.');
    this.step = step;
    this.reason = reason;
  }
}

/**
 * Sends one file through `store`, telling each step in words and naming the step a failure was at. An empty file is the file's own failure before anything is done. A refusal made before the first step (the
 * platform's limits, judged before the file is read) is told as a failure of the first step.
 */
export async function uploadWithSteps(
  store: EvidenceUploader,
  file: File,
  report: (words: string) => void,
  signal: AbortSignal,
): Promise<string> {
  if (file.size === 0) throw new UploadFailure('empty', undefined);
  let at: UploadStep = 'hashing';
  try {
    return await store(
      file,
      (step) => {
        at = step;
        report(UPLOAD_STEP_WORDS[step]);
      },
      signal,
    );
  } catch (failure) {
    throw new UploadFailure(at, failure);
  }
}

/** What a failed file says, in the one table's words. `use` is whose act the photo is for (the receiver's unless it is said to be the decision's). */
export function evidenceFailureWords(error: unknown, use: EvidenceUse = 'count'): string {
  if (!(error instanceof UploadFailure)) return STORE_UNREACHABLE;
  const { step, reason } = error;
  if (step === 'empty') return FILE_EMPTY;
  if (reason instanceof EvidenceRefusedError) {
    return reason.kind === 'too_large' ? fileTooLarge(reason.limit ?? 0) : FILE_TYPE_NOT_TAKEN;
  }
  if (reason instanceof UploadTimeoutError) return UPLOAD_TIMED_OUT;
  if (reason instanceof UploadAddressExpiredError) return UPLOAD_ADDRESS_RAN_OUT;
  if (reason instanceof ChecksumUnavailableError) return CHECKSUM_UNAVAILABLE;
  if (reason instanceof ObjectStoreError) {
    if (reason.kind === 'refused') return STORE_DECLINED;
    return reason.kind === 'blocked' ? STORE_BLOCKED : STORE_UNREACHABLE;
  }
  if (step === 'declaring' || step === 'confirming') {
    const message = problemOf(reason, {
      operation: step === 'declaring' ? 'createEvidence' : 'completeEvidenceUpload',
      ...(use === 'decision' ? { context: 'decision' } : {}),
    }).message;
    return message === '' ? STORE_UNREACHABLE : message;
  }
  return STORE_UNREACHABLE;
}

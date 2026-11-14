import { useMemo } from 'react';

import { EvidenceUpload } from '../../../components/ui/evidence-upload/EvidenceUpload';
import { useApiClient } from '../../../platform/api/api-client';
import type { IntakeEvidencePurpose } from '../../../platform/evidence/evidence-commands';
import { ChecksumUnavailableError } from '../../../platform/evidence/file-checksum';
import { ObjectStoreError } from '../../../platform/evidence/object-store-upload';
import {
  createEvidenceUploader,
  type UploadStep,
} from '../../../platform/evidence/upload-evidence';
import {
  CHECKSUM_UNAVAILABLE,
  FILE_EMPTY,
  STORE_DECLINED,
  STORE_UNREACHABLE,
} from '../../../platform/problem/hub-intake-copy';
import { problemOf } from '../../../platform/problem/problem-copy';

/** What a file is doing, in words, at each step of its trip to a stored record. */
const STEP_WORDS: Readonly<Record<UploadStep, string>> = {
  hashing: 'Checking the file…',
  declaring: 'Preparing the photo…',
  sending: 'Sending the photo…',
  confirming: 'Confirming it arrived…',
};

/** A file that could not be stored, with the step it was at, so that the words are the step's: the platform's for the two calls, the store's for the bytes. */
class UploadFailure extends Error {
  override name = 'UploadFailure';
  readonly step: UploadStep | 'empty';
  readonly reason: unknown;
  constructor(step: UploadStep | 'empty', reason: unknown) {
    super('The photo could not be stored.');
    this.step = step;
    this.reason = reason;
  }
}

/** What a failed file says, in the one table's words: never the server's text, an address or a storage key. */
export function failureWords(error: unknown): string {
  if (!(error instanceof UploadFailure)) return STORE_UNREACHABLE;
  const { step, reason } = error;
  if (step === 'empty') return FILE_EMPTY;
  if (reason instanceof ChecksumUnavailableError) return CHECKSUM_UNAVAILABLE;
  if (reason instanceof ObjectStoreError) {
    return reason.kind === 'refused' ? STORE_DECLINED : STORE_UNREACHABLE;
  }
  if (step === 'declaring' || step === 'confirming') {
    const message = problemOf(reason, {
      operation: step === 'declaring' ? 'createEvidence' : 'completeEvidenceUpload',
    }).message;
    return message === '' ? STORE_UNREACHABLE : message;
  }
  return STORE_UNREACHABLE;
}

export interface IntakeEvidenceProps {
  readonly intakeId: string;
  /** `CONDITION` for the receiver's photos, `OSD` for the adjudicator's: the key the platform asks for is the act's own. */
  readonly purpose: IntakeEvidencePurpose;
  readonly required: boolean;
  readonly error?: string | undefined;
  readonly onChange: (stored: readonly string[]) => void;
  readonly onBusyChange: (busy: boolean) => void;
}

/**
 * The photos of what was found, for a form of the receiving side: the generic upload (`components/ui/evidence-upload`) wired to the platform's way of storing one file (`platform/evidence/`), for an owner that is
 * this intake and the purpose of the act. **The type and the size of a file are the platform's to judge** (`evidence_upload_allowed_mime_types`, `evidence_upload_max_bytes`, which the portal has no read of): the
 * chooser offers photos and PDFs as a hint and the platform refuses the rest in words.
 */
export function IntakeEvidence({
  intakeId,
  purpose,
  required,
  error,
  onChange,
  onBusyChange,
}: IntakeEvidenceProps) {
  const client = useApiClient();
  const store = useMemo(
    () => createEvidenceUploader(client, { ownerId: intakeId, purpose }),
    [client, intakeId, purpose],
  );

  return (
    <EvidenceUpload
      label="Photos of what you found"
      help="Add a photo (JPEG or PNG) or a PDF. Each is sent as soon as you choose it."
      required={required}
      accept="image/jpeg,image/png,application/pdf"
      {...(error === undefined ? {} : { error })}
      upload={async (file, report, signal) => {
        if (file.size === 0) throw new UploadFailure('empty', undefined);
        let at: UploadStep = 'hashing';
        try {
          return await store(
            file,
            (step) => {
              at = step;
              report(STEP_WORDS[step]);
            },
            signal,
          );
        } catch (failure) {
          throw new UploadFailure(at, failure);
        }
      }}
      failureText={failureWords}
      onChange={onChange}
      onBusyChange={onBusyChange}
    />
  );
}

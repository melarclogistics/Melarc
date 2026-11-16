import { useMemo } from 'react';

import { EvidenceUpload } from '../../../components/ui/evidence-upload/EvidenceUpload';
import { useApiClient } from '../../../platform/api/api-client';
import type { IntakeEvidencePurpose } from '../../../platform/evidence/evidence-commands';
import {
  evidenceFailureWords,
  uploadWithSteps,
  type EvidenceUse,
} from '../../../platform/evidence/evidence-failure-words';
import { createEvidenceUploader } from '../../../platform/evidence/upload-evidence';

export interface IntakeEvidenceProps {
  readonly intakeId: string;
  /** `CONDITION` for the receiver's photos, `OSD` for the adjudicator's: the key the platform asks for is the act's own. */
  readonly purpose: IntakeEvidencePurpose;
  /** Whose act the photos are for, which is what decides the capability a refusal names: the receiver's (`count`, the default) or the senior's decision (`decision`). */
  readonly use?: EvidenceUse;
  readonly required: boolean;
  readonly error?: string | undefined;
  readonly onChange: (stored: readonly string[]) => void;
  readonly onBusyChange: (busy: boolean) => void;
}

/**
 * The photos of what was found, for a form of the receiving side: the generic upload (`components/ui/evidence-upload`) wired to the platform's way of storing one file (`platform/evidence/`), for an owner that is
 * this intake and the purpose of the act. **The type and the size of a file are the platform's to judge** (`evidence_upload_allowed_mime_types`, `evidence_upload_max_bytes`, which `getEvidenceLimits` gives the
 * screens that read them): the chooser offers photos and PDFs as a hint and the platform refuses the rest in words. **A refusal is worded by the use**: the adjudication's photos carry the adjudication's words.
 */
export function IntakeEvidence({
  intakeId,
  purpose,
  use = 'count',
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
      upload={(file, report, signal) => uploadWithSteps(store, file, report, signal)}
      failureText={(failure) => evidenceFailureWords(failure, use)}
      onChange={onChange}
      onBusyChange={onBusyChange}
    />
  );
}

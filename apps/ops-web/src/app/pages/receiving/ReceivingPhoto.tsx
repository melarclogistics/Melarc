import { useMemo } from 'react';

import { EvidenceUpload } from '../../../components/ui/evidence-upload/EvidenceUpload';
import { useApiClient } from '../../../platform/api/api-client';
import type { IntakeEvidencePurpose } from '../../../platform/evidence/evidence-commands';
import {
  evidenceFailureWords,
  uploadWithSteps,
} from '../../../platform/evidence/evidence-failure-words';
import { createEvidenceUploader } from '../../../platform/evidence/upload-evidence';
import { useEvidenceLimits } from '../../../platform/evidence/use-evidence-limits';

export interface ReceivingPhotoProps {
  /** The vendor the photo is of: the owner of the evidence record. */
  readonly intakeId: string;
  /** `OSD` for the photo of a parcel that is not on the list, `CONDITION` for the photo of damage: the key the platform asks for is the act's own. */
  readonly purpose: IntakeEvidencePurpose;
  readonly label: string;
  readonly help: string;
  readonly required: boolean;
  readonly error?: string | undefined;
  /** The photos that are stored, as the identifiers the platform gave them, in the order they were added. */
  readonly onChange: (stored: readonly string[]) => void;
  readonly onBusyChange: (busy: boolean) => void;
}

/**
 * The photo of what the officer found at the table, taken at the hub (D-D2, D-D4): the kit's generic upload (`components/ui/evidence-upload`) wired to the platform's way of storing one file, for a vendor and the
 * purpose of the act. **The file is judged before it is read** (the platform's limits, read once for the session, refuse a file of a type or a size it will not take before it is checksummed), each photo is sent
 * as soon as it is chosen, and a failure is told in the one table's words. On a tablet the chooser offers the camera. **The camera's own capture and preview are the photo kit's** (piece 3), which replaces the
 * inside of this file and leaves its props as they are.
 */
export function ReceivingPhoto({
  intakeId,
  purpose,
  label,
  help,
  required,
  error,
  onChange,
  onBusyChange,
}: ReceivingPhotoProps) {
  const client = useApiClient();
  // A read that fails gives no limit and is not a guessed one: the file is then judged by the platform alone.
  const limits = useEvidenceLimits().data;
  const store = useMemo(
    () => createEvidenceUploader(client, { ownerId: intakeId, purpose }, { limits }),
    [client, intakeId, purpose, limits],
  );
  return (
    <EvidenceUpload
      label={label}
      help={help}
      required={required}
      accept="image/*"
      {...(error === undefined ? {} : { error })}
      upload={(file, report, signal) => uploadWithSteps(store, file, report, signal)}
      failureText={(failure) => evidenceFailureWords(failure, 'count')}
      onChange={onChange}
      onBusyChange={onBusyChange}
    />
  );
}

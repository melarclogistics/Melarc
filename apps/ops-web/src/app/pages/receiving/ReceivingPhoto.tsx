import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { EvidenceUpload } from '../../../components/ui/evidence-upload/EvidenceUpload';
import { useApiClient } from '../../../platform/api/api-client';
import type { IntakeEvidencePurpose } from '../../../platform/evidence/evidence-commands';
import {
  evidenceFailureWords,
  uploadWithSteps,
  type EvidenceUse,
} from '../../../platform/evidence/evidence-failure-words';
import { imagesOnly } from '../../../platform/evidence/evidence-limits';
import { createEvidenceUploader } from '../../../platform/evidence/upload-evidence';
import { useEvidenceLimits } from '../../../platform/evidence/use-evidence-limits';
import { holdOf } from '../../../platform/query/read-hold';

export interface ReceivingPhotoProps {
  /** The vendor the photo is of: the owner of the evidence record. */
  readonly intakeId: string;
  /** `OSD` for the photo of a parcel that is not on the list and for a decision's photos, `CONDITION` for the photo of damage: the key the platform asks for is the act's own. */
  readonly purpose: IntakeEvidencePurpose;
  /** Whose act the photo is for, which decides the capability a refusal names: the officer's check-in (`count`, the default) or a senior officer's decision (`decision`). */
  readonly use?: EvidenceUse;
  readonly label: string;
  readonly help: string;
  readonly required: boolean;
  readonly error?: string | undefined;
  /** The photos that are stored, as the identifiers the platform gave them, in the order they were added. */
  readonly onChange: (stored: readonly string[]) => void;
  /** Told when a photo is on its way and when none is: a form hands it `useUploadGate().watch(label)` so that its submit can say what it waits for, whatever part of the form the upload is in. */
  readonly onBusyChange: (busy: boolean) => void;
}

/**
 * The photo of what the officer found at the table, taken at the hub (D-D2, D-D4): **the camera opens directly** (`capture="environment"`), with the gallery as the other choice and no document on the floor, and
 * each photo is shown back as a preview that can be retaken (the kit's `EvidenceUpload` in its photo mode). **The file is judged before it is read**: the platform's limits, read once for the session and narrowed to
 * images, refuse a file of a type or a size it will not take before it is checksummed, and a limit that could not be read is never guessed (the platform then judges alone). Each photo is sent as soon as it is
 * taken and a failure is told in the one table's words, for the use the page names.
 */
export function ReceivingPhoto({
  intakeId,
  purpose,
  use = 'count',
  label,
  help,
  required,
  error,
  onChange,
  onBusyChange,
}: ReceivingPhotoProps) {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const limits = useEvidenceLimits().data;
  const photoLimits = useMemo(
    () => (limits === undefined ? undefined : imagesOnly(limits)),
    [limits],
  );
  const store = useMemo(
    () =>
      createEvidenceUploader(
        client,
        { ownerId: intakeId, purpose },
        // The page's own hold: the files that have not begun wait while the API has asked the page to wait (a request refused for being too fast), as its automatic reads do.
        {
          hold: holdOf(queryClient),
          ...(photoLimits === undefined ? {} : { limits: photoLimits }),
        },
      ),
    [client, queryClient, intakeId, purpose, photoLimits],
  );
  return (
    <EvidenceUpload
      mode="photos"
      label={label}
      help={help}
      required={required}
      {...(error === undefined ? {} : { error })}
      upload={(file, report, signal) => uploadWithSteps(store, file, report, signal)}
      failureText={(failure) => evidenceFailureWords(failure, use)}
      onChange={onChange}
      onBusyChange={onBusyChange}
    />
  );
}

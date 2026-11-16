import { useState } from 'react';

import { useUploadGate, UploadGateNotice } from '../../../components/ui/evidence-upload/UploadGate';
import { Field } from '../../../components/ui/field/Field';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import {
  recordIntakeCondition,
  type ConditionRecord,
  type CountedWithVersion,
} from '../../../platform/hub-intake/hub-intake-commands';
import type { PostCountIntakeView } from '../../../platform/hub-intake/hub-intake-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { ReceivingPhoto } from './ReceivingPhoto';
import './receiving-pages.css';

/** What recording damage sends: the condition and the version of the vendor the officer saw (`If-Match`), held together so that a retry after a lost answer is the same request under the same key. */
interface DamageCommand {
  readonly version: string;
  readonly record: ConditionRecord;
}

export interface BlindDamageDialogProps {
  readonly intake: PostCountIntakeView;
  /** The vendor's `ETag`, exactly as the read gave it. */
  readonly version: string;
  readonly onCancel: () => void;
  readonly onDone: (result: CountedWithVersion) => void;
  readonly onReload: () => unknown;
}

/** The problems a photo can be refused for, which belong to the photo's field and not to the dialog as a whole. */
const PHOTO_CODES: readonly string[] = ['REASON_REQUIRED', 'EVIDENCE_NOT_STORED'];

/**
 * "Record damage" for a vendor whose parcels were counted and not checked in (D-D7): **the one condition of the whole vendor**, recorded once after the count, with at least one photo taken at the hub (stored
 * first, then cited) and a note if the officer has one. A vendor checked in against its door photos records damage on a parcel's own photo instead, and has no such dialog. It is sent on the version the
 * page read, so that a vendor that changed since is told and never overwritten, and it takes a key, so that a lost answer is never a second record. A vendor with damage goes to a senior officer's decision,
 * which the dialog says before it is confirmed.
 */
export function BlindDamageDialog({
  intake,
  version,
  onCancel,
  onDone,
  onReload,
}: BlindDamageDialogProps) {
  const client = useApiClient();
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const gate = useUploadGate();
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  return (
    <ActDialog<DamageCommand, CountedWithVersion>
      open
      title={WORDS.blindDamage.title}
      consequence={<p>{WORDS.blindDamage.consequence}</p>}
      confirmLabel={WORDS.blindDamage.confirm}
      confirmVariant="primary"
      size="lg"
      operation="recordIntakeCondition"
      retryable
      build={() => {
        // A photo on its way is told by the gate's own line beside the field, which is on the screen already: nothing is sent until it is stored.
        if (gate.busy) return undefined;
        const wrong = photos.length === 0 ? WORDS.blindDamage.photoNeeded : undefined;
        setPhotoError(wrong);
        if (wrong !== undefined) return undefined;
        const said = note.trim();
        return {
          version,
          record: {
            condition: 'DAMAGED',
            ...(said === '' ? {} : { note: said }),
            evidenceIds: photos,
          },
        };
      }}
      send={(command, key) =>
        recordIntakeCondition(client, intake.id, command.record, command.version, key)
      }
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
      onRefused={(problem) => {
        if (problem.code !== undefined && PHOTO_CODES.includes(problem.code)) {
          setPhotoError(problem.message);
        }
      }}
    >
      <ReceivingPhoto
        intakeId={intake.id}
        purpose="CONDITION"
        label={WORDS.blindDamage.photoLabel}
        help={WORDS.blindDamage.photoHelp}
        required
        error={photoError}
        onChange={setPhotos}
        onBusyChange={gate.watch(WORDS.blindDamage.photoLabel)}
      />
      <UploadGateNotice gate={gate} />
      <Field label={WORDS.blindDamage.noteLabel} help={WORDS.blindDamage.noteHelp}>
        <Textarea
          name="note"
          value={note}
          rows={3}
          maxLength={1000}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
      </Field>
    </ActDialog>
  );
}

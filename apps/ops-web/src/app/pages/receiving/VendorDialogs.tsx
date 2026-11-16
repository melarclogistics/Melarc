import { useState } from 'react';

import { Field } from '../../../components/ui/field/Field';
import { Textarea } from '../../../components/ui/textarea/Textarea';
import { useApiClient } from '../../../platform/api/api-client';
import {
  addExtraParcel,
  finishCheckIn,
  recordParcelCondition,
  type CheckInWithVersion,
  type FinishChoice,
  type ParcelConditionRecord,
} from '../../../platform/hub-receiving/receiving-commands';
import type {
  ParcelAnswerView,
  ParcelView,
  VendorView,
} from '../../../platform/hub-receiving/receiving-shape';
import { RECEIVING_WORDS as WORDS } from '../../../platform/problem/receiving-copy';
import { ActDialog } from '../manifests/ManifestActDialogs';
import { ParcelGrid } from './ParcelGrid';
import { ReceivingPhoto } from './ReceivingPhoto';
import './receiving-pages.css';

/**
 * What finishing a vendor sends: the way it is finished and the version of the vendor the officer saw (`If-Match`, the vendor's `intake_etag`), held together so that a retry after a lost answer is the same
 * request under the same key.
 */
interface FinishCommand {
  readonly version: string;
  readonly finish: FinishChoice;
}

export interface FinishDialogProps {
  readonly vendor: VendorView;
  readonly onCancel: () => void;
  readonly onDone: (result: CheckInWithVersion) => void;
  /** The officer asks to see the vendor as it is now (after a conflict, or to find out whether an unknown outcome was done). */
  readonly onReload: () => unknown;
  /** Takes the vendor's lock on the officer's first act on it: confirming is an act, as a tap is. It never fails (the lock is advisory). */
  readonly ensureLock: (intakeId: string) => Promise<void>;
}

/**
 * "All N here" (D-D2): the officer says that they counted the vendor's pile on the table and that it has every parcel the door photos show. **The number is a statement, never a default**: the question and the
 * button say it, and the photos are beside it to count against. What is sent is `{ all_arrived: true, confirmed_count: N }` with N the number the officer was shown and confirmed; the API refuses it when the
 * number of photos changed since (`count_changed`), and the dialog is then drawn with the new number, so that it is confirmed again by someone who has seen it. Confirmed, every parcel not yet checked in is.
 */
export function AllHereDialog({
  vendor,
  onCancel,
  onDone,
  onReload,
  ensureLock,
}: FinishDialogProps) {
  const client = useApiClient();
  const count = vendor.parcels_expected ?? 0;
  return (
    <ActDialog<FinishCommand, CheckInWithVersion>
      open
      title={WORDS.allHere.title(count, vendor.vendor_name)}
      consequence={<p>{WORDS.allHere.body(count)}</p>}
      confirmLabel={WORDS.allHere.confirm(count)}
      confirmVariant="primary"
      size="lg"
      operation="finishCheckIn"
      retryable
      build={() => ({
        version: vendor.intake_etag,
        finish: { allArrived: true, confirmedCount: count },
      })}
      send={async (command, key) => {
        await ensureLock(vendor.intake_id);
        return finishCheckIn(client, vendor.intake_id, command.finish, command.version, key);
      }}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
    >
      <ParcelGrid label={WORDS.vendor.gridLabel(vendor.vendor_name)} parcels={vendor.parcels} />
    </ActDialog>
  );
}

/**
 * "Finish this vendor" after the officer checked parcels in one by one (D-D2): the parcels they did not tap are marked missing, and the dialog says how many and, when a parcel that is not on the list was added
 * or a parcel is missing, that a senior officer decides next. What is sent is `{ all_arrived: false }` and nothing else. The number of parcels not tapped is counted from the parcels the page holds, to say
 * what is about to happen; what the API records is the API's.
 */
export function FinishVendorDialog({
  vendor,
  onCancel,
  onDone,
  onReload,
  ensureLock,
}: FinishDialogProps) {
  const client = useApiClient();
  const untapped = vendor.parcels.filter((parcel) => parcel.state === 'EXPECTED').length;
  const hasExtras = vendor.extra_count > 0;
  return (
    <ActDialog<FinishCommand, CheckInWithVersion>
      open
      title={WORDS.finish.title(vendor.vendor_name)}
      consequence={
        <>
          <p>{WORDS.finish.untapped(untapped)}</p>
          {hasExtras ? <p>{WORDS.finish.extras}</p> : null}
          {untapped > 0 || hasExtras ? <p>{WORDS.finish.decision}</p> : null}
        </>
      }
      confirmLabel={WORDS.finish.confirm}
      confirmVariant="primary"
      size="lg"
      operation="finishCheckIn"
      retryable
      build={() => ({ version: vendor.intake_etag, finish: { allArrived: false } })}
      send={async (command, key) => {
        await ensureLock(vendor.intake_id);
        return finishCheckIn(client, vendor.intake_id, command.finish, command.version, key);
      }}
      onDone={onDone}
      onCancel={onCancel}
      onReload={onReload}
    />
  );
}

/** What adding an extra sends: the stored photo and the note. It takes a key and no version (nothing the officer read is judged: two extras are two parcels). */
interface ExtraCommand {
  readonly photoId: string;
  readonly note: string | undefined;
}

export interface ExtraParcelDialogProps {
  readonly vendor: VendorView;
  readonly onCancel: () => void;
  /** The API's answer: the new parcel, the vendor's token and its counts, which the page takes in. */
  readonly onDone: (answer: ParcelAnswerView) => void;
  readonly onReload: () => unknown;
  readonly ensureLock: (intakeId: string) => Promise<void>;
}

/** The problems a photo can be refused for, which belong to the photo's field and not to the dialog as a whole. */
const PHOTO_CODES: readonly string[] = ['REASON_REQUIRED', 'EVIDENCE_NOT_STORED'];

/**
 * "Add a parcel not on the list" (D-D2): a parcel on the table that has no door photo is recorded with a photo the officer takes **at the hub**, stored first (its three steps), then cited, once, with a note if
 * the officer has one. One photo, because one parcel is added; the dialog does not send while the photo is on its way. The parcel is counted as an extra and goes to a senior officer's decision however the vendor
 * is finished, which the dialog says before it is confirmed.
 */
export function ExtraParcelDialog({
  vendor,
  onCancel,
  onDone,
  onReload,
  ensureLock,
}: ExtraParcelDialogProps) {
  const client = useApiClient();
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  return (
    <ActDialog<ExtraCommand, ParcelAnswerView>
      open
      title={WORDS.extra.title}
      consequence={<p>{WORDS.extra.consequence}</p>}
      confirmLabel={WORDS.extra.confirm}
      confirmVariant="primary"
      size="lg"
      operation="addExtraParcel"
      retryable
      build={() => {
        const [photo] = photos;
        const wrong = busy
          ? WORDS.extra.photoBusy
          : photo === undefined
            ? WORDS.extra.photoNeeded
            : photos.length > 1
              ? WORDS.extra.onePhoto
              : undefined;
        setPhotoError(wrong);
        if (wrong !== undefined || photo === undefined) return undefined;
        const said = note.trim();
        return { photoId: photo, note: said === '' ? undefined : said };
      }}
      send={async (command, key) => {
        await ensureLock(vendor.intake_id);
        return addExtraParcel(client, vendor.intake_id, command.photoId, command.note, key);
      }}
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
        intakeId={vendor.intake_id}
        purpose="OSD"
        label={WORDS.extra.photoLabel}
        help={WORDS.extra.photoHelp}
        required
        error={photoError}
        onChange={setPhotos}
        onBusyChange={setBusy}
      />
      <Field label={WORDS.extra.noteLabel} help={WORDS.extra.noteHelp}>
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

/** What recording damage sends: the parcel, the condition, the photos and the note, with the version of the vendor the officer saw (If-Match). */
interface DamageCommand {
  readonly version: string;
  readonly record: ParcelConditionRecord;
}

export interface DamageDialogProps {
  readonly vendor: VendorView;
  readonly parcel: ParcelView;
  readonly onCancel: () => void;
  readonly onDone: (result: CheckInWithVersion) => void;
  readonly onReload: () => unknown;
  readonly ensureLock: (intakeId: string) => Promise<void>;
}

/**
 * "Damaged" on a parcel (D-D7): damage is recorded on **the parcel's own photo**, once for each parcel, with at least one photo taken at the hub (stored first, then cited) and a note if the officer has one,
 * whether or not the vendor is finished. It is sent on the vendor's version, so that a vendor that changed since the officer read it is told, not overwritten. A parcel with damage goes to a senior officer's
 * decision, which the dialog says before it is confirmed.
 */
export function DamageDialog({
  vendor,
  parcel,
  onCancel,
  onDone,
  onReload,
  ensureLock,
}: DamageDialogProps) {
  const client = useApiClient();
  const [photos, setPhotos] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | undefined>(undefined);
  const [note, setNote] = useState('');
  const label = WORDS.parcel.label(parcel.ordinal, parcel.origin === 'HUB_EXTRA');
  return (
    <ActDialog<DamageCommand, CheckInWithVersion>
      open
      title={WORDS.damage.title(label)}
      consequence={<p>{WORDS.damage.consequence}</p>}
      confirmLabel={WORDS.damage.confirm}
      confirmVariant="primary"
      size="lg"
      operation="floor:recordIntakeCondition"
      retryable
      build={() => {
        const wrong = busy
          ? WORDS.damage.photoBusy
          : photos.length === 0
            ? WORDS.damage.photoNeeded
            : undefined;
        setPhotoError(wrong);
        if (wrong !== undefined) return undefined;
        const said = note.trim();
        return {
          version: vendor.intake_etag,
          record: {
            parcelId: parcel.id,
            condition: 'DAMAGED',
            ...(said === '' ? {} : { note: said }),
            evidenceIds: photos,
          },
        };
      }}
      send={async (command, key) => {
        await ensureLock(vendor.intake_id);
        return recordParcelCondition(
          client,
          vendor.intake_id,
          command.record,
          command.version,
          key,
        );
      }}
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
        intakeId={vendor.intake_id}
        purpose="CONDITION"
        label={WORDS.damage.photoLabel}
        help={WORDS.damage.photoHelp}
        required
        error={photoError}
        onChange={setPhotos}
        onBusyChange={setBusy}
      />
      <Field label={WORDS.damage.noteLabel} help={WORDS.damage.noteHelp}>
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

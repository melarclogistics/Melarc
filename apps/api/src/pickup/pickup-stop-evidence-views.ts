import type { ParcelPhotoExceptionView } from './collection.service.js';

/**
 * What `listPickupStopEvidence` is made of (S1.30; the Product Owner's decision D-A10, `AC-SLICE-001-86` to `-88`, `OB-S1-80`): the evidence of a pickup stop as Ops reads it.
 * **A closed projection, copied member by member**, so that nothing else a record holds can reach the wire: **no object key, no address, no signed operation, no checksum**
 * (the image of one record is read with `createEvidenceRetrievalAuthorization`, one at a time and only when it is shown), no device context and no rider.
 */

/** The purposes a pickup stop's evidence can have: the photo of a parcel counted, and the proof of a failure or of a short count's reason. */
export const STOP_EVIDENCE_PURPOSES = ['PARCEL_PHOTO', 'COLLECTION_PROOF'] as const;
export type StopEvidencePurpose = (typeof STOP_EVIDENCE_PURPOSES)[number];

export const STOP_EVIDENCE_STATES = ['PENDING_UPLOAD', 'STORED', 'EXPIRED'] as const;
export type StopEvidenceState = (typeof STOP_EVIDENCE_STATES)[number];

const instant = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/** A record of the stop's evidence as the statement reads it, with the position of the row in the page. */
export interface StopEvidenceRow {
  readonly id: string;
  readonly purpose: StopEvidencePurpose;
  readonly state: StopEvidenceState;
  readonly captured_at: string | Date;
  readonly uploaded_at: string | Date | null;
  readonly content_type: string;
  readonly scanned_clean: boolean;
  readonly position_text: string;
  readonly position_id: string;
}

export interface StopEvidenceItemView {
  readonly id: string;
  readonly purpose: StopEvidencePurpose;
  readonly state: StopEvidenceState;
  readonly captured_at: string;
  /** The completion of the upload, by the platform's clock; `null` until the record is stored. */
  readonly uploaded_at: string | null;
  readonly content_type: string;
  /** Whether the malicious-content check found the stored file clean: a verdict is on the record. */
  readonly scanned_clean: boolean;
}

export function stopEvidenceItemViewOf(row: StopEvidenceRow): StopEvidenceItemView {
  return {
    id: row.id,
    purpose: row.purpose,
    state: row.state,
    captured_at: instant(row.captured_at),
    uploaded_at: row.uploaded_at === null ? null : instant(row.uploaded_at),
    content_type: row.content_type,
    scanned_clean: row.scanned_clean,
  };
}

/** The progress of a stop's parcel photos as the database counts them for the whole stop: the figures are the server's and the page works out none. */
export interface ParcelPhotoProgressRow {
  readonly stored: number;
  readonly pending: number;
  readonly expired: number;
}

export interface ParcelPhotoProgressView {
  /** What the rider has made and is sending: `stored` and `pending` together. An expired record is never part of it. */
  readonly declared: number;
  readonly stored: number;
  readonly pending: number;
  readonly expired: number;
}

export function parcelPhotoProgressViewOf(row: ParcelPhotoProgressRow): ParcelPhotoProgressView {
  return {
    declared: row.stored + row.pending,
    stored: row.stored,
    pending: row.pending,
    expired: row.expired,
  };
}

/** The exception that let a stop's count through without parcel photos, as the table keeps it. */
export interface ParcelPhotoExceptionRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly authorised_by: string;
  readonly authorised_at: string | Date;
  readonly note: string;
}

export function parcelPhotoExceptionViewOf(row: ParcelPhotoExceptionRow): ParcelPhotoExceptionView {
  return {
    id: row.id,
    pickup_stop_id: row.pickup_stop_id,
    authorised_by: row.authorised_by,
    authorised_at: instant(row.authorised_at),
    note: row.note,
  };
}

export interface StopEvidenceListView {
  readonly items: readonly StopEvidenceItemView[];
  readonly next_page_token: string | null;
  readonly parcel_photos: ParcelPhotoProgressView;
  readonly parcel_photo_exception: ParcelPhotoExceptionView | null;
}

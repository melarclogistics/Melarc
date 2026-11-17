import { sql, type SQL } from 'drizzle-orm';

/** The reason of a short count or of a count above the booking as it is kept on the record: the code and the label as they were (domain-model.md section 3.7), and the note. */
export interface VarianceReasonSnapshot {
  readonly reason_code: string;
  readonly label: string;
  readonly attribution: string;
  readonly note?: string;
}

/** How the count compares with the booking: equal, fewer (a shortfall) or more (an over count, D-D5). */
export type CollectionVariance = 'MATCH' | 'SHORT' | 'OVER';

export interface CollectionRecordRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly responsible_hub_id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: CollectionVariance;
  readonly variance_reason_snapshot: VarianceReasonSnapshot | null;
  readonly office_notified_at: string | Date | null;
  readonly handshake_type: 'VENDOR_ENTERED_RIDER_DISPLAYED' | 'SENDER_SMS_RIDER_ENTERED';
  readonly captured_at: string | Date | null;
  readonly recorded_by: string;
}

/** The columns of a collection record read. */
export const COLLECTION_RECORD_COLUMNS: SQL = sql.raw(`
  id, pickup_stop_id, responsible_hub_id, declared_count, collected_count, variance, variance_reason_snapshot, office_notified_at,
  handshake_type, captured_at, recorded_by`);

/** The contract's `CollectionRecord`: what the rider sent as it was kept, and the server's fields. */
export interface CollectionRecordView {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: CollectionVariance;
  readonly variance_reason_code?: string;
  readonly variance_note?: string;
  /** The evidence the count attached beside its reason (the photo of the parcel left behind that a short count's reason may ask for), as the rider named it; absent, and never an empty list, when none was attached. */
  readonly evidence_ids?: readonly string[];
  /** The photos of the parcels counted that **this request named** (D-A10), as the rider named them: the photos it staged beforehand are not repeated; absent, and never an empty list, when it named none. */
  readonly parcel_photo_ids?: readonly string[];
  /** How many parcel photos the count attached, **staged and named together** (D-E1): the count's number of photos, which equals `collected_count`; absent, and never zero, for a stop Ops let through without photos. */
  readonly parcel_photo_count?: number;
  readonly captured_at?: string;
  readonly office_notified_at: string | null;
}

const iso = (value: string | Date | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The record as the contract states it: the members it names and no other, so that what the table keeps beside them (the hub, the rider, the direction
 * of the handshake to come) is never on the wire. The label and the attribution of the reason are the catalogue's and are not repeated to the rider.
 * `parcelPhotoIds` are the photos **the request named**, in the order the rider named them (the record's own row does not hold them: they are links to it); the answer states them as the
 * contract's `CollectionRecord.parcel_photo_ids` declares, and the stored answer that a replay returns carries them with it. **The photos the rider staged beforehand are not listed** (a
 * collection of twenty thousand parcels would otherwise answer with twenty thousand identifiers, the bottleneck of the request turned round): `parcelPhotoCount` is how many the count attached
 * in all, staged and named together (D-E1). None attached (a stop Ops let through without photos) states neither.
 * `evidenceIds` are the other evidence the count attached to the stop beside its reason (the photo of the parcel left behind), in the order the rider named it, stated as the contract's
 * `CollectionRecord.evidence_ids` declares (Run D, Part 2, finding F2: the answer and its replay used to drop them); none attached states none.
 */
export function collectionRecordViewOf(
  row: CollectionRecordRow,
  parcelPhotoIds: readonly string[] = [],
  evidenceIds: readonly string[] = [],
  parcelPhotoCount?: number,
): CollectionRecordView {
  const reason = row.variance_reason_snapshot;
  const captured = iso(row.captured_at);
  return {
    id: row.id,
    pickup_stop_id: row.pickup_stop_id,
    declared_count: row.declared_count,
    collected_count: row.collected_count,
    variance: row.variance,
    ...(reason === null ? {} : { variance_reason_code: reason.reason_code }),
    ...(reason?.note === undefined ? {} : { variance_note: reason.note }),
    ...(evidenceIds.length === 0 ? {} : { evidence_ids: evidenceIds }),
    ...(parcelPhotoIds.length === 0 ? {} : { parcel_photo_ids: parcelPhotoIds }),
    ...(parcelPhotoCount === undefined || parcelPhotoCount === 0
      ? {}
      : { parcel_photo_count: parcelPhotoCount }),
    ...(captured === null ? {} : { captured_at: captured }),
    office_notified_at: iso(row.office_notified_at),
  };
}

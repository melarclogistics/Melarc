import { sql, type SQL } from 'drizzle-orm';

/** The reason of a short count as it is kept on the record: the code and the label as they were (domain-model.md section 3.7), and the note. */
export interface VarianceReasonSnapshot {
  readonly reason_code: string;
  readonly label: string;
  readonly attribution: string;
  readonly note?: string;
}

export interface CollectionRecordRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly responsible_hub_id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: 'MATCH' | 'SHORT';
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
  readonly variance: 'MATCH' | 'SHORT';
  readonly variance_reason_code?: string;
  readonly variance_note?: string;
  readonly captured_at?: string;
  readonly office_notified_at: string | null;
}

const iso = (value: string | Date | null): string | null =>
  value === null ? null : (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * The record as the contract states it: the members it names and no other, so that what the table keeps beside them (the hub, the rider, the direction
 * of the handshake to come) is never on the wire. The label and the attribution of the reason are the catalogue's and are not repeated to the rider.
 */
export function collectionRecordViewOf(row: CollectionRecordRow): CollectionRecordView {
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
    ...(captured === null ? {} : { captured_at: captured }),
    office_notified_at: iso(row.office_notified_at),
  };
}

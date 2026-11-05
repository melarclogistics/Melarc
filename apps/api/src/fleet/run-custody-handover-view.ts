import { createHash } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

export type RunCustodyHandoverState = 'PENDING' | 'COMPLETED' | 'FAILED';

/**
 * A custody handover as the contract states it (`RunCustodyHandover`): the run, the two parties and the destination, the state, the count the
 * receiver took, and the two moments. **It carries no note**: the notes of opening and failing a handover are Ops's own text, kept in the audit
 * trail, and a rider who is a party to the handover is not shown them.
 */
export interface RunCustodyHandoverView {
  readonly id: string;
  readonly manifest_id: string;
  readonly from_rider_id: string;
  readonly to_rider_id: string | null;
  readonly to_hub_id: string | null;
  readonly state: RunCustodyHandoverState;
  readonly parcel_count_taken: number | null;
  readonly initiated_at: string;
  readonly resolved_at: string | null;
}

/** A `run_custody_handover` row as `HANDOVER_COLUMNS` returns it. */
export interface RunCustodyHandoverRow {
  readonly id: string;
  readonly manifest_id: string;
  readonly responsible_hub_id: string;
  readonly from_rider_id: string;
  readonly to_rider_id: string | null;
  readonly to_hub_id: string | null;
  readonly state: RunCustodyHandoverState;
  readonly parcel_count_taken: number | null;
  readonly initiated_at: string | Date;
  readonly resolved_at: string | Date | null;
  readonly version: number;
  /** The moment of opening as the database prints it (microseconds): the position of a page. */
  readonly initiated_at_text: string;
}

export const HANDOVER_COLUMNS: SQL = sql.raw(`
  id, manifest_id, responsible_hub_id, from_rider_id, to_rider_id, to_hub_id, state, parcel_count_taken, initiated_at, resolved_at, version,
  initiated_at::text as initiated_at_text`);

const iso = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/** The handover as the contract states it: the members it names and no other, so that nothing else the row holds can reach the wire. */
export function handoverViewOf(row: RunCustodyHandoverRow): RunCustodyHandoverView {
  return {
    id: row.id,
    manifest_id: row.manifest_id,
    from_rider_id: row.from_rider_id,
    to_rider_id: row.to_rider_id,
    to_hub_id: row.to_hub_id,
    state: row.state,
    parcel_count_taken: row.parcel_count_taken,
    initiated_at: iso(row.initiated_at),
    resolved_at: row.resolved_at === null ? null : iso(row.resolved_at),
  };
}

/**
 * The ETag of a custody handover (S1.24): an opaque strong validator of **what the answer returned** and of the **durable version** of the row
 * (which the database moves for any change to it), made as the manifest's and the stop's are and under a domain of its own, so that the token of
 * one record is never accepted for another kind. `acceptRunCustodyHandover` and `failRunCustodyHandover` compare their `If-Match` with the token
 * recomputed from the handover under its lock.
 */
const DOMAIN = 'melarc.run-custody-handover-etag.v1';
const HANDOVER_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

export function handoverEtagOf(view: RunCustodyHandoverView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const fields: Record<keyof RunCustodyHandoverView, unknown> = {
    id: view.id,
    manifest_id: view.manifest_id,
    from_rider_id: view.from_rider_id,
    to_rider_id: view.to_rider_id,
    to_hub_id: view.to_hub_id,
    state: view.state,
    parcel_count_taken: view.parcel_count_taken,
    initiated_at: view.initiated_at,
    resolved_at: view.resolved_at,
  };
  const digest = createHash('sha256')
    .update(JSON.stringify([DOMAIN, version, ...Object.values(fields)]), 'utf8')
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function handoverEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && HANDOVER_ETAG.test(header) && header === current;
}

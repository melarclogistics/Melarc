import { sql } from 'drizzle-orm';

import { timestampOf } from '../platform/database/timestamps.js';

/**
 * The columns of an intake that a read model may carry **before its count is committed**: every column the application's login holds `SELECT` on (migration `0092`), and the columns
 * `HubIntakePreCount` carries (the contract's shape, which **has no `rider_declared_count` property**). The list is written out on purpose and never `*`: the login has no privilege
 * on the declaration or on what the form was pre-filled with, so a statement that named them would be refused by the database, and a statement that asked for `*` would be too. A read
 * of S1.32 selects from this list.
 */
export const HUB_INTAKE_PRE_COUNT_COLUMNS = sql.raw(
  `id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, handed_over_at, declaration_captured_at, state, active_receiver_id, lock_acquired_at`,
);

/** An intake as the database answers for those columns. */
export interface HubIntakePreCountRow {
  readonly id: string;
  readonly code: string;
  readonly responsible_hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly handed_over_by: string;
  readonly handed_over_at: string | Date;
  readonly declaration_captured_at: string | Date;
  readonly state: string;
  readonly active_receiver_id: string | null;
  readonly lock_acquired_at: string | Date | null;
}

/** The contract's `HubIntakePreCount`: the intake before its count is committed. **It has no `rider_declared_count`, not even for a zero declaration.** */
export interface HubIntakePreCountView {
  readonly id: string;
  readonly code: string;
  readonly state: string;
  readonly hub_id: string;
  readonly pickup_request_id: string;
  readonly pickup_manifest_id: string;
  readonly handed_over_by: string;
  readonly handed_over_at: string;
  readonly declaration_captured_at: string;
  readonly active_receiver_id: string | null;
  readonly lock_acquired_at: string | null;
  readonly count_phase: 'PRE_COUNT';
}

/** The representation of an intake that has not been counted. Built from the named columns of the stored row: nothing else of the row is in it. */
export function hubIntakePreCountOf(row: HubIntakePreCountRow): HubIntakePreCountView {
  return {
    id: row.id,
    code: row.code,
    state: row.state,
    hub_id: row.responsible_hub_id,
    pickup_request_id: row.pickup_request_id,
    pickup_manifest_id: row.pickup_manifest_id,
    handed_over_by: row.handed_over_by,
    handed_over_at: timestampOf(row.handed_over_at).toISOString(),
    declaration_captured_at: timestampOf(row.declaration_captured_at).toISOString(),
    active_receiver_id: row.active_receiver_id,
    lock_acquired_at:
      row.lock_acquired_at === null ? null : timestampOf(row.lock_acquired_at).toISOString(),
    count_phase: 'PRE_COUNT',
  };
}

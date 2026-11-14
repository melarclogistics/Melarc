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

/**
 * Every column the application's login reads of an intake (S1.32): the pre-count columns, the facts of a count that has been committed, the condition and the version (the `ETag`'s
 * source). **Never the declaration**: it is served by one function of the database, only for an intake that has been counted (`melarc.hub_intake_declarations`, migration `0093`).
 */
export const HUB_INTAKE_READ_COLUMNS = sql.raw(
  `id, code, responsible_hub_id, pickup_request_id, pickup_manifest_id, handed_over_by, handed_over_at, declaration_captured_at, state, active_receiver_id, lock_acquired_at, physical_count, count_variance, count_difference, condition, version`,
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

/** An intake as `HUB_INTAKE_READ_COLUMNS` answer for it. */
export interface HubIntakeRow extends HubIntakePreCountRow {
  readonly physical_count: number | null;
  readonly count_variance: string | null;
  readonly count_difference: number | null;
  readonly condition: string;
  readonly version: number;
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

/**
 * The contract's `HubIntakePostCount`: the intake once its physical count is committed, which is the first moment the declaration (and the photos of the parcels counted at the door, D-A10)
 * may appear beside the count (hub-intake.md section 5.1 step 5). `parcel_photo_ids` is there when the stop's count had photos and absent when Ops let the stop through without them. Not
 * here, because the task that decides them has not been built: `condition_findings`, `dispute_state` and `parity_exception_id` (S1.34 and the itemization tasks); they are optional in the
 * contract and are left out, never given a value that no fact supports.
 */
export interface HubIntakePostCountView extends Omit<HubIntakePreCountView, 'count_phase'> {
  readonly count_phase: 'POST_COUNT';
  readonly rider_declared_count: number;
  readonly physical_count: number;
  readonly count_variance: 'MATCH' | 'SHORT' | 'OVER';
  readonly count_difference: number;
  readonly condition: string;
  readonly parcel_photo_ids?: readonly string[];
  readonly condition_findings?: readonly IntakeFindingView[];
}

/** A finding as the database holds it (`pickup_intake_finding`, migration 0096). */
export interface IntakeFindingRow {
  readonly id: string;
  readonly pickup_intake_id: string;
  readonly kind: string;
  readonly condition: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_at: string | Date;
}

/**
 * What was found at an intake after its count (`condition_findings` of the contract's `HubIntakePostCount`): the receiver's recording of a condition and Senior Ops's adjudication, each with the
 * evidence it cites, in the order they were made. A finding explains a discrepancy; it never changes a count.
 */
export interface IntakeFindingView {
  readonly id: string;
  readonly kind: string;
  readonly condition: string | null;
  readonly outcome: string | null;
  readonly note: string | null;
  readonly evidence_ids: readonly string[];
  readonly recorded_by: string;
  readonly recorded_at: string;
}

export const intakeFindingOf = (row: IntakeFindingRow): IntakeFindingView => ({
  id: row.id,
  kind: row.kind,
  condition: row.condition,
  outcome: row.outcome,
  note: row.note,
  evidence_ids: [...row.evidence_ids],
  recorded_by: row.recorded_by,
  recorded_at: timestampOf(row.recorded_at).toISOString(),
});

/** What the database answers for an intake that has been counted, beyond the columns the login can read (`melarc.hub_intake_after_count`, `melarc.commit_blind_count`), and the findings made since. */
export interface AfterCount {
  readonly declared: number;
  /** The stop's stored parcel photos, in the order they were attached; none when Ops let the stop through without them. */
  readonly photoIds: readonly string[];
  /** The findings made after the count, in the order they were made: none until one is. */
  readonly findings?: readonly IntakeFindingView[];
}

export type HubIntakeView = HubIntakePreCountView | HubIntakePostCountView;

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

/**
 * The representation of an intake as it is read (S1.32): **`HubIntakePreCount` until a physical count has been committed, and then `HubIntakePostCount`** (`AC-SLICE-001-37`). The phase is
 * decided by the fact the table holds (a count, which exists exactly when the intake has left `AWAITING_COUNT`), and never by a request or a header. `after` is what the database's
 * function answered for an intake that has been counted: an intake that has not been counted is given none and has no way to carry one, and a counted intake that was given none, or whose
 * comparison is missing, is a fault and not an answer.
 */
export function hubIntakeViewOf(row: HubIntakeRow, after: AfterCount | undefined): HubIntakeView {
  const base = hubIntakePreCountOf(row);
  if (row.physical_count === null) return base;
  if (
    after === undefined ||
    row.count_difference === null ||
    (row.count_variance !== 'MATCH' &&
      row.count_variance !== 'SHORT' &&
      row.count_variance !== 'OVER')
  ) {
    throw new Error(
      'An intake that has been counted is read with its declaration and its comparison',
    );
  }
  return {
    ...base,
    count_phase: 'POST_COUNT',
    rider_declared_count: after.declared,
    physical_count: row.physical_count,
    count_variance: row.count_variance,
    count_difference: row.count_difference,
    condition: row.condition,
    ...(after.photoIds.length === 0 ? {} : { parcel_photo_ids: [...after.photoIds] }),
    ...(after.findings === undefined || after.findings.length === 0
      ? {}
      : { condition_findings: [...after.findings] }),
  };
}

import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../platform/database/database.service.js';

/**
 * The clone of a pickup request (S1.15; pickup-request.md section 5.2, "Reschedule after failure" and "Past the hub booking cutoff";
 * domain-model.md section 6.2, the chain): a new `PENDING` request that is the same booking on another date, linked to the one it
 * replaces. The cancel-plus-clone of a late booking's reschedule (S1.15) and of a failed attempt's (S1.18) are this one insert; they differ
 * in one column only, the attempt number: the same attempt for a late booking (nothing was attempted), the next for a failed one.
 *
 * **Every column of `pickup_request` is in exactly one of the three lists below**, and a test reads the table's columns and fails the day
 * one is added to the table and to none of them: a column a clone silently does not carry (a payer arrangement, an acknowledgement of the
 * liability cap) or silently carries (a charge, a cancellation, a manifest fact) is a defect that no test of the happy path would see.
 */

/** The booking itself: what the sender and Ops arranged, which the clone carries unchanged. */
export const COPIED_COLUMNS = [
  'vendor_organization_id',
  'ad_hoc_sender_id',
  'sender_name',
  'responsible_hub_id',
  'pickup_intent',
  'declared_package_count',
  'one_package_exception_id',
  'pickup_location',
  'resolved_pickup_location',
  'collection_point',
  'collection_reference',
  'collection_item',
  'destination_location_id',
  'vendor_pickup_location_id',
  'primary_phone',
  'secondary_phone',
  'current_item_description',
  'location_overrides',
  'default_payer_intent',
  'split_basis',
  'split_sender_amount_minor',
  'split_sender_percentage',
  'declared_value_minor',
  'liability_cap_acknowledged_at',
  'liability_cap_snapshot',
  'attempt_extension_id',
] as const;

/**
 * What the act decides for the clone: its identity, its place in the chain (its source and its attempt), the day it is for and who made it.
 * The extension a source carries is copied above: it is what lets the one further attempt it allows be confirmed.
 */
export const SET_BY_THE_ACT_COLUMNS = [
  'id',
  'code',
  'scheduled_service_date',
  'replaces_request_id',
  'attempt_number',
  'created_by',
] as const;

/** What starts as it does for any new request (its default, or nothing): the state, the facts of a confirmation or a cancellation, the version. */
export const FRESH_COLUMNS = [
  'state',
  'estimate_snapshot',
  'cutoff_exception_state',
  'replacement_request_id',
  'cancellation_reason_code',
  'cancellation_reason_label',
  'cancelled_by_actor_type',
  'cancellation_charge_outcome',
  'cancellation_charge_snapshot',
  'cancellation_charge_reason_code',
  'cancellation_charge_reason_label',
  'cancellation_charge_waived_by',
  'cancellation_charge_waiver_note',
  'rider_assigned',
  'version',
  'created_at',
  'confirmed_by',
  'confirmed_at',
  'cancelled_by',
  'cancelled_at',
  'escalated_at',
] as const;

export interface ReplacementInput {
  /** The request being replaced. */
  readonly sourceId: string;
  /** The identifier and operational code of the clone. */
  readonly id: string;
  readonly code: string;
  /** The day the clone is for, `YYYY-MM-DD`. */
  readonly serviceDate: string;
  /** Its place in the chain: the source's own attempt (a late booking, which no rider has tried) or the next (a failed attempt's reschedule). */
  readonly attempt: 'SAME' | 'NEXT';
  /** The staff member who made the clone. */
  readonly actor: string;
}

/**
 * Inserts the clone of `sourceId` in the caller's transaction and says whether it did. It does not when the operational code is already
 * in use (the caller draws another and tries again); the source row is read under the caller's own context, so a request that is out of
 * its scope has no clone. The columns are the module's lists above, which are constants and never the caller's text.
 */
export async function insertReplacement(
  tx: DatabaseTransaction,
  input: ReplacementInput,
): Promise<boolean> {
  const copied = sql.raw(COPIED_COLUMNS.join(', '));
  // (A choice of two constants, and never the caller's text.)
  const attempt = sql.raw(input.attempt === 'NEXT' ? 'attempt_number + 1' : 'attempt_number');
  const inserted = await tx.execute(sql`
    insert into pickup_request (id, code, scheduled_service_date, replaces_request_id, created_by, attempt_number, ${copied})
    select ${input.id}::uuid, ${input.code}, ${input.serviceDate}::date, id, ${input.actor}::uuid, ${attempt}, ${copied}
      from pickup_request where id = ${input.sourceId}::uuid
    on conflict (code) do nothing
    returning id`);
  return inserted.rows.length === 1;
}

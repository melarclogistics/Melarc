import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import type { StopSkipSnapshot } from './pickup-manifest-view.js';

/**
 * What the cancellation of a request does to the stop that holds it (S1.20 closeout; the Product Owner's decision of 2 November 2026, on the reviewer's recommendation;
 * state-machines.md section 5; features/pickup/pickup-manifest.md section 6): **the cancellation takes effect at once, whether or not a
 * rider has been told**, so that a rider is never left with a stop for a request that no longer exists.
 *
 * - **The stop is skipped in the transaction that cancels the request**, on a draft manifest and on a dispatched one alike, if it is
 *   still to be worked: a `PENDING` stop or an `ARRIVED` one (the arrival is kept: it is evidence of the visit). The request is cancelled
 *   or it is not, and the stop is skipped or it is not, together.
 * - **The stop keeps its place and its claim.** It stays where it was in the order, and its claim is **not released**: the request is
 *   cancelled and must not return to the pool of requests that can be manifested. Only an explicitly authorized transition releases a claim.
 * - **The reason is the system's, structured, and not the catalogue's.** `REQUEST_CANCELLED` names why the stop was skipped (it is not
 *   one of the reasons Ops chooses when it skips a stop for itself, `skipPickupStop`, S1.23); the cancellation's own reason, note and
 *   charge are on the request and are not copied here, and the note of a cancellation is not shown to the rider.
 * - **A stop already resolved is not touched.** A collected or partly collected stop is custody, a failed stop is a visit that happened,
 *   and a skipped one is already skipped: the cancellation of a request erases none of them and turns none into a skip. What a cancellation
 *   after a collection means for the parcels is not decided here (it is not this operation's to decide) and is a finding for the owner.
 * - **It serialises with whatever else changes the stop.** The stop is locked (`for update`) after the request, which the cancellation
 *   holds, and the skip is judged on the state the lock found: a collection that committed first leaves a stop this skips nothing of, and
 *   a skip that committed first leaves a stop a collection finds resolved and refuses. A rider's act on the stop locks the stop alone
 *   (S1.22: the rider does not read the request, so it has none to lock), so it waits only for a cancellation that holds the request and
 *   is taking the stop, never the other way round; the state the lock found, and not a read of the request, is what refuses it.
 * - **Only the staff of the hub's grant reach it.** The policy of the stop admits this update for `pickup.request.cancel` alone, and a
 *   vendor's cancellation (of a request still `PENDING`, which has no stop) never calls it.
 *
 * The audit of each skipped stop is `pickup.stop.skipped` (`auditSkippedStops`), written after the event of the cancellation that caused
 * it, in the transaction.
 */

/** The code of the skip a cancellation makes: the system's, never a code of the reason catalogue. */
export const REQUEST_CANCELLED = 'REQUEST_CANCELLED';
const REQUEST_CANCELLED_LABEL = 'Request cancelled';

export interface SkippedStop {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly responsible_hub_id: string;
  readonly previous_state: 'PENDING' | 'ARRIVED';
}

interface HeldStop {
  readonly id: string;
  readonly pickup_manifest_id: string;
  readonly responsible_hub_id: string;
  readonly state: 'PENDING' | 'ARRIVED';
}

/**
 * Skips the stop that holds a cancelled request, if it is still to be worked, and returns what it skipped (none or one: a request is held
 * by one unreleased stop at most). To be called in the transaction that cancels the request, after the request is updated, by a staff
 * context that holds `pickup.request.cancel`.
 */
export async function skipStopsOfCancelledRequest(
  handle: TransactionHandle,
  requestId: string,
): Promise<readonly SkippedStop[]> {
  const tx = transactionOf(handle);
  // The lock first, and then the instant: a skip is stamped with a time no earlier than anything that committed to the stop while this waited.
  const held = await tx.execute(sql`
    select id, pickup_manifest_id, responsible_hub_id, state
      from pickup_stop
     where pickup_request_id = ${requestId}::uuid and released_at is null and state in ('PENDING', 'ARRIVED')
     order by id
       for update`);
  const stops = held.rows as unknown as HeldStop[];
  if (stops.length === 0) return [];

  // A stop the rider has counted is not skipped (S1.26): the parcels were taken at the door, and the handshake closes the stop. This is looked for
  // under the stop's lock, so a collection that committed while this waited is seen, and one that commits after is held off by the lock; and the
  // database refuses it for every writer (`pickup_stop_collection_kept`). The whole cancellation is refused: the request stays as it was.
  const counted = await tx.execute(sql`
    select 1 from collection_record where pickup_stop_id in (${sql.join(
      stops.map((stop) => sql`${stop.id}::uuid`),
      sql`, `,
    )}) limit 1`);
  if (counted.rows.length > 0) {
    throw ApiException.of(
      ErrorCode.StateConflict,
      'The pickup has been collected: it is not cancelled',
      { rule: 'collection_recorded' },
    );
  }

  const found = await tx.execute(sql`select clock_timestamp() as instant`);
  const raw = (found.rows[0] as { instant: string | Date } | undefined)?.instant;
  if (raw === undefined) throw new Error('The database gave no time');
  const instant = (raw instanceof Date ? raw : new Date(raw)).toISOString();
  const snapshot: StopSkipSnapshot = {
    reason_code: REQUEST_CANCELLED,
    label: REQUEST_CANCELLED_LABEL,
    skipped_at: instant,
  };

  const skipped: SkippedStop[] = [];
  for (const stop of stops) {
    const updated = await tx.execute(sql`
      update pickup_stop
         set state = 'SKIPPED', resolved_at = ${instant}::timestamptz, skip_snapshot = ${JSON.stringify(snapshot)}::jsonb
       where id = ${stop.id}::uuid and state = ${stop.state}
      returning id`);
    // Under the lock and having read the stop in that state, the update cannot miss it.
    if (updated.rows.length !== 1) throw new Error('A locked stop was not skipped');
    skipped.push({
      id: stop.id,
      pickup_manifest_id: stop.pickup_manifest_id,
      responsible_hub_id: stop.responsible_hub_id,
      previous_state: stop.state,
    });
  }
  return skipped;
}

/** One `pickup.stop.skipped` event for each stop the cancellation of the request skipped, by the actor of the cancellation. */
export async function auditSkippedStops(
  audit: AuditWriter,
  handle: TransactionHandle,
  requestId: string,
  skipped: readonly SkippedStop[],
): Promise<void> {
  for (const stop of skipped) {
    await audit.write(handle, {
      code: 'pickup.stop.skipped',
      enhanced: false,
      outcome: 'SUCCEEDED',
      object: { type: 'PickupStop', id: stop.id },
      responsibleHubId: stop.responsible_hub_id,
      previousState: stop.previous_state,
      resultingState: 'SKIPPED',
      reason: { code: REQUEST_CANCELLED, label: REQUEST_CANCELLED_LABEL },
      relatedIds: { pickup_request_id: requestId, pickup_manifest_id: stop.pickup_manifest_id },
      detail: { cause: 'REQUEST_CANCELLATION' },
    });
  }
}

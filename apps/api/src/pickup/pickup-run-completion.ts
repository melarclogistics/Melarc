import { sql } from 'drizzle-orm';

import type { AuditWriter } from '../platform/auth/ports/audit-writer.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { RunCompletionCause } from '../platform/domain-ports/run-access.port.js';
import type { RunCustody } from '../platform/domain-ports/run-custody.port.js';

/**
 * The completion of a run by the system (S1.23; state-machines.md section 4, "`IN_PROGRESS` → `COMPLETED`, System"; `AC-SLICE-001-78`): a run in
 * progress whose **every stop is terminal, none of them collected, and no custody handover of it pending** is completed at the moment its last
 * stop turns terminal or its last pending handover resolves, with no hub handover and no intake, because nothing was collected (the
 * specification, section 22.2). A run that collected something is closed by the hub
 * handover of the custody holder and never by this.
 *
 * **Who calls it.** Every act that turns a stop terminal in the transaction of that act, once the stop is written: the skip of Ops
 * (`skipPickupStop`) and the cancellation of a request (`cancelPickupRequest`, whose own skip of the stop is one such act), and the
 * two resolutions of a custody handover (S1.24: its acceptance and its failure, in `fleet`). The act that turns a stop terminal in the rider's name, the report of a failure (S1.28), calls it too, under the rider's own key
 * (migration 0072; the cause is `LAST_STOP_FAILED`); the collection never completes a run, because a collected stop makes it one that collected something.
 * The database does not call it for any of them: a trigger that completed a run from inside a stop's update would take the
 * manifest's lock in a place the order of locks below does not allow.
 *
 * **The order of locks, and why it holds.** The acts on a whole manifest (`setManifestStopOrder`, `assignRider`, `cancelPickupManifest`,
 * `dispatchManifest`, `startRun`) lock the manifest, then its requests, then its stops; an act on one stop locks the stop and then, here, the
 * manifest. These do not wait in a circle, because the one place a stop's act waits for a manifest is **a manifest in progress**, and the acts that
 * hold a manifest while they wait for a stop all judge the manifest's state first and refuse (or, for the start, are the transition into progress
 * and lock every stop before they judge what is left). So: (1) the manifest is read **without a lock** and left alone unless it is in progress;
 * a run that is not in progress cannot become one without the start, and the start waits for this act's stop, and judges the stops it finds when it
 * gets them, so a pickup resolved here is a pickup the start does not count; (2) a run that is in progress stays in progress while this act's
 * stop is still to be worked (the manifest's guard refuses its completion), so it is locked only now, after the stop, and the reading of its
 * stops is taken after the lock, in a statement of its own, so that a second act that resolved the run's other stop and committed first is
 * seen. Two acts that resolve the last two stops of one run therefore end as one serial order would, and the run is completed exactly once.
 */

export interface CompletedRun {
  readonly manifestId: string;
}

/** What the completion needs besides the transaction: the ledger, and the custody domain's answer (a port) to whether a handover is pending. */
export interface RunCompletionDependencies {
  readonly audit: AuditWriter;
  readonly custody: RunCustody;
}

interface ManifestFacts {
  readonly id: string;
  readonly state: string;
  readonly responsible_hub_id: string;
  readonly assigned_rider_id: string | null;
}

interface StopCounts {
  readonly to_work: string | number;
  readonly collected: string | number;
}

/**
 * Completes the run if it is in progress with nothing left to work and nothing collected, and says whether it did. To be called in the
 * transaction of the act that turned a stop of it terminal, by a context whose key the manifest's policy and guard admit for the completion
 * (`pickup.stop.skip`, `pickup.request.cancel`; migration 0066).
 */
export async function completeRunIfSettled(
  { audit, custody }: RunCompletionDependencies,
  handle: TransactionHandle,
  manifestId: string,
  cause: RunCompletionCause,
): Promise<CompletedRun | undefined> {
  const tx = transactionOf(handle);

  // Read without a lock first: a run that is not in progress is none of this function's, and it must not be locked from here (see above).
  const seen = await tx.execute(
    sql`select state from pickup_manifest where id = ${manifestId}::uuid`,
  );
  if ((seen.rows[0] as { state: string } | undefined)?.state !== 'IN_PROGRESS') return undefined;

  const locked = await tx.execute(sql`
    select id, state, responsible_hub_id, assigned_rider_id from pickup_manifest where id = ${manifestId}::uuid for update`);
  const manifest = locked.rows[0] as unknown as ManifestFacts | undefined;
  if (manifest?.state !== 'IN_PROGRESS') return undefined;

  // The stops as they are now, after the lock: in a statement of their own, so that an act that committed while this waited is counted.
  const counted = await tx.execute(sql`
    select count(*) filter (where state in ('PENDING', 'ARRIVED')) as to_work,
           count(*) filter (where state in ('COLLECTED', 'PARTIALLY_COLLECTED')) as collected
      from pickup_stop where pickup_manifest_id = ${manifest.id}::uuid`);
  const counts = counted.rows[0] as unknown as StopCounts;
  if (Number(counts.to_work) > 0 || Number(counts.collected) > 0) return undefined;

  // A custody handover still pending holds the run until it resolves (state-machines.md section 4), so a run never closes over an open custody
  // record. It is asked of the custody domain through its port, in this transaction and **after the run's lock is held**: the acts that change a
  // run's custody take the run's lock first, so the answer cannot change under this completion. This file imports nothing of `fleet`.
  if (await custody.hasPendingHandover(handle, manifest.id)) return undefined;

  // The lock first, and then the instant: the completion is stamped no earlier than anything that committed to the run while this waited.
  const completed = await tx.execute(sql`
    update pickup_manifest set state = 'COMPLETED', completed_at = clock_timestamp()
     where id = ${manifest.id}::uuid and state = 'IN_PROGRESS'
    returning id`);
  // Under the lock and having read the run as in progress, the update cannot miss it.
  if (completed.rows.length !== 1) throw new Error('A locked run in progress was not completed');

  await audit.write(handle, {
    code: 'pickup.manifest.completed',
    enhanced: false,
    outcome: 'SUCCEEDED',
    object: { type: 'PickupManifest', id: manifest.id },
    responsibleHubId: manifest.responsible_hub_id,
    previousState: 'IN_PROGRESS',
    resultingState: 'COMPLETED',
    relatedIds: manifest.assigned_rider_id === null ? {} : { rider_id: manifest.assigned_rider_id },
    detail: { completed_by: 'SYSTEM', cause },
  });
  return { manifestId: manifest.id };
}

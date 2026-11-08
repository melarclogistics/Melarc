import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { pickupManifestEtagMatches, pickupManifestEtagOf } from './pickup-manifest-etag.js';
import {
  MANIFEST_COLUMNS,
  STOP_COLUMNS,
  manifestViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
} from './pickup-manifest-view.js';

export interface LoadedManifest {
  readonly row: PickupManifestRow;
  /** The stops in the order of their sequence. */
  readonly stops: readonly PickupStopRow[];
  readonly view: PickupManifestView;
  /** The ETag of exactly this representation and version: what a read answers and what a mutation compares `If-Match` with. */
  readonly etag: string;
}

/**
 * A pickup manifest as `getPickupManifest` answers it, with its stops and its ETag (S1.21). **The one place a mutation makes a view and its
 * ETag from the rows**, so that the token a read hands out and the token a mutation recomputes under the manifest's lock cannot drift apart:
 * a client that read a manifest and sends its ETag back is compared with the very same function of the very same rows.
 *
 * `lock` takes the manifest's lock (`for update`), so that the planning acts on one manifest (ordering, assigning, cancelling) are put in a
 * line and the second reads what the first left; the stops are read after it, so the token a mutation judges is the manifest as it is under
 * the lock. **The stops are not locked here**: a stop is also changed by the cancellation of its request, which locks the request and then
 * the stop and never the manifest, and the statements that change stops judge each stop's state when they run. A stop that changes between
 * the read and the write moves the token for the next caller, and the statements below are written so that it cannot be written over.
 * The caller's own context decides what it can see: a manifest that is out of its scope is not found.
 *
 * `lockStops` takes the stops' locks too, in the order of their sequence, after the manifest's and before they are read, **for a draft or a
 * dispatched manifest only**. The acts that need it judge the stops they find and then write them: the ordering (`setManifestStopOrder`) and the
 * start of a run (`startRun`), which must never act on a stop that an act in flight has resolved (an ordering that read a stop as pending and
 * then met it skipped was answered with a failure by the stop's guard; a run started past a pickup that was being resolved would be in progress
 * with nothing to work). **Why only these two states.** A stop that turns terminal in a run in progress takes the manifest's lock after its own
 * (`pickup-run-completion.ts`), so an act that held the manifest and waited for such a stop could meet one that holds the stop and waits for the
 * manifest, and neither would move. In a draft or a dispatched manifest no act on a stop ever asks for the manifest afterwards (the completion
 * reads the state without a lock and goes no further), so waiting for a stop while holding the manifest cannot form a circle.
 */
export async function loadManifest(
  handle: TransactionHandle,
  id: string,
  options: { readonly lock?: boolean; readonly lockStops?: boolean } = {},
): Promise<LoadedManifest | undefined> {
  const tx = transactionOf(handle);
  const found = await tx.execute(
    options.lock === true
      ? sql`select ${MANIFEST_COLUMNS} from pickup_manifest where id = ${id}::uuid for update`
      : sql`select ${MANIFEST_COLUMNS} from pickup_manifest where id = ${id}::uuid`,
  );
  const row = found.rows[0] as unknown as PickupManifestRow | undefined;
  if (row === undefined) return undefined;
  const stopRows = await tx.execute(
    options.lockStops === true && (row.state === 'DRAFT' || row.state === 'DISPATCHED')
      ? sql`select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${row.id}::uuid order by sequence, id for update`
      : sql`select ${STOP_COLUMNS} from pickup_stop where pickup_manifest_id = ${row.id}::uuid order by sequence, id`,
  );
  const stops = stopRows.rows as unknown as PickupStopRow[];
  const view = manifestViewOf(row, stops);
  return { row, stops, view, etag: pickupManifestEtagOf(view, row.version) };
}

/**
 * `If-Match` is exactly the ETag of the manifest as it is now, under its lock: one strong quoted token of the form the reads hand out and
 * equal to the recomputed one. Missing, weak, a list, `*`, another manifest's and a stale one are all the same answer, `STATE_CONFLICT`:
 * the caller read a manifest that is not the one that is there.
 */
export function requireCurrentManifest(
  ifMatch: string | undefined,
  loaded: Pick<LoadedManifest, 'etag'>,
): void {
  if (!pickupManifestEtagMatches(ifMatch, loaded.etag)) {
    throw ApiException.of(ErrorCode.StateConflict, 'The manifest has changed since it was read');
  }
}

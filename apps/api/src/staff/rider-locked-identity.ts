import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { riderEtagMatches, riderEtagOf } from './rider-etag.js';
import {
  RIDER_COLUMNS,
  RIDER_SOURCE,
  devicesOfRider,
  generationOf,
  viewOf,
  type RiderDeviceView,
  type RiderRow,
  type RiderView,
} from './rider-view.js';

/** What `melarc.rider_locked_facts` (migration 0040) answers for the rider an administrative act on a device has locked. */
export interface LockedRiderFacts {
  readonly rider_id: string;
  readonly status: string;
  readonly primary_hub_id: string;
  readonly pin_established: boolean;
  readonly credential_generation: number;
  /** The id of the `ACTIVE` device, if the rider has one (the database holds that there is at most one). */
  readonly active_device_id: string | null;
  readonly active_devices: number;
  readonly revoked_devices: number;
  readonly replaced_devices: number;
}

export interface LockedRider {
  readonly row: RiderRow;
  readonly facts: LockedRiderFacts;
  readonly view: RiderView;
  readonly devices: readonly RiderDeviceView[];
  /** The ETag of the rider as `getRider` would answer it now: what `If-Match` is compared with. */
  readonly etag: string;
}

/**
 * Locks a rider for an administrative act on its device and reads it again under the lock (S0.53b, S0.53c, S0.58): the facts through
 * `melarc.rider_locked_facts`, which refuses any key but the three device keys, locks only a rider the caller's scope shows
 * (`FOR NO KEY UPDATE`, the identity lock the sign-in and the enrolment take, so every writer of the rider's PIN or devices is ordered
 * against it) and binds the transaction to it (the arms of the grant, the device and the session are bound to that rider); then the
 * rider and its devices in the caller's own context, and the view and the ETag **built as the read builds them**, so that `If-Match` is
 * compared with what the caller was shown. A rider that has gone since the guard found it is `NOT_FOUND`.
 */
export async function lockRider(handle: TransactionHandle, id: string): Promise<LockedRider> {
  const database = transactionOf(handle);
  const locked = await database.execute(sql`select * from melarc.rider_locked_facts(${id}::uuid)`);
  const facts = locked.rows[0] as unknown as LockedRiderFacts | undefined;
  if (facts === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
  const found = await database.execute(
    sql`select ${RIDER_COLUMNS} from ${RIDER_SOURCE} where r.id = ${id}::uuid`,
  );
  const row = found.rows[0] as unknown as RiderRow | undefined;
  if (row === undefined) {
    throw new Error('A rider was locked and could not be read in the same scope');
  }
  const view = viewOf(row);
  const devices = await devicesOfRider(handle, id);
  return { row, facts, view, devices, etag: riderEtagOf(view, devices, generationOf(row)) };
}

/** The version the caller acts on is the one it read; anything else, a missing header included, is `STATE_CONFLICT`. */
export function requireRiderVersion(header: string | undefined, current: string): void {
  if (!riderEtagMatches(header, current)) {
    throw ApiException.of(ErrorCode.StateConflict, 'The rider has changed since it was read');
  }
}

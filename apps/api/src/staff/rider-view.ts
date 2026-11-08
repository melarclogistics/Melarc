import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * A rider as the reads answer it (`RiderSummary`, `RiderDetail`, `RegisteredDevice`; domain-model.md section 6.8): **identity and readiness
 * only**. Who the rider is and where they belong, whether a PIN is established and whether exactly one `ACTIVE` device exists: nothing that
 * is a PIN, a hash, a key, a failed-attempt count or a lock, and nothing about the rider's work. The administrative acts (S0.53b, S0.53c,
 * S0.58) build the same view from the same columns, so the ETag they recompute under the rider's lock is the one the read gave.
 *
 * The rider tables are the staff domain's (plan section 3, placement); `dispatch` reads them through these helpers and holds no table of
 * its own, so there is no second identity store and no duplicated logic.
 */
export interface RiderView {
  readonly id: string;
  readonly full_name: string;
  readonly phone: string;
  readonly status: string;
  readonly primary_hub_id: string;
  readonly pin_established: boolean;
  readonly has_active_device: boolean;
}

/** A device the rider has held. Neither the key nor anything that could stand for it is a column the runtime can select. */
export interface RiderDeviceView {
  readonly id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly device_kind: string;
  readonly status: string;
  readonly registered_at: string;
  readonly registered_by: string | null;
}

/** The columns of a rider a representation is made of, with the credential generation (the ETag's) and the moment a page position uses. */
export interface RiderRow {
  readonly id: string;
  readonly full_name: string;
  readonly phone: string;
  readonly status: string;
  readonly primary_hub_id: string;
  readonly pin_established: boolean;
  readonly has_active_device: boolean;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
  readonly created_at_text: string;
}

/** `r` is `rider_identity`: the statement that reads it names it so. */
export const RIDER_COLUMNS = sql.raw(
  `r.id, r.full_name, r.phone, r.status, r.primary_hub_id, (r.pin_established_at is not null) as pin_established,
   exists (select 1 from registered_device d where d.rider_identity_id = r.id and d.status = 'ACTIVE') as has_active_device,
   r.credential_generation, r.created_at::text as created_at_text`,
);

export const RIDER_SOURCE = sql.raw(`rider_identity r`);

export function viewOf(row: RiderRow): RiderView {
  return {
    id: row.id,
    full_name: row.full_name,
    phone: row.phone,
    status: row.status,
    primary_hub_id: row.primary_hub_id,
    pin_established: row.pin_established,
    has_active_device: row.has_active_device,
  };
}

export function generationOf(row: Pick<RiderRow, 'credential_generation'>): number {
  const generation = Number(row.credential_generation);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('A credential generation is a whole number, zero or more');
  }
  return generation;
}

/** Every device a rider has held, `REVOKED` and `REPLACED` included, newest first (then by id, so the order is total). */
export async function devicesOfRider(
  handle: TransactionHandle,
  riderId: string,
): Promise<RiderDeviceView[]> {
  const result = await transactionOf(handle).execute(
    sql`select id, principal_type, principal_id, device_kind, status, registered_at, registered_by
          from registered_device
         where principal_type = 'RIDER' and rider_identity_id = ${riderId}::uuid
         order by registered_at desc, id`,
  );
  const rows = result.rows as unknown as (Omit<RiderDeviceView, 'registered_at'> & {
    readonly registered_at: Date | string;
  })[];
  return rows.map((row) => ({
    id: row.id,
    principal_type: row.principal_type,
    principal_id: row.principal_id,
    device_kind: row.device_kind,
    status: row.status,
    registered_at: new Date(row.registered_at).toISOString(),
    registered_by: row.registered_by,
  }));
}

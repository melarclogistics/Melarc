import { sql, type SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import type { LocationView, OnePackageExceptionView } from './pickup-request-view.js';

/**
 * The one-package exception as a request reads it (S1.16; the contract's `OnePackageException`; domain-model.md section 6.2), made from a
 * row of `one_package_exception`. It carries the recipient and the fee that became due as the approval snapshotted it (an amount, never a
 * pointer to the setting), and nothing that is a price of the parcel.
 */
export interface FeeSnapshot {
  readonly amount_minor: number;
  readonly setting_key: string;
  readonly effective_version: string;
}

export interface ExceptionRow {
  readonly id: string;
  readonly pickup_request_id: string;
  readonly state: OnePackageExceptionView['state'];
  readonly requested_by: string;
  readonly requested_at: string | Date;
  readonly approved_by: string | null;
  readonly decided_at: string | Date | null;
  readonly note: string;
  readonly recipient_name: string;
  readonly recipient_phone: string;
  readonly recipient_location: LocationView;
  readonly single_package_fee_snapshot: FeeSnapshot | null;
}

/** The columns a read selects, qualified `e.` for the joins that ask for them. */
export const EXCEPTION_COLUMNS: SQL = sql.raw(
  `e.id, e.pickup_request_id, e.state, e.requested_by, e.requested_at, e.approved_by, e.decided_at, e.note, e.recipient_name,
   e.recipient_phone, e.recipient_location, e.single_package_fee_snapshot`,
);

const iso = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

export function exceptionViewOf(row: ExceptionRow): OnePackageExceptionView {
  return {
    id: row.id,
    state: row.state,
    requested_by: row.requested_by,
    requested_at: iso(row.requested_at),
    approved_by: row.approved_by,
    decided_at: row.decided_at === null ? null : iso(row.decided_at),
    note: row.note,
    recipient: {
      name: row.recipient_name,
      phone: row.recipient_phone,
      location: row.recipient_location,
    },
    single_package_fee:
      row.single_package_fee_snapshot === null
        ? null
        : { amount_minor: row.single_package_fee_snapshot.amount_minor, currency: 'GHS' },
  };
}

/**
 * The exception each request shows. **The one it carries** (`one_package_exception_id`, which an approval sets and a clone inherits, so
 * the approval travels with the booking), and failing that the latest one raised for it (a requested one, or a refused one). A request
 * with neither has none. The caller's own context decides what it can see: an exception whose request it cannot read is not found.
 */
export async function exceptionsShownFor(
  handle: TransactionHandle,
  requestIds: readonly string[],
): Promise<ReadonlyMap<string, ExceptionRow>> {
  if (requestIds.length === 0) return new Map();
  const found = await transactionOf(handle).execute(sql`
    select distinct on (r.id) r.id as shown_for, ${EXCEPTION_COLUMNS}
      from pickup_request r
      join one_package_exception e on e.id = r.one_package_exception_id or e.pickup_request_id = r.id
     where r.id = any(${`{${requestIds.join(',')}}`}::uuid[])
     order by r.id, (e.id = r.one_package_exception_id) desc, e.requested_at desc, e.id desc`);
  return new Map(
    (found.rows as unknown as (ExceptionRow & { shown_for: string })[]).map((row) => [
      row.shown_for,
      row,
    ]),
  );
}

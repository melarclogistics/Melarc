import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { vendorAccountEtagMatches, vendorAccountEtagOf } from './vendor-account-etag.js';
import {
  ACCOUNT_COLUMNS,
  ACCOUNT_SOURCE,
  devicesOf,
  viewOf,
  type AccountRow,
  type RegisteredDeviceView,
  type VendorAccountView,
} from './vendor-account-view.js';

/** What `melarc.vendor_locked_facts` (migration 0034) answers for the account an administrative act has locked. */
export interface LockedVendorFacts {
  readonly vendor_account_id: string;
  readonly account_status: string;
  readonly organization_status: string;
  readonly credential_established: boolean;
  readonly credential_generation: number;
  readonly has_recovery_email: boolean;
  readonly has_recovery_phone: boolean;
  readonly delivery_channel: 'EMAIL' | 'PHONE' | null;
  /** The registered address of the delivery channel: for the act to queue its message to, and for nothing else. Never returned. */
  readonly delivery_destination: string | null;
}

export interface LockedVendorAccount {
  readonly row: AccountRow;
  readonly facts: LockedVendorFacts;
  readonly view: VendorAccountView;
  readonly devices: readonly RegisteredDeviceView[];
  /** The ETag of the account as `getVendorAccount` would answer it now: what `If-Match` is compared with. */
  readonly etag: string;
}

/**
 * Locks a vendor account's credential for an administrative act and reads it again under the lock (S0.47b, S0.51): the facts through
 * `melarc.vendor_locked_facts`, which refuses any key but the two administrative ones, locks only an account the caller's scope shows and
 * binds the transaction to it (the arms of the grant and the message are bound to that account); then the account, its organisation and
 * its browsers in the caller's own context, and the view and the ETag **built as the read builds them**, so that `If-Match` is compared
 * with what the caller was shown. An account that has gone since the guard found it is `NOT_FOUND`.
 */
export async function lockVendorAccount(
  handle: TransactionHandle,
  id: string,
): Promise<LockedVendorAccount> {
  const database = transactionOf(handle);
  const locked = await database.execute(sql`select * from melarc.vendor_locked_facts(${id}::uuid)`);
  const facts = locked.rows[0] as unknown as LockedVendorFacts | undefined;
  if (facts === undefined) throw ApiException.of(ErrorCode.NotFound, 'Not found');
  const found = await database.execute(
    sql`select ${ACCOUNT_COLUMNS} from ${ACCOUNT_SOURCE} where a.id = ${id}::uuid`,
  );
  const row = found.rows[0] as unknown as AccountRow | undefined;
  if (row === undefined)
    throw new Error('A vendor account was locked and could not be read in the same scope');
  const view = viewOf(row, facts);
  const devices = await devicesOf(handle, id);
  return {
    row,
    facts,
    view,
    devices,
    etag: vendorAccountEtagOf(view, devices, facts.credential_generation),
  };
}

/** The version the caller acts on is the one it read; anything else, a missing header included, is `STATE_CONFLICT`. */
export function requireVendorVersion(header: string | undefined, current: string): void {
  if (!vendorAccountEtagMatches(header, current)) {
    throw ApiException.of(ErrorCode.StateConflict, 'The account has changed since it was read');
  }
}

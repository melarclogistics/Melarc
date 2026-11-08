import { sql } from 'drizzle-orm';

import {
  decideMfaResetState,
  loadLockedFacts,
  type ResetFacts,
} from '../platform/auth/mfa/mfa-reset-state.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { transactionOf } from '../platform/database/transaction-handle.js';
import { ApiException } from '../platform/http/api-exception.js';
import { ErrorCode } from '../platform/http/error-codes.js';
import { staffIdentityEtagMatches, staffIdentityEtagOf } from './staff-identity-etag.js';
import {
  IDENTITY_COLUMNS,
  viewOf,
  type IdentityRow,
  type StaffIdentityView,
} from './staff-identity-view.js';

/**
 * The staff identity a mutation holds the lock of, as the reads would answer it (S0.36, S0.37): the row, the facts read under the lock
 * (`melarc.staff_locked_facts`), the representation they make and its ETag. The function takes the identity's `FOR NO KEY UPDATE` lock
 * in the caller's own context and scope, at READ COMMITTED, under the key of the operation; this reads the row after it and builds the
 * representation with the rule the reads use, so the ETag recomputed here is the one the read gave. An identity outside the caller's
 * scope, or gone, is `NOT_FOUND` (the guard has already told a scope from an absence before the transaction opened).
 */
export interface LockedIdentity {
  readonly row: IdentityRow;
  readonly facts: ResetFacts;
  readonly view: StaffIdentityView;
  readonly etag: string;
}

export async function lockStaffIdentity(
  handle: TransactionHandle,
  id: string,
): Promise<LockedIdentity> {
  const facts = await loadLockedFacts(handle, id);
  if (facts === null) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
  const found = await transactionOf(handle).execute(
    sql`select ${IDENTITY_COLUMNS} from staff_identity where id = ${id}::uuid`,
  );
  const row = found.rows[0] as unknown as IdentityRow | undefined;
  if (row === undefined) throw ApiException.of(ErrorCode.NotFound, 'Resource not found');
  const view = viewOf(row, {
    mfaEnrolled: facts.hasActiveFactor,
    resetState: decideMfaResetState(facts),
  });
  return { row, facts, view, etag: staffIdentityEtagOf(view, row.version) };
}

/** The version a mutation acts on: the `If-Match` it carries must be exactly the ETag of the locked identity, or the answer is `STATE_CONFLICT`. */
export function requireVersion(header: string | undefined, current: string): void {
  if (!staffIdentityEtagMatches(header, current)) {
    throw ApiException.of(ErrorCode.StateConflict, 'The profile has changed since it was read');
  }
}

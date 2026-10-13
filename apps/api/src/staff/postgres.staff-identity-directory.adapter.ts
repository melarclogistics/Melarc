import { sql, type SQL } from 'drizzle-orm';

import type {
  IdentityDirectory,
  PrincipalRef,
  PrincipalSummary,
} from '../platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * A lookup this adapter cannot answer because the identities it would search are not built yet: a vendor account (the vendor domain)
 * and a rider (the rider tasks). It fails and says so, and never answers "no such account": a success stub would sign nobody in and
 * also hide that nothing could have been found.
 */
export class IdentityDirectoryNotBuiltError extends Error {
  constructor(readonly what: 'vendor account' | 'rider') {
    super(`The ${what} directory is not built: no ${what} can be looked up yet`);
    this.name = 'IdentityDirectoryNotBuiltError';
  }
}

interface StaffIdentityColumns {
  readonly id: string;
  readonly status: string;
  readonly role_bundle_id: string;
  readonly primary_hub_id: string | null;
  readonly credential_established_at: Date | string | null;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
}

// The columns are named: the hash is not among those the runtime may read (migration 0016), and `select *` would be refused.
const SELECT = sql`select id, status, role_bundle_id, primary_hub_id, credential_established_at, credential_generation from staff_identity`;

function generationOf(value: number | string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('A credential generation is a whole number, zero or more');
  }
  return generation;
}

function summaryOf(row: StaffIdentityColumns): PrincipalSummary {
  return {
    ref: { type: 'STAFF', id: row.id },
    status: row.status,
    credentialGeneration: generationOf(row.credential_generation),
    credentialEstablishedAt:
      row.credential_established_at === null ? null : timestampOf(row.credential_established_at),
    bundleId: row.role_bundle_id,
    // Primary membership only: the effective assignments (HubAssignment, §5.8) are added by the task that builds them.
    authorizedHubIds: row.primary_hub_id === null ? [] : [row.primary_hub_id],
  };
}

function staffRef(ref: PrincipalRef): string {
  if (ref.type !== 'STAFF')
    throw new IdentityDirectoryNotBuiltError(ref.type === 'VENDOR' ? 'vendor account' : 'rider');
  return ref.id;
}

/**
 * The staff `IdentityDirectory` over PostgreSQL (S0.24; SOLUTION_ARCHITECTURE.md §5, "domains own their persistence adapters"): the
 * first adapter a domain provides, in `src/staff/`, over the minimal `staff_identity` table. It joins the caller's transaction, which
 * the sign-in and the session-issue protocol open under the `authentication` capability (the only context row-level security lets
 * read this table before a principal exists), and it opens none.
 *
 * - **Finders take the canonical identifier** and look up by it as a value. There is no list and no scan, which is the interface
 *   that bounds what the `authentication` capability can reach (the registry: "the credential repository port exposes by-key
 *   lookups and no list or scan method"). A `REJECTED` profile has released its address and is not found by it.
 * - **`readIdentity` takes no lock** and is only a hint: it is the discovery read of a policy-locked operation.
 * - **`lockIdentity` takes the identity row lock** (`FOR NO KEY UPDATE`: the second of the lock order, policy, identity, session,
 *   business) and reads the row again under it, so a decision about the principal is made on the state the lock protects. The lock
 *   needs an `UPDATE` privilege on at least one column, which the API holds on the two credential columns (migration 0016). It
 *   releases with the transaction.
 * - **The summary carries what a decision needs and nothing it could use to read the record**: the status, whether a credential
 *   is established (never the hash), the bundle a session snapshots and the hubs the principal is limited to.
 * - Vendor accounts and riders are not built: their lookups throw `IdentityDirectoryNotBuiltError`.
 */
export class PostgresStaffIdentityDirectory implements IdentityDirectory {
  async findStaffByCanonicalEmail(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<PrincipalSummary | null> {
    return this.#one(
      transaction,
      sql`${SELECT} where work_email_canonical = ${canonicalEmail} and status <> 'REJECTED'`,
    );
  }

  findVendorAccountByIdentifier(): Promise<PrincipalSummary | null> {
    return Promise.reject(new IdentityDirectoryNotBuiltError('vendor account'));
  }

  findRiderByCanonicalPhone(): Promise<PrincipalSummary | null> {
    return Promise.reject(new IdentityDirectoryNotBuiltError('rider'));
  }

  async readIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where id = ${staffRef(ref)}`);
  }

  async lockIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where id = ${staffRef(ref)} for no key update`);
  }

  async #one(transaction: TransactionHandle, statement: SQL): Promise<PrincipalSummary | null> {
    const result = await transactionOf(transaction).execute(statement);
    const row = result.rows[0] as unknown as StaffIdentityColumns | undefined;
    return row === undefined ? null : summaryOf(row);
  }
}

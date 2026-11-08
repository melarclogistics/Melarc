import { sql, type SQL } from 'drizzle-orm';

import type {
  FailedAttempt,
  IdentityDirectory,
  LockoutPolicy,
  PrincipalRef,
  PrincipalSummary,
  RegisteredChannel,
  SignInCandidate,
} from '../platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import { timestampOf } from '../platform/database/timestamps.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/**
 * A lookup this adapter cannot answer because the identities it would search are another directory's: a vendor account (the vendor
 * domain) and a rider (the rider directory). It fails and says so, and never answers "no such account": a success stub would sign nobody
 * in and also hide that the question was put to the wrong directory.
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
  readonly origin: 'BOOTSTRAP' | 'MAKER_CHECKER';
  readonly credential_established_at: Date | string | null;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
}

// The columns are named: the hash is not among those the runtime may read (migration 0016), and `select *` would be refused.
const SELECT = sql`select id, status, role_bundle_id, primary_hub_id, origin, credential_established_at, credential_generation from staff_identity`;

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
    origin: row.origin,
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
 * - **The credential's failed-attempt count and lock time (S0.32)** are written by two statements and read by none that returns
 *   them: `recordFailedAttempt` (one atomic conditional update that adds one unless a lock is in force) and `clearFailedAttempts`;
 *   the sign-in's lookup says only whether a lock is in force now, on the database's clock. Setting a credential clears both.
 * - **The summary carries what a decision needs and nothing it could use to read the record**: the status, whether a credential
 *   is established (never the hash), the bundle a session snapshots and the hubs the principal is limited to.
 * - A rider is the rider directory's (`postgres.rider-identity-directory.adapter.ts`, S0.53) and a vendor account the vendor directory's
 *   (S0.47): the router of `platform/auth` sends them there, and asked of this adapter anyway, a rider or a vendor throws
 *   `IdentityDirectoryNotBuiltError`, never "no such principal".
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

  /**
   * One conditional update of the three credential columns, the only columns the API may write: the hash, the moment (the database's
   * clock) and the generation, from 0 to 1 (the table's guard holds it to one step, and its check holds the three together). The
   * `credential_generation = 0` condition is what makes it a setup and not a replacement. The identity lock is the caller's.
   */
  async establishCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = staffRef(ref);
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is established from the encoded hash of a password: 1 to 1024 characters',
      );
    }
    const result = await transactionOf(transaction).execute(sql`
      update staff_identity
         set credential_hash = ${encodedHash}, credential_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1,
             failed_attempt_count = 0, locked_until = null
       where id = ${id}::uuid and credential_generation = 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  async accountLabel(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select work_email from staff_identity where id = ${staffRef(ref)}::uuid`,
    );
    const row = result.rows[0] as unknown as { work_email: string } | undefined;
    return row === undefined ? null : row.work_email;
  }

  /**
   * The identity a sign-in's canonical work email names, and whether its lock is in force: `locked_until` is judged against the
   * database's clock in the same statement that reads the row, so a lock that has just run out is no lock and the application's clock
   * is never consulted. The columns are named (the hash is not readable by the runtime) and the count and the moment are not returned.
   */
  async findStaffForSignIn(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<SignInCandidate | null> {
    const result = await transactionOf(transaction).execute(sql`
      select id, status, role_bundle_id, primary_hub_id, origin, credential_established_at, credential_generation,
             (locked_until is not null and locked_until > clock_timestamp()) as locked
        from staff_identity
       where work_email_canonical = ${canonicalEmail} and status <> 'REJECTED'`);
    const row = result.rows[0] as unknown as
      (StaffIdentityColumns & { locked: boolean }) | undefined;
    return row === undefined ? null : { summary: summaryOf(row), locked: row.locked };
  }

  /** A lock is in force while `locked_until` is in the future on the database's clock; one that has run out is no lock. */
  async isCredentialLocked(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    const result = await transactionOf(transaction).execute(sql`
      select (locked_until is not null and locked_until > clock_timestamp()) as locked
        from staff_identity where id = ${staffRef(ref)}::uuid`);
    const row = result.rows[0] as unknown as { locked: boolean } | undefined;
    return row?.locked === true;
  }

  /** The hash comes from `melarc.staff_credential_hash`, which refuses every context but the authentication capability's (migration 0016). */
  async readCredentialHash(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select melarc.staff_credential_hash(${staffRef(ref)}::uuid) as hash`,
    );
    const row = result.rows[0] as unknown as { hash: string | null } | undefined;
    return row?.hash ?? null;
  }

  /**
   * One conditional update (SECURITY_DESIGN.md §13.4b, "Concurrency"): the row is changed only if no lock is in force, and the new
   * count and the lock are worked out from the row as it is **when the update runs**, after any wait for another transaction's lock
   * on it, so concurrent failures each add one and the threshold cannot be stepped over. The lock is judged on the database's clock
   * (`clock_timestamp()`, read where the row is judged and not at the statement's start). A lock that has run out is no lock: the count
   * starts again from one. The statement returns the row it wrote; no row means that nothing was counted, and a second read says why:
   * the credential is locked, or it is **not the one the attempt was made against** (the identity holds another generation now, can
   * no longer sign in, or is not there). The row is changed only while it holds `generation` and is `ACTIVE`, in the same statement
   * that judges the lock, so a replacement that committed while a verification was running cannot be given the old attempt's count
   * (the audit of 21 October 2026, A03).
   */
  async recordFailedAttempt(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    policy: LockoutPolicy,
  ): Promise<FailedAttempt> {
    const id = staffRef(ref);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError('A credential generation is a whole number of one or more');
    }
    const { maxAttempts, lockoutMinutes } = policy;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError(
        'The most failed attempts before a lock is a whole number of one or more',
      );
    }
    if (!Number.isSafeInteger(lockoutMinutes) || lockoutMinutes < 1) {
      throw new TypeError('A lock lasts a whole number of minutes, one or more');
    }
    const result = await transactionOf(transaction).execute(sql`
      update staff_identity s
         set failed_attempt_count = case when s.locked_until is not null then 1 else s.failed_attempt_count + 1 end,
             locked_until = case
               when (case when s.locked_until is not null then 1 else s.failed_attempt_count + 1 end) >= ${maxAttempts}::int
               then clock_timestamp() + make_interval(mins => ${lockoutMinutes}::int)
               else null end
       where s.id = ${id}::uuid and s.credential_generation = ${generation}::bigint and s.status = 'ACTIVE'
         and (s.locked_until is null or s.locked_until <= clock_timestamp())
      returning s.failed_attempt_count, s.locked_until`);
    const row = result.rows[0] as unknown as
      { failed_attempt_count: number; locked_until: Date | string | null } | undefined;
    if (row === undefined) {
      const holds = await transactionOf(transaction).execute(sql`
        select (credential_generation = ${generation}::bigint and status = 'ACTIVE') as current
          from staff_identity where id = ${id}::uuid`);
      const current = (holds.rows[0] as { current: boolean } | undefined)?.current === true;
      return { counted: false, reason: current ? 'LOCKED' : 'STALE' };
    }
    if (row.locked_until === null) {
      return {
        counted: true,
        failedAttemptCount: row.failed_attempt_count,
        tipped: false,
        lockedUntil: null,
      };
    }
    return {
      counted: true,
      failedAttemptCount: row.failed_attempt_count,
      tipped: true,
      lockedUntil: timestampOf(row.locked_until),
    };
  }

  /**
   * One conditional update of the hash alone: the generation and the moment are not touched (a rehash is the same credential at a new
   * cost, and the table's guard holds the two apart from a replacement). It writes only while the generation is the one verified **and
   * the stored hash is the one that was verified**: a rehash does not move the generation, so the generation cannot say that a hash
   * another instance has upgraded since (or rotated to a newer pepper) is still the one the caller verified, and an older upgrade
   * must never overwrite a newer one (the audit of 21 October 2026, A01). The runtime may not read the column, so the stored hash is
   * read again through `readCredentialHash`, the definer function that answers to the authentication capability alone, and compared
   * here; **the caller holds the identity's lock, as every writer of the credential does, so nothing can change it between that read and
   * this update**. A hash that is no longer the verified one answers `false`, and the caller keeps what is stored.
   */
  async rehashCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    verifiedHash: string,
    encodedHash: string,
  ): Promise<boolean> {
    const id = staffRef(ref);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError('A credential generation is a whole number of one or more');
    }
    if (typeof verifiedHash !== 'string' || verifiedHash.length === 0) {
      throw new TypeError('A credential is rehashed from the hash that was verified');
    }
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is rehashed from the encoded hash of a password: 1 to 1024 characters',
      );
    }
    if ((await this.readCredentialHash(transaction, ref)) !== verifiedHash) return false;
    const result = await transactionOf(transaction).execute(sql`
      update staff_identity set credential_hash = ${encodedHash}
       where id = ${id}::uuid and credential_generation = ${generation}::bigint
      returning id`);
    return result.rows.length === 1;
  }

  async clearFailedAttempts(transaction: TransactionHandle, ref: PrincipalRef): Promise<void> {
    await transactionOf(transaction).execute(sql`
      update staff_identity set failed_attempt_count = 0, locked_until = null
       where id = ${staffRef(ref)}::uuid and (failed_attempt_count <> 0 or locked_until is not null)`);
  }

  async displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select full_name from staff_identity where id = ${staffRef(ref)}::uuid`,
    );
    const row = result.rows[0] as unknown as { full_name: string } | undefined;
    return row === undefined ? null : row.full_name;
  }

  /** A staff member's messages go to the verified work email, as entered and without the padding the canonical form removes. */
  async registeredChannel(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<RegisteredChannel | null> {
    const result = await transactionOf(transaction).execute(
      sql`select work_email from staff_identity where id = ${staffRef(ref)}::uuid`,
    );
    const row = result.rows[0] as unknown as { work_email: string } | undefined;
    return row === undefined ? null : { channel: 'EMAIL', destination: row.work_email.trim() };
  }

  /**
   * A staff identity may recover while it is `ACTIVE` or `SUSPENDED` with an established password and a work email
   * (credential-recovery.md section 5.7): never `PENDING_APPROVAL`, never the terminal `REJECTED` (its address is released) or
   * `OFFBOARDED`, and never one that has set no password yet (the setup grant reaches it). Read in the caller's transaction, under the lock.
   */
  async recoveryEligible(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    const result = await transactionOf(transaction).execute(sql`
      select 1 from staff_identity
       where id = ${staffRef(ref)}::uuid and status in ('ACTIVE', 'SUSPENDED')
         and credential_generation > 0 and credential_established_at is not null and btrim(work_email) <> ''`);
    return result.rows.length === 1;
  }

  /**
   * One conditional update of the credential columns: the hash, the moment (the database's clock), the generation raised by one (the
   * table's guard holds it to one step) and the lockout cleared. `credential_generation > 0` is what makes it a replacement and not a setup.
   * The identity lock is the caller's.
   */
  async replaceCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = staffRef(ref);
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is replaced by the encoded hash of a password: 1 to 1024 characters',
      );
    }
    const result = await transactionOf(transaction).execute(sql`
      update staff_identity
         set credential_hash = ${encodedHash}, credential_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1,
             failed_attempt_count = 0, locked_until = null
       where id = ${id}::uuid and credential_generation > 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  /** A staff member belongs to no vendor organisation: only the vendor directory answers this. */
  vendorOrganizationOf(_transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    staffRef(ref);
    return Promise.reject(new TypeError('A staff identity belongs to no vendor organisation'));
  }

  async #one(transaction: TransactionHandle, statement: SQL): Promise<PrincipalSummary | null> {
    const result = await transactionOf(transaction).execute(statement);
    const row = result.rows[0] as unknown as StaffIdentityColumns | undefined;
    return row === undefined ? null : summaryOf(row);
  }
}

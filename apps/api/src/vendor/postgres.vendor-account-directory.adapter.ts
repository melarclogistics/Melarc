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

/** A question this directory is not the one to answer: a staff member or a rider is another directory's (the router never asks it). */
export class NotAVendorQuestionError extends Error {
  constructor(what: string) {
    super(`The vendor account directory does not answer ${what}`);
    this.name = 'NotAVendorQuestionError';
  }
}

interface VendorAccountColumns {
  readonly id: string;
  readonly status: string;
  readonly bundle_id: string;
  readonly credential_established_at: Date | string | null;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
}

// The account and its credential, with the one fixed bundle of the Vendor audience (a scalar subquery: a second such bundle is a fault
// that fails the statement, never a guess). The secret's hash is not among the columns the runtime may read (migration 0034).
const SELECT = sql`
  select a.id, a.status, c.credential_established_at, c.credential_generation,
         (select b.id from role_bundle b where b.audience = 'VENDOR') as bundle_id
    from vendor_account a join vendor_credential c on c.vendor_account_id = a.id`;

function generationOf(value: number | string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('A credential generation is a whole number, zero or more');
  }
  return generation;
}

function summaryOf(row: VendorAccountColumns): PrincipalSummary {
  return {
    ref: { type: 'VENDOR', id: row.id },
    status: row.status,
    credentialGeneration: generationOf(row.credential_generation),
    credentialEstablishedAt:
      row.credential_established_at === null ? null : timestampOf(row.credential_established_at),
    bundleId: row.bundle_id,
    // A vendor session is scoped by ownership, not by hub (vendor-authentication.md section 5.1): it reaches no hub-scoped row.
    authorizedHubIds: [],
  };
}

function vendorRef(ref: PrincipalRef): string {
  if (ref.type !== 'VENDOR')
    throw new NotAVendorQuestionError(`a ${ref.type.toLowerCase()} principal`);
  return ref.id;
}

/**
 * The vendor `IdentityDirectory` over PostgreSQL (S0.47; SOLUTION_ARCHITECTURE.md section 5, "domains own their persistence adapters"): the
 * vendor domain's answer to what `platform/auth` asks of a vendor account, over `vendor_account` and `vendor_credential` (migration 0034).
 * It joins the caller's transaction, which the sign-in, the setup, the recovery and the session-issue protocol open under the
 * `authentication` capability (the only context row-level security lets read the credential), and it opens none. The composition root
 * puts it behind the router of `platform/auth`, which sends it the questions about a `VENDOR` principal and the vendor finder only.
 *
 * - **The finder takes the canonical identifier** (`canonicalAccountIdentifier`) and looks up by it as a value; there is no list and no
 *   scan, the port's bound on what the capability can reach.
 * - **The identity lock is the account row's** (`FOR NO KEY UPDATE`): the row a change of the account's standing updates, and the one
 *   `melarc.vendor_locked_facts` locks for an administrator's act, the lock order's second level for a vendor. It is taken in a statement of
 *   its own and the state is read in the next, after any wait. The API holds the privilege the lock needs and the lock policy refuses any
 *   change of the row; it cannot read the secret.
 * - **The summary carries the account's status** (`ACTIVE`, `SUSPENDED`: credential and session standing), its credential's generation,
 *   the one fixed bundle of the Vendor audience a session snapshots, and no hub. The organisation's operational status is not the
 *   account's standing; the recovery guard reads it where the rule needs it (S0.50).
 * - **The lockout** is the staff one over the shared credential (SECURITY_DESIGN.md section 13.4b): one atomic conditional update, counted
 *   only against the credential of the generation verified while the account is `ACTIVE`.
 */
export class PostgresVendorAccountDirectory implements IdentityDirectory {
  findStaffByCanonicalEmail(): Promise<PrincipalSummary | null> {
    return Promise.reject(new NotAVendorQuestionError('a staff member by work email'));
  }

  async findVendorAccountByIdentifier(
    transaction: TransactionHandle,
    accountIdentifier: string,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where a.account_identifier = ${accountIdentifier}`);
  }

  findRiderByCanonicalPhone(): Promise<PrincipalSummary | null> {
    return Promise.reject(new NotAVendorQuestionError('a rider by phone'));
  }

  async readIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where a.id = ${vendorRef(ref)}::uuid`);
  }

  async lockIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    const id = vendorRef(ref);
    const locked = await transactionOf(transaction).execute(
      sql`select id from vendor_account where id = ${id}::uuid for no key update`,
    );
    if (locked.rows.length === 0) return null;
    // The state as it stands once the lock is held: a statement of its own, whose snapshot is taken after any wait for the lock. Read in
    // the locking statement, the credential (another row of the join) would be the one of before the wait.
    return this.#one(transaction, sql`${SELECT} where a.id = ${id}::uuid`);
  }

  /**
   * The vendor's first secret: one conditional update of the secret, its moment (the database's clock) and its generation from 0 to 1, and
   * the lockout cleared ("establishing it resets the credential's failed-attempt count"). The `credential_generation = 0` condition is what
   * makes it a setup and not a replacement. The identity lock is the caller's.
   */
  async establishCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = vendorRef(ref);
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is established from the encoded hash of a secret: 1 to 1024 characters',
      );
    }
    const result = await transactionOf(transaction).execute(sql`
      update vendor_credential
         set secret_hash = ${encodedHash}, credential_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1, failed_attempt_count = 0, locked_until = null
       where vendor_account_id = ${id}::uuid and credential_generation = 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  /** An authenticator app names a staff member's account; a vendor has none. */
  accountLabel(): Promise<string | null> {
    return Promise.reject(new NotAVendorQuestionError('the label of an authenticator account'));
  }

  findStaffForSignIn(): Promise<SignInCandidate | null> {
    return Promise.reject(new NotAVendorQuestionError('a staff sign-in'));
  }

  /** A lock is in force while `locked_until` is in the future on the database's clock; one that has run out is no lock. */
  async isCredentialLocked(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    const result = await transactionOf(transaction).execute(sql`
      select (locked_until is not null and locked_until > clock_timestamp()) as locked
        from vendor_credential where vendor_account_id = ${vendorRef(ref)}::uuid`);
    const row = result.rows[0] as unknown as { locked: boolean } | undefined;
    return row?.locked === true;
  }

  /** The hash comes from `melarc.vendor_secret_hash`, which refuses every context but the authentication capability's (migration 0034). */
  async readCredentialHash(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select melarc.vendor_secret_hash(${vendorRef(ref)}::uuid) as hash`,
    );
    const row = result.rows[0] as unknown as { hash: string | null } | undefined;
    return row?.hash ?? null;
  }

  /**
   * The staff rule over the shared credential (`PostgresStaffIdentityDirectory.recordFailedAttempt` states it): one atomic conditional
   * update that adds one unless a lock is in force, restarts from one after a lock ran out and sets the lock at the policy's count, and
   * changes the row only while the credential is of `generation` and the account is `ACTIVE`; no row written means it did not count, and
   * a second read says why.
   */
  async recordFailedAttempt(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    policy: LockoutPolicy,
  ): Promise<FailedAttempt> {
    const id = vendorRef(ref);
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
      update vendor_credential c
         set failed_attempt_count = case when c.locked_until is not null then 1 else c.failed_attempt_count + 1 end,
             locked_until = case
               when (case when c.locked_until is not null then 1 else c.failed_attempt_count + 1 end) >= ${maxAttempts}::int
               then clock_timestamp() + make_interval(mins => ${lockoutMinutes}::int)
               else null end
        from vendor_account a
       where c.vendor_account_id = ${id}::uuid and a.id = c.vendor_account_id
         and c.credential_generation = ${generation}::bigint and a.status = 'ACTIVE'
         and (c.locked_until is null or c.locked_until <= clock_timestamp())
      returning c.failed_attempt_count, c.locked_until`);
    const row = result.rows[0] as unknown as
      { failed_attempt_count: number; locked_until: Date | string | null } | undefined;
    if (row === undefined) {
      const holds = await transactionOf(transaction).execute(sql`
        select (c.credential_generation = ${generation}::bigint and a.status = 'ACTIVE') as current
          from vendor_credential c join vendor_account a on a.id = c.vendor_account_id
         where c.vendor_account_id = ${id}::uuid`);
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
   * The staff rule (`PostgresStaffIdentityDirectory.rehashCredential`): the secret alone, only while the generation is the one verified and
   * the stored hash is the one that was verified, read again through the authentication-only reader under the caller's identity lock.
   */
  async rehashCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    verifiedHash: string,
    encodedHash: string,
  ): Promise<boolean> {
    const id = vendorRef(ref);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError('A credential generation is a whole number of one or more');
    }
    if (typeof verifiedHash !== 'string' || verifiedHash.length === 0) {
      throw new TypeError('A credential is rehashed from the hash that was verified');
    }
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is rehashed from the encoded hash of a secret: 1 to 1024 characters',
      );
    }
    if ((await this.readCredentialHash(transaction, ref)) !== verifiedHash) return false;
    const result = await transactionOf(transaction).execute(sql`
      update vendor_credential set secret_hash = ${encodedHash}
       where vendor_account_id = ${id}::uuid and credential_generation = ${generation}::bigint
      returning vendor_account_id`);
    return result.rows.length === 1;
  }

  async clearFailedAttempts(transaction: TransactionHandle, ref: PrincipalRef): Promise<void> {
    await transactionOf(transaction).execute(sql`
      update vendor_credential set failed_attempt_count = 0, locked_until = null
       where vendor_account_id = ${vendorRef(ref)}::uuid and (failed_attempt_count <> 0 or locked_until is not null)`);
  }

  /** What a vendor session shows as whose it is: the organisation's trading name, or its legal name where it has none (never a person). */
  async displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    const result = await transactionOf(transaction).execute(sql`
      select coalesce(o.trading_name, o.legal_name) as name
        from vendor_account a join vendor_organization o on o.id = a.vendor_organization_id
       where a.id = ${vendorRef(ref)}::uuid`);
    const row = result.rows[0] as unknown as { name: string } | undefined;
    return row === undefined ? null : row.name;
  }

  /** The organisation a vendor account belongs to, read from the account: what a vendor session's context names (`VendorOrganizationResolver`). */
  async vendorOrganizationOf(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select vendor_organization_id from vendor_account where id = ${vendorRef(ref)}::uuid`,
    );
    const row = result.rows[0] as unknown as { vendor_organization_id: string } | undefined;
    return row === undefined ? null : row.vendor_organization_id;
  }

  /**
   * Where the account's messages go (domain-model.md section 6.8, `delivery_channel`): the registered address of the channel its approver
   * chose, never the other one (no automatic fallback), with the account identifier the message carries beside the link. No channel chosen,
   * or the chosen one not registered, is no deliverable channel.
   */
  async registeredChannel(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<RegisteredChannel | null> {
    const result = await transactionOf(transaction).execute(sql`
      select a.account_identifier, c.delivery_channel, c.recovery_email, c.recovery_phone
        from vendor_account a join vendor_credential c on c.vendor_account_id = a.id
       where a.id = ${vendorRef(ref)}::uuid`);
    const row = result.rows[0] as unknown as
      | {
          account_identifier: string;
          delivery_channel: 'EMAIL' | 'PHONE' | null;
          recovery_email: string | null;
          recovery_phone: string | null;
        }
      | undefined;
    if (row === undefined) return null;
    if (row.delivery_channel === 'EMAIL' && row.recovery_email !== null) {
      return {
        channel: 'EMAIL',
        destination: row.recovery_email,
        accountIdentifier: row.account_identifier,
      };
    }
    if (row.delivery_channel === 'PHONE' && row.recovery_phone !== null) {
      return {
        channel: 'SMS',
        destination: row.recovery_phone,
        accountIdentifier: row.account_identifier,
      };
    }
    return null;
  }

  /**
   * A vendor account may recover while it is `ACTIVE` or `SUSPENDED` **and its organisation is `ACTIVE` or `SUSPENDED`**, with an
   * established shared secret and the address of its delivery channel registered (credential-recovery.md section 5.7; Product decision of
   * 9 October 2026). Never an account with no secret yet (the setup grant reaches it), nor one whose organisation is `REJECTED`,
   * `TERMINATED`, `CREATED_BY_OPS` or `PENDING_SENIOR_OPS_REVIEW`. The organisation is read through its link in this statement, after the
   * account lock the caller holds, so a status a second connection changed while the caller waited for that lock is the one judged.
   */
  async recoveryEligible(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    const result = await transactionOf(transaction).execute(sql`
      select 1
        from vendor_account a
        join vendor_credential c on c.vendor_account_id = a.id
        join vendor_organization o on o.id = a.vendor_organization_id
       where a.id = ${vendorRef(ref)}::uuid
         and a.status in ('ACTIVE', 'SUSPENDED') and o.operational_status in ('ACTIVE', 'SUSPENDED')
         and c.credential_generation > 0 and c.credential_established_at is not null
         and ((c.delivery_channel = 'EMAIL' and c.recovery_email is not null)
              or (c.delivery_channel = 'PHONE' and c.recovery_phone is not null))`);
    return result.rows.length === 1;
  }

  /**
   * The shared secret replaced (S0.51): one conditional update of the secret, its moment (the database's clock), its generation raised by one
   * and the lockout cleared. `credential_generation > 0` is what makes it a replacement and not a setup. The identity lock is the caller's.
   */
  async replaceCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = vendorRef(ref);
    if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
      throw new TypeError(
        'A credential is replaced by the encoded hash of a secret: 1 to 1024 characters',
      );
    }
    const result = await transactionOf(transaction).execute(sql`
      update vendor_credential
         set secret_hash = ${encodedHash}, credential_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1, failed_attempt_count = 0, locked_until = null
       where vendor_account_id = ${id}::uuid and credential_generation > 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  async #one(transaction: TransactionHandle, statement: SQL): Promise<PrincipalSummary | null> {
    const result = await transactionOf(transaction).execute(statement);
    const row = result.rows[0] as unknown as VendorAccountColumns | undefined;
    return row === undefined ? null : summaryOf(row);
  }
}

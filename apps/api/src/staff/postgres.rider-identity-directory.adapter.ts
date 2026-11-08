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

/** A question this directory is not the one to answer: a staff member or a vendor account is another directory's (the router never asks it). */
export class NotARiderQuestionError extends Error {
  constructor(what: string) {
    super(`The rider directory does not answer ${what}`);
    this.name = 'NotARiderQuestionError';
  }
}

interface RiderColumns {
  readonly id: string;
  readonly status: string;
  readonly primary_hub_id: string;
  readonly bundle_id: string;
  readonly pin_established_at: Date | string | null;
  /** `bigint` comes back from a raw statement as text. */
  readonly credential_generation: number | string;
}

// The rider and the one fixed bundle of the Rider audience (a scalar subquery: a second such bundle is a fault that fails the statement,
// never a guess). The PIN's hash is not among the columns the runtime may read (migration 0040).
const SELECT = sql`
  select r.id, r.status, r.primary_hub_id, r.pin_established_at, r.credential_generation,
         (select b.id from role_bundle b where b.audience = 'RIDER') as bundle_id
    from rider_identity r`;

function generationOf(value: number | string): number {
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError('A credential generation is a whole number, zero or more');
  }
  return generation;
}

function summaryOf(row: RiderColumns): PrincipalSummary {
  return {
    ref: { type: 'RIDER', id: row.id },
    status: row.status,
    credentialGeneration: generationOf(row.credential_generation),
    credentialEstablishedAt:
      row.pin_established_at === null ? null : timestampOf(row.pin_established_at),
    bundleId: row.bundle_id,
    // The primary hub only: the effective temporary assignments (HubAssignment, section 5.8) are added by the task that builds them.
    authorizedHubIds: [row.primary_hub_id],
  };
}

function riderRef(ref: PrincipalRef): string {
  if (ref.type !== 'RIDER')
    throw new NotARiderQuestionError(`a ${ref.type.toLowerCase()} principal`);
  return ref.id;
}

/**
 * The rider `IdentityDirectory` over PostgreSQL (S0.53; SOLUTION_ARCHITECTURE.md section 5, "domains own their persistence adapters"): the
 * staff domain's answer to what `platform/auth` asks of a rider, over `rider_identity` (migration 0040). It joins the caller's transaction,
 * which the sign-in, the enrolment and the session-issue protocol open under the `authentication` capability (the only context
 * row-level security lets read the PIN before a principal exists), and it opens none. The composition root puts it behind the router of
 * `platform/auth`, which sends it the questions about a `RIDER` principal and the rider finder only.
 *
 * - **The finder takes the canonical phone** (`canonicalRiderPhone`) and looks up by it as a value; there is no list and no scan.
 * - **The identity lock is the rider's row** (`FOR NO KEY UPDATE`): the row the officers' device acts also lock (`melarc.rider_locked_facts`),
 *   the lock order's second level for a rider. The API holds the privilege the lock needs on the PIN columns and the lock policy refuses any
 *   change of the row through a staff context.
 * - **The summary carries the rider's status** (the five of the domain model), the PIN's generation (0 while there is none), the one fixed
 *   bundle of the Rider audience a session snapshots and the rider's primary hub. Only an `ACTIVE` rider is issued a session.
 * - **The PIN** is set at enrolment and replaced at a replacement (`establishCredential`, `replaceCredential`: one conditional update each,
 *   the lockout cleared), counted against by the staff rule (SECURITY_DESIGN.md section 13.4b: one atomic conditional update, only against
 *   the PIN of the generation verified and only while the rider is `ACTIVE`), and read through `melarc.rider_pin_hash`, which answers the
 *   authentication capability alone.
 * - **A rider has no deliverable channel and no self-service recovery**: the PIN is re-established by a replacement handset in person
 *   (credential-recovery.md), so `registeredChannel` is none and `recoveryEligible` is false.
 */
export class PostgresRiderIdentityDirectory implements IdentityDirectory {
  findStaffByCanonicalEmail(): Promise<PrincipalSummary | null> {
    return Promise.reject(new NotARiderQuestionError('a staff member by work email'));
  }

  findVendorAccountByIdentifier(): Promise<PrincipalSummary | null> {
    return Promise.reject(new NotARiderQuestionError('a vendor account by identifier'));
  }

  async findRiderByCanonicalPhone(
    transaction: TransactionHandle,
    canonicalPhone: string,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where r.phone = ${canonicalPhone}`);
  }

  async readIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    return this.#one(transaction, sql`${SELECT} where r.id = ${riderRef(ref)}::uuid`);
  }

  async lockIdentity(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<PrincipalSummary | null> {
    const id = riderRef(ref);
    const locked = await transactionOf(transaction).execute(
      sql`select id from rider_identity where id = ${id}::uuid for no key update`,
    );
    if (locked.rows.length === 0) return null;
    // The state as it stands once the lock is held: a statement of its own, whose snapshot is taken after any wait for the lock.
    return this.#one(transaction, sql`${SELECT} where r.id = ${id}::uuid`);
  }

  /**
   * The rider's first PIN: one conditional update of the hash, its moment (the database's clock) and its generation from 0 to 1, and the
   * lockout cleared ("setting it resets the credential's failed-attempt count"). The `credential_generation = 0` condition is what makes it
   * an establishment and not a replacement. The identity lock is the caller's.
   */
  async establishCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = riderRef(ref);
    boundedHash(encodedHash, 'established from');
    const result = await transactionOf(transaction).execute(sql`
      update rider_identity
         set pin_hash = ${encodedHash}, pin_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1, failed_attempt_count = 0, locked_until = null
       where id = ${id}::uuid and credential_generation = 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  /** The rider has no authenticator-app label. */
  accountLabel(): Promise<string | null> {
    return Promise.reject(new NotARiderQuestionError('the label of an authenticator account'));
  }

  findStaffForSignIn(): Promise<SignInCandidate | null> {
    return Promise.reject(new NotARiderQuestionError('a staff sign-in'));
  }

  /** A lock is in force while `locked_until` is in the future on the database's clock; one that has run out is no lock. */
  async isCredentialLocked(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean> {
    const result = await transactionOf(transaction).execute(sql`
      select (locked_until is not null and locked_until > clock_timestamp()) as locked
        from rider_identity where id = ${riderRef(ref)}::uuid`);
    const row = result.rows[0] as unknown as { locked: boolean } | undefined;
    return row?.locked === true;
  }

  /** The hash comes from `melarc.rider_pin_hash`, which refuses every context but the authentication capability's (migration 0040). */
  async readCredentialHash(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select melarc.rider_pin_hash(${riderRef(ref)}::uuid) as hash`,
    );
    const row = result.rows[0] as unknown as { hash: string | null } | undefined;
    return row?.hash ?? null;
  }

  /**
   * The staff rule over the rider's PIN (`PostgresVendorAccountDirectory.recordFailedAttempt` states it): one atomic conditional update that
   * adds one unless a lock is in force, restarts from one after a lock ran out and sets the lock at the policy's count, and changes the row
   * only while the PIN is of `generation` and the rider is `ACTIVE`; no row written means it did not count, and a second read says why.
   */
  async recordFailedAttempt(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    policy: LockoutPolicy,
  ): Promise<FailedAttempt> {
    const id = riderRef(ref);
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
      update rider_identity r
         set failed_attempt_count = case when r.locked_until is not null then 1 else r.failed_attempt_count + 1 end,
             locked_until = case
               when (case when r.locked_until is not null then 1 else r.failed_attempt_count + 1 end) >= ${maxAttempts}::int
               then clock_timestamp() + make_interval(mins => ${lockoutMinutes}::int)
               else null end
       where r.id = ${id}::uuid and r.credential_generation = ${generation}::bigint and r.status = 'ACTIVE'
         and (r.locked_until is null or r.locked_until <= clock_timestamp())
      returning r.failed_attempt_count, r.locked_until`);
    const row = result.rows[0] as unknown as
      { failed_attempt_count: number; locked_until: Date | string | null } | undefined;
    if (row === undefined) {
      const holds = await transactionOf(transaction).execute(sql`
        select (credential_generation = ${generation}::bigint and status = 'ACTIVE') as current
          from rider_identity where id = ${id}::uuid`);
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
   * The staff rule (`PostgresStaffIdentityDirectory.rehashCredential`): the PIN's hash alone, only while the generation is the one verified
   * and the stored hash is the one that was verified, read again through the authentication-only reader under the caller's identity lock.
   */
  async rehashCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    verifiedHash: string,
    encodedHash: string,
  ): Promise<boolean> {
    const id = riderRef(ref);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError('A credential generation is a whole number of one or more');
    }
    if (typeof verifiedHash !== 'string' || verifiedHash.length === 0) {
      throw new TypeError('A credential is rehashed from the hash that was verified');
    }
    boundedHash(encodedHash, 'rehashed from');
    if ((await this.readCredentialHash(transaction, ref)) !== verifiedHash) return false;
    const result = await transactionOf(transaction).execute(sql`
      update rider_identity set pin_hash = ${encodedHash}
       where id = ${id}::uuid and credential_generation = ${generation}::bigint
      returning id`);
    return result.rows.length === 1;
  }

  async clearFailedAttempts(transaction: TransactionHandle, ref: PrincipalRef): Promise<void> {
    await transactionOf(transaction).execute(sql`
      update rider_identity set failed_attempt_count = 0, locked_until = null
       where id = ${riderRef(ref)}::uuid and (failed_attempt_count <> 0 or locked_until is not null)`);
  }

  /** What a rider session shows as whose it is: the rider's full name. */
  async displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null> {
    const result = await transactionOf(transaction).execute(
      sql`select full_name from rider_identity where id = ${riderRef(ref)}::uuid`,
    );
    const row = result.rows[0] as unknown as { full_name: string } | undefined;
    return row === undefined ? null : row.full_name;
  }

  /** Only a Vendor principal belongs to an organisation. */
  vendorOrganizationOf(): Promise<string | null> {
    return Promise.reject(new NotARiderQuestionError('the organisation of a vendor account'));
  }

  /** A rider's PIN is not delivered anywhere: the handset in the officer's presence is the only channel (rider-authentication.md section 4.2). */
  registeredChannel(): Promise<RegisteredChannel | null> {
    return Promise.resolve(null);
  }

  /** There is no recovery link for a rider (credential-recovery.md section 5.7: never a rider). */
  recoveryEligible(): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * The PIN replaced (a replacement handset's enrolment): one conditional update of the hash, its moment (the database's clock), its generation
   * raised by one and the lockout cleared. `credential_generation > 0` is what makes it a replacement and not a first establishment. The
   * identity lock is the caller's.
   */
  async replaceCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null> {
    const id = riderRef(ref);
    boundedHash(encodedHash, 'replaced by');
    const result = await transactionOf(transaction).execute(sql`
      update rider_identity
         set pin_hash = ${encodedHash}, pin_established_at = clock_timestamp(),
             credential_generation = credential_generation + 1, failed_attempt_count = 0, locked_until = null
       where id = ${id}::uuid and credential_generation > 0
      returning credential_generation`);
    const row = result.rows[0] as unknown as { credential_generation: number | string } | undefined;
    return row === undefined ? null : { generation: generationOf(row.credential_generation) };
  }

  async #one(transaction: TransactionHandle, statement: SQL): Promise<PrincipalSummary | null> {
    const result = await transactionOf(transaction).execute(statement);
    const row = result.rows[0] as unknown as RiderColumns | undefined;
    return row === undefined ? null : summaryOf(row);
  }
}

function boundedHash(encodedHash: unknown, how: string): void {
  if (typeof encodedHash !== 'string' || encodedHash.length === 0 || encodedHash.length > 1024) {
    throw new TypeError(`A PIN is ${how} the encoded hash of a PIN: 1 to 1024 characters`);
  }
}

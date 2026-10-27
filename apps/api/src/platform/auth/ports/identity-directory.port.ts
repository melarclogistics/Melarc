import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

export interface PrincipalRef {
  readonly type: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly id: string;
}

/** What `platform/auth` needs to decide a step, and nothing it could use to read the principal's record. */
export interface PrincipalSummary {
  readonly ref: PrincipalRef;
  /** The principal's status in its own state machine (state-machines.md §13, §14). */
  readonly status: string;
  /**
   * Which credential the principal holds: 0 while there is none, and 1 or more once there is. It is what tells one credential from
   * another to a session: a sign-in that verified a credential states which one by this number, and the session-issue protocol
   * refuses it when the principal now holds another. Whoever replaces a credential (a setup, a recovery, a reset, a change) raises
   * it by one; rewriting the hash of the same credential at a new cost (a rehash after a successful verification) does not. A
   * moment cannot do this job: a clock repeats and steps back, and a `Date` keeps milliseconds where the database keeps
   * microseconds, so two credentials can carry the same one.
   */
  readonly credentialGeneration: number;
  /** When the current credential was established, or null while there is none: to read the history by, never to tell credentials apart. */
  readonly credentialEstablishedAt: Date | null;
  /**
   * The role bundle the principal's authority comes from, which a session snapshots and the policy lock of its issue is taken on
   * (SECURITY_DESIGN.md §13.10a). A staff identity's own bundle; for a Vendor and a Rider, the one fixed bundle of their audience.
   */
  readonly bundleId: string;
  /**
   * The hubs the principal may work in, resolved from primary membership plus any effective assignment (domain-model.md §6.8,
   * `Session.authorized_hub_ids`), in ascending order. An empty list means no hub-scoped rows, never all of them.
   */
  readonly authorizedHubIds: readonly string[];
  /**
   * How a staff identity came to exist (S0.31): `BOOTSTRAP` for the two the seed makes, `MAKER_CHECKER` for every other, read from
   * the immutable column and never inferred from the actor, an address or a count (domain-model.md §6.8). Absent for an audience whose
   * identities have no such column.
   */
  readonly origin?: 'BOOTSTRAP' | 'MAKER_CHECKER';
}

/** A staff identity found for a sign-in: what a decision needs, and whether a lock is in force. */
export interface SignInCandidate {
  readonly summary: PrincipalSummary;
  /**
   * Whether the credential is locked **now, on the database's clock** (`locked_until` is in the future): a lock that has run out is
   * no lock, whatever the count on the record still says. Never the lock's moment, never the count.
   */
  readonly locked: boolean;
}

/** What one failed attempt did to the credential's count (SECURITY_DESIGN.md §13.4b). */
export type FailedAttempt =
  /**
   * The attempt neither counted nor moved a lock. `LOCKED`: the credential was already locked. `STALE`: the credential the attempt
   * was made against is not the one the identity holds now, or the identity can no longer sign in (it was replaced, suspended,
   * offboarded or is not there), so a proof of the old credential is counted against nothing.
   */
  | { readonly counted: false; readonly reason: 'LOCKED' | 'STALE' }
  | {
      readonly counted: true;
      /** The count after this attempt: 1 when the previous lock had run out. */
      readonly failedAttemptCount: number;
      /** Whether **this** attempt set the lock: true once per lock, which is what makes the event one per lock. */
      readonly tipped: false;
      readonly lockedUntil: null;
    }
  | {
      readonly counted: true;
      readonly failedAttemptCount: number;
      readonly tipped: true;
      /** The moment the lock ends, on the database's clock. */
      readonly lockedUntil: Date;
    };

/**
 * Where a principal's credential messages go (SECURITY_DESIGN.md §13.9a; state-machines.md §19.1): resolved from the principal's record,
 * **never from a request**. A staff member's verified work email as entered; a vendor account's registered address of the delivery channel
 * its approver chose, with the account identifier every vendor message carries beside the link (S0.47).
 */
export interface RegisteredChannel {
  readonly channel: 'EMAIL' | 'SMS';
  readonly destination: string;
  readonly accountIdentifier?: string;
}

/** The two settings a failure is counted by (`signin_max_attempts`, `signin_lockout_minutes`), read by the caller. */
export interface LockoutPolicy {
  readonly maxAttempts: number;
  readonly lockoutMinutes: number;
}

/**
 * How `platform/auth` finds a staff member, a vendor account or a rider without importing the domain that owns them
 * (SOLUTION_ARCHITECTURE.md §5). The domain implements it over its own tables; no identity table is duplicated here. Each
 * finder takes the **canonical** identifier, never the text as typed.
 */
export interface IdentityDirectory {
  findStaffByCanonicalEmail(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<PrincipalSummary | null>;
  findVendorAccountByIdentifier(
    transaction: TransactionHandle,
    accountIdentifier: string,
  ): Promise<PrincipalSummary | null>;
  findRiderByCanonicalPhone(
    transaction: TransactionHandle,
    canonicalPhone: string,
  ): Promise<PrincipalSummary | null>;
  /**
   * A **non-authoritative** read of the principal by reference, for the discovery step of a policy-locked operation
   * (SECURITY_DESIGN.md §13.10a, "Discovery, the planned set and restart"): which bundle to plan the locks on, and what to
   * compare once they are held. It takes no lock and decides nothing; a decision is made on `lockIdentity`.
   */
  readIdentity(transaction: TransactionHandle, ref: PrincipalRef): Promise<PrincipalSummary | null>;
  /**
   * Takes the identity-level lock (lock order: policy, identity, session, business) and reads the principal's state again
   * under it. A decision about the principal is made on this read, never on the one that discovered it.
   */
  lockIdentity(transaction: TransactionHandle, ref: PrincipalRef): Promise<PrincipalSummary | null>;
  /**
   * Writes the **first** credential of a principal whose identity lock the caller holds (S0.31): the encoded hash, the moment on the
   * database's clock and the generation from 0 to 1, one conditional statement. It writes nothing and answers `null` for a principal
   * that does not exist or already holds a credential: replacing a credential is a recovery's act and never a setup's. The hash is
   * the caller's to make (`Hasher`) and is written as it is; it is never read back through this port.
   */
  establishCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null>;
  /**
   * What names the principal's account in an authenticator app (S0.31): a staff member's work email as entered, to be shown to the
   * person it belongs to in the provisioning answer and nowhere else. `null` when the principal does not exist.
   */
  accountLabel(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null>;
  /**
   * The identity the canonical work email names, for a sign-in (S0.32), with whether its credential is locked on the database's clock.
   * It takes no lock. A `REJECTED` profile has released its address and is not found.
   */
  findStaffForSignIn(
    transaction: TransactionHandle,
    canonicalEmail: string,
  ): Promise<SignInCandidate | null>;
  /**
   * Whether the principal's credential is locked **now, on the database's clock** (S0.33): a caller who holds a live challenge has
   * proved the password, so it is told. `false` for a lock that has run out, for a credential never locked and for a principal that does
   * not exist. It takes no lock of its own: the second step holds the identity's.
   */
  isCredentialLocked(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean>;
  /**
   * The encoded hash of the principal's credential, for the one verification of a sign-in (S0.32): `null` when there is none or no such
   * principal. It is returned by a definer function that answers to the authentication capability alone, and it is the caller's to
   * verify and never to log, return or keep.
   */
  readCredentialHash(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null>;
  /**
   * Counts one failed attempt against the credential of `generation`, the one the caller verified the password or the code against, by
   * **one atomic conditional update** (S0.32): add one unless the credential is already locked, restart from one when the lock has run
   * out, and set the lock when the count reaches the policy's. **It counts only while the identity still holds that credential and can
   * still sign in** (the audit of 21 October 2026, A03): a verification that started against generation G and finished after a
   * replacement committed G+1 and cleared its counters would otherwise add to the new credential's, and several in-flight old requests
   * could lock it. It says whether the attempt counted and whether it tipped the lock, or why it did not (`LOCKED`, `STALE`).
   * Concurrent failures each add one, none steps over the threshold without setting the lock, and a failure that completes after the
   * lock is set neither counts nor moves it. The caller commits this before it answers the refusal.
   */
  recordFailedAttempt(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    policy: LockoutPolicy,
  ): Promise<FailedAttempt>;
  /**
   * Replaces the stored hash of the credential the caller has just verified with a stronger one (S0.32: "a credential hash is rewritten
   * only when the Hasher says so", which only ever moves forward). It is **the same credential**: the generation and the moment do not
   * change, so the generation alone cannot say that the hash is still the one that was verified. The caller holds the identity's lock,
   * and this writes only while the identity holds the credential of that generation **and the stored hash is `verifiedHash`**, the
   * one the caller verified (it is read again under the lock through the authentication-only reader, and the runtime is granted no
   * read of the column): a hash that another instance has since upgraded further, or rotated to a newer pepper, is kept, and an
   * opportunistic rewrite is never allowed to reverse an upgrade (the audit of 21 October 2026, A01). It answers whether it wrote.
   */
  rehashCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    generation: number,
    verifiedHash: string,
    encodedHash: string,
  ): Promise<boolean>;
  /** Sets the count to zero and ends any lock: a complete sign-in, and a credential set or recovered (S0.32). Nothing to clear is no error. */
  clearFailedAttempts(transaction: TransactionHandle, ref: PrincipalRef): Promise<void>;
  /**
   * What a session shows as whose it is: a staff member's full name, a vendor account's organisation (its trading name, or its legal
   * name where it has none; never a person). `null` when the principal does not exist.
   */
  displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null>;
  /**
   * The organisation a vendor account belongs to (S0.47), read from the account: what the security context of a vendor session's
   * operation names (`VendorOrganizationResolver`). `null` when the account does not exist. Only a `VENDOR` principal has one.
   */
  vendorOrganizationOf(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null>;
  /**
   * Where the principal's credential messages go (S0.49, S0.50): `null` when the principal does not exist or has no deliverable channel
   * (a vendor whose approver chose none, or whose chosen address is not registered). Read under the authentication capability.
   */
  registeredChannel(
    transaction: TransactionHandle,
    ref: PrincipalRef,
  ): Promise<RegisteredChannel | null>;
  /**
   * Whether the principal may be sent a recovery link and may complete one (S0.50, S0.51; credential-recovery.md section 5.7), read under
   * the identity lock the caller holds: a status of its own state machine that keeps a credential (a suspended principal included), an
   * established credential and a registered recovery channel, and for a vendor account an organisation that is `ACTIVE` or `SUSPENDED`.
   * Which statuses those are is the owning domain's: `platform/auth` never names another domain's states. False for a principal that
   * does not exist.
   */
  recoveryEligible(transaction: TransactionHandle, ref: PrincipalRef): Promise<boolean>;
  /**
   * Replaces the credential of a principal whose identity lock the caller holds (S0.51, a completed recovery): the encoded hash, the moment
   * on the database's clock, the generation raised by one, and the failed-attempt count and lock cleared, in one conditional statement.
   * It writes nothing and answers `null` for a principal that does not exist or holds no credential yet: establishing a first one is a
   * setup's act and never a recovery's. The hash is the caller's to make and is never read back through this port.
   */
  replaceCredential(
    transaction: TransactionHandle,
    ref: PrincipalRef,
    encodedHash: string,
  ): Promise<{ readonly generation: number } | null>;
}

export const IDENTITY_DIRECTORY = Symbol('IDENTITY_DIRECTORY');

export const IDENTITY_DIRECTORY_DESCRIPTOR: PortDescriptor<IdentityDirectory> = {
  port: 'IdentityDirectory',
  // Staff and rider identities live in the staff domain, vendor accounts in the vendor domain (plan §3, placement).
  owner: { kind: 'domain', domains: ['staff', 'vendor'] },
  operations: {
    findStaffByCanonicalEmail: {
      inputs: 'the transaction and a work email in its canonical form',
      outputs: "the staff identity's summary, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    findVendorAccountByIdentifier: {
      inputs: 'the transaction and a vendor account identifier',
      outputs: "the vendor account's summary, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    findRiderByCanonicalPhone: {
      inputs: 'the transaction and a phone number in its canonical form',
      outputs: "the rider's summary, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    readIdentity: {
      inputs: 'the transaction and the principal',
      outputs:
        "the principal's summary, read without a lock and so only a hint, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    lockIdentity: {
      inputs: 'the transaction and the principal',
      outputs:
        "the principal's summary read under the identity lock, or null when it no longer exists",
      outcomes: ['NOT_FOUND'],
      raises: ['LOCK_TIMEOUT'],
      transaction: 'inside-callers-transaction',
    },
    establishCredential: {
      inputs:
        'the transaction, the principal (whose identity lock the caller holds) and the encoded hash of the new credential',
      outputs:
        'the credential generation now held (1), or null when the principal does not exist or already holds a credential, in which case nothing is written',
      outcomes: ['NOT_FOUND', 'CREDENTIAL_ALREADY_ESTABLISHED'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    accountLabel: {
      inputs: 'the transaction and the principal',
      outputs: "the principal's work email as entered, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    findStaffForSignIn: {
      inputs: 'the transaction and a work email in its canonical form',
      outputs:
        "the staff identity's summary and whether its credential is locked now, on the database's clock, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    isCredentialLocked: {
      inputs: 'the transaction and the principal',
      outputs: "whether the credential is locked now, on the database's clock",
      outcomes: ['LOCKED_OUT'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    readCredentialHash: {
      inputs: 'the transaction and the principal',
      outputs: "the encoded hash of the principal's credential, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    recordFailedAttempt: {
      inputs:
        'the transaction, the principal, the generation of the credential that was verified and the lockout policy (the maximum count and the lock in minutes)',
      outputs:
        'whether the attempt counted (it does not inside a lock, nor against a credential that is no longer the identity’s), the count after it and whether it set the lock, by one atomic conditional update',
      outcomes: ['LOCKED_OUT', 'CREDENTIAL_CHANGED'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    rehashCredential: {
      inputs:
        'the transaction, the principal, the generation and the encoded hash that were verified, and the new encoded hash',
      outputs:
        'whether the hash was replaced: only while the identity still holds the credential of that generation and the stored hash is the one that was verified',
      outcomes: ['CREDENTIAL_CHANGED'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    clearFailedAttempts: {
      inputs: 'the transaction and the principal',
      outputs: 'nothing: the count is zero and no lock is in force',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    displayName: {
      inputs: 'the transaction and the principal',
      outputs: "the principal's full name, or null when there is none",
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    vendorOrganizationOf: {
      inputs: 'the transaction and a vendor account',
      outputs:
        'the id of the organisation the account belongs to, or null when there is no such account',
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    registeredChannel: {
      inputs: 'the transaction and the principal',
      outputs:
        "where the principal's credential messages go (the channel, the address and, for a vendor, the account identifier), or null when it has no deliverable channel",
      outcomes: ['NOT_FOUND', 'NO_DELIVERABLE_CHANNEL'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    recoveryEligible: {
      inputs: 'the transaction and the principal, whose identity lock the caller holds',
      outputs:
        'whether the principal may be sent and may complete a recovery link: an eligible status, an established credential, a registered channel and, for a vendor, an organisation that is ACTIVE or SUSPENDED',
      outcomes: ['NOT_FOUND', 'NOT_ELIGIBLE'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    replaceCredential: {
      inputs:
        'the transaction, the principal (whose identity lock the caller holds) and the encoded hash of the new credential',
      outputs:
        'the credential generation now held, raised by one, with the failed-attempt count and the lock cleared; or null when the principal does not exist or holds no credential, in which case nothing is written',
      outcomes: ['NOT_FOUND', 'NO_CREDENTIAL'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
  },
};

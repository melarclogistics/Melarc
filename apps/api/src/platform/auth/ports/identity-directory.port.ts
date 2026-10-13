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
  },
};

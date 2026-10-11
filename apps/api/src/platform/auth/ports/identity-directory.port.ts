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
  readonly credentialEstablished: boolean;
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

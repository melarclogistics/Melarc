import type { Surface } from '../../database/transaction-context.js';
import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

/** The contract's `SessionRecord.termination_reason` (openapi.yaml), without the null. */
export type SessionTerminationReason =
  | 'SIGNED_OUT'
  | 'SUPERSEDED_BY_NEW_LOGIN'
  | 'REPLACED_BY_NEW_SESSION'
  | 'EXPIRED'
  | 'CREDENTIAL_CHANGED'
  | 'SUSPENDED'
  | 'OFFBOARDED'
  | 'ADMIN_REVOKED'
  | 'AUTHORITY_CHANGED'
  | 'HUB_SCOPE_CHANGED'
  | 'DEVICE_REVOKED'
  | 'DEVICE_REPLACED'
  | 'MFA_RESET';

declare const authorityBrand: unique symbol;

/**
 * The immutable authority a session was issued with: the permission snapshot and its lineage. Opaque here; the task that
 * builds authorization defines it. A session never reads the live bundle, so a snapshot is correct history.
 */
export interface SessionAuthority {
  readonly [authorityBrand]: true;
}

export interface NewSession {
  readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principalId: string;
  readonly surface: Surface;
  /** The SHA-256 of the session token. The token itself is never stored. */
  readonly tokenHash: Uint8Array;
  readonly authority: SessionAuthority;
  /** The absolute end of the session. */
  readonly expiresAt: Date;
}

export interface StoredSession {
  readonly id: string;
  readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
  readonly principalId: string;
  readonly state: 'ACTIVE' | 'TERMINATED';
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  readonly terminationReason: SessionTerminationReason | null;
  readonly authority: SessionAuthority;
}

/** Which sessions an invalidation reaches. */
export type SessionSelector =
  | { readonly by: 'session'; readonly sessionId: string }
  | {
      readonly by: 'principal';
      readonly principalType: 'STAFF' | 'RIDER' | 'VENDOR';
      readonly principalId: string;
    }
  | { readonly by: 'bundle'; readonly bundleId: string };

/**
 * Session storage (SECURITY_DESIGN.md §13). Lookup is by the hash of a presented token. Whether a session has expired is
 * judged by the caller on one fresh database time **after** the locks, never by the store on a stale read. Every operation
 * joins the caller's transaction, so issuing a session, ending others and the audit event commit together.
 */
export interface SessionStore {
  create(transaction: TransactionHandle, session: NewSession): Promise<StoredSession>;
  findByTokenHash(
    transaction: TransactionHandle,
    tokenHash: Uint8Array,
  ): Promise<StoredSession | null>;
  /** Records activity, coalesced so that a burst of requests writes once. */
  recordActivity(transaction: TransactionHandle, sessionId: string, at: Date): Promise<void>;
  terminate(
    transaction: TransactionHandle,
    selector: SessionSelector,
    reason: SessionTerminationReason,
  ): Promise<number>;
}

export const SESSION_STORE = Symbol('SESSION_STORE');

export const SESSION_STORE_DESCRIPTOR: PortDescriptor<SessionStore> = {
  port: 'SessionStore',
  owner: { kind: 'platform', area: 'auth/sessions' },
  operations: {
    create: {
      inputs:
        'the transaction and the new session: principal, surface, token hash, authority and absolute end',
      outputs: 'the stored session',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    findByTokenHash: {
      inputs: 'the transaction and the hash of a presented token',
      outputs: 'the session with that hash in any state, or null when there is none',
      outcomes: ['NOT_FOUND'],
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    recordActivity: {
      inputs: 'the transaction, the session and the time of the activity',
      outputs: 'nothing: the write is skipped when a recent one already covers it',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
    terminate: {
      inputs:
        "the transaction, which sessions (one, a principal's, or a bundle's) and the termination reason",
      outputs: 'how many sessions were ended; sessions already ended keep their reason',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
  },
};

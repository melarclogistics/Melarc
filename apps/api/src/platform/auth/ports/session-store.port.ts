import type { PortDescriptor } from './port-descriptor.js';
import type { TransactionHandle } from './unit-of-work.port.js';

/** The contract's `SessionRecord.termination_reason` (openapi.yaml), without the null. */
export const SESSION_TERMINATION_REASONS = [
  'SIGNED_OUT',
  'SUPERSEDED_BY_NEW_LOGIN',
  'REPLACED_BY_NEW_SESSION',
  'EXPIRED',
  'CREDENTIAL_CHANGED',
  'SUSPENDED',
  'OFFBOARDED',
  'ADMIN_REVOKED',
  'AUTHORITY_CHANGED',
  'HUB_SCOPE_CHANGED',
  'DEVICE_REVOKED',
  'DEVICE_REPLACED',
  'MFA_RESET',
] as const;
export type SessionTerminationReason = (typeof SESSION_TERMINATION_REASONS)[number];

/** The three authentication models, which never mix (domain-model.md §6.8, `Session.principal_type`). */
export const SESSION_PRINCIPAL_TYPES = ['STAFF', 'RIDER', 'VENDOR'] as const;
export type SessionPrincipalType = (typeof SESSION_PRINCIPAL_TYPES)[number];

/** The rider app's own root-detection result, recorded at issue: a risk signal and never an authentication control. */
export const CLIENT_ROOT_SIGNALS = ['NOT_DETECTED', 'DETECTED', 'UNKNOWN'] as const;
export type ClientRootSignal = (typeof CLIENT_ROOT_SIGNALS)[number];

/** One permission a bundle grants, as the bundle held it when the session was issued (permissions.md §5). */
export interface BundleGrantSnapshot {
  readonly permission: string;
  readonly hubScope: 'none' | 'own' | 'all';
  readonly ownershipScope: 'own' | 'assigned' | 'any';
  /** Null where the catalogue gives the holder no tier (Finance, Rider, Vendor). */
  readonly tier: 'A' | 'S' | 'P' | null;
}

/**
 * The format of `session.bundle_snapshot`, which is **persisted**: every session carries one, an instance reads sessions that an
 * older or a newer instance issued, and the authorization step (S0.26) reads the grants from it. A change to the shape raises the
 * `format`, and the reader refuses a format it does not know (a session it cannot read is not trusted).
 */
export const BUNDLE_SNAPSHOT_FORMAT = 1;

/**
 * The `RoleBundle` as held at issue (domain-model.md §6.8, `Session.bundle_snapshot`): a copy of its content, never a reference to
 * the live bundle, so that history reads correctly and a session keeps the authority it was issued with until a reduction ends it.
 * `bundle_id` and `bundle_revision` are columns of the session beside it (lineage, not authority); the name is kept so a timeline
 * can say which bundle it was without joining to a bundle that may since have been renamed.
 */
export interface BundleSnapshot {
  readonly format: typeof BUNDLE_SNAPSHOT_FORMAT;
  readonly name: string;
  readonly audience: SessionPrincipalType;
  /** Whether the bundle is privileged (Senior Ops, Platform Admin and no other): decides the session's lifetime and idle limit. */
  readonly privileged: boolean;
  /** The bundle's grants, ordered by permission key. */
  readonly grants: readonly BundleGrantSnapshot[];
}

/**
 * The immutable authority a session was issued with: the permission snapshot and its lineage. A session never reads the live
 * bundle, so a snapshot is correct history; it is trusted only while its `bundleRevision` is at or above the bundle's
 * `reduction_floor` (SECURITY_DESIGN.md §13.10a).
 */
export interface SessionAuthority {
  readonly bundleId: string;
  readonly bundleRevision: number;
  /**
   * The compiled fixed-policy revision of the instance that issued a Vendor or Rider session (SECURITY_DESIGN.md §13.10), and null
   * for staff. Lineage, not authority.
   */
  readonly policyRevision: number | null;
  readonly snapshot: BundleSnapshot;
  /** Resolved at issue from primary membership plus any effective assignment. An empty list means no hub-scoped rows, never all. */
  readonly authorizedHubIds: readonly string[];
}

export interface NewSession {
  readonly principalType: SessionPrincipalType;
  readonly principalId: string;
  /** The SHA-256 of the session token (`TokenService.hash`). The token itself is never stored. */
  readonly tokenHash: Uint8Array;
  readonly authority: SessionAuthority;
  /**
   * The fresh database time the issue decision was made on, after the locks. The session's `last_activity_at` starts here, and
   * `expiresAt` is this plus the lifetime of its tier.
   */
  readonly issuedAt: Date;
  /** The absolute end of the session. */
  readonly expiresAt: Date;
  /** Non-null for `RIDER` and `VENDOR` (the registered device), null for `STAFF`. */
  readonly registeredDeviceId?: string;
  /** `RIDER` only. */
  readonly clientRootSignal?: ClientRootSignal;
  /** The hash of the synchronizer token issued with a browser session (`TokenService.hash`); never for a rider. */
  readonly csrfTokenHash?: Uint8Array;
}

export interface StoredSession {
  readonly id: string;
  readonly principalType: SessionPrincipalType;
  readonly principalId: string;
  /** `ACTIVE` exactly while the session has not been terminated: derived from `terminated_at`, never stored beside it. */
  readonly state: 'ACTIVE' | 'TERMINATED';
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  readonly terminatedAt: Date | null;
  readonly terminationReason: SessionTerminationReason | null;
  readonly authority: SessionAuthority;
  readonly registeredDeviceId: string | null;
  readonly clientRootSignal: ClientRootSignal | null;
  readonly csrfTokenHash: Uint8Array | null;
}

/** Which sessions an invalidation reaches. */
export type SessionSelector =
  | { readonly by: 'session'; readonly sessionId: string }
  | {
      readonly by: 'principal';
      readonly principalType: SessionPrincipalType;
      readonly principalId: string;
    }
  | {
      readonly by: 'bundle';
      readonly bundleId: string;
      /**
       * Only the sessions issued from a revision of the bundle **below** this one: what a reduction ends, when it raises the floor
       * to the new revision (SECURITY_DESIGN.md §13.10a). Without it, every live session of the bundle.
       */
      readonly belowRevision?: number;
    };

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
  /** Ends the live sessions the selector names and returns their ids, so that whoever ended them can record each (in id order). */
  terminate(
    transaction: TransactionHandle,
    selector: SessionSelector,
    reason: SessionTerminationReason,
  ): Promise<readonly string[]>;
}

export const SESSION_STORE = Symbol('SESSION_STORE');

export const SESSION_STORE_DESCRIPTOR: PortDescriptor<SessionStore> = {
  port: 'SessionStore',
  owner: { kind: 'platform', area: 'auth/sessions' },
  operations: {
    create: {
      inputs:
        'the transaction and the new session: principal, token hash, authority (bundle, revision, snapshot, hubs), the time it was issued and its absolute end',
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
      outputs:
        'the ids of the sessions that were ended, in id order; sessions already ended keep their reason',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
  },
};

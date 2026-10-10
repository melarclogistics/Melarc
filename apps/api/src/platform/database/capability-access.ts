import type { TaskCapability } from './task-capabilities.js';
import { API_RUNTIME_ROLE, PROVISIONING_ROLE, WORKER_RUNTIME_ROLE } from './technical-roles.js';

/**
 * The access matrix per capability (data-scope-registry.md §5.2; SECURITY_DESIGN.md §14.1 and §14.17): for each task
 * capability, the technical identity that holds its grants, where a context under it is opened, the tables it may touch
 * with the statements it may run on each, how it looks rows up and what it returns.
 *
 * The registry owns the rules and this is their machine-readable form. A test reads the registry and fails when the
 * capabilities, their identities or their tables disagree, so a change is made in both in one change. The statements
 * and restrictions are kept as the registry words them: they say what the grants of the table's own migration must
 * be, and a catalogue check against them can only exist once the tables do (S0.8 onward).
 *
 * A capability is a label and not an identity. What stops code that already runs as the API from asserting one is the
 * grant set: the label is usable only against the tables listed here and only with the DML granted to the identity
 * that legitimately needs it. `capabilityPermittedFor` refuses a context whose capability is not its connection's.
 */

/** The technical identities that hold the grants of a capability (registry §5, `api`, `worker` and `provisioning`). */
export const IDENTITY_ROLES = {
  api: API_RUNTIME_ROLE,
  worker: WORKER_RUNTIME_ROLE,
  provisioning: PROVISIONING_ROLE,
} as const;

export type TechnicalIdentity = keyof typeof IDENTITY_ROLES;

export type Statement = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface TableAccess {
  /** The table by the registry's name. */
  readonly table: string;
  readonly statements: readonly Statement[];
  /** What the registry limits the statements to, in its words. */
  readonly restriction?: string;
}

export interface CapabilityAccess {
  readonly identity: TechnicalIdentity;
  /** The registry's "opened only by". */
  readonly opener: string;
  /**
   * The directories under `src/` that may open a context under the capability, as a check of source text can see it. A
   * task that opens one elsewhere changes this line, and a review sees it.
   */
  readonly openedUnder: readonly string[];
  readonly tables: readonly TableAccess[];
  readonly lookups: string;
  readonly returns: string;
}

const on = (
  tables: readonly string[],
  statements: readonly Statement[],
  restriction?: string,
): TableAccess[] =>
  tables.map((table) => ({
    table,
    statements,
    ...(restriction === undefined ? {} : { restriction }),
  }));

export const CAPABILITY_ACCESS: Readonly<Record<TaskCapability, CapabilityAccess>> = {
  authentication: {
    identity: 'api',
    opener:
      'The credential services of platform/auth: sign-in, challenge, setup, enrolment, recovery and session lookup',
    openedUnder: ['platform/auth/'],
    tables: [
      ...on(
        ['StaffIdentity', 'RiderIdentity', 'VendorAccount', 'VendorCredential'],
        ['SELECT', 'UPDATE'],
        'UPDATE of the credential record only (hash, failed-attempt count, lock time, establishment)',
      ),
      ...on(
        ['Session', 'MfaChallenge', 'RiderSignInChallenge', 'SetupGrant', 'RecoveryRequest'],
        ['SELECT', 'INSERT', 'UPDATE'],
        'UPDATE of state and counters',
      ),
      ...on(
        ['MfaFactor', 'RegisteredDevice'],
        ['SELECT', 'INSERT', 'UPDATE'],
        'UPDATE of status and replay counter',
      ),
      ...on(
        [
          'Permission',
          'RoleBundle',
          'RoleBundleGrant',
          'FixedPermissionPolicy',
          'Hub',
          'Setting',
          'ReasonCode',
        ],
        ['SELECT'],
      ),
      ...on(
        ['CredentialDeliveryJob'],
        ['INSERT', 'UPDATE'],
        'UPDATE of state and the payload column only, to cancel and erase when the redemption record is consumed, superseded or invalidated',
      ),
      ...on(
        ['IdempotencyRecord'],
        ['UPDATE'],
        'UPDATE that erases the sealed columns only, for the grant just consumed, superseded or invalidated',
      ),
      ...on(['AuditEvent'], ['INSERT']),
    ],
    lookups:
      'By the key the request presents; the credential repository port exposes by-key lookups and no list or scan method',
    returns:
      'What the decision needs (status, credential record, factor state, the bundle to snapshot) and never a credential value to a caller; no business table and no DELETE',
  },
  rate_limit: {
    identity: 'api',
    opener: 'The limiter adapter',
    openedUnder: ['platform/limiter/'],
    tables: on(['RateLimitAdmission'], ['SELECT', 'INSERT', 'DELETE'], 'DELETE of expired rows'),
    lookups: 'A bucket and a key digest',
    returns: 'The admitted timestamps in the window and nothing else',
  },
  seed: {
    identity: 'provisioning',
    opener: 'The seed command',
    openedUnder: ['platform/database/seed/', 'tools/seed/', 'tools/fixtures/'],
    tables: [
      ...on(
        [
          'Hub',
          'Setting',
          'ReasonCode',
          'Permission',
          'RoleBundle',
          'RoleBundleGrant',
          'FixedPermissionPolicy',
        ],
        ['INSERT'],
        'INSERT into an empty set',
      ),
      ...on(
        ['RiderIdentity'],
        ['INSERT'],
        'the non-production demonstration fixture of MIGRATION_AND_SEEDING.md §4a: Local and Staging only',
      ),
    ],
    lookups: 'No lookup',
    returns: 'Refuses when its target is not empty; production refuses the fixtures',
  },
  credential_delivery: {
    identity: 'worker',
    opener: 'The credential-delivery worker process',
    openedUnder: ['platform/delivery/worker/'],
    tables: [
      ...on(
        ['CredentialDeliveryJob'],
        ['SELECT', 'UPDATE'],
        'UPDATE of lease, attempt, outcome and the payload column (to erase it)',
      ),
      ...on(['SetupGrant', 'RecoveryRequest'], ['SELECT'], 'SELECT of state and expiry only'),
      ...on(['IdempotencyRecord'], ['UPDATE'], 'UPDATE that erases the sealed columns only'),
    ],
    lookups:
      'Claims jobs from its own table by state, due time and lease, never by scanning another table',
    returns:
      'Decrypts a payload in memory for the one send and never writes the decrypted value anywhere',
  },
  bootstrap: {
    identity: 'provisioning',
    opener: 'The bootstrap seed and the bootstrap-resume command',
    openedUnder: ['tools/bootstrap/'],
    tables: [
      ...on(['StaffIdentity'], ['INSERT'], 'the pair, in one transaction'),
      ...on(
        ['SetupGrant'],
        ['INSERT'],
        'BOOTSTRAP_SETUP, and the resume command’s MFA_REENROLMENT',
      ),
      ...on(['MfaFactor'], ['INSERT', 'UPDATE'], 'supersede a stale PENDING'),
      ...on(['AuditEvent'], ['INSERT']),
    ],
    lookups:
      'The seeded bootstrap identities only, under the conditions of MIGRATION_AND_SEEDING.md §3.3a',
    returns: 'The raw secret once, to the controlled channel, and never logged',
  },
};

/**
 * Whether the capability may be opened over a connection that runs as `role`. The role is the one the database
 * reports (`current_user`), compared exactly: no prefix, no case folding, and nothing for a role that is missing.
 */
export function capabilityPermittedFor(
  capability: TaskCapability,
  role: string | null | undefined,
): boolean {
  return (
    typeof role === 'string' && IDENTITY_ROLES[CAPABILITY_ACCESS[capability].identity] === role
  );
}

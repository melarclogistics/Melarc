import type { TaskCapability } from './task-capabilities.js';
import {
  API_RUNTIME_ROLE,
  MIGRATION_ROLE,
  PROVISIONING_ROLE,
  WORKER_RUNTIME_ROLE,
} from './technical-roles.js';

/**
 * The access matrix per capability (data-scope-registry.md §5.2; SECURITY_DESIGN.md §14.1 and §14.17): for each task
 * capability, the technical identity that holds its grants, where a context under it is opened, the tables it may touch
 * with the statements it may run on each, how it looks rows up and what it returns.
 *
 * The registry owns the rules and this is their machine-readable form. A test reads the registry and fails when the
 * capabilities, their identities or their tables disagree, so a change is made in both in one change. The statements
 * and restrictions are kept as the registry words them: they say what the grants of the table's own migration must
 * be, and the grants of the tables that exist are checked against them and the registry by `src/test-support/registry-grants.ts` (S0.8 onward).
 *
 * A capability is a label and not an identity. What stops code that already runs as the API from asserting one is the
 * grant set: the label is usable only against the tables listed here and only with the DML granted to the identity
 * that legitimately needs it. `capabilityPermittedFor` refuses a context whose capability is not its connection's.
 */

/**
 * The technical identities that hold the grants of a capability (registry §5, `api`, `worker`, `provisioning` and `migration`).
 * `migration` holds exactly one, `policy_change`, and no application process connects as it: the capability is asserted by the
 * two database functions of migration 0017 for their own statements, and only this identity may execute them.
 */
export const IDENTITY_ROLES = {
  api: API_RUNTIME_ROLE,
  worker: WORKER_RUNTIME_ROLE,
  provisioning: PROVISIONING_ROLE,
  migration: MIGRATION_ROLE,
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
          // The status of a vendor account's organisation, which a vendor's recovery is judged on (S0.50, credential-recovery.md 5.7).
          'VendorOrganization',
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
        ['SELECT', 'INSERT', 'UPDATE'],
        'UPDATE that erases the sealed columns only, for the grant just consumed, superseded or invalidated; and a vendor’s own unsealed record of requestAdditionalDeviceGrant, kept on its behalf (migration 0036, S0.49)',
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
    tables: [
      ...on(['RateLimitAdmission'], ['SELECT', 'INSERT', 'DELETE'], 'DELETE of expired rows'),
      ...on(
        ['Setting'],
        ['SELECT'],
        'the six rate_limit_* rows (the buckets names, settings.md section 7.7) and the sub-ceiling that is counted beside them (provider_initiating_operation_ceiling_per_minute, migration 0073), and no other row; no write (migration 0012, the Gate 2 correction, OB-102)',
      ),
    ],
    lookups: 'A bucket and a key digest',
    returns:
      'The admitted timestamps in the window and nothing else; reads the bucket limit in its own transaction',
  },
  configuration: {
    identity: 'api',
    opener:
      'The configuration reader of platform/settings, for a server-side rule evaluated on behalf of any principal',
    openedUnder: ['platform/settings/'],
    tables: [
      ...on(['HubSetting', 'ServiceZone', 'ServiceZoneAlias'], ['SELECT']),
      ...on(
        ['Hub'],
        ['SELECT'],
        'the hub the rule is evaluated for, for its name (the hub code of an operational code, MSC-DEC-202); no write (migration 0045)',
      ),
      ...on(
        ['Setting'],
        ['SELECT'],
        'the COMPANY-scope rows (the company-wide business rules, settings.md section 7.1) and no PLATFORM row; no write (migration 0042)',
      ),
    ],
    lookups: 'A hub and an instant; the company rules by key',
    returns:
      'The values in force at that instant with their hub, key, scope, version and value, and never a row of another hub or a PLATFORM setting',
  },
  seed: {
    identity: 'provisioning',
    opener: 'The seed command',
    openedUnder: ['platform/database/seed/', 'tools/seed/', 'tools/fixtures/'],
    tables: [
      ...on(
        ['ServiceZone', 'ServiceZoneAlias', 'HubSetting'],
        ['INSERT'],
        'additive and idempotent, and only inside melarc.seed_hub_configuration (migration 0042): the identity holds no privilege on these tables',
      ),
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
        'INSERT into an empty set, once, and only inside melarc.initialize_reference_data (migration 0005): the identity holds no privilege on these tables, and the function refuses unless all seven are empty',
      ),
      ...on(
        ['RiderIdentity'],
        ['INSERT'],
        'the non-production demonstration fixture of MIGRATION_AND_SEEDING.md §4a: Local and Staging only',
      ),
    ],
    lookups:
      'No lookup: the identity holds no privilege on the tables it seeds. The emptiness check is a count inside the initialization function, which returns the number of rows it inserted and nothing read',
    returns: 'Refuses when its target is not empty; production refuses the fixtures',
  },
  credential_delivery: {
    identity: 'worker',
    opener: 'The credential-delivery worker process',
    openedUnder: ['platform/delivery/worker/', 'platform/delivery/retention/'],
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
  notification: {
    identity: 'worker',
    opener: 'The notification lane of the delivery worker process',
    openedUnder: ['platform/notifications/'],
    tables: [
      ...on(
        ['Outbox'],
        ['SELECT', 'UPDATE'],
        'UPDATE of the relay bookkeeping only (state, schedule, lease, outcome); the envelope never changes',
      ),
      ...on(
        ['Notification'],
        ['SELECT', 'INSERT', 'UPDATE'],
        'INSERT queued, held-back or feed rows only, under the leased envelope; UPDATE of state, schedule, lease, outcome, provider reference and receipt bookkeeping',
      ),
      ...on(
        ['PickupRequest'],
        ['SELECT'],
        'the one request the envelope names, and the columns a message is made from',
      ),
      ...on(['AdHocSender'], ['SELECT'], 'the one sender of that request: name and number'),
      ...on(
        ['PickupManifest'],
        ['SELECT'],
        'the one manifest the envelope names (S1.21, migration 0062): its code, state, day, hub and rider, the columns the rider’s text is made from',
      ),
      ...on(
        ['RiderIdentity'],
        ['SELECT'],
        'the one rider that manifest is given to: id and number, the number read for one send and held in memory only (migration 0062)',
      ),
      ...on(
        ['CollectionHandshake'],
        ['SELECT'],
        'the one handshake of the request the envelope names (S1.27, migrations 0070 and 0073): its stop, direction, state, generation, key version, code length and end, the columns a code is made from, the length being the one the code was made with; never the digest, the counters or the officer’s note. The lane also executes the one operation that records a delivered code, which writes the row as the owner, and the one that gives it the number a fallback code is texted to (the vendor credential’s registered phone, for this request and while a fallback code is live; it reads neither the organisation nor the credential)',
      ),
      ...on(
        ['Setting'],
        ['SELECT'],
        'the key and the value of the three text-message rows (sms_enabled, sms_per_number_daily_limit, sms_daily_limit) and no other row; no write (migration 0056). It no longer reads the length of a handshake code: the length is kept with the code (migration 0073)',
      ),
    ],
    lookups:
      'Leases envelopes and messages from its own tables by state, due time and lease; reads a business table only for the one aggregate the leased envelope names, by that envelope’s identifiers',
    returns:
      'A message is made in memory from the aggregate and its template and handed to the provider; the number and the text are written nowhere, and the table keeps a masked hint and a count digest',
  },
  evidence_validation: {
    identity: 'worker',
    opener: 'The evidence validation lane of the delivery worker process',
    openedUnder: ['platform/evidence/'],
    tables: [
      ...on(
        ['Evidence'],
        ['SELECT', 'UPDATE'],
        'SELECT of the id, the state and the end of the upload window, of the records still PENDING_UPLOAD or already EXPIRED only (an update is checked against the read policy for the row it makes); UPDATE of the state, to EXPIRED, once the window has passed (S1.11, migration 0080): an abandoned capture is marked and kept, never deleted, and nothing else of a record is written',
      ),
    ],
    lookups:
      'Finds the abandoned captures in its own table by state and the end of the upload window, in bounded batches, and never reads another table',
    returns:
      'Marks a record expired and returns its identifier to nothing outside the process; no storage reference, no signed address and no byte of an object is read or written',
  },
  pickup_backstop: {
    identity: 'worker',
    opener: 'The failure backstop lane of the delivery worker process',
    openedUnder: ['platform/delivery/backstop/'],
    // Only inside melarc.failure_backstop_escalate (migration 0084): the capability role holds the EXECUTE of that function and no privilege on any table, and the policies that
    // admit the statements of the function name the capability, the owner (the function runs as the owner) and the rows it may reach.
    tables: [
      ...on(
        ['PickupRequest'],
        ['SELECT', 'UPDATE'],
        'only inside melarc.failure_backstop_escalate: SELECT of the confirmed requests and UPDATE of the moment of an escalation (escalated_at) of a confirmed request that has not been escalated and whose stop failed, and of nothing else; the guard of the request holds both rules for every writer',
      ),
      ...on(
        ['PickupStop'],
        ['SELECT'],
        'only inside melarc.failure_backstop_escalate: the stops that FAILED, to find the request whose failure has sat undecided and to say how long it has sat; no write',
      ),
      ...on(
        ['HubSetting'],
        ['SELECT'],
        'only inside melarc.failure_backstop_escalate: the value in force of stale_failure_backstop_hours of a hub and no other row; no write',
      ),
      ...on(
        ['AuditEvent'],
        ['INSERT'],
        'only inside melarc.failure_backstop_escalate: the one event pickup.request.escalated (enhanced), by SYSTEM with a null actor and the trigger BACKSTOP, about a request the same change has escalated',
      ),
    ],
    lookups:
      'Finds the confirmed requests of a hub whose stop failed longer ago than the hub’s threshold, oldest first, in bounded batches, taking the row lock with skip locked so that two lanes at once escalate a request once',
    returns:
      'The number of requests escalated, whether the batch was full, and the hubs whose threshold is missing or unusable; no identifier of a request, no note and no figure of a person leaves the function',
  },
  bootstrap: {
    identity: 'provisioning',
    opener: 'The bootstrap seed and the bootstrap-resume command',
    openedUnder: ['tools/bootstrap/'],
    // Only inside the four functions of migration 0019 (melarc.bootstrap_status, seed_bootstrap_administrators, bootstrap_identity_state
    // and resume_bootstrap_identity): the provisioning identity holds no privilege on any of these tables, as it holds none on the
    // seven of the seed, and the functions run as the owner and set the capability for their own statements.
    tables: [
      ...on(
        ['StaffIdentity'],
        ['SELECT', 'INSERT'],
        'the pair, in one transaction, only inside melarc.seed_bootstrap_administrators: the insert policy admits the bootstrap shape (origin BOOTSTRAP, ACTIVE, Platform Admin, no hub, no credential, the reserved system actor as maker and checker) and nothing else; SELECT counts the table, and a row lock (no change) is admitted for a bootstrap identity',
      ),
      ...on(
        ['SetupGrant'],
        ['SELECT', 'INSERT', 'UPDATE'],
        'BOOTSTRAP_SETUP, and the resume command’s MFA_REENROLMENT, PENDING and with no issuer; UPDATE ends a PENDING grant as SUPERSEDED or EXPIRED and nothing else',
      ),
      ...on(
        ['MfaFactor'],
        ['SELECT', 'UPDATE'],
        'revoke a stale PENDING factor, with no administrator, reason or episode, and nothing else; no insert',
      ),
      ...on(
        ['AuditEvent'],
        ['INSERT'],
        'six events, by SYSTEM with a null actor, tiered as the catalogue says: staff.identity.created, staff.identity.approved, auth.mfa.revoked and the summary of a resume, auth.bootstrap.resumed (enhanced, about a StaffIdentity), auth.setup_grant.issued and auth.setup_grant.superseded (ordinary)',
      ),
      ...on(['Session'], ['SELECT'], 'that no session of the identity is live (condition 5)'),
      ...on(['Setting'], ['SELECT'], 'recovery_link_ttl_minutes and no other row, no write'),
    ],
    lookups:
      'The seeded bootstrap identities only, under the conditions of MIGRATION_AND_SEEDING.md §3.3a, which the resume function judges under the identity’s row lock; the seed counts the whole staff table, under a lock, and refuses unless it is empty',
    returns: 'The raw secret once, to the controlled channel (a custody bundle), and never logged',
  },
  policy_change: {
    identity: 'migration',
    opener:
      'The two policy-change functions of migration 0017, which run as the owner for their own statements and are executable by the migration login alone',
    // No application context is opened under it. The one directory is the TypeScript door to the functions, so that the check of
    // source text has a place where the capability may be named, should one ever be.
    openedUnder: ['platform/authorization/policy-change/'],
    tables: [
      ...on(
        ['RoleBundle', 'FixedPermissionPolicy'],
        ['SELECT', 'UPDATE'],
        'only inside melarc.change_role_bundle and melarc.change_fixed_policy, under the exclusive policy lock: the revision, the floor and (for a bundle) the name; the identity holds no privilege of its own on these tables',
      ),
      ...on(
        ['RoleBundleGrant'],
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
        'only inside melarc.change_role_bundle, under the exclusive policy lock: the complete new set of the grants of one bundle',
      ),
    ],
    lookups:
      'By the bundle id or the principal type the caller names, each under its exclusive advisory lock, taken before anything is read',
    returns:
      'The kind of change, the new revision and floor, and the ids of the sessions it ended; the sessions and their audit events are written under the authentication capability inside the same transaction',
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

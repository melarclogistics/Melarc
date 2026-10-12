/**
 * A stored session carries a bundle snapshot of a format this build does not know (`BUNDLE_SNAPSHOT_FORMAT`). The session is valid
 * and the instance reading it is the wrong one, as when an instance is older than a fixed-policy revision (SECURITY_DESIGN.md
 * §13.10): so the platform answers the operational failure (`503`, retryable, no code) and the session is **not** ended, and the
 * next request, reaching a suitable instance, succeeds. A snapshot is never read as if it were of the format the build does know.
 */
export class SessionSnapshotUnreadableError extends Error {
  constructor(readonly format: unknown) {
    super('A session holds a bundle snapshot of a format this build does not read');
    this.name = 'SessionSnapshotUnreadableError';
  }
}

/**
 * A request presented a credential and no session store is composed to judge it. Credentials are never judged by guess: the
 * platform answers the operational failure and does not serve the request. (A request that presents no credential is refused
 * `SESSION_INVALID` whether or not a store exists.)
 */
export class AuthenticationUnavailableError extends Error {
  constructor() {
    super('A credential was presented and no session store is composed to judge it');
    this.name = 'AuthenticationUnavailableError';
  }
}

/** Why a session was not issued, from the closed list the sign-in operations map to their own outward answers. */
export type SessionIssueRefusal =
  | 'PRINCIPAL_NOT_FOUND'
  | 'PRINCIPAL_NOT_ACTIVE'
  | 'CREDENTIAL_NOT_ESTABLISHED'
  | 'CREDENTIAL_CHANGED'
  | 'BUNDLE_MISSING'
  | 'BUNDLE_AUDIENCE_MISMATCH';

/**
 * The issue protocol found, under the locks, that this principal may not be given a session: it does not exist, is not `ACTIVE`
 * (a pending, rejected, suspended or offboarded profile grants nothing), has no established credential, holds a credential other than
 * the one the caller verified (it was replaced after the verification, and ended every session with `CREDENTIAL_CHANGED`: a session
 * resting on the credential it replaced must not outlive that), or its bundle is missing or is not a bundle of its audience. The caller (a sign-in) has already judged the credential and the factor; this is the
 * protocol's own last check, on the state it read under the identity lock. Nothing was written.
 */
export class SessionIssueRefusedError extends Error {
  constructor(readonly reason: SessionIssueRefusal) {
    super(`A session was not issued: ${reason}`);
    this.name = 'SessionIssueRefusedError';
  }
}

/**
 * This instance cannot be sure of the fixed policy of a Vendor or a Rider, and so serves nothing of that type (SECURITY_DESIGN.md
 * §13.10): its compiled revision is below the stored `minimum_revision` (a release that reduced the policy has raised the floor),
 * it is older than the revision the session was issued under, it has no compiled revision for the type at all, or the seed has
 * not written the policy. The platform answers the operational
 * failure (`503`, retryable, no business code) and ends no session: the instance is the wrong one, not the principal.
 */
export class FixedPolicyUnavailableError extends Error {
  constructor(
    readonly principalType: 'VENDOR' | 'RIDER',
    readonly reason: 'BELOW_FLOOR' | 'OLDER_THAN_SESSION' | 'NOT_COMPILED' | 'NOT_SEEDED',
  ) {
    super(`This instance cannot serve the ${principalType} fixed policy: ${reason}`);
    this.name = 'FixedPolicyUnavailableError';
  }
}

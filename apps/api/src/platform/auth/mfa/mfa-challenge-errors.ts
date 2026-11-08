/**
 * The conditions the MFA challenge store raises. Each message is fixed text built from nothing that was supplied. A caller that
 * catches one answers the platform's generic operational failure; nothing here is shown to a client.
 */

/**
 * The request is not one the store will act on: a field is missing or malformed. A programming error in the caller, raised before
 * anything is written; `field` names the field and never its value.
 */
export class MfaChallengeRequestError extends Error {
  readonly code = 'MFA_CHALLENGE_REQUEST_INVALID';
  constructor(readonly field: string) {
    super('The MFA challenge request is not usable');
    this.name = 'MfaChallengeRequestError';
  }
}

/**
 * The challenge lapsed between the moment it was judged live and the moment it was consumed: the table's guard refused the consumption
 * on the database's clock (SQLSTATE 23514, reason `CHALLENGE_EXPIRED`). The statement failed, so the transaction is spoiled and rolls
 * back whole; the caller answers the sign-in as expired once it has (the audit of 21 October 2026, A06). It carries nothing of the
 * request, and not the server's error either.
 */
export class MfaChallengeExpiredError extends Error {
  readonly code = 'MFA_CHALLENGE_EXPIRED';
  constructor() {
    super('The MFA challenge expired before it was consumed');
    this.name = 'MfaChallengeExpiredError';
  }
}

/**
 * The transaction is not the authentication capability's. Row-level security would answer a read with no row and a write with none
 * changed, which reads as "no challenge": the store refuses before it touches a table, so that a refusal never looks like an absence.
 */
export class MfaChallengeContextError extends Error {
  readonly code = 'MFA_CHALLENGE_CONTEXT_INVALID';
  constructor() {
    super('MFA challenges are read and written under the authentication capability');
    this.name = 'MfaChallengeContextError';
  }
}

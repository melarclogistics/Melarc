/**
 * The conditions the rider challenge store raises. Each message is fixed text built from nothing that was supplied. A caller that catches
 * one answers the platform's generic operational failure or, where stated, the sign-in's own refusal; nothing here is shown to a client.
 */

/**
 * The request is not one the store will act on: a field is missing or malformed. A programming error in the caller, raised before anything
 * is written; `field` names the field and never its value.
 */
export class RiderChallengeRequestError extends Error {
  readonly code = 'RIDER_CHALLENGE_REQUEST_INVALID';
  constructor(readonly field: string) {
    super('The rider challenge request is not usable');
    this.name = 'RiderChallengeRequestError';
  }
}

/**
 * The challenge lapsed between the moment it was judged live and the moment it was consumed: the table's guard refused the consumption on the
 * database's clock (SQLSTATE 23514, reason `CHALLENGE_EXPIRED`, migration 0041). The statement failed, so the transaction is spoiled and rolls
 * back whole; the caller answers the sign-in as expired once it has. It carries nothing of the request, and not the server's error either.
 */
export class RiderChallengeExpiredError extends Error {
  readonly code = 'RIDER_CHALLENGE_EXPIRED';
  constructor() {
    super('The rider challenge expired before it was consumed');
    this.name = 'RiderChallengeExpiredError';
  }
}

/**
 * The transaction is not the authentication capability's. Row-level security would answer a read with no row and a write with none changed,
 * which reads as "no challenge": the store refuses before it touches a table, so that a refusal never looks like an absence.
 */
export class RiderChallengeContextError extends Error {
  readonly code = 'RIDER_CHALLENGE_CONTEXT_INVALID';
  constructor() {
    super('Rider sign-in challenges are read and written under the authentication capability');
    this.name = 'RiderChallengeContextError';
  }
}

/**
 * The conditions the setup-grant store raises. Each message is fixed text built from nothing that was supplied: what a request holds
 * is a principal, a token and a destination, and an error is the likeliest way for any of them to reach a log. A caller that catches
 * one answers the platform's generic operational failure; nothing here is shown to a client.
 */

/**
 * The request is not one the store will act on: a field is missing, malformed, or not allowed with the others (a purpose of another
 * kind of principal, a delivery for a grant that never travels as a message, an episode on a purpose that carries none). It is a
 * programming error in the caller, raised before anything is written, and `field` names the field and never its value.
 */
export class SetupGrantRequestError extends Error {
  readonly code = 'SETUP_GRANT_REQUEST_INVALID';
  constructor(readonly field: string) {
    super('The setup grant request is not usable');
    this.name = 'SetupGrantRequestError';
  }
}

/**
 * The grant lapsed between the moment it was judged live and the moment it was consumed: the table's guard refused the consumption on
 * the database's clock (SQLSTATE 23514, reason `GRANT_EXPIRED`), as a statement that waited for a lock can meet it. The statement
 * failed, so the transaction is spoiled and must roll back whole; the caller lets it, and answers the grant as one that cannot be used
 * (the audit of 21 October 2026, A06). It carries nothing of the request, and not the server's error either.
 */
export class SetupGrantExpiredError extends Error {
  readonly code = 'SETUP_GRANT_EXPIRED';
  constructor() {
    super('The setup grant expired before it was consumed');
    this.name = 'SetupGrantExpiredError';
  }
}

/**
 * The transaction is not the authentication capability's. Row-level security would answer such a statement with nothing (an update
 * that reaches no row reads as "no grant to consume"), so the store refuses before it touches a table: a refusal must not look like
 * the ordinary absence of a grant.
 */
export class SetupGrantContextError extends Error {
  readonly code = 'SETUP_GRANT_CONTEXT_INVALID';
  constructor() {
    super('Setup grants are issued and consumed under the authentication capability');
    this.name = 'SetupGrantContextError';
  }
}

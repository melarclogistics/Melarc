/**
 * The conditions the MFA factor store raises. Each message is fixed text built from nothing that was supplied: what a request holds
 * is a seed, and an error is the likeliest way for a seed to reach a log. A caller that catches one answers the platform's generic
 * operational failure; nothing here is shown to a client.
 */

/**
 * The request is not one the store will act on: a field is missing or malformed, or not allowed with the others (an episode on a
 * factor an onboarding creates, a purpose that creates no factor). A programming error in the caller, raised before anything is
 * written; `field` names the field and never its value.
 */
export class MfaFactorRequestError extends Error {
  readonly code = 'MFA_FACTOR_REQUEST_INVALID';
  constructor(readonly field: string) {
    super('The MFA factor request is not usable');
    this.name = 'MfaFactorRequestError';
  }
}

/**
 * The transaction is not the authentication capability's. Row-level security would answer a read with no row and a write with none
 * changed, which reads as "no factor": the store refuses before it touches a table, so that a refusal never looks like an absence.
 */
export class MfaFactorContextError extends Error {
  readonly code = 'MFA_FACTOR_CONTEXT_INVALID';
  constructor() {
    super('MFA factors are read and written under the authentication capability');
    this.name = 'MfaFactorContextError';
  }
}

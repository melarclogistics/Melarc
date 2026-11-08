/**
 * The conditions the trusted-browser store raises. Each message is fixed text built from nothing that was supplied. A caller that catches
 * one answers the platform's generic operational failure; nothing here is shown to a client.
 */

/**
 * The request is not one the store will act on: a field is missing or malformed. A programming error in the caller, raised before anything
 * is written; `field` names the field and never its value.
 */
export class TrustedBrowserRequestError extends Error {
  readonly code = 'TRUSTED_BROWSER_REQUEST_INVALID';
  constructor(readonly field: string) {
    super('The trusted browser request is not usable');
    this.name = 'TrustedBrowserRequestError';
  }
}

/**
 * The transaction is not the authentication capability's. Row-level security would answer a read with no row and a write with none
 * changed, which reads as "no trusted browser": the store refuses before it touches a table, so a refusal never looks like an absence.
 */
export class TrustedBrowserContextError extends Error {
  readonly code = 'TRUSTED_BROWSER_CONTEXT_INVALID';
  constructor() {
    super('Trusted browsers are issued, used and replaced under the authentication capability');
    this.name = 'TrustedBrowserContextError';
  }
}

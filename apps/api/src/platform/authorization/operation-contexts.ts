import type { StoredSession } from '../auth/ports/session-store.port.js';
import type { SecurityContext } from '../database/transaction-context.js';
import {
  contextOfAuthorization,
  type AuthorizedRequest,
  type OperationContextOptions,
} from './authorized-request.js';

/**
 * Where a Vendor session's organisation comes from. A session records the vendor **account**, not the organisation it belongs to,
 * and the organisation is a vendor fact: the vendor domain resolves it (`session-context.ts`), so the platform asks for it through
 * this and holds no vendor table of its own. It is a read of an authoritative record, not a value taken from the session or the
 * request.
 */
export type VendorOrganizationResolver = (
  session: Pick<StoredSession, 'principalId'>,
) => Promise<string>;

export const VENDOR_ORGANIZATION_RESOLVER = Symbol('VENDOR_ORGANIZATION_RESOLVER');

/**
 * A Vendor session reached an operation and nothing is composed to say which organisation its account belongs to. The operation is
 * not served by guess: the platform answers the operational failure (`503`, no code) and ends no session. (No Vendor directory is
 * built in this slice until S0.47; a fixture supplies the resolver.)
 */
export class VendorOrganizationUnavailableError extends Error {
  constructor() {
    super('A vendor session acts and no resolver of its organisation is composed');
    this.name = 'VendorOrganizationUnavailableError';
  }
}

/**
 * Builds the security context of an authorized operation (`contextOfAuthorization`), resolving what the platform cannot know.
 * The one such thing is a Vendor's organisation. The principal, the surface and the grant come from the decision and never from the
 * request.
 */
export class OperationContexts {
  readonly #vendorOrganization: VendorOrganizationResolver | undefined;

  constructor(vendorOrganization?: VendorOrganizationResolver) {
    this.#vendorOrganization = vendorOrganization;
  }

  async of(authorized: AuthorizedRequest, correlationId: string): Promise<SecurityContext> {
    const options: OperationContextOptions = { correlationId };
    if (authorized.session.principalType !== 'VENDOR') {
      return contextOfAuthorization(authorized, options);
    }
    if (this.#vendorOrganization === undefined) throw new VendorOrganizationUnavailableError();
    const vendorOrganizationId = await this.#vendorOrganization(authorized.session);
    return contextOfAuthorization(authorized, { ...options, vendorOrganizationId });
  }
}

import { SURFACE_OF_PRINCIPAL, type SecurityContext } from '../../database/transaction-context.js';
import type { StoredSession } from '../ports/session-store.port.js';

export interface SessionContextOptions {
  /** The request's id: what the audit and the logs correlate on. */
  readonly correlationId: string;
  /**
   * The organisation of a vendor account, which the vendor domain resolves (a session records the account, not the organisation it
   * belongs to). Required for a vendor session and refused by the context validation when it is missing; ignored for any other.
   */
  readonly vendorOrganizationId?: string;
}

/**
 * The security context of the request a session authenticated (SECURITY_DESIGN.md §14.1b; plan obligation OB-54). It is built **only
 * from an authenticated, active session** and **always carries the session's id**, so that the transaction a use case opens, and
 * every event it writes, can say which session acted. The principal and the surface are the session's: the surface is the one
 * surface each principal type works through, and a pairing the table does not list is refused by the context validation.
 *
 * What it does not carry is the authorization step's to supply from the grant that authorizes the operation, never from the
 * session as a whole: the permission key, the hub scope mode and the effective hubs (`ALL` is never inferred from a bundle). A task
 * capability belongs to a `SYSTEM` context, and a session's principal is never one.
 */
export function contextOfSession(
  session: StoredSession,
  options: SessionContextOptions,
): SecurityContext {
  if (session.state !== 'ACTIVE') {
    throw new Error('A context is built from an active session, and this one is not active');
  }
  const base = {
    principalType: session.principalType,
    principalId: session.principalId,
    sessionId: session.id,
    surface: SURFACE_OF_PRINCIPAL[session.principalType],
    correlationId: options.correlationId,
  } as const;
  switch (session.principalType) {
    case 'STAFF':
      return base;
    case 'RIDER':
      return { ...base, riderId: session.principalId };
    case 'VENDOR':
      return {
        ...base,
        ...(options.vendorOrganizationId === undefined
          ? {}
          : { vendorOrganizationId: options.vendorOrganizationId }),
      };
  }
}

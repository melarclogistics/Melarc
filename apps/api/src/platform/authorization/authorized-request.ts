import type { Request } from 'express';

import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import { contextOfSession } from '../auth/sessions/session-context.js';
import type { SecurityContext } from '../database/transaction-context.js';
import type { ActivityPolicy } from '../routes/access-declaration.js';
import type { EffectiveScope } from './effective-scope.js';

/**
 * What the authorization step decided for one request, kept beside the request (S0.26): the session that acts, the grant that
 * authorizes the operation, the scope that grant gives it and the activity policy of the route. The use case reads it to open its
 * transaction under the context the decision describes, and a use case cannot widen it: the context is built here from the
 * decision and from nothing the client sent.
 */
export interface AuthorizedRequest {
  readonly session: StoredSession;
  readonly credential: 'COOKIE' | 'BEARER';
  /** The idle limit of the session's tier (none for a rider), carried from authentication for the locked revalidation. */
  readonly idleMinutes: number | null;
  /** The database instant authentication judged the session at: how fresh the recorded activity of `session` is. */
  readonly judgedAt: Date;
  /** The permission key the operation requires; undefined for a `self` operation. */
  readonly permission: string | undefined;
  /** The session's snapshot of the grant that authorizes the operation; undefined for a `self` operation. */
  readonly grant: BundleGrantSnapshot | undefined;
  readonly scope: EffectiveScope;
  readonly activity: ActivityPolicy;
  /** Whether the method changes state, which decides the lock protocol of the use case's transaction. */
  readonly stateChanging: boolean;
  /**
   * The record the route names and, where the route declares one, the tier rule that applies to it: kept so that the transaction
   * that acts can judge the rule again on the record as it then is (`OperationRunner.requireTargetTier`).
   */
  readonly target?: { readonly entity: string; readonly id: string; readonly tierRule?: string };
}

const held = new WeakMap<object, AuthorizedRequest>();

/** Keeps the decision beside the request. A weak map: no code can set it by assigning to the request, and it goes with the request. */
export function holdAuthorization(request: Request, authorized: AuthorizedRequest): void {
  held.set(request, authorized);
}

export function authorizationOf(request: Request): AuthorizedRequest | undefined {
  return held.get(request);
}

export interface OperationContextOptions {
  readonly correlationId: string;
  /** The organisation of a vendor account, which the vendor domain resolves; required for a vendor session. */
  readonly vendorOrganizationId?: string;
}

/**
 * The security context of the operation a decision authorizes (SECURITY_DESIGN.md sections 14.1 and 14.1a). The principal, the
 * surface and the session are the session's; **the permission key, the hub mode and the hub set are the authorizing grant's**
 * (`GBT-GS7`, `GBT-GS8`), and a `self` operation carries none of the three. Nothing here is taken from the request.
 */
export function contextOfAuthorization(
  authorized: AuthorizedRequest,
  options: OperationContextOptions,
): SecurityContext {
  const base = contextOfSession(authorized.session, options);
  if (authorized.permission === undefined) return base;
  return {
    ...base,
    authorizationKey: authorized.permission,
    hubScopeMode: authorized.scope.hubScopeMode,
    authorizedHubIds: authorized.scope.authorizedHubIds,
  };
}

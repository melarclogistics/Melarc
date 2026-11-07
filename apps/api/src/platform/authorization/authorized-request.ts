import type { Request } from 'express';

import type { BundleGrantSnapshot, StoredSession } from '../auth/ports/session-store.port.js';
import { contextOfSession } from '../auth/sessions/session-context.js';
import type { SecurityContext } from '../database/transaction-context.js';
import type { ActivityPolicy } from '../routes/access-declaration.js';
import {
  effectiveScope,
  scopeExcludesHub,
  scopeIncludesHub,
  type EffectiveScope,
} from './effective-scope.js';

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

/**
 * The session's snapshot of the grant of one permission key, or `undefined` where the bundle it was issued with held none: step 5 of the
 * refusal order reads it here, and so does everything that asks "may this session do what that key allows". It is read from the snapshot
 * taken at issue, never from the live bundle.
 */
export function grantOfSession(
  session: Pick<StoredSession, 'authority'>,
  permission: string,
): BundleGrantSnapshot | undefined {
  return session.authority.snapshot.grants.find((candidate) => candidate.permission === permission);
}

/**
 * The decision the authorization step would have taken for **the same request** on an operation that requires `permission`: the same
 * session, the same credential and judgement, the grant of that key from the session's snapshot, and the scope of that grant
 * (`effectiveScope`, the one function the guard calls, with the hubs the session reaches). `undefined` where the session holds no grant of
 * the key, which is the answer "this session may not do that".
 *
 * It exists for an operation that answers about **several** keys at once (`getQueueSummary` counts what a queue's own list would return,
 * and `lookupRecords` finds what each kind's own read would show; a list or a read is under the context of its own key): each key's work
 * is then run in the context of that key's grant, and **never in a wider one**. A grant of all hubs that the session holds for another key does not widen this one (`GBT-GS1`), because the scope is read
 * from the grant of the key asked for and from nothing else. Nothing is taken from the request; the activity policy stays the route's.
 */
export function authorizationForKey(
  authorized: AuthorizedRequest,
  permission: string,
): AuthorizedRequest | undefined {
  const grant = grantOfSession(authorized.session, permission);
  if (grant === undefined) return undefined;
  return {
    ...authorized,
    permission,
    grant,
    scope: effectiveScope(grant, authorized.session.authority.authorizedHubIds),
  };
}

/**
 * Whether a **staff** read that names `hubId` in a filter names a hub its grant (the grant of this decision's key, as `authorizationForKey`
 * made it) does not reach, so that its answer is empty before any statement is asked (task A1, `AC-HUBF-05`; `scopeExcludesHub`): a hub outside
 * the grant and a hub that does not exist take the same, short time, because neither opens a transaction. `false` for a Vendor or a Rider, whose
 * rows are scoped by what they own and not by a hub, for an all-hub grant and for a hub inside the grant: those read as they always did.
 * `hubId` is already judged to be a UUID by the caller.
 */
export function hubOutsideStaffGrant(authorized: AuthorizedRequest, hubId: string): boolean {
  return authorized.session.principalType === 'STAFF' && scopeExcludesHub(authorized.scope, hubId);
}

/**
 * Whether `hubId` is a hub the session itself belongs to, whatever the grant of this operation reaches: `authority.authorizedHubIds`, which the
 * session was issued with and which for a staff member is its primary hub (`postgres.staff-identity-directory.adapter.ts`; an effective assignment
 * would add to it). It reads nothing from the database. It exists for the one staff list whose table shows a row to its holder whatever the grant
 * (`listStaffIdentities`: a profile's own row), so that a `hub_id` that names the caller's own hub is not answered empty by `hubOutsideStaffGrant`
 * and the filter only ever narrows what the same session sees without it (task A3.5, `AC-HUBF-14`). Every other hub is still answered without a
 * statement, so a hub that exists and a hub that does not take the same short time.
 */
export function hubOfTheSession(authorized: AuthorizedRequest, hubId: string): boolean {
  return scopeIncludesHub(
    { hubScopeMode: 'SET', authorizedHubIds: authorized.session.authority.authorizedHubIds },
    hubId,
  );
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

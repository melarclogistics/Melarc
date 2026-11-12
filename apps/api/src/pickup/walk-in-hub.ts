import type { EffectiveScope } from '../platform/authorization/effective-scope.js';

/**
 * The hub of a walk-in booking (`createPickupRequest`, `pickup_intent: ADHOC_SENDER`; task P1; `AC-SLICE-001-82`; permissions.md section 5):
 * the walk-in is the office's booking, in a hub of the grant of the Ops member who makes it. Their own hub (the primary hub on their record)
 * is the answer while the grant reaches exactly that one; **a grant that reaches more than one hub (a grant of all hubs, as the Platform
 * Admin's is, or of several hubs of its own) makes the person name the hub**, because the server never picks one for them.
 *
 * The rule is the grant's and is the same however many hubs the company has today: a client that works with one hub does not stop working
 * when a second is opened, and a Platform Admin is never booked into a hub it did not choose.
 */
export function coversMoreThanOneHub(scope: EffectiveScope): boolean {
  return scope.hubScopeMode === 'ALL' || scope.authorizedHubIds.length > 1;
}

export type WalkInHub =
  /** The person named a hub: the booking transaction checks it exists and that the grant reaches it. */
  | { readonly kind: 'named'; readonly hubId: string }
  /** The grant reaches more than one hub and none was named: a validation failure of `/hub_id`. */
  | { readonly kind: 'must-name' }
  /** The grant reaches one hub or none and none was named: the hub on the member's own record (absent: the booking is outside the grant). */
  | { readonly kind: 'own' };

export function walkInHubChoice(scope: EffectiveScope, named: string | undefined): WalkInHub {
  if (named !== undefined) return { kind: 'named', hubId: named };
  return coversMoreThanOneHub(scope) ? { kind: 'must-name' } : { kind: 'own' };
}

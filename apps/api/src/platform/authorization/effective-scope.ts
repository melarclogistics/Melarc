import type { BundleGrantSnapshot } from '../auth/ports/session-store.port.js';
import type { HubScopeMode } from '../database/transaction-context.js';

/**
 * The hub scope an operation runs under (S0.26; SECURITY_DESIGN.md sections 14.1a and 14.2; `GBT-GS1` to `GBT-GS12`): **the scope of
 * the grant that authorizes this operation, intersected with what the session can reach**, and nothing wider. It becomes the
 * `melarc.hub_scope_mode` and `melarc.authorized_hub_ids` of the operation's transaction, which row-level security reads.
 *
 * - **A grant scoped `own`** reaches the session's own hubs (`authorized_hub_ids`, resolved when it was issued from the primary hub
 *   and any effective assignment): the mode is `SET` and the set is that list. A session with no hub has an empty set, and **an empty
 *   set means no hub-scoped rows, never all of them** (`GBT-B5`).
 * - **A grant scoped `all`** is the explicit all-hub authority of that grant and of nothing else: the mode is `ALL`, and the set is
 *   empty because it is not used. There is no identity-level flag that does this, and an `all` grant held beside the one being
 *   exercised does not widen it (`GBT-GS1`): the scope is read from the grant of **this** operation.
 * - **A grant scoped `none`**, and an operation with no grant at all (a `self` operation), have no hub dimension: the mode is `SET`
 *   with an empty set, so a hub-scoped row is invisible to them. A resource that has no hub is judged by its own predicate and no
 *   hub requirement is made up for it (`GBT-GS11`); a hub-scoped row is not reached by a grant that has no hub (`GBT-GS12`).
 *
 * The result is a value; nothing here reads the database. The row-level security of each table is what enforces it.
 */
export interface EffectiveScope {
  readonly hubScopeMode: HubScopeMode;
  readonly authorizedHubIds: readonly string[];
}

/**
 * The hub scope as every place that decides it holds it: a mode and, for `SET`, the set of hubs. An `EffectiveScope` is one, and so is a
 * `SecurityContext` (whose two members are optional: a context with no mode and no set reaches no hub).
 */
export interface HubScope {
  readonly hubScopeMode?: HubScopeMode;
  readonly authorizedHubIds?: readonly string[];
}

/**
 * Whether `hubId` is a hub this scope **reaches**: every hub for `ALL`, and otherwise one of the hubs of the set, compared as lower-case text, as the
 * context writes them (a UUID in capitals is the same hub). **This is the one place the question is answered** (task A3.6 of the audit follow-up,
 * the Product Owner's decision of 7 November 2026): the booking of a request in a hub, the creation and change of a staff profile in a hub, the
 * probe that tells a hub outside the grant from a record that is not there, and the short answer of a list (`scopeExcludesHub`) all call it, so that
 * they cannot disagree about a hub. A test (`hub-in-grant-helper.test.ts`) fails on a second copy of the comparison. The caller has already judged
 * `hubId` to be a UUID. The set of an `ALL` scope is empty and is not read.
 */
export function scopeIncludesHub(scope: HubScope, hubId: string): boolean {
  if (scope.hubScopeMode === 'ALL') return true;
  const wanted = hubId.toLowerCase();
  return (scope.authorizedHubIds ?? []).some((each) => each.toLowerCase() === wanted);
}

/**
 * Whether `hubId` is a hub this scope **cannot** reach: the scope is a set of hubs (`SET`, which includes the empty set that reaches nothing) and
 * the hub is not in it. It is the answer the row-level security of a hub-scoped table gives for that hub (`melarc.hub_scope_mode() = 'ALL' OR
 * responsible_hub_id = ANY (melarc.authorized_hub_ids())`, and `authorized_hub_ids` is this very set, written to the transaction by
 * `contextOfAuthorization`), so a read that names such a hub in a filter can be answered **empty without opening a statement** (task A1,
 * `AC-HUBF-05`): the database would walk the hub's index and discard every row, and the time that takes tells a caller whether the hub exists
 * and how much it holds. `ALL` reaches every hub, so it excludes none: it is `scopeIncludesHub` turned round.
 *
 * A **staff** scope only: a Vendor's and a Rider's rows are scoped by what they own and not by a hub, so this answers nothing about them
 * (`hubOutsideStaffGrant` in `authorized-request.ts` is the form a service calls).
 */
export function scopeExcludesHub(scope: EffectiveScope, hubId: string): boolean {
  return !scopeIncludesHub(scope, hubId);
}

export function effectiveScope(
  grant: Pick<BundleGrantSnapshot, 'hubScope'> | undefined,
  sessionHubIds: readonly string[],
): EffectiveScope {
  switch (grant?.hubScope) {
    case 'all':
      return Object.freeze({ hubScopeMode: 'ALL', authorizedHubIds: Object.freeze([]) });
    case 'own':
      return Object.freeze({
        hubScopeMode: 'SET',
        authorizedHubIds: Object.freeze([...sessionHubIds]),
      });
    case 'none':
    case undefined:
      return Object.freeze({ hubScopeMode: 'SET', authorizedHubIds: Object.freeze([]) });
    default:
      // A scope this build does not know grants nothing: the narrowest reading, never the widest.
      return Object.freeze({ hubScopeMode: 'SET', authorizedHubIds: Object.freeze([]) });
  }
}

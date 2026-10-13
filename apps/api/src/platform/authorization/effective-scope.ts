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

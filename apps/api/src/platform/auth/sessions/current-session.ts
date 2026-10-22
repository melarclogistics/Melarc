import { sql } from 'drizzle-orm';

import { transactionOf } from '../../database/transaction-handle.js';
import type { PrincipalRef } from '../ports/identity-directory.port.js';
import type { StoredSession } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';

/**
 * The caller's own session as the caller sees it (contracts/openapi.yaml `CurrentSession`: `SessionRecord` plus `SessionDisplay`, both
 * display fields always present). It is the answer of the sign-ins that issue a browser session and of `getCurrentSession`.
 *
 * **It carries labels and keys, never authority**: the permission keys of the snapshot (never a role name or a bundle), the hubs by id
 * and display name, and the principal's name. No session credential, no token hash, no snapshot and no policy object appears here.
 */
export interface CurrentSessionView {
  readonly id: string;
  readonly principal_type: StoredSession['principalType'];
  readonly principal_id: string;
  readonly state: StoredSession['state'];
  readonly authorized_hub_ids: readonly string[];
  readonly permissions: readonly string[];
  readonly issued_at: string;
  readonly expires_at: string;
  readonly last_activity_at: string;
  readonly principal_display_name: string | null;
  readonly authorized_hubs: readonly { readonly id: string; readonly display_name: string }[];
}

/** What gives a principal's display name: the directory of the principal's own domain, through its port. */
export interface DisplayNames {
  displayName(transaction: TransactionHandle, ref: PrincipalRef): Promise<string | null>;
}

/**
 * Builds the view of a session in the caller's transaction. The hubs are read by id, in the order of their names, and a hub the
 * snapshot names that no longer exists is not invented: the list is the hubs there are, and it is never truncated.
 */
export async function currentSessionOf(
  transaction: TransactionHandle,
  session: StoredSession,
  names: DisplayNames,
): Promise<CurrentSessionView> {
  const ref: PrincipalRef = { type: session.principalType, id: session.principalId };
  const hubIds = [...session.authority.authorizedHubIds];
  const hubs =
    hubIds.length === 0
      ? []
      : (
          await transactionOf(transaction).execute(
            sql`select id, name from hub where id = any(${`{${hubIds.join(',')}}`}::uuid[]) order by name, id`,
          )
        ).rows.map((row) => {
          const hub = row as unknown as { id: string; name: string };
          return { id: hub.id, display_name: hub.name };
        });
  return {
    id: session.id,
    principal_type: session.principalType,
    principal_id: session.principalId,
    state: session.state,
    authorized_hub_ids: hubIds,
    // Keys only, from the snapshot, sorted and unique: the source of navigation and nothing more.
    permissions: [
      ...new Set(session.authority.snapshot.grants.map((grant) => grant.permission)),
    ].toSorted(),
    issued_at: session.issuedAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
    last_activity_at: session.lastActivityAt.toISOString(),
    principal_display_name: await names.displayName(transaction, ref),
    authorized_hubs: hubs,
  };
}

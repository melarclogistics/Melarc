import { sql } from 'drizzle-orm';

import type { AuthorizedRequest } from '../platform/authorization/authorized-request.js';
import type { OperationRunner } from '../platform/authorization/operation-runner.js';
import { transactionOf } from '../platform/database/transaction-handle.js';

/** One bundle as the maker's form sees it: what to send as `role_bundle_id`, what to call it, and whether approving it needs more. */
export interface AssignableStaffRoleBundleView {
  readonly id: string;
  readonly name: string;
  readonly requires_platform_admin_approval: boolean;
}

export interface AssignableStaffRoleBundlesServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
}

/**
 * `listAssignableStaffRoleBundles` (S0.35; `permission.assignable_bundle.read`, MSC-DEC-439, MSC-DEC-443): the staff role bundles a
 * maker may name when creating a staff profile, read in the transaction of the caller's own context on the lock-free read path.
 *
 * - **Only the bundles currently valid for assignment to human staff**: the bundles of the `STAFF` audience, never the fixed Rider and
 *   Vendor bundles, never a technical identity's capability set, and never one the Product Owner has only proposed (a proposed bundle
 *   is not in the table). The table holds the configuration and is the same at every hub: **the key's scope is none**, so no hub is named
 *   or evaluated and the key confers no cross-hub access to a staff record.
 * - **A minimal projection**: `id`, `name`, and `requires_platform_admin_approval`, which is the bundle's `privileged` flag (Senior Ops
 *   and Platform Admin): the existing approval policy, reported and not replaced. Choosing a bundle grants nothing, and
 *   `createStaffIdentity` validates the id itself and does not trust that it came from this list.
 * - **Not paged and no ETag**: the set is small and fixed by configuration. Ordered by name, then id, bytewise, so the order is the
 *   same on every database.
 */
export class AssignableStaffRoleBundlesService {
  readonly #options: AssignableStaffRoleBundlesServiceOptions;

  constructor(options: AssignableStaffRoleBundlesServiceOptions) {
    this.#options = options;
  }

  async list(
    authorized: AuthorizedRequest,
    correlationId: string,
  ): Promise<{ readonly items: readonly AssignableStaffRoleBundleView[] }> {
    return this.#options.runner.read(authorized, correlationId, async (handle) => {
      const result = await transactionOf(handle).execute(sql`
        select id, name, privileged from role_bundle where audience = 'STAFF' order by name collate "C", id`);
      return {
        items: (result.rows as unknown as { id: string; name: string; privileged: boolean }[]).map(
          (row) => ({
            id: row.id,
            name: row.name,
            requires_platform_admin_approval: row.privileged,
          }),
        ),
      };
    });
  }
}

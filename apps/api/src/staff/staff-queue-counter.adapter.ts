import { sql, type SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type { QueueCounter, QueueFilter } from '../platform/domain-ports/queue-counter.port.js';
import { readCount } from '../platform/queue-summary/read-count.js';
import { staffIdentityCriteria } from './staff-identity-criteria.js';

/**
 * The staff domain's side of `QueueCounter` (task C1; reporting-data-dictionary.md section 5.5.6): the approver's queue of staff profiles
 * waiting for approval, counted by the filter of the list the screen reads (`listStaffIdentities` with `status=PENDING_APPROVAL`) and by
 * the very function that list calls (`staffIdentityCriteria`). The list's key (`staff.read`) decides the scope: the caller opens the
 * transaction under the context of that grant, and row-level security shows a Senior Ops user the profiles of its hubs and a holder of the
 * all-hub grant every one. The decision key (`staff.identity.approve`) decides that the queue is the session's work; it decides nothing
 * about scope. Whether this approver may approve this profile (the maker's own, a bundle above their tier) is not part of the count: the
 * act refuses those, and the list shows them (`AC-SLICE-000-85`).
 *
 * **By hub (task C3, `AC-HUBF-04`)**: the filter's hub is the list's own `hub_id`, which `staffIdentityCriteria` applies to the profile's
 * **primary hub**. A profile with no primary hub is therefore in the count with no hub and in the count of no hub: the counts of the hubs
 * are not added up to the count of all hubs, and the contract says so.
 */
export const STAFF_QUEUE_STATEMENT = (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(created_at) as oldest
      from staff_identity
     where ${staffIdentityCriteria({ status: 'PENDING_APPROVAL', hubId: filter.hubId, pattern: null })}`;

export function staffQueueCounters(): readonly QueueCounter[] {
  return [
    {
      queue: 'STAFF_AWAITING_APPROVAL',
      listKey: 'staff.read',
      decisionKey: 'staff.identity.approve',
      count: (handle: TransactionHandle, filter: QueueFilter) =>
        readCount(handle, STAFF_QUEUE_STATEMENT(filter)),
    },
  ];
}

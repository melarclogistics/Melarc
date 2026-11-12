import { sql, type SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type {
  QueueCount,
  QueueCounter,
  QueueFilter,
} from '../platform/domain-ports/queue-counter.port.js';
import { readCount } from '../platform/queue-summary/read-count.js';
import { pickupManifestCriteria } from './pickup-manifest-criteria.js';
import {
  ANY_PICKUP_REQUEST,
  CUTOFF_REVIEW,
  pickupRequestCriteria,
  shownException,
} from './pickup-request-criteria.js';

/**
 * The pickup domain's side of `QueueCounter` (task C1; reporting-data-dictionary.md sections 5.5.1 to 5.5.5): the five queues of the
 * pickup desk, each counted **by the filter of the list the screen reads, and by the very function that list calls** for it
 * (`pickupRequestCriteria`, `pickupManifestCriteria`), so that a queue's count is what its list returns and the two cannot drift. The scope
 * is not written here: the caller opens the transaction under the context of the list's key (`pickup.read`), and row-level security does
 * the rest, exactly as it does for the list. One statement for each queue: `count(*)` and the oldest moment, over one predicate.
 *
 * **By hub (task C3, `AC-HUBF-04`)**: each statement takes the filter the list is given (`hubId`) and passes it into the criteria function its
 * list calls (`pickupRequestCriteria`, `pickupManifestCriteria`), so a hub's count is the number of records the list returns with that
 * `hub_id`. The hub is a statement parameter: the security context is the one the caller opened for the list's key, and a hub outside
 * its grant counts as 0.
 *
 * | Queue | List and filter | Oldest |
 * |---|---|---|
 * | `PICKUP_AWAITING_CONFIRMATION` | `listPickupRequests` `state=PENDING` | `created_at` |
 * | `PICKUP_CUTOFF_REVIEW` | `listPickupRequests` `state=CONFIRMED` and `cutoff_exception_state=PENDING_OPS_REVIEW` (task C1.1) | `confirmed_at` |
 * | `PICKUP_EXCEPTION_APPROVAL` | `listPickupRequests` `one_package_exception_state=REQUESTED`, of the pending requests alone (decision key `pickup.exception.approve`; task C1.1 and the decision of 6 November 2026) | `requested_at` of the exception shown |
 * | `PICKUP_UNMANIFESTED_POOL` | `listPickupRequests` `state=CONFIRMED` and `manifested=false` | `confirmed_at` |
 * | `PICKUP_RUNS_IN_PROGRESS` | `listPickupManifests` `state=IN_PROGRESS` | `started_at` |
 */
export const PICKUP_QUEUE_STATEMENTS = {
  PICKUP_AWAITING_CONFIRMATION: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(created_at) as oldest
      from pickup_request
     where ${pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, state: 'PENDING', hubId: filter.hubId })}`,

  PICKUP_CUTOFF_REVIEW: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(confirmed_at) as oldest
      from pickup_request
     where ${pickupRequestCriteria({ ...CUTOFF_REVIEW, hubId: filter.hubId })}`,

  PICKUP_EXCEPTION_APPROVAL: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(${shownException('requested_at')}) as oldest
      from pickup_request
     where ${pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, exceptionState: 'REQUESTED', hubId: filter.hubId })}`,

  PICKUP_UNMANIFESTED_POOL: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(confirmed_at) as oldest
      from pickup_request
     where ${pickupRequestCriteria({ ...ANY_PICKUP_REQUEST, state: 'CONFIRMED', manifested: false, hubId: filter.hubId })}`,

  PICKUP_RUNS_IN_PROGRESS: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(started_at) as oldest
      from pickup_manifest
     where ${pickupManifestCriteria({ state: 'IN_PROGRESS', serviceDate: null, hubId: filter.hubId })}`,
} as const;

const counted =
  (statement: (filter: QueueFilter) => SQL) =>
  (handle: TransactionHandle, filter: QueueFilter): Promise<QueueCount> =>
    readCount(handle, statement(filter));

export function pickupQueueCounters(): readonly QueueCounter[] {
  return [
    {
      queue: 'PICKUP_AWAITING_CONFIRMATION',
      listKey: 'pickup.read',
      count: counted(PICKUP_QUEUE_STATEMENTS.PICKUP_AWAITING_CONFIRMATION),
    },
    {
      queue: 'PICKUP_CUTOFF_REVIEW',
      listKey: 'pickup.read',
      count: counted(PICKUP_QUEUE_STATEMENTS.PICKUP_CUTOFF_REVIEW),
    },
    {
      queue: 'PICKUP_EXCEPTION_APPROVAL',
      listKey: 'pickup.read',
      decisionKey: 'pickup.exception.approve',
      count: counted(PICKUP_QUEUE_STATEMENTS.PICKUP_EXCEPTION_APPROVAL),
    },
    {
      queue: 'PICKUP_UNMANIFESTED_POOL',
      listKey: 'pickup.read',
      count: counted(PICKUP_QUEUE_STATEMENTS.PICKUP_UNMANIFESTED_POOL),
    },
    {
      queue: 'PICKUP_RUNS_IN_PROGRESS',
      listKey: 'pickup.read',
      count: counted(PICKUP_QUEUE_STATEMENTS.PICKUP_RUNS_IN_PROGRESS),
    },
  ];
}

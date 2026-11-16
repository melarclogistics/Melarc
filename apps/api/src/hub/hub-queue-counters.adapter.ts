import { sql, type SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../platform/auth/ports/unit-of-work.port.js';
import type {
  QueueCount,
  QueueCounter,
  QueueFilter,
} from '../platform/domain-ports/queue-counter.port.js';
import { readCount } from '../platform/queue-summary/read-count.js';

/**
 * The receiving side's part of `QueueCounter` (S1.35b; reporting-data-dictionary.md sections 5.5.7 and 5.5.8): the two queues of the hub's receiving
 * screens, each counted **by the very function its list calls** (`melarc.receiving_runs`, `melarc.missing_parcels`: migration 0107), so that a queue's
 * count is what its list returns and the two cannot drift. The function takes the hub of the filter as its own first argument (a statement parameter:
 * it narrows and never widens) and judges the caller's context itself (staff that read intakes, the hubs of the grant); the transaction is the
 * caller's, opened under the context of `hub.read`, and these statements open none.
 *
 * | Queue | List and filter | Oldest |
 * |---|---|---|
 * | `HUB_RECEIVING_RUNS_WAITING` | `listReceivingRuns` `view=waiting`: runs, never vendors or intakes | the least `handed_over_at` of the run's intakes that still wait |
 * | `HUB_MISSING_PARCELS_SEARCHING` | `listMissingParcels` `view=searching`: parcels, never vendors | the least `missing_marked_at` |
 *
 * The count names no declared count, vendor, parcel number or photo: a blind-count vendor's number is never reached. The limit that the two
 * functions require is the largest an integer holds, so that a count is exact and never capped.
 */
const EVERY_ROW = 2147483647;

export const HUB_QUEUE_STATEMENTS = {
  HUB_RECEIVING_RUNS_WAITING: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(w.oldest) as oldest
      from melarc.receiving_runs(${filter.hubId}::uuid, 'waiting', null::text, null::timestamptz, null::uuid, ${EVERY_ROW}::integer, null::uuid) as r
     cross join lateral (
       select min(i.handed_over_at) as oldest
         from pickup_intake as i
        where i.pickup_manifest_id = r.run_id and i.state = 'AWAITING_COUNT'
     ) as w`,

  HUB_MISSING_PARCELS_SEARCHING: (filter: QueueFilter): SQL => sql`
    select count(*)::int as count, min(m.missing_since) as oldest
      from melarc.missing_parcels(${filter.hubId}::uuid, 'searching', null::timestamptz, null::uuid, ${EVERY_ROW}::integer) as m`,
} as const;

const counted =
  (statement: (filter: QueueFilter) => SQL) =>
  (handle: TransactionHandle, filter: QueueFilter): Promise<QueueCount> =>
    readCount(handle, statement(filter));

export function hubQueueCounters(): readonly QueueCounter[] {
  return [
    {
      queue: 'HUB_RECEIVING_RUNS_WAITING',
      listKey: 'hub.read',
      count: counted(HUB_QUEUE_STATEMENTS.HUB_RECEIVING_RUNS_WAITING),
    },
    {
      queue: 'HUB_MISSING_PARCELS_SEARCHING',
      listKey: 'hub.read',
      count: counted(HUB_QUEUE_STATEMENTS.HUB_MISSING_PARCELS_SEARCHING),
    },
  ];
}

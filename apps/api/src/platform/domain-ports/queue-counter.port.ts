import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';

/**
 * The port through which the work waiting in a queue (a domain's) reaches the one read that counts them all, `getQueueSummary` (task C1;
 * reporting-data-dictionary.md section 5.5; SOLUTION_ARCHITECTURE.md section 5: `platform/` defines narrow ports, a domain implements the
 * ones it owns, and the composition root wires them).
 *
 * - **Owner:** the domain that owns the queue implements one counter for each queue it owns (`pickup/pickup-queue-counters.adapter.ts`,
 *   `staff/staff-queue-counter.adapter.ts`); `platform/queue-summary/` is the caller. The composition root binds them (`domain-ports.module.ts`).
 * - **A counter counts what its queue's own list returns, by the same predicate.** The list and the counter call one function for the
 *   filter (`pickup/pickup-request-criteria.ts`, ...), so that the two cannot drift; the scope is not the counter's to write: it is
 *   the row-level security of the transaction the caller opens, under the context of `listKey`.
 * - **Inputs:** the caller's transaction handle, always. It is opened by the caller under the security context of `listKey` (the hub mode
 *   and the hub set of the session's grant of that key, the key itself as the authorization key), and the counter reads on it: it opens
 *   no transaction, takes no connection of its own, sets no context and writes nothing.
 * - **Transactional requirement:** the caller's own transaction, and no other. The counters of one key share one snapshot (`REPEATABLE
 *   READ`), so that the counts of one key agree with each other.
 * - **Locks:** none. A count is a read; nothing is locked.
 * - **Failure:** a counter that cannot answer throws, and the whole read fails (`500`); the platform never answers with the counts it has
 *   and without the one it has not (a queue missing from the answer means "the session may not read it", and a failed read must never say
 *   that).
 */

/**
 * The queues that have a count: **a closed list, in the order the contract names them (`QueueId`)**; the answer is in this order. A
 * value is never renamed or reused, and a queue built later is added here, in the contract and in the data dictionary together.
 */
export const QUEUE_IDS = [
  'PICKUP_AWAITING_CONFIRMATION',
  'PICKUP_CUTOFF_REVIEW',
  'PICKUP_EXCEPTION_APPROVAL',
  'PICKUP_UNMANIFESTED_POOL',
  'PICKUP_RUNS_IN_PROGRESS',
  'STAFF_AWAITING_APPROVAL',
] as const;

export type QueueId = (typeof QUEUE_IDS)[number];

/** What a counter answers: the exact number of records, and when the oldest of them entered the queue (`null` when there is none). */
export interface QueueCount {
  readonly count: number;
  readonly oldestAt: Date | null;
}

export interface QueueCounter {
  readonly queue: QueueId;
  /**
   * The permission key of the queue's own list. It decides whether the session has the entry at all (a session whose bundle holds no
   * grant of it has none) and the scope the count is taken in (**the grant of this key**, never the widest grant the session holds).
   */
  readonly listKey: string;
  /**
   * The decision key of an approver's queue (`pickup.exception.approve`, `staff.identity.approve`): the queue is the session's work only
   * if it holds this key as well. It decides nothing about scope; the list's key does.
   */
  readonly decisionKey?: string;
  count(handle: TransactionHandle): Promise<QueueCount>;
}

/** The injection token of the counters of every queue, bound once, by the composition root. */
export const QUEUE_COUNTERS = Symbol('QUEUE_COUNTERS');

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import {
  authorizationForKey,
  grantOfSession,
  type AuthorizedRequest,
} from '../authorization/authorized-request.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import {
  QUEUE_IDS,
  type QueueCount,
  type QueueCounter,
  type QueueId,
} from '../domain-ports/queue-counter.port.js';

/** One queue's entry in the answer: its identifier, how many records it holds, and the moment the oldest entered it (absent when none). */
export interface QueueSummaryEntryView {
  readonly queue: QueueId;
  readonly count: number;
  readonly oldest_at?: string;
}

export interface QueueSummaryView {
  readonly queues: readonly QueueSummaryEntryView[];
}

export interface QueueSummaryServiceOptions {
  readonly runner: Pick<OperationRunner, 'read'>;
  /** The counter of every queue that has one, from the domains that own them. */
  readonly counters: readonly QueueCounter[];
  /**
   * Bounds every statement that follows it in the transaction it is given (the counts, and the commit) to at most `milliseconds` (a `SET LOCAL statement_timeout`, which ends with the
   * transaction), run before the first count of it. Required, so that no composition can leave a count unbounded.
   */
  readonly limitStatements: (handle: TransactionHandle, milliseconds: number) => Promise<void>;
}

/** The counts of one key are read in one `REPEATABLE READ` transaction: they are one picture of the data and agree with each other. */
const ONE_SNAPSHOT = { isolation: 'REPEATABLE READ' } as const;

/**
 * The longest a statement of the summary may run (`AC-QSUM-13`, the Product Owner's decision of 6 November 2026). The summary is read on every
 * page, so a count that runs long (the pool of confirmed requests reads the whole history until the marker of the plan's performance task) must
 * end as a failed read, which the Portal draws as a failure with a way to try again, and not hold a connection for as long as the pool allows.
 */
export const QUEUE_SUMMARY_STATEMENT_TIMEOUT_MS = 3000;

/**
 * `getQueueSummary` (task C1; master specification section 17.4; reporting-data-dictionary.md section 5.5): the count of the work waiting
 * in each queue the calling session may read, from one request.
 *
 * - **An entry exists for a queue the session may read, and only for those.** A queue is the session's when its bundle's snapshot holds
 *   **the key of the queue's own list** and, for an approver's queue, **the decision key** as well. A queue it may not read is **absent,
 *   never `0`**, so that the absence tells nothing and a `0` always means "read, and nothing waits". There is no permission of the
 *   summary's own, and none is added: the keys are the lists' keys and the decision keys that already exist.
 * - **Each count is taken in the context of the key of its own list**, never in a wider one (`authorizationForKey`: the grant of that
 *   key from the session's snapshot and the scope of that grant, by the function the authorization step calls). A session that holds
 *   `pickup.read` at its hubs and another key at all hubs is counted at its hubs for the pickup queues. The counts of one key are one
 *   transaction at `REPEATABLE READ`, run through `OperationRunner.read` like any read, and there is one transaction for each key the
 *   queues need (two at the most today: `pickup.read` and `staff.read`), because a transaction has one authorization key.
 * - **The count is the list's by construction**: each counter calls the same function for the filter as its list does
 *   (`pickupRequestCriteria` and the others), and row-level security does the scoping, as it does for the list.
 * - **It writes nothing, not even an audit event.** It returns no record and no page of records, so the `auth.hub_boundary.crossed` of a
 *   list is not written for it (audit.md section 6 says nothing of an aggregate; recorded as a finding for the Product Owner).
 * - **The answer is in the order of `QueueId`**, whatever the order the counters were given in; the client orders what it shows.
 * - **A counter that fails fails the read** (`500`; a count that outlasts its bound of 3 seconds fails it as the platform's `503`, `AC-QSUM-13`);
 *   a queue missing from the answer means "not the session's", and a failed read must never say that.
 */
export class QueueSummaryService {
  readonly #runner: Pick<OperationRunner, 'read'>;
  readonly #counters: readonly QueueCounter[];
  readonly #limitStatements: QueueSummaryServiceOptions['limitStatements'];

  constructor(options: QueueSummaryServiceOptions) {
    this.#runner = options.runner;
    this.#limitStatements = options.limitStatements;
    const known = new Set<QueueId>();
    for (const counter of options.counters) {
      if (known.has(counter.queue)) {
        throw new Error(`Two counters are composed for the queue ${counter.queue}`);
      }
      known.add(counter.queue);
    }
    // In the order of the contract's enumeration, so that the answer has one order whatever the composition gave.
    this.#counters = QUEUE_IDS.flatMap((queue) =>
      options.counters.filter((counter) => counter.queue === queue),
    );
  }

  async read(authorized: AuthorizedRequest, correlationId: string): Promise<QueueSummaryView> {
    // The queues the session may read, grouped by the key of their list (the context a count is taken in).
    const byKey = new Map<string, QueueCounter[]>();
    for (const counter of this.#counters) {
      if (counter.decisionKey !== undefined) {
        if (grantOfSession(authorized.session, counter.decisionKey) === undefined) continue;
      }
      const group = byKey.get(counter.listKey) ?? [];
      group.push(counter);
      byKey.set(counter.listKey, group);
    }

    const counted = new Map<QueueId, QueueCount>();
    for (const [key, group] of byKey) {
      // A session whose bundle holds no grant of the list's key has none of these queues: they are not counted, and not shown as 0.
      const forKey = authorizationForKey(authorized, key);
      if (forKey === undefined) continue;
      const counts = await this.#runner.read(
        forKey,
        correlationId,
        async (handle) => {
          // Bounded before the first count: a statement that runs longer than the limit ends the read, which then fails as any failed read does.
          await this.#limitStatements(handle, QUEUE_SUMMARY_STATEMENT_TIMEOUT_MS);
          const read: [QueueId, QueueCount][] = [];
          for (const counter of group) read.push([counter.queue, await counter.count(handle)]);
          return read;
        },
        ONE_SNAPSHOT,
      );
      for (const [queue, count] of counts) counted.set(queue, count);
    }

    return {
      queues: this.#counters.flatMap((counter): QueueSummaryEntryView[] => {
        const count = counted.get(counter.queue);
        if (count === undefined) return [];
        return [
          count.oldestAt === null
            ? { queue: counter.queue, count: count.count }
            : {
                queue: counter.queue,
                count: count.count,
                oldest_at: count.oldestAt.toISOString(),
              },
        ];
      }),
    };
  }
}

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import {
  authorizationForKey,
  grantOfSession,
  hubOutsideStaffGrant,
  type AuthorizedRequest,
} from '../authorization/authorized-request.js';
import type { OperationRunner } from '../authorization/operation-runner.js';
import { isUuid } from '../database/transaction-context.js';
import {
  ANY_HUB,
  QUEUE_IDS,
  type QueueCount,
  type QueueCounter,
  type QueueFilter,
  type QueueId,
} from '../domain-ports/queue-counter.port.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';

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

/** What a queue holds when the hub asked for is none its key's grant reaches: nothing waits, so there is no oldest moment. */
const NOTHING_WAITS: QueueCount = Object.freeze({ count: 0, oldestAt: null });

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
 * - **`hub_id` narrows and never widens** (task C3, `AC-HUBF-04`): it is the filter every queue's list is given, passed to every counter of
 *   every key group as a statement parameter. **It is never part of the context a count is taken in**: the `AuthorizedRequest` the runner is
 *   given is what it is without a hub, so a hub outside the grant of a queue's list key counts 0 in that queue (the entry is still there:
 *   the queue is the session's and nothing waits in that hub), a hub that does not exist counts 0 everywhere, and a queue the session may
 *   not read stays absent whatever the hub. A value that is not a UUID is refused before any transaction opens (`VALIDATION_FAILED`, 400).
 * - **A hub that a key's grant does not reach is counted 0 without a transaction or a statement** (task A1, `AC-HUBF-05`): the group of that key
 *   is answered at once with each of its queues at 0 (`hubOutsideStaffGrant`, decided key by key), so that a hub the session may not reach
 *   and a hub that does not exist take the same, short time; a key whose grant holds the hub, and an all-hub grant, still count.
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

  async read(
    authorized: AuthorizedRequest,
    correlationId: string,
    filter: QueueFilter = ANY_HUB,
  ): Promise<QueueSummaryView> {
    // A hub that is not a UUID is refused before anything is read: no transaction is opened for it, and no count of it is asked.
    if (filter.hubId !== null && !isUuid(filter.hubId)) {
      throw new ApiException(ErrorCode.ValidationFailed, 400, 'The request is not valid', {
        violations: [{ in: 'query', pointer: '/hub_id', rule: 'format' }],
      });
    }
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
      // A hub that this key's grant does not reach counts 0 in each of its queues **with no transaction and no statement** (task A1, `AC-HUBF-05`):
      // the database would walk the hub's index and discard every row, and how long that takes says whether the hub exists and how much it holds.
      // It is decided key by key, since a key's grant is what its counts run under: a key whose grant holds the hub still counts. The entries are
      // the ones that would have been counted, so the answer is the one row-level security gives (the summary names no hub).
      if (filter.hubId !== null && hubOutsideStaffGrant(forKey, filter.hubId)) {
        for (const counter of group) counted.set(counter.queue, NOTHING_WAITS);
        continue;
      }
      const counts = await this.#runner.read(
        forKey,
        correlationId,
        async (handle) => {
          // Bounded before the first count: a statement that runs longer than the limit ends the read, which then fails as any failed read does.
          await this.#limitStatements(handle, QUEUE_SUMMARY_STATEMENT_TIMEOUT_MS);
          const read: [QueueId, QueueCount][] = [];
          for (const counter of group)
            read.push([counter.queue, await counter.count(handle, filter)]);
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

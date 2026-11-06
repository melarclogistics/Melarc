import type { components } from '@melarc/api-client';

import { instantOf, isOneOf, isRecord } from '../staff/staff-shape';

/**
 * The runtime judgement of the answer of `getQueueSummary` (the same discipline as `staff-shape.ts`, U05 of 23 October 2026). A type is a
 * promise nobody checked at run time: a proxy's `{}` would be drawn as a menu with no counts that says nothing is wrong, a count that is a
 * string or a fraction as a figure beside a queue an officer works down. The guard is not a second description of the wire: the types stay
 * the contract's, and `test/queue-summary-contract.test.ts` reads the contract and holds the lists below to its schemas.
 *
 * **What each parser returns is what it judged and nothing else.** An entry is the queue, its count and, when the server gave one, the
 * moment its oldest record entered it; a property the contract adds and this does not read is not carried into a screen.
 *
 * **A queue this build does not know is dropped, and the rest is kept.** The contract's list of queues is closed, and a server newer than
 * the page may name one the page has no words, no icon and no link for. Refusing the whole answer would take the counts of every queue it
 * does know away from the menu; drawing it would put an identifier on a screen. It is left out, which is also what the page did before the
 * queue existed. (Every other disagreement with the contract refuses the whole answer, as everywhere else: a count that is not a whole
 * number, a queue twice, an age on an empty queue.)
 */
export const QUEUE_IDS = [
  'PICKUP_AWAITING_CONFIRMATION',
  'PICKUP_CUTOFF_REVIEW',
  'PICKUP_EXCEPTION_APPROVAL',
  'PICKUP_UNMANIFESTED_POOL',
  'PICKUP_RUNS_IN_PROGRESS',
  'STAFF_AWAITING_APPROVAL',
] as const;

export const QUEUE_SUMMARY_FIELDS = {
  QueueSummary: { required: ['queues'], optional: [], enums: {} },
  QueueSummaryEntry: {
    required: ['queue', 'count'],
    optional: ['oldest_at'],
    enums: { queue: QUEUE_IDS },
  },
} as const;

export type QueueName = components['schemas']['QueueId'];

/** One queue as the server counted it for the signed-in session. `oldestAt` is the moment its oldest record entered it; none when it is empty. */
export interface QueueCountView {
  readonly queue: QueueName;
  readonly count: number;
  readonly oldestAt: string | null;
}

export interface QueueSummaryView {
  /** The queues the session may read, in the order the server gave them. A queue the session may not read is not here, and is not `0`. */
  readonly queues: readonly QueueCountView[];
}

/** There are six queues; an answer with many more entries than the contract has queues is not the API's. */
const MAX_ENTRIES = QUEUE_IDS.length * 4;

function entryOf(body: unknown): QueueCountView | 'unknown-queue' | undefined {
  if (!isRecord(body)) return undefined;
  const { queue, count } = body;
  // A queue of a newer server is no entry here (see above); anything that is not a word at all is not an entry of the API's.
  if (typeof queue !== 'string') return undefined;
  if (!isOneOf(QUEUE_IDS, queue)) return 'unknown-queue';
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  const oldest = body.oldest_at;
  if (oldest === undefined) return { queue, count, oldestAt: null };
  // An age on a queue that holds nothing is a disagreement with the contract ("absent when `count` is 0"), not a moment to draw.
  if (count === 0) return undefined;
  const oldestAt = instantOf(oldest);
  return oldestAt === undefined ? undefined : { queue, count, oldestAt };
}

/** The summary the answer describes, or nothing when it is not one the screens may draw. */
export function parseQueueSummary(body: unknown): QueueSummaryView | undefined {
  if (!isRecord(body)) return undefined;
  const { queues } = body;
  if (!Array.isArray(queues) || queues.length > MAX_ENTRIES) return undefined;
  const seen = new Set<QueueName>();
  const kept: QueueCountView[] = [];
  for (const each of queues as unknown[]) {
    const entry = entryOf(each);
    if (entry === undefined) return undefined;
    if (entry === 'unknown-queue') continue;
    // The same queue twice cannot both be right, and the later would silently win in any map made from them.
    if (seen.has(entry.queue)) return undefined;
    seen.add(entry.queue);
    kept.push(entry);
  }
  return { queues: kept };
}

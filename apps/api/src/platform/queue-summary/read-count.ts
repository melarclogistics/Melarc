import type { SQL } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { timestampOf } from '../database/timestamps.js';
import { transactionOf } from '../database/transaction-handle.js';
import type { QueueCount } from '../domain-ports/queue-counter.port.js';

/** The row a counting statement returns: `count(*)::int as count, min(<the moment a record entered the queue>) as oldest`. */
export interface CountedRow {
  /** What the driver gives for `count(*)::int`: a number, or its text for a larger type; `null` is never given and is refused, not read as 0. */
  readonly count: number | string | null;
  readonly oldest: Date | string | null;
}

/**
 * What a queue's row says, read strictly:
 *
 * - the count is a whole, non-negative, safe integer, and anything else (a `null`, a negative, a fraction) is a defect that fails the read
 *   and is never turned into a number that looks right;
 * - the oldest moment is read as the instant it is (`timestampOf`, which truncates to the millisecond and never rounds up), and **a queue
 *   that holds records has one**: a count with no moment is a fault of the data the queue's columns promise (`pickup_request_confirmation_facts`,
 *   `pickup_manifest_start_facts`), and it fails the read rather than draw an age the server did not read;
 * - a queue with no records has no moment, whatever the statement said.
 */
export function queueCountOf(row: CountedRow | undefined): QueueCount {
  if (row === undefined) throw new TypeError('The count of a queue returned no row');
  const count = Number(row.count);
  if (!Number.isSafeInteger(count) || count < 0 || row.count === null || row.count === '') {
    throw new TypeError('The count of a queue is not a whole, non-negative number');
  }
  if (count === 0) return { count, oldestAt: null };
  if (row.oldest === null) throw new TypeError('A queue that holds records has an oldest one');
  return { count, oldestAt: timestampOf(row.oldest) };
}

/**
 * Runs the one statement that counts a queue and reads its row: `select count(*)::int as count, min(<the moment a record entered the
 * queue>) as oldest from <the queue's table> where <the criteria its list also calls>`. The statement is the queue's own (its counter
 * writes it, with the criteria it shares with its list); what is common to all of them is **how the answer is read** (`queueCountOf`).
 */
export async function readCount(handle: TransactionHandle, statement: SQL): Promise<QueueCount> {
  const result = await transactionOf(handle).execute(statement);
  return queueCountOf(result.rows[0] as unknown as CountedRow | undefined);
}

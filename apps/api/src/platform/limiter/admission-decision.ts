import type { RateLimitDecision } from '../auth/ports/rate-limiter.port.js';
import { MAX_BUCKET_LIMIT, WINDOW_SECONDS } from './limiter-parameters.js';

/**
 * How far past the window a row may read as leaving (S0.32): a row is stamped by the database's clock when it is admitted and judged by
 * the clock of the statement that reads it, and the clock of a server can read some tenths of a second **behind** a stamp it has
 * already written (a virtual machine whose clock is corrected; a server stepped by its time service; measured here on the development
 * machine at up to about 120 ms, in two reads of a hundred). A row stamped a little ahead of the reader is **reported** as leaving at
 * the end of the window, which is the longest a caller is ever told to wait. It is not true of the row: a row stamped ahead by some
 * seconds stays counted that many seconds longer than the window, so a caller told to wait a whole window can be refused once more
 * (by at most this tolerance). The value is a provisional engineering one (`delivery/planning/SLICE-000-IMPLEMENTATION-PLAN.md`,
 * decision 8 of S0.32), calibrated with the other limits at S0.65. A row further ahead than this is not skew but a clock that cannot
 * be trusted, and the limiter still fails closed on it.
 */
export const CLOCK_SKEW_TOLERANCE_SECONDS = 5;

/**
 * The whole seconds a refused caller is told to wait: the time until the place frees, rounded **up** (a client sent back early is
 * refused again and counts a retry), and never below one second or above the window.
 */
export function retryAfterSeconds(secondsUntilFree: number): number {
  if (typeof secondsUntilFree !== 'number' || !Number.isFinite(secondsUntilFree)) {
    throw new TypeError('A wait is a finite number of seconds');
  }
  return Math.min(WINDOW_SECONDS, Math.max(1, Math.ceil(secondsUntilFree)));
}

/**
 * Whether one more request is admitted to a bucket, from the live rows of its key (SECURITY_DESIGN.md §14.12). Pure: the store
 * reads the rows and this decides.
 *
 * `secondsUntilLeaving` is, for each admitted row still inside the rolling window, the seconds until it leaves it, ascending (the
 * oldest first). A bucket admits at most `limit` requests in any rolling window, so a request is admitted while fewer than `limit`
 * rows are live. At the limit the caller must wait until enough rows have left that one place is free: with `count` live rows
 * that is the `count - limit + 1`-th to leave, which is the row at index `count - limit`. (`count` can exceed the limit when a
 * limit has been lowered since the rows were admitted.) A refusal changes nothing, so it never extends the wait.
 */
export function decideAgainstLimit(
  limit: number,
  secondsUntilLeaving: readonly number[],
): RateLimitDecision {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BUCKET_LIMIT) {
    throw new TypeError('A bucket limit is a whole number from one to the cap');
  }
  let previous = 0;
  for (const seconds of secondsUntilLeaving) {
    if (
      typeof seconds !== 'number' ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds > WINDOW_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS ||
      seconds < previous
    ) {
      throw new TypeError('The live rows leave the window ascending, within it');
    }
    previous = seconds;
  }
  // What is read as ahead of the window leaves at the end of it: the skew is not a longer window.
  const leaving = secondsUntilLeaving.map((seconds) => Math.min(seconds, WINDOW_SECONDS));
  const count = leaving.length;
  if (count < limit) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: retryAfterSeconds(leaving[count - limit] ?? WINDOW_SECONDS),
  };
}

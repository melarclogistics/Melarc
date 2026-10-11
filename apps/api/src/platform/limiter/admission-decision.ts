import type { RateLimitDecision } from '../auth/ports/rate-limiter.port.js';
import { MAX_BUCKET_LIMIT, WINDOW_SECONDS } from './limiter-parameters.js';

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
      seconds > WINDOW_SECONDS ||
      seconds < previous
    ) {
      throw new TypeError('The live rows leave the window ascending, within it');
    }
    previous = seconds;
  }
  const count = secondsUntilLeaving.length;
  if (count < limit) return { allowed: true };
  return {
    allowed: false,
    retryAfterSeconds: retryAfterSeconds(secondsUntilLeaving[count - limit] ?? WINDOW_SECONDS),
  };
}

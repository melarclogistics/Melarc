/**
 * The retry schedule of a credential message (BACKGROUND_JOBS_AND_EVENTS.md §3.2, the Class 1 schedule; SECURITY_DESIGN.md §13.9a,
 * "Retries touch only the same job and token, on the bounded Class 1 schedule ... cut off at the redemption record's expiry").
 *
 * ```
 * attempt 1   immediately
 * attempt 2   ~30 seconds
 * attempt 3   ~2 minutes
 * attempt 4   ~10 minutes
 * attempt 5   ~30 minutes
 * attempt 6   ~2 hours
 * then        a terminal failure (the dead letter): the schedule ends
 * ```
 *
 * The figures are the document's. **Jitter** is not a refinement: a clock-driven failure is simultaneous, and so would be its
 * retries. Its width is not stated, and a fifth either way is chosen here (development-qualified, plan section 7.14). **A provider's
 * `Retry-After` may extend the next attempt and never removes the bound**: it lengthens a wait, up to two hours, and cannot buy an
 * attempt after the sixth. The cut-off at the redemption record's expiry is the database's (`recordOutcome` compares the next
 * attempt with the job's `expires_at` on the database's clock), because an expiry is judged on database time.
 *
 * A pure function of the number of attempts made, so the schedule is the same in the worker, in the adapter and in a test.
 */

/** Six attempts: the first at once and five waits between them. */
export const MAX_ATTEMPTS = 6;

/** The wait after attempt 1, 2, 3, 4 and 5, before jitter. */
export const BASE_DELAYS_MS: readonly number[] = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
];

/** The wait after a deferral begins here, doubles for each deferral and stops at the cap (G2-03). Development-qualified. */
export const DEFERRAL_BASE_MS = 30_000;
export const MAX_DEFERRAL_MS = 10 * 60_000;

/**
 * How long a job waits after a deferral: a claim that ended before any provider was asked, because this worker could not open the
 * payload or confirm the record. Not a send, so not on the Class 1 schedule and not counted against it; but not at once either, or a
 * worker that can never open a payload would claim it as fast as it can. Half a minute for the first, doubling to ten minutes, with the
 * schedule's jitter. `priorDeferrals` is how many deferrals the job had before this one.
 */
export function deferralDelayMs(
  priorDeferrals: number,
  options: { random?: () => number } = {},
): number {
  if (!Number.isInteger(priorDeferrals) || priorDeferrals < 0) {
    throw new RangeError('The number of earlier deferrals is a whole number from nought');
  }
  const base = Math.min(DEFERRAL_BASE_MS * 2 ** Math.min(priorDeferrals, 16), MAX_DEFERRAL_MS);
  const random = options.random ?? Math.random;
  const spread = (random() * 2 - 1) * JITTER_FRACTION;
  return Math.round(base * (1 + spread));
}

/** The wait varies by up to this fraction of itself either way. */
export const JITTER_FRACTION = 0.2;

/** The longest a provider's `Retry-After` can make a wait: the longest wait of the schedule itself. */
export const MAX_RETRY_AFTER_MS = 2 * 60 * 60_000;

export interface RetryOptions {
  /** A provider's own request to wait, in milliseconds. It can lengthen the wait and nothing else. */
  readonly retryAfterMs?: number;
  /** A number in [0, 1). Replaceable so that a test can hold the jitter still. */
  readonly random?: () => number;
}

/**
 * How long to wait before the next attempt, in milliseconds, given how many attempts have been made (one or more), or `undefined`
 * when the schedule is over and the job fails terminally.
 */
export function retryDelayMs(attemptsMade: number, options: RetryOptions = {}): number | undefined {
  if (!Number.isInteger(attemptsMade) || attemptsMade < 1) {
    throw new RangeError('The number of attempts made is a whole number from one');
  }
  const base = BASE_DELAYS_MS[attemptsMade - 1];
  if (attemptsMade >= MAX_ATTEMPTS || base === undefined) return undefined;

  const random = options.random ?? Math.random;
  const spread = (random() * 2 - 1) * JITTER_FRACTION;
  const jittered = Math.round(base * (1 + spread));

  const asked = options.retryAfterMs;
  if (asked === undefined || !Number.isFinite(asked) || asked <= 0) return jittered;
  return Math.max(jittered, Math.min(Math.round(asked), MAX_RETRY_AFTER_MS));
}

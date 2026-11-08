import type { Clock } from '../auth/ports/clock.port.js';
import type { Metrics } from '../auth/ports/metrics.port.js';
import {
  RATE_LIMIT_BUCKETS,
  type RateLimitBucket,
  type RateLimitDecision,
  type RateLimiter,
} from '../auth/ports/rate-limiter.port.js';
import { decideAgainstLimit, retryAfterSeconds } from './admission-decision.js';
import {
  MAX_BUCKET_LIMIT,
  MAX_KEY_BYTES,
  MAX_TOTAL_ROWS,
  WINDOW_SECONDS,
} from './limiter-parameters.js';

export interface InMemoryRateLimiterOptions {
  readonly clock: Pick<Clock, 'now'>;
  /** The limit of every bucket: all six, whole numbers from one to the cap. */
  readonly limits: Readonly<Record<RateLimitBucket, number>>;
  /** The most live admissions held. At it, admissions are refused uniformly and nothing is evicted. */
  readonly maxTotalEntries?: number;
  /** Counts the refusals as the authoritative limiter does (`rate_limited_total`). */
  readonly metrics?: Metrics;
}

/**
 * A bounded in-memory limiter for **unit tests and local diagnostics only** (SECURITY_DESIGN.md §14.12): the same rolling-window
 * decision as the authoritative one (`decideAgainstLimit`) and the same refusals, with its state in this process. It is never
 * deployment evidence: a per-process limiter resets on restart and multiplies each bucket by the number of running instances, and
 * a rolling release runs two versions at once. **A deployed environment refuses it** (`RATE_LIMITER=memory` is refused outside a
 * local run, `adapter-refusals.ts`), and the runtime composition does not bind it by itself; nothing here is a fallback for the
 * PostgreSQL limiter's failing.
 *
 * It keeps the admitted times of each key and no identifier outside the process's own memory; it reads the injected `Clock`, which
 * is fine here because a unit test sets that clock (the authoritative limiter decides on the database's).
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly #clock: Pick<Clock, 'now'>;
  readonly #limits: Readonly<Record<RateLimitBucket, number>>;
  readonly #maxTotalEntries: number;
  readonly #metrics: Metrics | undefined;
  /** Admitted times in milliseconds, ascending, by bucket and key. */
  readonly #admitted = new Map<string, number[]>();

  constructor(options: InMemoryRateLimiterOptions) {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const limit: unknown = options.limits[bucket];
      if (
        !Number.isInteger(limit) ||
        (limit as number) < 1 ||
        (limit as number) > MAX_BUCKET_LIMIT
      ) {
        throw new RangeError('Every bucket has a limit that is a whole number from one to the cap');
      }
    }
    this.#clock = options.clock;
    this.#limits = options.limits;
    this.#maxTotalEntries = options.maxTotalEntries ?? MAX_TOTAL_ROWS;
    this.#metrics = options.metrics;
  }

  admit(bucket: RateLimitBucket, canonicalKey: string): Promise<RateLimitDecision> {
    if (!(RATE_LIMIT_BUCKETS as readonly string[]).includes(bucket)) {
      return Promise.reject(
        new TypeError('A rate-limit bucket is one of the six canonical buckets'),
      );
    }
    if (typeof canonicalKey !== 'string') {
      return Promise.reject(new TypeError('A rate-limit key is text'));
    }
    if (Buffer.byteLength(canonicalKey, 'utf8') > MAX_KEY_BYTES) {
      this.#metrics?.increment('rate_limited_total', { bucket, cause: 'KEY_TOO_LONG' });
      return Promise.resolve({ allowed: false, retryAfterSeconds: WINDOW_SECONDS });
    }

    const now = this.#clock.now().getTime();
    const windowMs = WINDOW_SECONDS * 1000;
    // Expired entries go; what remains is what still counts.
    let total = 0;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [name, times] of this.#admitted) {
      const live = times.filter((time) => time > now - windowMs);
      if (live.length === 0) this.#admitted.delete(name);
      else this.#admitted.set(name, live);
      total += live.length;
      oldest = Math.min(oldest, live[0] ?? oldest);
    }

    const name = `${bucket}\u0000${canonicalKey}`;
    const times = this.#admitted.get(name) ?? [];
    const decision = decideAgainstLimit(
      this.#limits[bucket],
      times.map((time) => (time + windowMs - now) / 1000),
    );
    if (!decision.allowed) {
      this.#metrics?.increment('rate_limited_total', { bucket, cause: 'BUCKET_CEILING' });
      return Promise.resolve(decision);
    }
    if (total >= this.#maxTotalEntries) {
      this.#metrics?.increment('rate_limited_total', { bucket, cause: 'STORE_CAPACITY' });
      return Promise.resolve({
        allowed: false,
        retryAfterSeconds: retryAfterSeconds((oldest + windowMs - now) / 1000),
      });
    }
    this.#admitted.set(name, [...times, now]);
    return Promise.resolve(decision);
  }
}

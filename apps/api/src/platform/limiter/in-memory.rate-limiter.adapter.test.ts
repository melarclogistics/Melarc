import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_BUCKETS, type RateLimitBucket } from '../auth/ports/rate-limiter.port.js';
import { ManualClock } from '../../test-support/manual-clock.js';
import { BoundedMetrics } from '../metrics/bounded.metrics.adapter.js';
import { InMemoryRateLimiter } from './in-memory.rate-limiter.adapter.js';
import { MAX_KEY_BYTES, WINDOW_SECONDS } from './limiter-parameters.js';

const LIMITS: Readonly<Record<RateLimitBucket, number>> = {
  rate_limit_staff_signin: 10,
  rate_limit_privileged_mfa: 10,
  rate_limit_vendor_signin: 10,
  rate_limit_rider_challenge: 20,
  rate_limit_recovery: 10,
  rate_limit_authenticated_api: 120,
};

const make = (maxTotalEntries?: number) => {
  const clock = new ManualClock(new Date('2026-10-10T08:00:00.000Z'));
  const limiter = new InMemoryRateLimiter({
    clock,
    limits: LIMITS,
    ...(maxTotalEntries === undefined ? {} : { maxTotalEntries }),
  });
  return { clock, limiter };
};

async function admitMany(
  limiter: InMemoryRateLimiter,
  bucket: RateLimitBucket,
  key: string,
  times: number,
): Promise<number> {
  let allowed = 0;
  for (let attempt = 0; attempt < times; attempt += 1) {
    if ((await limiter.admit(bucket, key)).allowed) allowed += 1;
  }
  return allowed;
}

describe('the in-memory limiter (unit tests and local diagnostics only)', () => {
  // Break caught: a threshold that differs from the authoritative limiter’s, which this one stands in for in unit tests.
  it('admits exactly the limit of each bucket in a window and refuses the next', async () => {
    for (const bucket of RATE_LIMIT_BUCKETS) {
      const { limiter } = make();
      expect(await admitMany(limiter, bucket, 'k', LIMITS[bucket] + 5), bucket).toBe(
        LIMITS[bucket],
      );
    }
  });

  // Break caught: a fixed window (a double burst at its boundary) in place of a rolling one.
  it('rolls: places free one by one as the admissions leave the window', async () => {
    const { clock, limiter } = make();
    await admitMany(limiter, 'rate_limit_staff_signin', 'k', 5);
    clock.advance(40_000);
    await admitMany(limiter, 'rate_limit_staff_signin', 'k', 5);
    expect((await limiter.admit('rate_limit_staff_signin', 'k')).allowed).toBe(false);

    // The first five were admitted 61 seconds ago, the other five 21 seconds ago.
    clock.advance(21_000);

    expect(await admitMany(limiter, 'rate_limit_staff_signin', 'k', 8)).toBe(5);
  });

  // Break caught: a refusal that counts, extending the penalty, or one that does not say when to come back.
  it('counts only what it admits, and says when a place frees', async () => {
    const { clock, limiter } = make();
    await admitMany(limiter, 'rate_limit_recovery', 'k', 10);
    clock.advance(25_000);

    const refused = await limiter.admit('rate_limit_recovery', 'k');
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 35 });
    for (let attempt = 0; attempt < 20; attempt += 1)
      await limiter.admit('rate_limit_recovery', 'k');
    clock.advance(35_000);

    expect((await limiter.admit('rate_limit_recovery', 'k')).allowed).toBe(true);
  });

  // Break caught: one key or bucket sharing another’s allowance.
  it('keeps each key and each bucket to its own allowance', async () => {
    const { limiter } = make();
    await admitMany(limiter, 'rate_limit_staff_signin', 'a', 10);

    expect((await limiter.admit('rate_limit_staff_signin', 'a')).allowed).toBe(false);
    expect((await limiter.admit('rate_limit_staff_signin', 'b')).allowed).toBe(true);
    expect((await limiter.admit('rate_limit_vendor_signin', 'a')).allowed).toBe(true);
  });

  // Break caught: the capacity bound missing, or an invented key evicting another caller’s admissions.
  it('refuses uniformly at capacity and evicts nothing', async () => {
    const { clock, limiter } = make(4);
    await admitMany(limiter, 'rate_limit_staff_signin', 'victim', 3);
    await limiter.admit('rate_limit_staff_signin', 'one-more');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const refused = await limiter.admit('rate_limit_staff_signin', `invented-${String(attempt)}`);
      expect(refused.allowed).toBe(false);
    }
    // The victim still has its three, and a fourth is refused at capacity, not by its limit.
    expect((await limiter.admit('rate_limit_staff_signin', 'victim')).allowed).toBe(false);
    clock.advance((WINDOW_SECONDS + 1) * 1000);
    expect((await limiter.admit('rate_limit_staff_signin', 'victim')).allowed).toBe(true);
  });

  // Break caught: a bucket outside the six counted, an oversize key digested, a non-text key accepted.
  it('refuses a bucket that is not one of the six and a key that is too long', async () => {
    const { limiter } = make();

    await expect(limiter.admit('rate_limit_seventh' as never, 'k')).rejects.toThrow(TypeError);
    await expect(limiter.admit('rate_limit_staff_signin', 7 as never)).rejects.toThrow(TypeError);
    expect(await limiter.admit('rate_limit_staff_signin', 'k'.repeat(MAX_KEY_BYTES + 1))).toEqual({
      allowed: false,
      retryAfterSeconds: WINDOW_SECONDS,
    });
  });

  // Break caught: a limit table missing a bucket (the limiter would read undefined as no limit).
  it('is not composed without a limit for every bucket', () => {
    const missing = { ...LIMITS } as Partial<Record<RateLimitBucket, number>>;
    delete missing.rate_limit_recovery;

    expect(
      () =>
        new InMemoryRateLimiter({
          clock: new ManualClock(),
          limits: missing as Record<RateLimitBucket, number>,
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new InMemoryRateLimiter({
          clock: new ManualClock(),
          limits: { ...LIMITS, rate_limit_recovery: 0 },
        }),
    ).toThrow(RangeError);
  });
});

describe('the in-memory limiter counts its refusals as the authoritative one does', () => {
  // Break caught: the stand-in counting differently from the real limiter, so that a test of the counters proves nothing about it.
  it('counts a ceiling, a full table and a key too long under their causes, and no admission', async () => {
    const clock = new ManualClock();
    const metrics = new BoundedMetrics({ policy: 'throw', clock });
    const limiter = new InMemoryRateLimiter({
      clock,
      limits: LIMITS,
      maxTotalEntries: 10,
      metrics,
    });

    await admitMany(limiter, 'rate_limit_recovery', 'k', 11);
    await limiter.admit('rate_limit_staff_signin', 'other');
    await limiter.admit('rate_limit_staff_signin', 'k'.repeat(MAX_KEY_BYTES + 1));

    const counted = Object.fromEntries(
      metrics
        .snapshot()
        .counters.map((entry) => [
          `${entry.labels.bucket ?? ''}/${entry.labels.cause ?? ''}`,
          entry.value,
        ]),
    );
    expect(counted).toEqual({
      'rate_limit_recovery/BUCKET_CEILING': 1,
      'rate_limit_staff_signin/STORE_CAPACITY': 1,
      'rate_limit_staff_signin/KEY_TOO_LONG': 1,
    });
  });
});

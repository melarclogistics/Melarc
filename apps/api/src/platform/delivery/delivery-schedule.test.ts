import { describe, expect, it } from 'vitest';

import {
  BASE_DELAYS_MS,
  DEFERRAL_BASE_MS,
  JITTER_FRACTION,
  MAX_ATTEMPTS,
  MAX_DEFERRAL_MS,
  MAX_RETRY_AFTER_MS,
  deferralDelayMs,
  retryDelayMs,
} from './delivery-schedule.js';
import { DEFERRAL_CLASSES, RETRY_CLASSES } from './delivery-vocabulary.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** The middle of the jitter: no deviation from the base. */
const MIDDLE = () => 0.5;

describe('the Class 1 schedule of BACKGROUND_JOBS_AND_EVENTS.md section 3.2', () => {
  // Break caught: a schedule that is not the documented one (attempt 1 at once, then about 30 seconds, 2 minutes, 10 minutes, 30
  // minutes and 2 hours), or one with a seventh attempt: the schedule terminates, and the terminus is the part that gets left out.
  it('waits about 30 seconds, 2 minutes, 10 minutes, 30 minutes and 2 hours after attempts one to five, and ends after six', () => {
    expect([1, 2, 3, 4, 5].map((attempts) => retryDelayMs(attempts, { random: MIDDLE }))).toEqual([
      30 * SECOND,
      2 * MINUTE,
      10 * MINUTE,
      30 * MINUTE,
      2 * HOUR,
    ]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(BASE_DELAYS_MS).toHaveLength(MAX_ATTEMPTS - 1);
    expect(retryDelayMs(6, { random: MIDDLE })).toBeUndefined();
    expect(retryDelayMs(7, { random: MIDDLE })).toBeUndefined();
    expect(retryDelayMs(1000, { random: MIDDLE })).toBeUndefined();
  });

  // Break caught: no jitter, so that jobs whose first attempts failed together retry together; or jitter that takes a retry
  // outside its band, or below zero.
  it('spreads each wait by a fifth either way and never outside that band', () => {
    expect(JITTER_FRACTION).toBe(0.2);
    for (const attempts of [1, 2, 3, 4, 5]) {
      const base = BASE_DELAYS_MS[attempts - 1] ?? Number.NaN;
      expect(retryDelayMs(attempts, { random: () => 0 })).toBe(Math.round(base * 0.8));
      expect(retryDelayMs(attempts, { random: () => 1 })).toBe(Math.round(base * 1.2));
      for (let at = 0; at <= 20; at += 1) {
        const delay = retryDelayMs(attempts, { random: () => at / 20 });
        expect(delay).toBeGreaterThanOrEqual(Math.round(base * 0.8));
        expect(delay).toBeLessThanOrEqual(Math.round(base * 1.2));
      }
    }
  });

  // Break caught: the system random number generator, which a test cannot hold still, being the only source; and a default that
  // returns something other than a band of the documented wait.
  it('draws its jitter from Math.random unless it is given another source', () => {
    for (let at = 0; at < 50; at += 1) {
      const delay = retryDelayMs(2);
      expect(delay).toBeGreaterThanOrEqual(Math.round(2 * MINUTE * 0.8));
      expect(delay).toBeLessThanOrEqual(Math.round(2 * MINUTE * 1.2));
    }
  });

  // Break caught: a provider's Retry-After removing the bound (shortening a wait), ignored when it asks for longer, or letting a
  // provider push a retry out for a week. It may extend the next attempt and it never removes the bound.
  it('lets a Retry-After lengthen the wait but never shorten it, and never lengthen it past two hours', () => {
    expect(retryDelayMs(1, { random: MIDDLE, retryAfterMs: 10 * SECOND })).toBe(30 * SECOND);
    expect(retryDelayMs(1, { random: MIDDLE, retryAfterMs: 90 * SECOND })).toBe(90 * SECOND);
    expect(retryDelayMs(1, { random: MIDDLE, retryAfterMs: 7 * 24 * HOUR })).toBe(
      MAX_RETRY_AFTER_MS,
    );
    expect(MAX_RETRY_AFTER_MS).toBe(2 * HOUR);
    // The bound itself stays: a Retry-After does not buy a seventh attempt.
    expect(retryDelayMs(6, { random: MIDDLE, retryAfterMs: HOUR })).toBeUndefined();
  });

  // Break caught: a Retry-After that is not a usable duration (negative, not a number, infinite) changing the wait.
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0])(
    'ignores a Retry-After of %s',
    (retryAfterMs) => {
      expect(retryDelayMs(2, { random: MIDDLE, retryAfterMs })).toBe(2 * MINUTE);
    },
  );

  // Break caught: a count of attempts that is not a whole number from one being read as a place in the schedule.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as a number of attempts',
    (attempts) => {
      expect(() => retryDelayMs(attempts, { random: MIDDLE })).toThrow(RangeError);
    },
  );
});

describe('the wait after a claim that sent nothing (G2-03)', () => {
  // Break caught: no wait (a worker that cannot open a payload claiming it again at once, and again), a flat wait (the same load for a
  // job that stays unreadable for a day), or one that grows without a cap (a job waiting for a rotation that finished an hour ago).
  it('begins at half a minute, doubles for each deferral and stops at ten minutes', () => {
    expect(DEFERRAL_BASE_MS).toBe(30 * SECOND);
    expect(MAX_DEFERRAL_MS).toBe(10 * MINUTE);
    expect(
      [0, 1, 2, 3, 4, 5, 6, 50].map((prior) => deferralDelayMs(prior, { random: MIDDLE })),
    ).toEqual([
      30 * SECOND,
      MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
      10 * MINUTE,
      10 * MINUTE,
      10 * MINUTE,
    ]);
  });

  // Break caught: no jitter, so that every job an incompatible worker deferred together is claimed together; or jitter outside the band.
  it('spreads each wait by a fifth either way, as the schedule does', () => {
    expect(deferralDelayMs(0, { random: () => 0 })).toBe(Math.round(30 * SECOND * 0.8));
    expect(deferralDelayMs(0, { random: () => 1 })).toBe(Math.round(30 * SECOND * 1.2));
    expect(deferralDelayMs(9, { random: () => 0 })).toBe(Math.round(10 * MINUTE * 0.8));
    expect(deferralDelayMs(9, { random: () => 1 })).toBe(Math.round(10 * MINUTE * 1.2));
  });

  // Break caught: a count that is not a whole number from nought being read as a place in the doubling.
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s as a number of earlier deferrals',
    (prior) => {
      expect(() => deferralDelayMs(prior, { random: MIDDLE })).toThrow(RangeError);
    },
  );

  // Break caught: a deferral class that the closed set of outcomes for a waiting job does not hold, so that recording it is refused by
  // the table's constraint at the worst moment: with a worker that has just found out it cannot open the queue.
  it('names only classes that a waiting job may carry', () => {
    for (const each of DEFERRAL_CLASSES) expect(RETRY_CLASSES).toContain(each);
  });
});

import { describe, expect, it } from 'vitest';

import { decideAgainstLimit, retryAfterSeconds } from './admission-decision.js';
import { MAX_BUCKET_LIMIT, WINDOW_SECONDS } from './limiter-parameters.js';

describe('the seconds to wait', () => {
  // Break caught: a fractional wait rounded down, which would send the client back a moment too soon, and a wait of zero.
  it('rounds up to whole seconds and is never below one or above the window', () => {
    expect(retryAfterSeconds(0.2)).toBe(1);
    expect(retryAfterSeconds(1)).toBe(1);
    expect(retryAfterSeconds(1.01)).toBe(2);
    expect(retryAfterSeconds(59.2)).toBe(60);
    expect(retryAfterSeconds(0)).toBe(1);
    expect(retryAfterSeconds(-5)).toBe(1);
    expect(retryAfterSeconds(WINDOW_SECONDS + 30)).toBe(WINDOW_SECONDS);
  });

  // Break caught: an unreadable time producing a wait that a client would obey.
  it('refuses a number that is not finite', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '3' as never]) {
      expect(() => retryAfterSeconds(value)).toThrow(TypeError);
    }
  });
});

describe('the decision against a bucket’s limit', () => {
  // Break caught: an off-by-one at the threshold: the limit-th request refused, or the limit+1-th admitted.
  it('admits while the live count is below the limit and refuses at it', () => {
    expect(decideAgainstLimit(3, [])).toEqual({ allowed: true });
    expect(decideAgainstLimit(3, [50, 51])).toEqual({ allowed: true });
    expect(decideAgainstLimit(3, [50, 51, 52])).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(decideAgainstLimit(1, [12.3])).toEqual({ allowed: false, retryAfterSeconds: 13 });
  });

  // Break caught: the wait computed from the newest row instead of the one whose leaving frees a place.
  it('says to wait until the row whose leaving the window brings the count below the limit', () => {
    // Three live rows leave at 10, 20 and 30 seconds; with a limit of two, the second to leave (20) frees a place.
    expect(decideAgainstLimit(2, [10, 20, 30])).toEqual({ allowed: false, retryAfterSeconds: 20 });
    // With a limit of one, the third to leave (30) does.
    expect(decideAgainstLimit(1, [10, 20, 30])).toEqual({ allowed: false, retryAfterSeconds: 30 });
  });

  // Break caught: a limit nobody configured (zero, negative, fractional, beyond the cap) treated as a number to compare with.
  it('refuses a limit that is not a whole number from one to the cap', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, MAX_BUCKET_LIMIT + 1, '10' as never]) {
      expect(() => decideAgainstLimit(limit, [])).toThrow(TypeError);
    }
    expect(decideAgainstLimit(MAX_BUCKET_LIMIT, [])).toEqual({ allowed: true });
  });

  // Break caught: rows that are not in order, or a time outside the window, deciding a wait.
  it('refuses live times that are not ascending, positive and within the window', () => {
    for (const times of [[5, 3], [0, 1], [-1], [WINDOW_SECONDS + 1], [Number.NaN]]) {
      expect(() => decideAgainstLimit(2, times)).toThrow(TypeError);
    }
  });
});

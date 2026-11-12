import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RATE_LIMIT_WAIT_SECONDS,
  MAX_RATE_LIMIT_WAIT_SECONDS,
  RATE_LIMITED_MESSAGE,
  parseRetryAfter,
  rateLimitWaitSeconds,
} from './rate-limit';

describe('the words of a request that was too fast', () => {
  // Break caught: the Product Owner's words changed in passing (A2 of the audit, 7 November 2026): "exactly these words".
  it('are the Product Owner’s, exactly', () => {
    expect(RATE_LIMITED_MESSAGE).toBe("You're going a little fast. Try again in a few seconds.");
  });

  // Break caught: a wait of nought or of a day. The figures are the ones the surface document gives (a few seconds; the ceiling is a minute).
  it('have a default wait of a few seconds and a ceiling of a minute', () => {
    expect(DEFAULT_RATE_LIMIT_WAIT_SECONDS).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_RATE_LIMIT_WAIT_SECONDS).toBeLessThanOrEqual(10);
    expect(MAX_RATE_LIMIT_WAIT_SECONDS).toBe(60);
  });
});

describe('Retry-After, as the API sends it to a signed-in caller', () => {
  // Break caught: a wait read from a header the API does not send in that form (an HTTP date), or one that is nought, a fraction or text, which the
  // page would then honour as a figure it invented.
  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['1', 1],
    ['60', 60],
    ['3600', 3600],
  ] as const)('reads %j as %i whole seconds', (header, seconds) => {
    expect(parseRetryAfter(header)).toBe(seconds);
  });

  it.each([
    '0',
    '-5',
    '1.5',
    '1e3',
    '0x10',
    'soon',
    'Wed, 21 Oct 2026 07:28:00 GMT',
    '',
    '   ',
    '1234567890',
    null,
    undefined,
  ])('reads %j as no wait the page can honour', (header) => {
    expect(parseRetryAfter(header)).toBeUndefined();
  });
});

describe('the wait the page keeps', () => {
  // Break caught: the wait ignored when the API gave one, kept past the ceiling when it is absurd, or not kept at all when there is none.
  it.each([
    [30, 30],
    [1, 1],
    [60, 60],
    [61, 60],
    [3600, 60],
    [2.2, 3],
    [undefined, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [0, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [-4, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [Number.NaN, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
    [Number.POSITIVE_INFINITY, DEFAULT_RATE_LIMIT_WAIT_SECONDS],
  ])('keeps %s seconds asked for as %s', (asked, kept) => {
    expect(rateLimitWaitSeconds(asked)).toBe(kept);
  });
});

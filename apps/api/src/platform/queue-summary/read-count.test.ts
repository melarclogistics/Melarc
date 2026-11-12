import { describe, expect, it } from 'vitest';

import { queueCountOf } from './read-count.js';

/**
 * How the row of a counting statement is read (task C1): strictly, so that a figure the server did not read is never drawn. The statement
 * itself, and the count it makes, are `queue-summary.db.test.ts`.
 */
describe('the row of a counting statement', () => {
  // Break caught: a count read as text or as a float, or an instant read with the engine's lenient parser, or rounded up.
  it('is the count as a number and the instant, truncated to the millisecond, as a date', () => {
    expect(queueCountOf({ count: 3, oldest: '2026-11-02 09:15:30.123987+00' })).toEqual({
      count: 3,
      oldestAt: new Date('2026-11-02T09:15:30.123Z'),
    });
    // The driver gives a bigint as text; the statement casts to int, and a text that is a whole number is still one.
    expect(queueCountOf({ count: '12', oldest: new Date('2026-11-02T09:15:30.000Z') })).toEqual({
      count: 12,
      oldestAt: new Date('2026-11-02T09:15:30.000Z'),
    });
  });

  // Break caught: an age on an empty queue, which would draw a wait for nothing that waits.
  it('has no moment when the count is 0, whatever the statement said', () => {
    expect(queueCountOf({ count: 0, oldest: null })).toEqual({ count: 0, oldestAt: null });
    expect(queueCountOf({ count: '0', oldest: '2026-11-02 09:15:30+00' })).toEqual({
      count: 0,
      oldestAt: null,
    });
  });

  // Break caught: a queue that holds records answered with no moment, which would be drawn as a queue that has waited for no time.
  it('refuses a queue that holds records and says nothing of when they entered', () => {
    expect(() => queueCountOf({ count: 2, oldest: null })).toThrow(TypeError);
  });

  // Break caught: a figure that is not a count turned into one that looks right: a missing row, a negative, a fraction, an empty or non-numeric text.
  it.each([
    ['no row', undefined],
    ['a negative', { count: -1, oldest: null }],
    ['a fraction', { count: 1.5, oldest: '2026-11-02 09:15:30+00' }],
    ['an empty text', { count: '', oldest: null }],
    ['a text that is not a number', { count: 'many', oldest: null }],
    ['not a number', { count: Number.NaN, oldest: null }],
    ['a number too large to be exact', { count: Number.MAX_SAFE_INTEGER + 2, oldest: null }],
  ] as const)('refuses %s', (_name, row) => {
    expect(() => queueCountOf(row as Parameters<typeof queueCountOf>[0])).toThrow(TypeError);
  });

  // Break caught: the engine's lenient date parser accepting a text that only looks like a date.
  it('refuses an oldest moment that is not a timestamp the database prints', () => {
    expect(() => queueCountOf({ count: 1, oldest: '2026-11-02T09:15:30Z' })).toThrow(TypeError);
    expect(() => queueCountOf({ count: 1, oldest: 'yesterday' })).toThrow(TypeError);
  });
});

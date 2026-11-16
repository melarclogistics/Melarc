import { describe, expect, it } from 'vitest';

import { waitedText } from './waited';

/** How long something has waited, said as a person says it, from the instant and a clock that the test holds. */
const NOW = Date.parse('2026-11-14T12:00:00Z');
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

describe('how long something has waited', () => {
  it.each([
    [0, 'less than a minute'],
    [59, 'less than a minute'],
    [60, '1 minute'],
    [119, '1 minute'],
    [12 * 60, '12 minutes'],
    [59 * 60 + 59, '59 minutes'],
    [60 * 60, '1 hour'],
    [3 * 60 * 60, '3 hours'],
    [47 * 60 * 60 + 59 * 60, '47 hours'],
    [48 * 60 * 60, '2 days'],
    [5 * 24 * 60 * 60, '5 days'],
  ])('says %i seconds as %s', (seconds, words) => {
    expect(waitedText(ago(seconds), NOW)).toBe(words);
  });

  // Break caught: a moment in the future told as a wait, or text that is not an instant told as one.
  it('says nothing of a moment in the future or of text that is not an instant', () => {
    expect(waitedText(ago(-30), NOW)).toBeUndefined();
    expect(waitedText('yesterday', NOW)).toBeUndefined();
  });
});

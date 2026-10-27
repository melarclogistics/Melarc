import { describe, expect, it } from 'vitest';

import { formatInstant } from './format-time';

describe('formatInstant', () => {
  // Break caught: a format with a year, a weekday or a zone label, none of which the design system shows (COMPONENT_PATTERNS section 40).
  it('shows a day, a short month and a 24-hour time, with no zone label', () => {
    expect(formatInstant('2026-08-18T14:30:00Z')).toBe('18 Aug, 14:30');
  });

  // Break caught: a zone other than Accra's, which would move a time by the machine's offset. Accra is UTC+0 all year.
  it('shows the time in Accra whatever offset the instant is written in', () => {
    expect(formatInstant('2026-08-18T15:30:00+01:00')).toBe('18 Aug, 14:30');
    expect(formatInstant('2026-08-18T09:30:00-05:00')).toBe('18 Aug, 14:30');
    expect(formatInstant('2026-12-31T23:59:59.999Z')).toBe('31 Dec, 23:59');
  });

  // Break caught: a 12-hour clock, or midnight written as 24:05.
  it('writes the hours of a 24-hour clock with two digits and midnight as 00', () => {
    expect(formatInstant('2026-09-03T00:05:00Z')).toBe('3 Sep, 00:05');
    expect(formatInstant('2026-09-03T09:05:00Z')).toBe('3 Sep, 09:05');
    expect(formatInstant('2026-09-03T23:05:00Z')).toBe('3 Sep, 23:05');
  });

  // Break caught: an instant that is not one being drawn as "Invalid Date" or as the epoch.
  it.each([['not a time'], [''], ['2026-13-40T99:00:00Z']])('says nothing for %j', (text) => {
    expect(formatInstant(text)).toBeUndefined();
  });
});

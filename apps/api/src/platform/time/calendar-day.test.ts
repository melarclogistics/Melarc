import { describe, expect, it } from 'vitest';

import { isCalendarDay } from './calendar-day.js';

/** The filters by day of the pickup requests and of the manifests judge a day with this before it reaches a statement. */
describe('isCalendarDay: a day that exists, written as the contract writes it', () => {
  // Break caught: a calendar that is too wide (a day the month does not have) or a leap year judged wrongly, in either direction.
  it.each([
    ['the first day of a year', '2031-01-01'],
    ['the last day of a year', '2031-12-31'],
    ['the 31st of a month of thirty-one days', '2031-07-31'],
    ['the 30th of a month of thirty days', '2031-06-30'],
    ['the 28th of February', '2031-02-28'],
    ['the 29th of February of a leap year', '2032-02-29'],
    ['the 29th of February of a year divisible by 400', '2000-02-29'],
    ['the 29th of February of a small leap year', '0004-02-29'],
    ['the 31st of a month of thirty-one days in a leap year', '2032-07-31'],
    ['the 30th of a month of thirty days in a leap year', '2032-04-30'],
    ['a year before 100, which is not the 1900s', '0050-06-02'],
    ['the first year there is', '0001-01-01'],
    ['the last year of four digits', '9999-12-31'],
  ])('accepts %s', (_what, text) => {
    expect(isCalendarDay(text)).toBe(true);
  });

  it.each([
    ['the 31st of a month of thirty days', '2031-06-31'],
    ['the 30th of February', '2031-02-30'],
    ['the 30th of February of a leap year', '2032-02-30'],
    ['the 31st of a month of thirty days in a leap year', '2032-04-31'],
    ['the 29th of February of a year that is not a leap year', '2031-02-29'],
    ['the 29th of February of a century that is not a leap year', '1900-02-29'],
    ['the 32nd of a month', '2031-07-32'],
    ['a day of zero', '2031-06-00'],
    ['a month of zero', '2031-00-10'],
    ['a month that does not exist', '2031-13-01'],
    ['a year of zero, which the database has no day in', '0000-01-01'],
  ])('refuses %s', (_what, text) => {
    expect(isCalendarDay(text)).toBe(false);
  });

  // Break caught: a month of the table with the wrong number of days, which only a boundary of that very month shows.
  it.each([
    [1, 31],
    [2, 28],
    [3, 31],
    [4, 30],
    [5, 31],
    [6, 30],
    [7, 31],
    [8, 31],
    [9, 30],
    [10, 31],
    [11, 30],
    [12, 31],
  ])('knows that month %i of a year has %i days', (month, length) => {
    const written = (day: number): string =>
      `2031-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    expect(isCalendarDay(written(length))).toBe(true);
    expect(isCalendarDay(written(length + 1))).toBe(false);
  });

  // Break caught: a shape that is looser than the contract's `YYYY-MM-DD`: anything around the day, or a part written without its zeros.
  it.each([
    ['an empty text', ''],
    ['text that is not a day', 'not-a-date'],
    ['a day without its zeros', '2031-6-2'],
    ['a year of five digits', '12031-06-02'],
    ['a year of three digits', '031-06-02'],
    ['a day with a time after it', '2031-06-02T00:00:00Z'],
    ['a day with a space after it', '2031-06-02 '],
    ['a day with a space before it', ' 2031-06-02'],
    ['a day with a line after it', '2031-06-02\n'],
    ['a day with text before it', 'x2031-06-02'],
    ['a day written with slashes', '2031/06/02'],
    ['a day with a sign', '-2031-06-02'],
    ['a day with Arabic-Indic digits', '٢٠٣١-٠٦-٠٢'],
  ])('refuses %s', (_what, text) => {
    expect(isCalendarDay(text)).toBe(false);
  });
});

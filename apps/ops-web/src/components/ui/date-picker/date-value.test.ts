import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUSINESS_TIME_ZONE,
  DATE_LOCALE,
  dateFromText,
  describeDay,
  monthName,
  textFromDate,
  todayInAccra,
  weekdayInitial,
} from './date-value';

describe('dateFromText', () => {
  // Break caught: a date the page gave read as another one, or the control drawing a date for text that names none.
  it('reads the text of a real calendar date', () => {
    const date = dateFromText('2026-10-28');

    expect([date?.year, date?.month, date?.day]).toEqual([2026, 10, 28]);
    expect(dateFromText('2028-02-29')?.day).toBe(29);
  });

  it.each([
    ['nothing', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a date with a time', '2026-10-28T00:00:00Z'],
    ['the day-first spelling people type', '28/10/2026'],
    ['a month without its zero', '2026-1-05'],
    ['a space around it', ' 2026-10-28'],
    ['a day the month does not have', '2026-02-30'],
    ['a leap day in a year that has none', '2027-02-29'],
    ['a month that does not exist', '2026-13-01'],
    ['day zero', '2026-10-00'],
    ['year zero', '0000-01-01'],
  ])('reads %s as no date, never as another one', (_label, text) => {
    expect(dateFromText(text)).toBeNull();
  });
});

describe('textFromDate', () => {
  // Break caught: a date that comes out of the control in a different shape from the one the page and the API use.
  it('writes a date as YYYY-MM-DD, and none as null', () => {
    expect(textFromDate(null)).toBeNull();
    expect(textFromDate(dateFromText('2026-01-05'))).toBe('2026-01-05');
  });

  it.each(['2026-10-28', '2028-02-29', '2026-12-31', '2026-01-01', '2099-09-09', '0026-10-28'])(
    'gives back what it read: %s',
    (text) => {
      expect(textFromDate(dateFromText(text))).toBe(text);
    },
  );
});

describe('todayInAccra', () => {
  const zone = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    if (zone === undefined) Reflect.deleteProperty(process.env, 'TZ');
    else process.env.TZ = zone;
  });

  // Break caught: "today" read from the machine's clock zone, so that a laptop in another country offers the wrong day to book a pickup
  // for, for hours of every day. Business time is Africa/Accra.
  it.each([
    ['Pacific/Kiritimati', 'fourteen hours ahead of Accra'],
    ['Pacific/Pago_Pago', 'eleven hours behind Accra'],
    ['Africa/Accra', 'Accra itself'],
  ])('is the date in Accra whatever the machine thinks (%s, %s)', (machineZone) => {
    process.env.TZ = machineZone;
    vi.useFakeTimers();

    vi.setSystemTime(new Date('2026-10-28T23:59:59Z'));
    expect(todayInAccra().toString()).toBe('2026-10-28');

    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
    expect(todayInAccra().toString()).toBe('2026-10-29');
  });

  it('is a plain calendar date, with no clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-31T13:45:12Z'));

    expect(todayInAccra().toString()).toBe('2026-03-31');
  });
});

describe('monthName', () => {
  // Break caught: a month named in the browser's language, or off by one (the month 1 is January), which the words that refuse a day ("There is no 30 February") would repeat to the person.
  it('names the months from 1, in English, and none for a month that is not one', () => {
    expect([1, 2, 4, 9, 12].map(monthName)).toEqual([
      'January',
      'February',
      'April',
      'September',
      'December',
    ]);
    expect([monthName(0), monthName(13)]).toEqual(['', '']);
  });
});

describe('describeDay', () => {
  // Break caught: a day named in the browser's language and order (jsdom's is United States English), or with a weekday that is not the day's, which a screen reader would
  // read out to a person choosing a pickup date.
  it.each([
    ['2026-10-08', 'Thursday, 8 October 2026'],
    ['2026-10-28', 'Wednesday, 28 October 2026'],
    ['2026-11-01', 'Sunday, 1 November 2026'],
    ['2026-01-05', 'Monday, 5 January 2026'],
    ['2028-02-29', 'Tuesday, 29 February 2028'],
  ])('names %s as %s', (text, name) => {
    const date = dateFromText(text);
    if (date === null) throw new Error(`${text} is not a date`);

    expect(describeDay(date)).toBe(name);
  });
});

describe('weekdayInitial', () => {
  // Break caught: the heading of a column of the calendar taken from the browser's language, or the week not starting on Monday (the headings of a week that does are M T W T F S S).
  it('is the first letter of the weekday of a JavaScript date', () => {
    const week = [26, 27, 28, 29, 30, 31, 32].map((day) => weekdayInitial(new Date(2026, 9, day)));

    expect(week.join('')).toBe('MTWTFSS');
  });
});

describe('the language of the date controls', () => {
  // Break caught: the language drifting to the browser's, which writes 10/28/2026 for one person and 28/10/2026 for another.
  it('is fixed, with the zone that decides the day', () => {
    expect(DATE_LOCALE).toBe('en-GB');
    expect(BUSINESS_TIME_ZONE).toBe('Africa/Accra');
  });
});

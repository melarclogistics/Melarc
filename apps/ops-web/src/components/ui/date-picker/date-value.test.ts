import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUSINESS_TIME_ZONE,
  DATE_LOCALE,
  dateFromText,
  textFromDate,
  todayInAccra,
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

describe('the language of the date controls', () => {
  // Break caught: the language drifting to the browser's, which writes 10/28/2026 for one person and 28/10/2026 for another.
  it('is fixed, with the zone that decides the day', () => {
    expect(DATE_LOCALE).toBe('en-GB');
    expect(BUSINESS_TIME_ZONE).toBe('Africa/Accra');
  });
});

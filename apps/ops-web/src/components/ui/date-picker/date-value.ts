import { BUSINESS_TIME_ZONE, todayText } from '../../../platform/time/format-time';

export { BUSINESS_TIME_ZONE };

/**
 * Dates in the design system (DESIGN_SYSTEM section 24a). A date crosses into and out of a component as the text `YYYY-MM-DD`, the way the API carries a
 * calendar date, and this file is the one place that reads and writes that text, so the rules about it are in one place; a page never sees what it makes.
 *
 * The date is the one the business calendar names, with no clock and no zone of its own. Only "today" needs a zone, and it is Accra's: business time is
 * `Africa/Accra` and Ghana keeps UTC+0 all year, the same rule as `formatInstant`, never the zone of the machine.
 */

/**
 * The language of every date control: day, month, year, weeks that start on Monday and English month names, written by the portal and not taken from
 * the browser, as the words of `formatInstant` are not: a screen must not change with the machine, and 03/04 must never mean two days to two people
 * (the Product Owner approved this on 28 October 2026).
 */
export const DATE_LOCALE = 'en-GB';

/** A day of the calendar: a year, a month from 1 and a day from 1, and nothing of a clock or a zone. */
export class CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;

  constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  /** `YYYY-MM-DD`, the year in four digits, so that the year 26 is `0026` and reads back as the year it is. */
  toString(): string {
    return `${String(this.year).padStart(4, '0')}-${String(this.month).padStart(2, '0')}-${String(this.day).padStart(2, '0')}`;
  }

  /** Negative before `other`, zero the same day, positive after it. */
  compare(other: CalendarDate): number {
    return this.year - other.year || this.month - other.month || this.day - other.day;
  }
}

/** How many days a month has: leap years by the Gregorian rule. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Whether a year, a month and a day are a day of the calendar (year 0 is not one: a text names the date it says, or none). */
export function isRealDate(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The date a text names, or null when there is none: no text, or text that is not a date of the calendar. A value that is not a date is
 * shown as an empty control and never as a different date (`2026-02-30` is nothing, not 28 February).
 */
export function dateFromText(text: string | null | undefined): CalendarDate | null {
  if (text === null || text === undefined) return null;
  const match = ISO_DATE.exec(text);
  if (match === null) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return isRealDate(year, month, day) ? new CalendarDate(year, month, day) : null;
}

/** The text for a date the control gave, or null for none. */
export function textFromDate(date: CalendarDate | null): string | null {
  return date === null ? null : date.toString();
}

/** Today in Accra, as the business calendar has it. */
export function todayInAccra(): CalendarDate {
  const today = dateFromText(todayText());
  if (today === null) throw new Error('The business calendar gave no date for today.');
  return today;
}

/**
 * A day as the calendar draws it (`react-day-picker` works in JavaScript dates): midnight of that day in the machine's own zone, which is the one
 * the calendar reads it back in, so the day is the same on both sides. (`new Date(26, 9, 28)` would be 1926, so the year is set apart.)
 */
export function jsDateFromCalendar(date: CalendarDate): Date {
  const made = new Date(2000, 0, 1);
  made.setFullYear(date.year, date.month - 1, date.day);
  return made;
}

/** The day a JavaScript date falls on, in the machine's own zone, as the calendar hands it back. */
export function calendarFromJsDate(date: Date): CalendarDate {
  return new CalendarDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** The names of the days, from Sunday (the order of `Date#getDay`), in English: the portal's language, not the browser's. */
const WEEKDAYS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The name of a month, from 1 (January), in English: the portal's language and not the browser's. */
export function monthName(month: number): string {
  return MONTHS[month - 1] ?? '';
}

/**
 * A day as a screen reader says it and as the calendar's day buttons are named: `Thursday, 8 October 2026`, written by the portal (English, day before month)
 * and not by the browser, so that the same day has the same name on every machine.
 */
export function describeDay(date: CalendarDate): string {
  const weekday = WEEKDAYS[jsDateFromCalendar(date).getDay()] ?? '';
  return `${weekday}, ${String(date.day)} ${monthName(date.month)} ${String(date.year)}`;
}

/** The first letter of the weekday that a JavaScript date falls on: the heading of a column of the calendar (`M` for Monday). */
export function weekdayInitial(date: Date): string {
  return (WEEKDAYS[date.getDay()] ?? '').charAt(0);
}

import {
  parseDate,
  toCalendarDate,
  type CalendarDate,
  type DateValue,
} from '@internationalized/date';

import { BUSINESS_TIME_ZONE, todayText } from '../../../platform/time/format-time';

export { BUSINESS_TIME_ZONE };

/**
 * Dates in the design system (DESIGN_SYSTEM section 24a). The library works in its own date objects; a page never sees them. A date crosses
 * into and out of a component as the text `YYYY-MM-DD`, the way the API carries a calendar date, and this file is the one place that
 * converts, so the rules about it are in one place.
 *
 * The date is the one the business calendar names, with no clock and no zone of its own. Only "today" needs a zone, and it is Accra's:
 * business time is `Africa/Accra` and Ghana keeps UTC+0 all year, the same rule as `formatInstant`, never the zone of the machine.
 */

/**
 * The language of every date control: day, month, year, weeks that start on Monday and English month names, written by the portal and not
 * taken from the browser, as the words of `formatInstant` are not: a screen must not change with the machine, and 03/04 must never mean
 * two days to two people (the Product Owner approved this on 28 October 2026).
 */
export const DATE_LOCALE = 'en-GB';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The date a text names, or null when there is none: no text, or text that is not a date of the calendar. A value that is not a date is
 * shown as an empty control and never as a different date (`2026-02-30` is nothing, not 28 February).
 */
export function dateFromText(text: string | null | undefined): CalendarDate | null {
  if (text === null || text === undefined || !ISO_DATE.test(text)) return null;
  try {
    const date = parseDate(text);
    // The library refuses a month or a day the calendar does not have, but moves year 0000 to year 1: a text is the date it says or none.
    return date.toString() === text ? date : null;
  } catch {
    return null;
  }
}

/**
 * The text for a date the control gave, or null for none. It is the date as the control shows it: a year typed in two digits is that year
 * (26 is the year 26, and is drawn as 26), and the page's own check refuses it as it refuses any date that cannot be booked.
 */
export function textFromDate(date: DateValue | null): string | null {
  return date === null ? null : toCalendarDate(date).toString();
}

/** Today in Accra, as the business calendar has it (`todayText` in the library's date object). */
export function todayInAccra(): CalendarDate {
  return parseDate(todayText());
}

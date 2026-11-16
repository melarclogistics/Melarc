import { isCalendarDay } from './calendar-day.js';

/** A moment the device sent: RFC 3339 (a date, a time and an offset), which `momentOf` judges further. */
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-](\d{2}):(\d{2}))$/;

/**
 * The instant a device's moment names, or `undefined` for one that names none. The parser of the language rolls an impossible day over (it reads
 * `2026-02-30` as the 2nd of March), which would store another day than the one sent, so the day is judged by the calendar first. An hour, a minute, a second and an offset are held to their ranges (a leap second is not accepted: a device that says it is wrong).
 */
export function momentOf(text: string): string | undefined {
  const parts = DATE_TIME.exec(text);
  if (parts === null) return undefined;
  const [
    ,
    year = '',
    month = '',
    day = '',
    hour = '',
    minute = '',
    second = '',
    ,
    ,
    offsetHour,
    offsetMinute,
  ] = parts;
  // The calendar refuses the year 0 as well (the database has no year 0), so nothing here judges the year alone.
  if (!isCalendarDay(`${year}-${month}-${day}`)) return undefined;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  if (Number(offsetHour ?? 0) > 23 || Number(offsetMinute ?? 0) > 59) return undefined;
  const instant = Date.parse(text);
  return Number.isNaN(instant) ? undefined : new Date(instant).toISOString();
}

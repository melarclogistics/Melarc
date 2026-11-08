/** `YYYY-MM-DD`: four digits of year, two of month and two of day, with nothing around them. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The days of each month of a year that is not a leap year. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/**
 * Whether `YYYY-MM-DD` names a calendar day that exists (`2031-02-30` does not, `2032-02-29` does), so that a filter by day is judged before it
 * reaches a statement. Judged by the calendar and not by the `Date` constructor, which reads the years 0 to 99 as the 1900s and would refuse
 * `0050-06-02`; and the year `0000` is no day, as the database (where the day is compared) has no year 0 and would fail the statement.
 */
export function isCalendarDay(text: string): boolean {
  const parts = ISO_DATE.exec(text);
  if (parts === null) return false;
  const [, yearText = '', monthText = '', dayText = ''] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || day < 1) return false;
  // A month outside 1 to 12 has no place in the table, and so no length for a day to be within.
  const length = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  return length !== undefined && day <= length;
}

import { CalendarDate, daysInMonth, isRealDate, monthName } from './date-value';

/**
 * A date as a person types it: day, month and year, `DD/MM/YYYY`, in that order and in no other (COMPONENT_PATTERNS section 22a). This file is the one place
 * that reads and writes it. **Reading is strict and corrects nothing**: two digits, a slash, two digits, a slash, **four digits**, and a day that its month has. A
 * year in fewer than four digits is not the year 26, a day the month does not have is not moved to one that it does (30 February is not the 28th), a day and a month
 * the wrong way round are not turned about, and a separator that is not a slash is not one. A text that is not a date is **refused in words** (`DayFirstReading`). **Typing is
 * helped, reading is not**: `maskDayFirst` puts the slashes in while digits are typed, so `28102026` is `28/10/2026`, and the result is then read strictly.
 */

/**
 * Why a text is not a date: it is not written as DD/MM/YYYY (`shape`), the year has fewer than four digits (`year`), the day is one that its month does not have
 * (`no-such-day`: the 29th to the 31st), or the day, month or year is not on the calendar at all (`calendar`: a month 13, a day 0 or 45, the year 0).
 */
export type DayFirstProblem = 'shape' | 'year' | 'no-such-day' | 'calendar';

export type DayFirstReading =
  | { readonly ok: true; readonly date: CalendarDate }
  | {
      readonly ok: false;
      readonly problem: DayFirstProblem;
      /** What to tell the person, in plain words. */
      readonly message: string;
    };

/** What to tell a person whose text is not a date, in plain words and in the order they would fix it. (A day that its month does not have is told by `noSuchDayMessage`.) */
export const DAY_FIRST_MESSAGES: Readonly<Record<'shape' | 'year' | 'calendar', string>> = {
  shape: 'Write the date as DD/MM/YYYY, for example 28/10/2026.',
  year: 'Enter the year in full, for example 2026',
  calendar: 'That day is not on the calendar. Check the day and the month.',
};

/**
 * The words for a day that its month does not have: `There is no 30 February`, and so for every such day but one. **The 29th of February in a year that is not a leap year
 * names the year**, because that is the one that a person can mistake for a real day (the Product Owner's decision of 7 November 2026, afternoon): `2027 has no 29 February`.
 * The year is written as it was typed, in four digits.
 */
export function noSuchDayMessage(day: number, month: number, year: number): string {
  if (day === 29 && month === 2 && daysInMonth(year, 2) < 29) {
    return `${String(year).padStart(4, '0')} has no 29 February`;
  }
  return `There is no ${String(day)} ${monthName(month)}`;
}

/** The shape of a whole date: the only one read. */
export const DAY_FIRST_SHAPE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** A date written whole except for the year, which has fewer than four digits. */
const DAY_FIRST_SHORT_YEAR = /^\d{2}\/\d{2}\/\d{1,3}$/;

/** The most characters a date takes. */
export const DAY_FIRST_LENGTH = 10;

/** The text of a date, as it is shown and typed: `28/10/2026`, or nothing for none. */
export function formatDayFirst(date: CalendarDate | null): string {
  if (date === null) return '';
  return `${String(date.day).padStart(2, '0')}/${String(date.month).padStart(2, '0')}/${String(date.year).padStart(4, '0')}`;
}

/**
 * Reads a text strictly. An empty text is not read at all: it is no date, and no mistake. A text written whole but for a year of fewer than four digits is refused for its year
 * before anything else is said of it; a day that its month does not have is named (`There is no 30 February`; the 29th of February of a year that is not a leap year names the year,
 * `2027 has no 29 February`).
 */
export function readDayFirst(text: string): DayFirstReading | undefined {
  if (text === '') return undefined;
  const match = DAY_FIRST_SHAPE.exec(text);
  if (match === null) {
    return DAY_FIRST_SHORT_YEAR.test(text)
      ? { ok: false, problem: 'year', message: DAY_FIRST_MESSAGES.year }
      : { ok: false, problem: 'shape', message: DAY_FIRST_MESSAGES.shape };
  }
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (isRealDate(year, month, day)) return { ok: true, date: new CalendarDate(year, month, day) };
  if (year >= 1 && month >= 1 && month <= 12 && day >= 29 && day <= 31) {
    return { ok: false, problem: 'no-such-day', message: noSuchDayMessage(day, month, year) };
  }
  return { ok: false, problem: 'calendar', message: DAY_FIRST_MESSAGES.calendar };
}

/** The three parts of a date as the field is typed. */
export type DayFirstPart = 'day' | 'month' | 'year';

/** The part a caret at `position` is in, in `dd/mm/yyyy`: positions 0 to 2 are the day, 3 to 5 the month and 6 to 10 the year. */
export function dayFirstPartAt(position: number): DayFirstPart {
  if (position <= 2) return 'day';
  if (position <= 5) return 'month';
  return 'year';
}

/**
 * The date one step up (`1`) or down (`-1`) in one part, as the arrow keys step it: the day goes round within its month (the 31st up is the 1st), the month round the year
 * (December up is January, with the day kept, or moved to the last day of a shorter month) and the year stays between 1 and 9999.
 */
export function stepDayFirst(
  date: CalendarDate,
  part: DayFirstPart,
  direction: 1 | -1,
): CalendarDate {
  if (part === 'day') {
    const length = daysInMonth(date.year, date.month);
    return new CalendarDate(
      date.year,
      date.month,
      ((date.day - 1 + direction + length) % length) + 1,
    );
  }
  if (part === 'month') {
    const month = ((date.month - 1 + direction + 12) % 12) + 1;
    return new CalendarDate(date.year, month, Math.min(date.day, daysInMonth(date.year, month)));
  }
  const year = Math.min(9999, Math.max(1, date.year + direction));
  return new CalendarDate(year, date.month, Math.min(date.day, daysInMonth(year, date.month)));
}

/**
 * The text of the field after the person typed, pasted or deleted: `previous` is what it held and `typed` is what it holds now. Only digits and slashes
 * stay. While the text **grows** the slashes are put in for the person: after two digits of the day and of the month, between digits that run on
 * (`281` is `28/1`), and a slash typed after a single digit pads it (`2/` is `02/`). While it **shrinks** it is left exactly as the person made it, so that
 * Backspace takes a slash away and does not put it back, and a part that is cleared (`/10/2026`, `28//2026`) stays cleared and keeps the others where they were. The
 * result is never longer than a date. **A paste that holds anything but digits and slashes** (`2026-10-28`, `28.10.2026`) is kept as it was pasted, so that the strict
 * reading says what is wrong with it instead of the mask turning it into another date.
 */
export function maskDayFirst(previous: string, typed: string, pasted = false): string {
  if (pasted && /[^\d/]/.test(typed.trim())) return typed.trim().slice(0, DAY_FIRST_LENGTH);
  const kept = typed.replace(/[^\d/]/g, '');
  if (kept.length <= previous.length) return kept.slice(0, DAY_FIRST_LENGTH);
  let text = kept.replace(/\/{2,}/g, '/').replace(/^\//, '');
  // A slash after one digit pads it: `2/` is the 2nd, `02/1/` is the 1st month. Typed, only the slash that ends the text counts (a digit typed before a slash that is
  // already there, into a part that was cleared, is the first digit of that part and is left alone); pasted, the whole text arrives at once.
  text = pasted
    ? text.replace(/^(\d)\//, '0$1/').replace(/^(\d{2}\/)(\d)\//, '$10$2/')
    : text.replace(/^(\d)\/$/, '0$1/').replace(/^(\d{2}\/)(\d)\/$/, '$10$2/');
  // Digits that run past a part go to the next one.
  for (let before = ''; before !== text;) {
    before = text;
    text = text.replace(/^(\d{2})(\d)/, '$1/$2').replace(/^(\d{2}\/\d{2})(\d)/, '$1/$2');
  }
  // A part is complete: the slash after it is typed for the person.
  if (/^(\d{2}|\d{2}\/\d{2})$/.test(text)) text += '/';
  return text.slice(0, DAY_FIRST_LENGTH);
}

/**
 * The hub's calendar (`SLICE-001`; settings.md: times of day are "on the hub's clock, Africa/Accra"; master specification §21.1: every zone operates Monday to Saturday). A calendar date has no
 * time zone: `YYYY-MM-DD` names a day, and which day an instant falls on is the hub's clock's to say. `Africa/Accra` has no daylight saving, so the day is the same all year, and the reading goes
 * through the zone all the same: a test shows it does, and a hub in another zone is a parameter and not a rewrite.
 */
export const HUB_CALENDAR_ZONE = 'Africa/Accra';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day an instant falls on, on the hub's clock, `YYYY-MM-DD`. */
export function hubCalendarDate(instant: Date, timeZone: string = HUB_CALENDAR_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((each) => each.type === type);
    if (found === undefined) throw new Error(`The clock of ${timeZone} gave no ${type}`);
    return found.value;
  };
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** The calendar day `days` after (or before, when negative) another, `YYYY-MM-DD`: pure calendar arithmetic, read as UTC dates, which have no daylight saving to cross. */
export function addCalendarDays(isoDate: string, days: number): string {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) throw new RangeError('A date is YYYY-MM-DD');
  if (!Number.isSafeInteger(days)) throw new RangeError('A number of days is a whole number');
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  const pad = (value: number, width: number): string => String(value).padStart(width, '0');
  return `${pad(moved.getUTCFullYear(), 4)}-${pad(moved.getUTCMonth() + 1, 2)}-${pad(moved.getUTCDate(), 2)}`;
}

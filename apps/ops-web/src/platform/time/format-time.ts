/*
 * An instant as the design system shows time (COMPONENT_PATTERNS section 40): 24-hour, in Accra, with no zone label, for example
 * `18 Aug, 14:30`. Instants are stored and carried as UTC, business time is `Africa/Accra`, and Ghana keeps UTC+0 all year; an export or
 * anything read outside Ghana carries an explicit offset instead, and is not a screen.
 *
 * The words are not taken from a locale: one ICU release spells September `Sept`, another `Sep`, and a screen must not change with the
 * runtime. The zone's numbers are read from the platform and written with a fixed table of months.
 */
/** The zone of the business calendar: Accra, UTC+0 all year. The one place the portal names it. */
export const BUSINESS_TIME_ZONE = 'Africa/Accra';

const ACCRA = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const ACCRA_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today in Accra as `YYYY-MM-DD`, the shape a calendar date has on the page and in the API, with no library and no zone of the machine's. A
 * page that wants a date control to start at today, or to offer nothing before it, asks here and gives the text.
 */
export function todayText(now: Date = new Date()): string {
  const parts = new Map(ACCRA_DAY.formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.get('year') ?? ''}-${parts.get('month') ?? ''}-${parts.get('day') ?? ''}`;
}

/** The text for an instant, or nothing when the text is not an instant. */
export function formatInstant(instant: string): string | undefined {
  const time = Date.parse(instant);
  if (Number.isNaN(time)) return undefined;
  const parts = new Map(ACCRA.formatToParts(time).map((part) => [part.type, part.value]));
  const day = parts.get('day');
  const month = MONTHS[Number(parts.get('month')) - 1];
  const hour = parts.get('hour');
  const minute = parts.get('minute');
  if (day === undefined || month === undefined || hour === undefined || minute === undefined) {
    return undefined;
  }
  return `${String(Number(day))} ${month}, ${hour}:${minute}`;
}

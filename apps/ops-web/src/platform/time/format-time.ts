/**
 * An instant as the design system shows time (COMPONENT_PATTERNS section 40): 24-hour, in Accra, with no zone label, for example
 * `18 Aug, 14:30`. Instants are stored and carried as UTC, business time is `Africa/Accra`, and Ghana keeps UTC+0 all year; an export or
 * anything read outside Ghana carries an explicit offset instead, and is not a screen.
 *
 * The words are not taken from a locale: one ICU release spells September `Sept`, another `Sep`, and a screen must not change with the
 * runtime. The zone's numbers are read from the platform and written with a fixed table of months.
 */
const ACCRA = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Accra',
  day: 'numeric',
  month: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

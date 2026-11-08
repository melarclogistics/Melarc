/**
 * Reads an instant that a raw statement returned. `DatabaseTransaction.execute` hands back `timestamptz` as the server's text
 * (`2026-10-11 15:05:27.537988+00`), not as a `Date`: the driver's type parsers are replaced for the ORM, which converts per column
 * for its own query builder and not for a raw statement. A port adapter that reads an instant reads it here, strictly, instead of
 * trusting the engine's lenient date parser with a text that only looks like a date.
 *
 * The result has the precision of a JavaScript date, a millisecond: the fraction is **truncated** at the third digit, never
 * rounded, so a time read here is never later than the database's. Text that is not a PostgreSQL `timestamptz` (a date alone, an
 * ISO text with a `T`, `infinity`) is a `TypeError`, and so is a `Date` that is invalid: an invalid date makes every comparison
 * after it false, which for an expiry is the wrong way to fail.
 */
const TIMESTAMPTZ =
  /^(?<date>\d{4}-\d{2}-\d{2}) (?<time>\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<sign>[+-])(?<hours>\d{2})(?::?(?<minutes>\d{2}))?$/;

interface Parts {
  readonly date: string;
  readonly time: string;
  readonly fraction?: string;
  readonly sign: string;
  readonly hours: string;
  readonly minutes?: string;
}

export function timestampOf(value: Date | string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('That is an invalid date');
    return value;
  }
  if (typeof value !== 'string') throw new TypeError('An instant is a date or the database’s text');
  const match = TIMESTAMPTZ.exec(value);
  if (match === null) throw new TypeError('That text is not a PostgreSQL timestamp with time zone');
  const parts = match.groups as unknown as Parts;
  const millis = (parts.fraction ?? '0').padEnd(3, '0').slice(0, 3);
  const date = new Date(
    `${parts.date}T${parts.time}.${millis}${parts.sign}${parts.hours}:${parts.minutes ?? '00'}`,
  );
  if (Number.isNaN(date.getTime())) throw new TypeError('That text is not a valid instant');
  return date;
}

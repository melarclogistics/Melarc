import { isUuid } from '../platform/database/transaction-context.js';

/**
 * The position after the last row of a page of `listStaffIdentities`, in the order of the list: the moment the record was created
 * (as the database writes it, with its microseconds, so that rows that share a millisecond are neither skipped nor repeated), then its
 * id. The token is that pair as URL-safe text and **nothing else**: the client sends it back, the server reads it as a position, and
 * it reaches a statement only as two values of those two types, after it has been checked to be exactly that.
 */
export interface PagePosition {
  readonly createdAt: string;
  readonly id: string;
}

/** What `timestamptz` prints (`2026-10-22 05:00:00.123456+00`): a date, a time with up to six decimals, and an offset. */
const MOMENT =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?([+-])(\d{2})(?::(\d{2}))?$/;
const MAX_TOKEN_LENGTH = 512;
/** The largest offset PostgreSQL admits is 15:59:59 east or west; it prints hours, and minutes only when they are not zero. */
const MAX_OFFSET_HOURS = 15;

const isLeapYear = (year: number): boolean =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

const daysIn = (year: number, month: number): number =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

/**
 * A moment the database could have printed: the shape above **and** a real calendar date, a real time of day and an offset in range.
 * The shape alone admits `2026-99-99 29:90:90+99`, which no statement can read as a position: it would reach the page query as a
 * value that query fails on (a server error answered for a client's own text). PostgreSQL has no year 0, prints no second 60 and no
 * hour 24, so none is admitted. The text is kept as it is, microseconds and all: it is the position, not a rounding of it.
 */
function isMoment(value: string): boolean {
  const parts = MOMENT.exec(value);
  if (parts === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    parts[1],
    parts[2],
    parts[3],
    parts[4],
    parts[5],
    parts[6],
    parts[9],
    parts[10] ?? '00',
  ].map(Number) as [number, number, number, number, number, number, number, number];
  return (
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysIn(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= MAX_OFFSET_HOURS &&
    offsetMinute <= 59
  );
}

const isPosition = (createdAt: unknown, id: unknown): createdAt is string =>
  typeof createdAt === 'string' && isMoment(createdAt) && typeof id === 'string' && isUuid(id);

export function encodePageToken(position: PagePosition): string {
  if (!isPosition(position.createdAt, position.id)) {
    throw new TypeError('A page position is a moment as the database prints it and an id (a UUID)');
  }
  return Buffer.from(JSON.stringify([position.createdAt, position.id.toLowerCase()])).toString(
    'base64url',
  );
}

/** The position a token names, or `undefined` when it is not exactly one. */
export function decodePageToken(token: string): PagePosition | undefined {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
  const [createdAt, id] = parsed as unknown[];
  if (!isPosition(createdAt, id)) return undefined;
  return { createdAt, id: (id as string).toLowerCase() };
}

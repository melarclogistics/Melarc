import { weekdayOf } from '../pricing/price-calculation.js';

/**
 * The booking cutoff (S1.15; pickup-request.md section 5.2; settings.md `booking_cutoff_time` and `vendor_credit_grace_window_minutes`;
 * `AC-SLICE-001-04`): whether a booking confirmed at an instant is late for its service date. Pure: it is handed the instant, the
 * settings already read, and answers; the database's clock and the settings are the caller's.
 *
 * **A late booking is never refused.** The verdict decides one thing, whether the confirmed request queues for Ops review, and an unset
 * cutoff decides nothing (`UNSET`), so that a hub with no cutoff configured books as it always did (an operational decision is not held
 * hostage to missing configuration, and no hub inherits another's cutoff, settings.md section 33.4).
 */

/** The hub's clock: a time of day in the settings is "on the hub's clock, Africa/Accra", which has no daylight saving. */
export const HUB_TIME_ZONE = 'Africa/Accra';

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = 86_400_000;

export interface HubLocalTime {
  /** The calendar day on the hub's clock, `YYYY-MM-DD`. */
  readonly date: string;
  /** Minutes since that day's midnight on the hub's clock, with the fraction the seconds make, so a boundary is read exactly. */
  readonly minutes: number;
}

/** An instant as the hub's clock reads it. The zone is a parameter only so that a test can show the reading goes through it. */
export function hubLocal(instant: Date, timeZone: string = HUB_TIME_ZONE): HubLocalTime {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((each) => each.type === type);
    if (found === undefined) throw new Error(`The clock of ${timeZone} gave no ${type}`);
    return found.value;
  };
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    minutes:
      Number(part('hour')) * 60 +
      Number(part('minute')) +
      (Number(part('second')) + instant.getUTCMilliseconds() / 1000) / 60,
  };
}

export type CutoffVerdict =
  | { readonly kind: 'ON_TIME' }
  /** After the cutoff and within the grace window of a sender that was given one. */
  | { readonly kind: 'ON_TIME_IN_GRACE' }
  | { readonly kind: 'LATE' }
  /** The hub has no cutoff in force: there is nothing to be late for. */
  | { readonly kind: 'UNSET' };

export interface CutoffInput {
  readonly instant: Date;
  /** The scheduled service date, `YYYY-MM-DD`. */
  readonly serviceDate: string;
  /** The cutoff as minutes since midnight, or `undefined` where the hub has none in force. */
  readonly cutoffMinutes: number | undefined;
  /** Minutes after the cutoff within which a sender that was given the window may still book; `0` for one that was not. */
  readonly graceMinutes: number;
}

/** The day number of a calendar day (the day it names, whatever the zone of the machine), refusing what is not one. */
function dayNumber(date: string): number {
  weekdayOf(date);
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/**
 * Minutes elapsed since the service day's midnight on the hub's clock, against the cutoff and the cutoff plus the grace window. A
 * service date after the day of the instant is negative and so always on time; one that has passed is more than a day and so late unless
 * a grace window is long enough to reach it, which is arithmetic and not a special case: the window is minutes after the cutoff.
 * The cutoff itself is on time (`10:00:00` is not yet past `10:00`), the first instant after it is not.
 */
export function cutoffVerdict(input: CutoffInput): CutoffVerdict {
  const serviceDay = dayNumber(input.serviceDate);
  if (!Number.isInteger(input.graceMinutes) || input.graceMinutes < 0) {
    throw new RangeError('A grace window is a whole number of minutes, none or more');
  }
  if (input.cutoffMinutes === undefined) return { kind: 'UNSET' };
  if (
    !Number.isFinite(input.cutoffMinutes) ||
    input.cutoffMinutes < 0 ||
    input.cutoffMinutes >= MINUTES_PER_DAY
  ) {
    throw new RangeError('A cutoff is a time of the day');
  }
  const local = hubLocal(input.instant);
  const elapsed = (dayNumber(local.date) - serviceDay) * MINUTES_PER_DAY + local.minutes;
  if (elapsed <= input.cutoffMinutes) return { kind: 'ON_TIME' };
  if (elapsed <= input.cutoffMinutes + input.graceMinutes) return { kind: 'ON_TIME_IN_GRACE' };
  return { kind: 'LATE' };
}

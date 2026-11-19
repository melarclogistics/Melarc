import type { HubConfiguration, Weekday } from '../platform/settings/hub-configuration.js';
import { addCalendarDays, hubCalendarDate } from '../platform/time/hub-calendar.js';
import { refuseIfMissing, weekdayOf, type Destination } from './price-calculation.js';

/**
 * The date an order is promised for (S1.36, `SLICE-001`; domain-model.md `Order.derived_delivery_date` and `DeliveryCommitment`; itemization.md §5.1; `MSC-DEC-213`, `-305` to `-308`). **Pure**: it is
 * handed the hub's configuration snapshot, the moment custody passed and what the sender or recipient asked for, and answers; it reads nothing.
 *
 * - **The default date is counted from pickup custody and never from the hub or from today** (the SLA clock "reaches backwards": the order is made hours after the custody that started its
 *   promise, and starting the clock at itemization "would quietly award Melarc every hour of its own delay"). It is the first day **after** the custody day, on the hub's clock, on which the
 *   destination is served: *the next working day after pickup, skipping Sunday*, so that a Saturday pickup is delivered on Monday; and for a corridor the days its **batch day** names, so that a
 *   corridor's parcel is delivered on its next batch day (**a reading**: the domain model says "corridor batch days override the derivation"). A third-party destination (Station Drop, or outside
 *   the service area) has no service area, and is served on the company's calendar, Monday to Saturday (§21.1).
 * - **A requested date applies over it when it is accepted** (the contract: "an accepted sender or recipient requested date applies over it"). Accepted is **a reading**: a day the hub
 *   operates (never a Sunday: "the documented scheduler must not assign delivery dates on Sunday") and not before the next working day after pickup (Version 1 has no express service, so the day
 *   after custody is the earliest on offer). A corridor delivery requested off its batch day, **before it as well as after it**, is accepted and is priced at the corridor's off-day fee, as the fee
 *   table says: the premium is what the sender pays for a day that is not the batch day.
 * - **The window is the hub's** (`delivery_service_window_start` and `_end`), read at the moment of the commitment; **a hub that has not set both promises a date with no window** (an operational
 *   value: recorded as absent, never invented).
 */

const COMPANY_CALENDAR: readonly Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** More days than any week of operating days could need: a service area that is never served fails here and not in a loop. */
const HORIZON_DAYS = 14;

export const DELIVERY_DATE_REFUSALS = ['REQUESTED_BEFORE_DEFAULT', 'SUNDAY'] as const;
export type DeliveryDateRefusalCode = (typeof DELIVERY_DATE_REFUSALS)[number];

/** A requested date that cannot be accepted: `SUNDAY` is `SERVICE_DATE_NOT_PERMITTED`, `REQUESTED_BEFORE_DEFAULT` is a request that is not valid. */
export class DeliveryDateRefusal extends Error {
  constructor(
    readonly code: DeliveryDateRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryDateRefusal';
  }
}

/** The weekdays on which a destination is served: its service area's base-fee days, or the company's Monday to Saturday for a destination that has no service area. */
function servedDays(config: HubConfiguration, destination: Destination): readonly Weekday[] {
  if (destination.kind !== 'IN_AREA_DOORSTEP') return COMPANY_CALENDAR;
  return refuseIfMissing(() => config.baseFee(destination.serviceArea)).value.days;
}

/** The first day after `custodyDay` that is one of `days`. */
function firstDayAfter(custodyDay: string, days: readonly Weekday[]): string {
  for (let ahead = 1; ahead <= HORIZON_DAYS; ahead += 1) {
    const candidate = addCalendarDays(custodyDay, ahead);
    if (days.includes(weekdayOf(candidate))) return candidate;
  }
  throw new RangeError('The destination is served on no day of the calendar');
}

/** The first day after the day custody passed (on the hub's clock) on which the destination is served. */
export function defaultDeliveryDate(
  config: HubConfiguration,
  destination: Destination,
  custodyAt: Date,
): string {
  return firstDayAfter(hubCalendarDate(custodyAt), servedDays(config, destination));
}

/** The earliest day anything is delivered: the next working day after custody, on the company's calendar. A corridor's own default is later (its batch day), and a request may name this one. */
export function earliestDeliveryDate(custodyAt: Date): string {
  return firstDayAfter(hubCalendarDate(custodyAt), COMPANY_CALENDAR);
}

export interface DeliveryDates {
  /** The calculated service date: kept on every revision of the commitment and never recomputed. */
  readonly defaultDate: string;
  /** What the sender or recipient asked for, when anyone did. */
  readonly requestedDate: string | null;
  /** What Melarc promised: the requested date when one is accepted, else the default. */
  readonly committedDate: string;
}

/** The dates of the first commitment: the default, what was asked and what is promised. */
export function deliveryDatesOf(
  config: HubConfiguration,
  destination: Destination,
  custodyAt: Date,
  requestedDate: string | undefined,
): DeliveryDates {
  const defaultDate = defaultDeliveryDate(config, destination, custodyAt);
  if (requestedDate === undefined) {
    return { defaultDate, requestedDate: null, committedDate: defaultDate };
  }
  if (weekdayOf(requestedDate) === 'SUN') {
    throw new DeliveryDateRefusal('SUNDAY', 'No delivery is promised for a Sunday');
  }
  if (requestedDate < earliestDeliveryDate(custodyAt)) {
    throw new DeliveryDateRefusal(
      'REQUESTED_BEFORE_DEFAULT',
      'Version 1 has no express service: a delivery is promised no earlier than the next working day after pickup',
    );
  }
  return { defaultDate, requestedDate, committedDate: requestedDate };
}

export interface DeliveryWindow {
  readonly start: string | null;
  readonly end: string | null;
}

/** The hub's customer-facing delivery window, `HH:MM` and `HH:MM`, or none: both are needed to say a window, and an operational value that is not set is recorded as absent. */
export function deliveryWindowOf(config: HubConfiguration): DeliveryWindow {
  const start = config.find('delivery_service_window_start');
  const end = config.find('delivery_service_window_end');
  if (start === undefined || end === undefined) return { start: null, end: null };
  return {
    start: config.timeOfDay('delivery_service_window_start').value.text,
    end: config.timeOfDay('delivery_service_window_end').value.text,
  };
}

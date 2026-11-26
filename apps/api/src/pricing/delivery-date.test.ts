import { describe, expect, it } from 'vitest';

import { HubConfiguration, type HubSettingRecord } from '../platform/settings/hub-configuration.js';
import { addCalendarDays, hubCalendarDate } from '../platform/time/hub-calendar.js';
import { HUB_SETTINGS, LAUNCH_HUB_ID } from '../tools/seed/hub-configuration.js';
import {
  defaultDeliveryDate,
  deliveryDatesOf,
  deliveryWindowOf,
  DeliveryDateRefusal,
} from './delivery-date.js';
import type { Destination } from './price-calculation.js';

/**
 * The date an order is promised for (S1.36; `MSC-DEC-213`, `-305` to `-308`; domain-model.md `DeliveryCommitment`). The configuration is the launch seed itself. 2026-11-02 is a Monday.
 */
function configWith(options: { without?: readonly string[] } = {}): HubConfiguration {
  const settings: HubSettingRecord[] = HUB_SETTINGS.filter(
    (seed) => !(options.without ?? []).includes(seed.key),
  ).map((seed) => ({
    hubId: LAUNCH_HUB_ID,
    key: seed.key,
    scopeRef: seed.scopeRef,
    version: 1,
    value: seed.value,
    unit: seed.unit,
    effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  }));
  return new HubConfiguration({
    hubId: LAUNCH_HUB_ID,
    at: new Date('2026-11-02T10:00:00Z'),
    zones: [],
    aliases: [],
    settings,
    company: [],
  });
}

const ACCRA: Destination = { kind: 'IN_AREA_DOORSTEP', serviceArea: 'ACCRA_TEMA' };
const KASOA: Destination = { kind: 'IN_AREA_DOORSTEP', serviceArea: 'KASOA_CORRIDOR' };
const STATION: Destination = { kind: 'STATION_DROP' };
const ABROAD: Destination = { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 5000 };

describe('the hub’s calendar', () => {
  // Break caught: the day read from the server's own zone instead of the hub's (a pickup at 23:30 in Accra is that day in Accra and the next in Auckland).
  it('reads the day an instant falls on through the hub’s zone', () => {
    const instant = new Date('2026-11-02T23:30:00Z');
    expect(hubCalendarDate(instant)).toBe('2026-11-02');
    expect(hubCalendarDate(instant, 'Pacific/Auckland')).toBe('2026-11-03');
  });

  // Break caught: a month, a year or a leap day crossed by a day too many or too few.
  it.each([
    ['2026-11-30', 1, '2026-12-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2027-02-28', 1, '2027-03-01'],
    ['2026-11-02', 7, '2026-11-09'],
    ['2026-11-02', -2, '2026-10-31'],
    ['2026-11-02', 0, '2026-11-02'],
  ])('%s plus %i days is %s', (from, days, to) => {
    expect(addCalendarDays(from, days)).toBe(to);
  });

  it('refuses text that is not a date and a number of days that is not whole', () => {
    expect(() => addCalendarDays('tomorrow', 1)).toThrow(RangeError);
    expect(() => addCalendarDays('2026-11-02', 1.5)).toThrow(RangeError);
  });
});

describe('the default date counts from custody, to the next day the destination is served', () => {
  // Break caught: the clock started at itemization or at the hub (today's date), or the same day promised, or Sunday given a delivery ("a Saturday pickup delivers Monday").
  it.each([
    ['Monday', '2026-11-02T10:00:00Z', ACCRA, '2026-11-03'],
    ['Friday', '2026-11-06T15:00:00Z', ACCRA, '2026-11-07'],
    ['Saturday', '2026-11-07T09:00:00Z', ACCRA, '2026-11-09'],
    ['Sunday', '2026-11-08T09:00:00Z', ACCRA, '2026-11-09'],
    ['Saturday', '2026-11-07T09:00:00Z', STATION, '2026-11-09'],
    ['Saturday', '2026-11-07T09:00:00Z', ABROAD, '2026-11-09'],
    ['Monday', '2026-11-02T10:00:00Z', STATION, '2026-11-03'],
  ])('a %s custody at %s for %j is delivered on %s', (_day, custody, destination, expected) => {
    expect(defaultDeliveryDate(configWith(), destination, new Date(custody))).toBe(expected);
  });

  // Break caught: a corridor served on any day (it is served on its batch day, Friday), or on the very day of custody when that is its batch day.
  it.each([
    ['Monday', '2026-11-02T10:00:00Z', '2026-11-06'],
    ['Thursday', '2026-11-05T10:00:00Z', '2026-11-06'],
    ['Friday', '2026-11-06T10:00:00Z', '2026-11-13'],
    ['Saturday', '2026-11-07T10:00:00Z', '2026-11-13'],
  ])(
    'a corridor parcel collected on a %s (%s) is delivered on its next batch day, %s',
    (_day, custody, expected) => {
      expect(defaultDeliveryDate(configWith(), KASOA, new Date(custody))).toBe(expected);
    },
  );

  // Break caught: a custody late in the day counted as the next day's (the hub's day, not a UTC day of another zone).
  it('counts the hub’s own day: a custody at 23:59 is still that day’s', () => {
    expect(defaultDeliveryDate(configWith(), ACCRA, new Date('2026-11-06T23:59:59Z'))).toBe(
      '2026-11-07',
    );
  });

  // Break caught: a missing batch day served on a default (a hub with no base fee for the area is refused, never given another hub's days).
  it('is SETTING_MISSING for a service area the hub has no base fee for', () => {
    expect(() =>
      defaultDeliveryDate(
        configWith({ without: ['service_area_base_fee'] }),
        ACCRA,
        new Date('2026-11-02T10:00:00Z'),
      ),
    ).toThrow(/no approved value/);
  });
});

describe('the dates of the first commitment', () => {
  const custody = new Date('2026-11-02T10:00:00Z');

  // Break caught: the default overwritten by a request (it is kept on every row, "never recomputed"), or a request ignored.
  it('promises the default when nothing was asked, and keeps it beside what was asked', () => {
    expect(deliveryDatesOf(configWith(), ACCRA, custody, undefined)).toEqual({
      defaultDate: '2026-11-03',
      requestedDate: null,
      committedDate: '2026-11-03',
    });
    expect(deliveryDatesOf(configWith(), ACCRA, custody, '2026-11-05')).toEqual({
      defaultDate: '2026-11-03',
      requestedDate: '2026-11-05',
      committedDate: '2026-11-05',
    });
  });

  // Break caught: a requested date the same as the default refused, or a corridor request off its batch day refused (it is priced at the off-day fee, not refused).
  it('accepts the default itself, and a corridor request off its batch day', () => {
    expect(deliveryDatesOf(configWith(), ACCRA, custody, '2026-11-03').committedDate).toBe(
      '2026-11-03',
    );
    expect(deliveryDatesOf(configWith(), KASOA, custody, '2026-11-04')).toEqual({
      defaultDate: '2026-11-06',
      requestedDate: '2026-11-04',
      committedDate: '2026-11-04',
    });
  });

  // Break caught: an express promise (a day before ordinary service) accepted, or a Sunday promised.
  it('refuses a day before ordinary service and a Sunday', () => {
    const refusal = (requested: string, destination: Destination = ACCRA): string | undefined => {
      try {
        deliveryDatesOf(configWith(), destination, custody, requested);
        return undefined;
      } catch (error) {
        return error instanceof DeliveryDateRefusal ? error.code : `OTHER:${String(error)}`;
      }
    };
    expect(refusal('2026-11-02')).toBe('REQUESTED_BEFORE_DEFAULT');
    expect(refusal('2026-10-30')).toBe('REQUESTED_BEFORE_DEFAULT');
    expect(refusal('2026-11-08')).toBe('SUNDAY');
    expect(refusal('2026-11-15')).toBe('SUNDAY');
    // A corridor is promised its batch day, and a day before it is the premium the off-day fee is for: refused only before the next working day after pickup.
    expect(refusal('2026-11-02', KASOA)).toBe('REQUESTED_BEFORE_DEFAULT');
    expect(refusal('2026-11-03', KASOA)).toBeUndefined();
    expect(refusal('2026-11-08', KASOA)).toBe('SUNDAY');
  });
});

describe('the delivery window of the commitment', () => {
  // Break caught: a window invented for a hub that has none, one end without the other, or the hub's own times not carried.
  it('is the hub’s two times, or none', () => {
    expect(deliveryWindowOf(configWith())).toEqual({ start: '10:00', end: '16:00' });
    expect(deliveryWindowOf(configWith({ without: ['delivery_service_window_start'] }))).toEqual({
      start: null,
      end: null,
    });
    expect(deliveryWindowOf(configWith({ without: ['delivery_service_window_end'] }))).toEqual({
      start: null,
      end: null,
    });
  });
});

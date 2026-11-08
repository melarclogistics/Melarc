import { describe, expect, it } from 'vitest';

import {
  HubConfiguration,
  HubSettingMissingError,
  type HubSettingRecord,
} from './hub-configuration.js';
import { SettingInvalidError, SettingMissingError } from './settings-reader.js';

/**
 * The snapshot of a hub’s configuration (S1.4): pure, so the cases are the shapes a value may and may not have, and what a missing
 * value is. The reader that builds one from the database is proved in `configuration-reader.db.test.ts`.
 */
const HUB = '5eed0100-0000-4000-8000-000000000001';
const OTHER_HUB = '5eed0100-0000-4000-8000-000000000002';
const AT = new Date('2026-10-29T10:00:00Z');

const record = (
  key: string,
  value: unknown,
  overrides: Partial<HubSettingRecord> = {},
): HubSettingRecord => ({
  hubId: HUB,
  key,
  scopeRef: '',
  version: 1,
  value,
  unit: 'u',
  effectiveFrom: new Date('2026-10-01T00:00:00Z'),
  ...overrides,
});

const snapshot = (settings: readonly HubSettingRecord[], company = [] as never[]) =>
  new HubConfiguration({ hubId: HUB, at: AT, zones: [], aliases: [], settings, company });

describe('a value in force', () => {
  // Break caught: a snapshot that returns a value without saying which hub, key, scope and version it is, which is what every charge
  // must record (domain-model.md §3.7). Version counters are per hub, so the hub is part of the reference.
  it('carries the hub, key, scope and version it came from', () => {
    const config = snapshot([record('station_drop_fee', 2000, { version: 3 })]);
    expect(config.money('station_drop_fee')).toEqual({
      value: 2000,
      reference: { hubId: HUB, settingKey: 'station_drop_fee', scopeRef: '', effectiveVersion: 3 },
    });
  });

  // Break caught: the base fee read without its weekdays, which is how a corridor’s batch day is held.
  it('reads a base fee with the weekdays it applies on, per service area', () => {
    const config = snapshot([
      record(
        'service_area_base_fee',
        { amount_minor: 3500, days: ['FRI'] },
        { scopeRef: 'KASOA_CORRIDOR' },
      ),
      record(
        'service_area_base_fee',
        { amount_minor: 3500, days: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] },
        { scopeRef: 'ACCRA_TEMA' },
      ),
    ]);
    expect(config.baseFee('KASOA_CORRIDOR').value).toEqual({ amountMinor: 3500, days: ['FRI'] });
    expect(config.baseFee('ACCRA_TEMA').value.days).toHaveLength(6);
    expect(config.baseFee('KASOA_CORRIDOR').reference.scopeRef).toBe('KASOA_CORRIDOR');
  });

  it('reads one off-day fee per corridor, the size surcharges, a time of day and a switch', () => {
    const config = snapshot([
      record('corridor_off_day_fee', { amount_minor: 7000 }, { scopeRef: 'AMASAMAN_ENVIRONS' }),
      record('corridor_off_day_fee', { amount_minor: 8000 }, { scopeRef: 'KASOA_CORRIDOR' }),
      record('size_class_surcharges', { SMALL: 0, MEDIUM: 2000, LARGE: 3000 }),
      record('booking_cutoff_time', '10:00'),
      record('auto_reschedule', false),
      record('MELARC_MAX_PICKUP_ATTEMPTS', 3),
    ]);
    expect(config.corridorOffDayFee('AMASAMAN_ENVIRONS').value).toBe(7000);
    expect(config.corridorOffDayFee('KASOA_CORRIDOR').value).toBe(8000);
    expect(config.sizeClassSurcharges().value).toEqual({ SMALL: 0, MEDIUM: 2000, LARGE: 3000 });
    expect(config.timeOfDay('booking_cutoff_time').value).toEqual({
      text: '10:00',
      minutesSinceMidnight: 600,
    });
    expect(config.boolean('auto_reschedule').value).toBe(false);
    expect(config.integer('MELARC_MAX_PICKUP_ATTEMPTS', '', 1).value).toBe(3);
  });
});

describe('a value that is not there', () => {
  // Break caught: a missing value answered with a default or with another hub’s value (§33.4), which would let a new hub charge
  // another city’s prices without anyone noticing.
  it('is SETTING_MISSING for the key and scope asked, never a default', () => {
    const config = snapshot([
      record(
        'service_area_base_fee',
        { amount_minor: 3500, days: ['FRI'] },
        { scopeRef: 'ACCRA_TEMA' },
      ),
    ]);
    expect(() => config.money('station_drop_fee')).toThrow(HubSettingMissingError);
    expect(() => config.baseFee('KASOA_CORRIDOR')).toThrow(HubSettingMissingError);
    expect(() => config.corridorOffDayFee('KASOA_CORRIDOR')).toThrow(SettingMissingError);
    expect(config.find('station_drop_fee')).toBeUndefined();
    try {
      config.money('station_drop_fee');
    } catch (error) {
      expect(error).toMatchObject({ code: 'SETTING_MISSING', key: 'station_drop_fee', hubId: HUB });
    }
  });

  it('is SETTING_MISSING for a company rule that is not there', () => {
    expect(() => snapshot([]).companyMoney('liability_cap_amount')).toThrow(SettingMissingError);
  });
});

describe('a value of the wrong shape', () => {
  // Break caught: a malformed value reaching a price. Each is SETTING_INVALID, which fails safely, and none is coerced.
  it.each([
    ['money as a decimal string', (c: HubConfiguration) => c.money('m'), record('m', '20.00')],
    ['money as a float', (c: HubConfiguration) => c.money('m'), record('m', 20.5)],
    ['money as a negative', (c: HubConfiguration) => c.money('m'), record('m', -1)],
    [
      'a time as text that is not HH:MM',
      (c: HubConfiguration) => c.timeOfDay('t'),
      record('t', '25:00'),
    ],
    ['a switch as a string', (c: HubConfiguration) => c.boolean('b'), record('b', 'Off')],
    [
      'an integer below its minimum',
      (c: HubConfiguration) => c.integer('i', '', 1),
      record('i', 0),
    ],
    [
      'a base fee with no weekdays',
      (c: HubConfiguration) => c.baseFee('A'),
      record('service_area_base_fee', { amount_minor: 1, days: [] }, { scopeRef: 'A' }),
    ],
    [
      'a base fee with an unknown weekday',
      (c: HubConfiguration) => c.baseFee('A'),
      record('service_area_base_fee', { amount_minor: 1, days: ['FUNDAY'] }, { scopeRef: 'A' }),
    ],
    [
      'a base fee with a repeated weekday',
      (c: HubConfiguration) => c.baseFee('A'),
      record('service_area_base_fee', { amount_minor: 1, days: ['FRI', 'FRI'] }, { scopeRef: 'A' }),
    ],
    [
      'size surcharges missing a class',
      (c: HubConfiguration) => c.sizeClassSurcharges(),
      record('size_class_surcharges', { SMALL: 0, MEDIUM: 1 }),
    ],
    [
      'size surcharges with a fourth class',
      (c: HubConfiguration) => c.sizeClassSurcharges(),
      record('size_class_surcharges', { SMALL: 0, MEDIUM: 1, LARGE: 2, EXTRA_LARGE: 3 }),
    ],
  ])('refuses %s as SETTING_INVALID', (_label, read, row) => {
    expect(() => read(snapshot([row]))).toThrow(SettingInvalidError);
  });
});

describe('what a snapshot refuses to hold', () => {
  // Break caught: another hub’s row reaching a snapshot, the failure §33.4 exists to prevent.
  it('refuses a setting of another hub', () => {
    expect(() => snapshot([record('station_drop_fee', 2000, { hubId: OTHER_HUB })])).toThrow(
      RangeError,
    );
  });

  it('refuses two versions of one key and scope in force at once', () => {
    expect(() => snapshot([record('k', 1), record('k', 2, { version: 2 })])).toThrow(RangeError);
  });
});

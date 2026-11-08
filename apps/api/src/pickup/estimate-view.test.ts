import { describe, expect, it } from 'vitest';

import { HubConfiguration } from '../platform/settings/hub-configuration.js';
import type { BookingEstimate } from '../pricing/booking-estimate.js';
import { estimateOf, estimateViewOf } from './estimate-view.js';

const HUB = '5eed0100-0000-4000-8000-000000000001';

/**
 * The booking estimate as the contract's `IndicativeEstimate` (S1.14; `MSC-DEC-211`): provisional, never a price, with the inputs of each
 * component named by hub, setting key and effective version so that the figure shown can be reproduced.
 */
describe('the estimate as a representation', () => {
  const available: BookingEstimate = {
    status: 'AVAILABLE',
    provisional: true,
    totalMinor: 10_500,
    assumesSizeClass: 'SMALL',
    excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
    components: [
      {
        kind: 'SERVICE_AREA_BASE_FEE',
        reference: {
          hubId: HUB,
          settingKey: 'service_area_base_fee',
          scopeRef: 'ACCRA_TEMA',
          effectiveVersion: 3,
        },
        quantity: 3,
        amountMinor: 10_500,
      },
    ],
  };

  // Break caught: an estimate that loses its inputs (the figure then cannot be reproduced), loses its provisional flag, or turns a
  // version number into something the contract's string does not hold.
  it('carries the total, the provisional flag, what it assumes and excludes, and each component’s inputs', () => {
    expect(estimateViewOf(HUB, available)).toEqual({
      status: 'AVAILABLE',
      provisional: true,
      total: { amount_minor: 10_500, currency: 'GHS' },
      assumes_size_class: 'SMALL',
      excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
      components: [
        {
          kind: 'SERVICE_AREA_BASE_FEE',
          hub_id: HUB,
          setting_key: 'service_area_base_fee',
          effective_version: '3',
          quantity: 3,
          amount: { amount_minor: 10_500, currency: 'GHS' },
        },
      ],
    });
  });

  // Break caught: an unavailable estimate shown as zero (a missing fee is never estimated at zero), or with a component.
  it.each(['UNAVAILABLE_OUTSIDE_SERVICE_AREA', 'UNAVAILABLE_SETTING_MISSING'] as const)(
    'carries no total and no component when it is %s',
    (status) => {
      const view = estimateViewOf(HUB, {
        status,
        provisional: true,
        totalMinor: null,
        assumesSizeClass: 'SMALL',
        excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
        components: [],
      });
      expect(view).toMatchObject({ status, provisional: true, total: null, components: [] });
    },
  );
});

/**
 * The estimate of a request (S1.15): what booking and confirmation both answer, from one function over the configuration they hold.
 */
describe('the estimate of a request', () => {
  const settings = (days: readonly string[]) => [
    {
      hubId: HUB,
      key: 'service_area_base_fee',
      scopeRef: 'ACCRA_TEMA',
      version: 2,
      value: { amount_minor: 3_500, days },
      unit: 'pesewas',
      effectiveFrom: new Date('2026-10-01T00:00:00Z'),
    },
  ];
  const configured = new HubConfiguration({
    hubId: HUB,
    hubName: 'Accra',
    at: new Date('2026-10-30T00:00:00Z'),
    zones: [],
    aliases: [],
    settings: settings(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']),
    company: [],
  });
  const empty = new HubConfiguration({
    hubId: HUB,
    at: new Date('2026-10-30T00:00:00Z'),
    zones: [],
    aliases: [],
    settings: [],
    company: [],
  });

  // Break caught: the fee not multiplied by the packages, or the version of the fee it was computed from not named.
  it('is the base fee times the packages of a standard request, naming the version it came from', () => {
    expect(estimateOf(configured, { packageCount: 3, serviceDate: '2026-11-04' })).toMatchObject({
      status: 'AVAILABLE',
      provisional: true,
      total: { amount_minor: 10_500, currency: 'GHS' },
      components: [
        { kind: 'SERVICE_AREA_BASE_FEE', hub_id: HUB, effective_version: '2', quantity: 3 },
      ],
    });
  });

  // Break caught: a single package given the standard estimate, which has no destination to price and would be a number invented for it.
  it('is none for a single package, whose destination is not yet known', () => {
    expect(estimateOf(configured, { packageCount: 1, serviceDate: '2026-11-04' })).toBeNull();
  });

  // Break caught: a hub with no fee estimated at zero, or refused, when an operational decision must not be held hostage to it.
  it('is unavailable, not zero, for a hub that has no fee', () => {
    expect(estimateOf(empty, { packageCount: 3, serviceDate: '2026-11-04' })).toMatchObject({
      status: 'UNAVAILABLE_SETTING_MISSING',
      total: null,
      components: [],
    });
  });
});

/**
 * The estimate of a single package whose exception is approved (S1.16): the recipient's delivery address, resolved to a zone by the hub's
 * own aliases, names the destination, and the estimate is the fee that applies there plus the single-package pickup fee.
 */
describe('the estimate of a single package with a delivery address', () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const setting = (key: string, scopeRef: string, value: unknown) => ({
    hubId: HUB,
    key,
    scopeRef,
    version: 1,
    value,
    unit: 'pesewas',
    effectiveFrom: at,
  });
  const zone = (id: string, serviceArea: string, active = true) => ({
    id,
    hubId: HUB,
    code: id.toUpperCase(),
    name: id,
    serviceArea,
    active,
  });
  const alias = (alias: string, zoneId: string) => ({
    id: `alias-${alias}`,
    hubId: HUB,
    zoneId,
    alias,
    kind: 'LANDMARK' as const,
  });
  const MON_TO_SAT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  const configured = (over: { withoutPickupFee?: boolean } = {}) =>
    new HubConfiguration({
      hubId: HUB,
      hubName: 'Accra',
      at: new Date('2026-10-30T00:00:00Z'),
      zones: [
        zone('city', 'ACCRA_TEMA'),
        zone('amasaman', 'AMASAMAN_ENVIRONS'),
        zone('retired', 'ACCRA_TEMA', false),
      ],
      aliases: [
        alias('adenta housing down', 'city'),
        alias('amasaman junction', 'amasaman'),
        alias('airport', 'city'),
        alias('harbour', 'amasaman'),
        alias('old depot', 'retired'),
      ],
      settings: [
        setting('service_area_base_fee', 'ACCRA_TEMA', { amount_minor: 3_500, days: MON_TO_SAT }),
        setting('service_area_base_fee', 'AMASAMAN_ENVIRONS', {
          amount_minor: 3_500,
          days: ['FRI'],
        }),
        setting('corridor_off_day_fee', 'AMASAMAN_ENVIRONS', { amount_minor: 7_000 }),
        ...(over.withoutPickupFee === true
          ? []
          : [setting('single_package_pickup_fee', '', 2_000)]),
      ],
      company: [],
    });
  const WEDNESDAY = '2026-11-04';
  const FRIDAY = '2026-11-06';
  const single = (
    address: string,
    serviceDate = WEDNESDAY,
    over: { config?: HubConfiguration } = {},
  ) =>
    estimateOf(over.config ?? configured(), {
      packageCount: 1,
      serviceDate,
      deliveryLocation: { address },
    });
  const shape = (view: ReturnType<typeof estimateOf>) =>
    view?.components.map((each) => [each.kind, each.quantity, each.amount.amount_minor]);

  // Break caught: the pickup fee left out of a single package, or the destination's own fee not the one that applies.
  it('is the in-area fee plus the single-package pickup fee for a doorstep in the service area', () => {
    const view = single('House 7, Adenta Housing Down');
    expect(view).toMatchObject({
      status: 'AVAILABLE',
      provisional: true,
      total: { amount_minor: 5_500, currency: 'GHS' },
    });
    expect(shape(view)).toEqual([
      ['SERVICE_AREA_BASE_FEE', 1, 3_500],
      ['SINGLE_PACKAGE_PICKUP_FEE', 1, 2_000],
    ]);
  });

  // Break caught: a corridor priced at its batch fee on a day it is not served, or its off-day fee on its batch day.
  it('is a corridor’s flat fee on its batch day and its own off-day fee on another day, plus the pickup fee', () => {
    expect(shape(single('Amasaman Junction', FRIDAY))).toEqual([
      ['SERVICE_AREA_BASE_FEE', 1, 3_500],
      ['SINGLE_PACKAGE_PICKUP_FEE', 1, 2_000],
    ]);
    expect(single('Amasaman Junction', WEDNESDAY)?.total?.amount_minor).toBe(9_000);
    expect(shape(single('Amasaman Junction', WEDNESDAY))).toEqual([
      ['CORRIDOR_OFF_DAY_FEE', 1, 7_000],
      ['SINGLE_PACKAGE_PICKUP_FEE', 1, 2_000],
    ]);
  });

  // Break caught: a zone guessed for an address no alias names, for an ambiguous one, or for a zone that is out of coverage.
  it('is none where the address belongs to no known zone, to more than one, or to one out of coverage', () => {
    expect(single('Plot 9, Somewhere Unmapped')).toBeNull();
    expect(single('Between the airport and the harbour')).toBeNull();
    expect(single('The old depot')).toBeNull();
  });

  it('is none for a single package with no delivery address, and ignores an address for a standard request', () => {
    expect(estimateOf(configured(), { packageCount: 1, serviceDate: WEDNESDAY })).toBeNull();
    expect(
      estimateOf(configured(), {
        packageCount: 2,
        serviceDate: WEDNESDAY,
        deliveryLocation: { address: 'Amasaman Junction' },
      })?.total?.amount_minor,
    ).toBe(7_000);
  });

  // Break caught: a hub with no pickup fee refusing, or estimating the delivery alone and calling it the whole.
  it('is unavailable, not the delivery fee alone, where the hub has no single-package pickup fee', () => {
    expect(
      single('House 7, Adenta Housing Down', WEDNESDAY, {
        config: configured({ withoutPickupFee: true }),
      }),
    ).toMatchObject({ status: 'UNAVAILABLE_SETTING_MISSING', total: null, components: [] });
  });
});

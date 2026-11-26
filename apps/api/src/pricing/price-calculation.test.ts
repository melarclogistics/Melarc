import { describe, expect, it } from 'vitest';

import { HubConfiguration, type HubSettingRecord } from '../platform/settings/hub-configuration.js';
import { HUB_SETTINGS, LAUNCH_HUB_ID } from '../tools/seed/hub-configuration.js';
import { bookingEstimate } from './booking-estimate.js';
import {
  isHighValue,
  priceOf,
  weekdayOf,
  PricingRefusal,
  type PriceInput,
} from './price-calculation.js';
import { SettingInvalidError } from '../platform/settings/settings-reader.js';

/**
 * The fee of a destination and the booking estimate (S1.6; settings.md §7.2; itemization.md §5.1; `MSC-DEC-207`, `-209`, `-210`,
 * `-211`). The configuration is the launch seed itself, so the figures asserted here are the ones the owner confirmed, and a table
 * that disagrees with the document fails in `hub-configuration.test.ts` before it can fail here.
 */
const AT = new Date('2026-10-29T10:00:00Z');

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
    at: AT,
    zones: [],
    aliases: [],
    settings,
    company: [],
  });
}

// 2026-11-02 is a Monday; 2026-11-03 Tuesday; 2026-11-06 Friday; 2026-11-08 Sunday.
const MONDAY = '2026-11-02';
const TUESDAY = '2026-11-03';
const FRIDAY = '2026-11-06';
const SUNDAY = '2026-11-08';

const codeOf = (work: () => unknown): string | undefined => {
  try {
    work();
    return undefined;
  } catch (error) {
    return error instanceof PricingRefusal ? error.code : `OTHER:${String(error)}`;
  }
};

describe('the weekday of a calendar date', () => {
  it.each([
    [MONDAY, 'MON'],
    [TUESDAY, 'TUE'],
    [FRIDAY, 'FRI'],
    [SUNDAY, 'SUN'],
  ])('%s is %s', (date, weekday) => {
    expect(weekdayOf(date)).toBe(weekday);
  });

  it('refuses text that is not a calendar date', () => {
    expect(() => weekdayOf('2026-02-30')).toThrow(RangeError);
    expect(() => weekdayOf('tomorrow')).toThrow(RangeError);
  });
});

describe('the fee of a destination', () => {
  // Break caught: a size surcharge on a doorstep delivery inside the service area, the rule §23.4 inverted on 19 August.
  it.each(['SMALL', 'MEDIUM', 'LARGE'] as const)(
    'is the flat Accra & Tema fee for a %s parcel, whatever its size',
    (sizeClass) => {
      const price = priceOf(configWith(), {
        destination: { kind: 'IN_AREA_DOORSTEP', serviceArea: 'ACCRA_TEMA' },
        deliveryDate: MONDAY,
        sizeClass,
      });
      expect(price.totalMinor).toBe(3500);
      expect(price.components).toHaveLength(1);
      expect(price.components[0]).toMatchObject({
        kind: 'SERVICE_AREA_BASE_FEE',
        amountMinor: 3500,
        reference: {
          hubId: LAUNCH_HUB_ID,
          settingKey: 'service_area_base_fee',
          scopeRef: 'ACCRA_TEMA',
          effectiveVersion: 1,
        },
      });
    },
  );

  // Break caught: a corridor priced at the batch fee every day, or at the off-day fee on its batch day; and the two corridors’ off-day
  // fees merged (the owner set them apart on 29 October 2026).
  it.each([
    ['KASOA_CORRIDOR', FRIDAY, 3500, 'SERVICE_AREA_BASE_FEE'],
    ['KASOA_CORRIDOR', TUESDAY, 8000, 'CORRIDOR_OFF_DAY_FEE'],
    ['AMASAMAN_ENVIRONS', FRIDAY, 3500, 'SERVICE_AREA_BASE_FEE'],
    ['AMASAMAN_ENVIRONS', MONDAY, 7000, 'CORRIDOR_OFF_DAY_FEE'],
  ])('prices %s on %s at %i (%s)', (serviceArea, deliveryDate, total, kind) => {
    const price = priceOf(configWith(), {
      destination: { kind: 'IN_AREA_DOORSTEP', serviceArea },
      deliveryDate,
      sizeClass: 'LARGE',
    });
    expect(price.totalMinor).toBe(total);
    expect(price.components.map((component) => component.kind)).toEqual([kind]);
  });

  // Break caught: a size surcharge on a Station Drop.
  it('is the Station Drop fee, flat, for a large parcel', () => {
    const price = priceOf(configWith(), {
      destination: { kind: 'STATION_DROP' },
      sizeClass: 'LARGE',
    });
    expect(price.totalMinor).toBe(2000);
    expect(price.components.map((component) => component.kind)).toEqual(['STATION_DROP_FEE']);
  });

  // Break caught: the margin or the surcharge dropped, added twice, or the carrier’s cost treated as a price. The fee outside the
  // service area is the carrier’s actual charge, plus the hub’s flat margin, plus the size surcharge (SMALL adds nothing).
  it.each([
    ['SMALL', 5000 + 3000 + 0],
    ['MEDIUM', 5000 + 3000 + 2000],
    ['LARGE', 5000 + 3000 + 3000],
  ] as const)(
    'is carrier cost + margin + surcharge for a %s parcel outside the service area',
    (sizeClass, total) => {
      const price = priceOf(configWith(), {
        destination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 5000 },
        sizeClass,
      });
      expect(price.totalMinor).toBe(total);
      expect(price.components.map((component) => component.kind)).toEqual([
        'CARRIER_COST',
        'OUTSIDE_ACCRA_MARGIN',
        'SIZE_CLASS_SURCHARGE',
      ]);
      // The carrier’s cost is an observation with a waybill behind it: it names no setting.
      expect(price.components[0]).not.toHaveProperty('reference');
      expect(price.components[1]?.reference?.settingKey).toBe('outside_accra_margin');
      expect(price.components[2]?.reference?.settingKey).toBe('size_class_surcharges');
    },
  );

  // Break caught: the total not equal to the sum of its components, the property every audit of a price relies on.
  it('has a total equal to the sum of its components', () => {
    const price = priceOf(configWith(), {
      destination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 12345 },
      sizeClass: 'MEDIUM',
    });
    expect(price.components.reduce((sum, component) => sum + component.amountMinor, 0)).toBe(
      price.totalMinor,
    );
  });
});

describe('what pricing refuses', () => {
  const area = { kind: 'IN_AREA_DOORSTEP', serviceArea: 'ACCRA_TEMA' } as const;

  // Break caught: a default size standing in for the officer’s judgement (a pre-selected SMALL quietly costs revenue).
  it('refuses a parcel with no size class, in every mode', () => {
    for (const destination of [
      area,
      { kind: 'STATION_DROP' },
      { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 100 },
    ] as const) {
      const input: PriceInput = { destination, deliveryDate: MONDAY };
      expect(
        codeOf(() => priceOf(configWith(), input)),
        destination.kind,
      ).toBe('SIZE_CLASS_REQUIRED');
    }
  });

  it('refuses a third-party parcel with no carrier cost, or a non-positive one', () => {
    for (const carrierCostMinor of [undefined, 0, -1, 1.5]) {
      expect(
        codeOf(() =>
          priceOf(configWith(), {
            destination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor },
            sizeClass: 'SMALL',
          }),
        ),
        String(carrierCostMinor),
      ).toBe('CARRIER_COST_REQUIRED');
    }
  });

  // Break caught: a parcel shipped at cost because the margin was unset. It is refused, not priced.
  it('refuses a third-party parcel when the hub has no margin', () => {
    expect(
      codeOf(() =>
        priceOf(configWith({ without: ['outside_accra_margin'] }), {
          destination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 5000 },
          sizeClass: 'SMALL',
        }),
      ),
    ).toBe('MARGIN_NOT_CONFIGURED');
  });

  // Break caught: a missing fee priced at zero or at another hub’s value.
  it.each([
    ['station_drop_fee', { destination: { kind: 'STATION_DROP' }, sizeClass: 'SMALL' }],
    ['service_area_base_fee', { destination: area, deliveryDate: MONDAY, sizeClass: 'SMALL' }],
    [
      'size_class_surcharges',
      { destination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 100 }, sizeClass: 'SMALL' },
    ],
    [
      'corridor_off_day_fee',
      {
        destination: { kind: 'IN_AREA_DOORSTEP', serviceArea: 'KASOA_CORRIDOR' },
        deliveryDate: TUESDAY,
        sizeClass: 'SMALL',
      },
    ],
  ] as const)('refuses a missing %s as SETTING_MISSING', (key, input) => {
    expect(codeOf(() => priceOf(configWith({ without: [key] }), input))).toBe('SETTING_MISSING');
  });

  // Break caught: a Sunday delivery priced, when every zone operates Monday to Saturday and no other day (§21.1).
  it('refuses a delivery day on which the service area does not operate', () => {
    expect(
      codeOf(() =>
        priceOf(configWith(), { destination: area, deliveryDate: SUNDAY, sizeClass: 'SMALL' }),
      ),
    ).toBe('SERVICE_DATE_NOT_PERMITTED');
  });

  // Break caught: a corridor delivery without a date priced at one of the two fees by guesswork.
  it('refuses an in-area delivery with no delivery date', () => {
    expect(
      codeOf(() =>
        priceOf(configWith(), {
          destination: { kind: 'IN_AREA_DOORSTEP', serviceArea: 'KASOA_CORRIDOR' },
          sizeClass: 'SMALL',
        }),
      ),
    ).toBe('SERVICE_DATE_NOT_PERMITTED');
  });
});

describe('the booking estimate (MSC-DEC-211)', () => {
  // Break caught: an estimate that is presented as a price, or that includes the surcharges it cannot know.
  it('is the in-area base fee times the packages for a standard request, assuming the smallest class', () => {
    const estimate = bookingEstimate(configWith(), { packageCount: 3, serviceDate: MONDAY });
    expect(estimate).toMatchObject({
      status: 'AVAILABLE',
      provisional: true,
      totalMinor: 10500,
      assumesSizeClass: 'SMALL',
      excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
    });
    expect(estimate.components).toEqual([
      expect.objectContaining({ kind: 'SERVICE_AREA_BASE_FEE', quantity: 3, amountMinor: 10500 }),
    ]);
    expect(estimate.components[0]?.reference.scopeRef).toBe('ACCRA_TEMA');
  });

  // Break caught: the one-package exception estimated at the batch fee for a destination that costs the off-day fee (a single package to
  // Kasoa on a Tuesday showed GH₵35 and was charged more).
  it.each([
    ['ACCRA_TEMA', MONDAY, 3500 + 2000],
    ['KASOA_CORRIDOR', FRIDAY, 3500 + 2000],
    ['KASOA_CORRIDOR', TUESDAY, 8000 + 2000],
    ['AMASAMAN_ENVIRONS', TUESDAY, 7000 + 2000],
  ])(
    'prices a one-package exception to %s on %s at %i with the single-package fee',
    (serviceArea, serviceDate, total) => {
      const estimate = bookingEstimate(configWith(), {
        packageCount: 1,
        serviceDate,
        singlePackageDestination: { kind: 'IN_AREA_DOORSTEP', serviceArea },
      });
      expect(estimate.status).toBe('AVAILABLE');
      expect(estimate.totalMinor).toBe(total);
      expect(estimate.components.map((component) => component.kind)).toContain(
        'SINGLE_PACKAGE_PICKUP_FEE',
      );
    },
  );

  // Break caught: a number invented for a destination whose carrier charge is unknown until itemization.
  it('has no figure for a destination outside the service area', () => {
    const estimate = bookingEstimate(configWith(), {
      packageCount: 1,
      serviceDate: MONDAY,
      singlePackageDestination: { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: undefined },
    });
    expect(estimate).toMatchObject({
      status: 'UNAVAILABLE_OUTSIDE_SERVICE_AREA',
      totalMinor: null,
      components: [],
    });
  });

  // Break caught: a missing fee blocking the booking or being estimated at zero. The estimate is unavailable, and says why.
  it.each([
    ['service_area_base_fee', 3],
    ['single_package_pickup_fee', 1],
  ])('is unavailable, not an error, when %s is missing', (key, packageCount) => {
    const estimate = bookingEstimate(configWith({ without: [key] }), {
      packageCount,
      serviceDate: MONDAY,
      ...(packageCount === 1
        ? {
            singlePackageDestination: {
              kind: 'IN_AREA_DOORSTEP',
              serviceArea: 'ACCRA_TEMA',
            } as const,
          }
        : {}),
    });
    expect(estimate).toMatchObject({
      status: 'UNAVAILABLE_SETTING_MISSING',
      totalMinor: null,
      components: [],
    });
  });

  // Break caught: a Sunday booking estimated. No zone operates on it; the booking refuses the date before it asks for an estimate,
  // so reaching one is the caller’s defect, and it says so instead of inventing a figure.
  it('refuses a Sunday, which no zone serves, instead of estimating it', () => {
    expect(
      codeOf(() => bookingEstimate(configWith(), { packageCount: 2, serviceDate: SUNDAY })),
    ).toBe('SERVICE_DATE_NOT_PERMITTED');
  });
});

describe('the high-value surcharge (D-06, AC-SLICE-001-54)', () => {
  const area = { kind: 'IN_AREA_DOORSTEP', serviceArea: 'ACCRA_TEMA' } as const;
  const priced = (declaredValueMinor: number | undefined) =>
    priceOf(configWith(), {
      destination: area,
      deliveryDate: MONDAY,
      sizeClass: 'SMALL',
      ...(declaredValueMinor === undefined ? {} : { declaredValueMinor }),
    });

  // Break caught: a band boundary moved by a pesewa (exactly GH₵500 is below the first band; exactly GH₵2,000 is still in it), a band charged twice, or the bands read from the wrong end.
  it.each([
    [0, 0],
    [49999, 0],
    [50000, 0],
    [50001, 1000],
    [150000, 1000],
    [200000, 1000],
    [200001, 2000],
    [5_000_000, 2000],
  ])('a declared value of %i pesewas adds a surcharge of %i', (declared, surcharge) => {
    const price = priced(declared);
    expect(price.totalMinor).toBe(3500 + surcharge);
    expect(price.components.some((component) => component.kind === 'HIGH_VALUE_SURCHARGE')).toBe(
      surcharge > 0,
    );
  });

  // Break caught: the surcharge dropped for a destination, or applied in place of the fee instead of on top of it (D-06: its own component, stacked).
  it.each([
    ['a doorstep delivery', area, 3500],
    ['a Station Drop', { kind: 'STATION_DROP' }, 2000],
    [
      'a third-party delivery',
      { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: 5000 },
      5000 + 3000 + 3000,
    ],
  ] as const)('is stacked on %s', (_name, destination, fee) => {
    const price = priceOf(configWith(), {
      destination,
      deliveryDate: MONDAY,
      sizeClass: 'LARGE',
      declaredValueMinor: 300000,
    });
    expect(price.totalMinor).toBe(fee + 2000);
    expect(price.components.at(-1)).toMatchObject({
      kind: 'HIGH_VALUE_SURCHARGE',
      amountMinor: 2000,
    });
    expect(price.components.reduce((sum, component) => sum + component.amountMinor, 0)).toBe(
      price.totalMinor,
    );
  });

  // Break caught: a component that does not name where its amount came from (a frozen price that cannot be explained, §3.7), or one that names the wrong key.
  it('names the hub, the key and the version it was read from', () => {
    const component = priced(100000).components.find(
      (each) => each.kind === 'HIGH_VALUE_SURCHARGE',
    );
    expect(component?.reference).toEqual({
      hubId: LAUNCH_HUB_ID,
      settingKey: 'MELARC_HIGH_VALUE_TIERS',
      scopeRef: '',
      effectiveVersion: 1,
    });
  });

  // Break caught: the tiers read for a parcel that has no declared value (the estimate has none), which would make a booking fail for a setting it never needs.
  it('reads the tiers only for a parcel that has a declared value', () => {
    const without = configWith({ without: ['MELARC_HIGH_VALUE_TIERS'] });
    const input = { destination: area, deliveryDate: MONDAY, sizeClass: 'SMALL' } as const;
    expect(priceOf(without, input).totalMinor).toBe(3500);
    expect(codeOf(() => priceOf(without, { ...input, declaredValueMinor: 1000 }))).toBe(
      'SETTING_MISSING',
    );
  });

  // Break caught: a parcel flagged high value at, or below, the declaration threshold, or not flagged above it.
  it.each([
    [0, false],
    [50000, false],
    [50001, true],
    [200000, true],
    [9_999_999, true],
  ])('flags a declared value of %i as high value: %s', (declared, flagged) => {
    expect(isHighValue(configWith(), declared)).toBe(flagged);
  });

  it('refuses to flag without the hub’s tiers, and refuses a declared value that is not pesewas', () => {
    expect(
      codeOf(() => isHighValue(configWith({ without: ['MELARC_HIGH_VALUE_TIERS'] }), 60000)),
    ).toBe('SETTING_MISSING');
    for (const declared of [-1, 1.5, Number.NaN]) {
      expect(() => isHighValue(configWith(), declared), String(declared)).toThrow(RangeError);
    }
  });

  // Break caught: a tiers value that is not bands (read as no band and so no surcharge, silently).
  it.each([
    ['not a list', { above_minor: 50000, surcharge_minor: 1000 }],
    ['an empty list', []],
    ['a band with a third member', [{ above_minor: 50000, surcharge_minor: 1000, extra: 1 }]],
    ['a negative amount', [{ above_minor: 50000, surcharge_minor: -1 }]],
    [
      'bands that do not rise',
      [
        { above_minor: 200000, surcharge_minor: 2000 },
        { above_minor: 50000, surcharge_minor: 1000 },
      ],
    ],
    [
      'two bands with one boundary',
      [
        { above_minor: 50000, surcharge_minor: 1000 },
        { above_minor: 50000, surcharge_minor: 2000 },
      ],
    ],
  ])('reads %s as an invalid setting, not as no surcharge', (_name, value) => {
    const config = new HubConfiguration({
      hubId: LAUNCH_HUB_ID,
      at: AT,
      zones: [],
      aliases: [],
      settings: [
        {
          hubId: LAUNCH_HUB_ID,
          key: 'MELARC_HIGH_VALUE_TIERS',
          scopeRef: '',
          version: 1,
          value,
          unit: 'pesewas, by band',
          effectiveFrom: new Date('2026-10-01T00:00:00Z'),
        },
      ],
      company: [],
    });
    expect(() => config.highValueTiers()).toThrow(SettingInvalidError);
  });
});

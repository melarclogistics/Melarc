import { describe, expect, it } from 'vitest';

import {
  HubConfiguration,
  type HubSettingRecord,
  type ServiceZoneRecord,
  type ZoneAliasRecord,
} from '../platform/settings/hub-configuration.js';
import { HUB_SETTINGS, LAUNCH_HUB_ID, SERVICE_ZONES } from '../tools/seed/hub-configuration.js';
import { OrderRuleRefusal, priceOrder, type OrderFacts } from './order-pricing.js';
import { PricingRefusal } from './price-calculation.js';

/**
 * The price and the promise of an order (S1.36; `AC-SLICE-001-47` to `-50`, `-53`, `-54`, `-58`, `-59`; itemization.md §5.1 and §5.2). The configuration is the launch seed, with the aliases a test
 * needs (the real ones are the Product Owner's to supply, OB-S1-02). 2026-11-02 is a Monday.
 */
const ZONES: ServiceZoneRecord[] = SERVICE_ZONES.map((zone) => ({
  id: zone.id,
  hubId: LAUNCH_HUB_ID,
  code: zone.code,
  name: zone.name,
  serviceArea: zone.serviceArea,
  active: true,
}));
const zoneOf = (area: string): ServiceZoneRecord => {
  const found = ZONES.find((zone) => zone.serviceArea === area);
  if (found === undefined) throw new Error(`no zone of ${area}`);
  return found;
};
const ACCRA_ZONE = zoneOf('ACCRA_TEMA');
const KASOA_ZONE = zoneOf('KASOA_CORRIDOR');
const AMASAMAN_ZONE = zoneOf('AMASAMAN_ENVIRONS');
const SECOND_ACCRA_ZONE = ZONES.filter((zone) => zone.serviceArea === 'ACCRA_TEMA')[1];
if (SECOND_ACCRA_ZONE === undefined) throw new Error('the seed has a second Accra zone');

const alias = (zone: ServiceZoneRecord, text: string, id: string): ZoneAliasRecord => ({
  id,
  hubId: LAUNCH_HUB_ID,
  zoneId: zone.id,
  alias: text,
  kind: 'AREA',
});
const ALIASES: ZoneAliasRecord[] = [
  alias(ACCRA_ZONE, 'madina', 'a1'),
  alias(KASOA_ZONE, 'kasoa', 'a2'),
  alias(AMASAMAN_ZONE, 'amasaman', 'a3'),
  // One name that means two zones: the server cannot place it.
  alias(ACCRA_ZONE, 'east legon', 'a4'),
  alias(SECOND_ACCRA_ZONE, 'east legon', 'a5'),
];

function configWith(
  options: { without?: readonly string[]; noThreshold?: boolean } = {},
): HubConfiguration {
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
    at: new Date('2026-11-02T12:00:00Z'),
    zones: ZONES,
    aliases: ALIASES,
    settings,
    company:
      options.noThreshold === true
        ? []
        : [
            {
              key: 'value_declaration_threshold',
              valueType: 'integer',
              value: 50000,
              unit: 'pesewas',
            },
          ],
  });
}

const CUSTODY = new Date('2026-11-02T10:00:00Z');

const facts = (overrides: Partial<OrderFacts> = {}): OrderFacts => ({
  lane: 'DOORSTEP',
  commercialMode: undefined,
  sizeClass: 'SMALL',
  carrierCostMinor: undefined,
  declaredValueMinor: undefined,
  manualHighValue: false,
  location: { address: '12 Madina Estate' },
  authorization: undefined,
  custodyAt: CUSTODY,
  requestedDeliveryDate: undefined,
  acknowledgedAtBooking: false,
  highValueEvidenceCount: 0,
  ...overrides,
});

const refusalOf = (work: () => unknown): string => {
  try {
    work();
    return 'NONE';
  } catch (error) {
    if (error instanceof OrderRuleRefusal) return `${error.code}:${error.rule}`;
    if (error instanceof PricingRefusal) return error.code;
    return `OTHER:${String(error)}`;
  }
};

describe('a doorstep order', () => {
  // Break caught: a size surcharge on a doorstep order, an origin-dependent fee, or the zone not recorded with how it was resolved (AC-49, AC-50).
  it('is priced at the flat fee of the zone the server resolved, whatever its size, and keeps the alias that decided it', () => {
    for (const sizeClass of ['SMALL', 'MEDIUM', 'LARGE'] as const) {
      const order = priceOrder(configWith(), facts({ sizeClass }));
      expect(order.price.totalMinor, sizeClass).toBe(3500);
      expect(order.destinationResolution).toBe('SERVER_RESOLVED');
      expect(order.destinationSnapshot).toEqual({
        scope: 'SERVICE_AREA',
        zone_id: ACCRA_ZONE.id,
        zone_code: ACCRA_ZONE.code,
        zone_name: ACCRA_ZONE.name,
        service_area: 'ACCRA_TEMA',
        alias: 'madina',
      });
      expect(order.dates).toEqual({
        defaultDate: '2026-11-03',
        requestedDate: null,
        committedDate: '2026-11-03',
      });
    }
  });

  // Break caught: a corridor priced at the batch fee on any day, or its off-day request refused (AC-48). Collected on a Monday it is delivered on Friday; asked for on a Tuesday it costs the off-day fee.
  it.each([
    ['KASOA_CORRIDOR', 'kasoa', undefined, '2026-11-06', 3500, 'SERVICE_AREA_BASE_FEE'],
    ['KASOA_CORRIDOR', 'kasoa', '2026-11-03', '2026-11-03', 8000, 'CORRIDOR_OFF_DAY_FEE'],
    ['AMASAMAN_ENVIRONS', 'amasaman', undefined, '2026-11-06', 3500, 'SERVICE_AREA_BASE_FEE'],
    ['AMASAMAN_ENVIRONS', 'amasaman', '2026-11-04', '2026-11-04', 7000, 'CORRIDOR_OFF_DAY_FEE'],
  ])(
    'prices a %s order (%s, asked for %s) delivered on %s at %i',
    (_area, place, asked, delivered, fee, kind) => {
      const order = priceOrder(
        configWith(),
        facts({
          location: { address: `Plot 4, ${place}` },
          ...(asked === undefined ? {} : { requestedDeliveryDate: asked }),
        }),
      );
      expect(order.dates.committedDate).toBe(delivered);
      expect(order.price.totalMinor).toBe(fee);
      expect(order.price.components.map((component) => component.kind)).toEqual([kind]);
    },
  );

  // Break caught: a zone the server could not place priced anyway (AC-50), or guessed from the nearest match.
  it('is blocked, as SETTING_MISSING, when the address resolves to no zone of the hub', () => {
    expect(
      refusalOf(() => priceOrder(configWith(), facts({ location: { address: 'Kumasi' } }))),
    ).toBe('SETTING_MISSING:destination_zone_unresolved');
  });

  // Break caught: an ambiguous address resolved by picking one of the zones.
  it('needs an authorized selection for an ambiguous address, and names the candidates', () => {
    const ambiguous = facts({ location: { address: 'East Legon' } });
    expect(refusalOf(() => priceOrder(configWith(), ambiguous))).toBe(
      'VALIDATION_FAILED:destination_zone_ambiguous',
    );
    try {
      priceOrder(configWith(), ambiguous);
    } catch (error) {
      expect((error as OrderRuleRefusal).details).toEqual({
        candidates: [
          { zone_id: ACCRA_ZONE.id, name: ACCRA_ZONE.name },
          { zone_id: SECOND_ACCRA_ZONE.id, name: SECOND_ACCRA_ZONE.name },
        ],
      });
    }
  });

  // Break caught: an authorized selection ignored, recorded as the server's own resolution, or kept without the note that justified it.
  it('records an authorized selection as such, with its note, where the server could not place the address', () => {
    for (const address of ['Kumasi', 'East Legon']) {
      const order = priceOrder(
        configWith(),
        facts({
          location: { address },
          authorization: { zoneId: SECOND_ACCRA_ZONE.id, note: 'The sender phoned and said so' },
        }),
      );
      expect(order.destinationResolution, address).toBe('EXPLICITLY_AUTHORIZED');
      expect(order.destinationSnapshot).toMatchObject({
        zone_id: SECOND_ACCRA_ZONE.id,
        authorization_note: 'The sender phoned and said so',
      });
      expect(order.destinationSnapshot).not.toHaveProperty('alias');
    }
  });

  // Break caught: a client that overrides the server's own resolution by sending a zone (the zone is the server's, §35.6.6), or names a zone that is not the hub's or not active.
  it('refuses a selection where the server resolved the address itself, and one that names no active zone of the hub', () => {
    expect(
      refusalOf(() =>
        priceOrder(
          configWith(),
          facts({ authorization: { zoneId: KASOA_ZONE.id, note: 'cheaper to price as Kasoa' } }),
        ),
      ),
    ).toBe('VALIDATION_FAILED:destination_zone_resolved');
    for (const zoneId of ['00000000-0000-4000-8000-000000000001', 'not a zone at all']) {
      expect(
        refusalOf(() =>
          priceOrder(
            configWith(),
            facts({ location: { address: 'Kumasi' }, authorization: { zoneId, note: 'x' } }),
          ),
        ),
        zoneId,
      ).toBe('VALIDATION_FAILED:destination_zone_not_available');
    }
  });
});

describe('a third-party order', () => {
  const abroad = (overrides: Partial<OrderFacts> = {}): OrderFacts =>
    facts({
      lane: 'THIRD_PARTY_HANDOFF',
      commercialMode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      carrierCostMinor: 5000,
      location: { address: 'Kumasi, Adum' },
      ...overrides,
    });

  // Break caught: the margin or the size surcharge dropped, or the carrier's cost treated as a price (AC-49, AC-59); and an order outside the service area given a hub zone.
  it.each([
    ['SMALL', 5000 + 3000 + 0],
    ['MEDIUM', 5000 + 3000 + 2000],
    ['LARGE', 5000 + 3000 + 3000],
  ] as const)(
    'is the carrier’s cost plus the margin plus the surcharge for a %s parcel',
    (sizeClass, total) => {
      const order = priceOrder(configWith(), abroad({ sizeClass }));
      expect(order.price.totalMinor).toBe(total);
      expect(order.destinationSnapshot).toEqual({ scope: 'OUTSIDE_SERVICE_AREA' });
      expect(order.destinationResolution).toBe('SERVER_RESOLVED');
      // The carrier's charge is an observation and names no setting, but it names the hub like every component.
      expect(order.snapshot.components[0]).toEqual({
        kind: 'CARRIER_COST',
        amount_minor: 5000,
        hub_id: LAUNCH_HUB_ID,
      });
      // Delivered on the company's calendar: Tuesday after a Monday custody.
      expect(order.dates.committedDate).toBe('2026-11-03');
    },
  );

  it('is the flat Station Drop fee, whatever the size, with no carrier cost', () => {
    const order = priceOrder(
      configWith(),
      facts({ lane: 'THIRD_PARTY_HANDOFF', commercialMode: 'STATION_DROP', sizeClass: 'LARGE' }),
    );
    expect(order.price.totalMinor).toBe(2000);
    expect(order.price.components.map((component) => component.kind)).toEqual(['STATION_DROP_FEE']);
  });

  // Break caught: pricing without the carrier's charge (the order is refused, never priced from nothing), or at cost because the margin was unset (AC-50, AC-59).
  it('is refused without the carrier’s cost, and without the hub’s margin', () => {
    expect(refusalOf(() => priceOrder(configWith(), abroad({ carrierCostMinor: undefined })))).toBe(
      'CARRIER_COST_REQUIRED',
    );
    expect(
      refusalOf(() => priceOrder(configWith({ without: ['outside_accra_margin'] }), abroad())),
    ).toBe('MARGIN_NOT_CONFIGURED');
  });
});

describe('the size class and the declaration', () => {
  // Break caught: a default size standing in for the officer's judgement (AC-58), and the size refused only after other refusals (it is the first judgement).
  it('refuses an order with no size class first, whatever else is wrong with it', () => {
    expect(
      refusalOf(() =>
        priceOrder(
          configWith(),
          facts({
            sizeClass: undefined,
            location: { address: 'Kumasi' },
            declaredValueMinor: 90000,
            requestedDeliveryDate: '2026-11-08',
          }),
        ),
      ),
    ).toBe('SIZE_CLASS_REQUIRED:size_class_required');
  });

  // Break caught: a value above the threshold itemized without the acknowledgement at booking, or the boundary read the other way (above, not at or above).
  it.each([
    [50000, false, 'NONE'],
    [50001, false, 'VALUE_DECLARATION_REQUIRED:declaration_required'],
    [50001, true, 'REASON_REQUIRED:high_value_evidence_required'],
    [0, false, 'NONE'],
  ])(
    'a declared value of %i (acknowledged at booking: %s) is %s',
    (declared, acknowledged, outcome) => {
      expect(
        refusalOf(() =>
          priceOrder(
            configWith(),
            facts({ declaredValueMinor: declared, acknowledgedAtBooking: acknowledged }),
          ),
        ),
      ).toBe(outcome);
    },
  );

  it('refuses, as SETTING_MISSING, a declared value when the company has no declaration threshold', () => {
    expect(
      refusalOf(() =>
        priceOrder(configWith({ noThreshold: true }), facts({ declaredValueMinor: 1000 })),
      ),
    ).toBe('SETTING_MISSING:setting_missing');
  });
});

describe('a high-value order (AC-SLICE-001-54)', () => {
  const high = (overrides: Partial<OrderFacts> = {}): OrderFacts =>
    facts({
      declaredValueMinor: 150000,
      acknowledgedAtBooking: true,
      highValueEvidenceCount: 1,
      ...overrides,
    });

  // Break caught: the surcharge missing from the frozen price, not its own component, or the order not flagged.
  it('is flagged automatically, carries the surcharge as its own component, and names where it came from', () => {
    const order = priceOrder(configWith(), high());
    expect(order.isHighValue).toBe(true);
    expect(order.price.totalMinor).toBe(3500 + 1000);
    expect(order.snapshot.components.at(-1)).toEqual({
      kind: 'HIGH_VALUE_SURCHARGE',
      amount_minor: 1000,
      hub_id: LAUNCH_HUB_ID,
      setting_key: 'MELARC_HIGH_VALUE_TIERS',
      scope_ref: '',
      effective_version: 1,
    });
    expect(priceOrder(configWith(), high({ declaredValueMinor: 300000 })).price.totalMinor).toBe(
      3500 + 2000,
    );
  });

  // Break caught: itemization accepted for a high-value parcel with no evidence, for one flagged by an officer, or the flag set for a value at the threshold.
  it('is refused without evidence, whether flagged by its value or by an officer', () => {
    expect(refusalOf(() => priceOrder(configWith(), high({ highValueEvidenceCount: 0 })))).toBe(
      'REASON_REQUIRED:high_value_evidence_required',
    );
    expect(
      refusalOf(() =>
        priceOrder(configWith(), facts({ manualHighValue: true, highValueEvidenceCount: 0 })),
      ),
    ).toBe('REASON_REQUIRED:high_value_evidence_required');
    const manual = priceOrder(
      configWith(),
      facts({ manualHighValue: true, highValueEvidenceCount: 2 }),
    );
    expect(manual.isHighValue).toBe(true);
    expect(manual.price.totalMinor).toBe(3500);
    expect(priceOrder(configWith(), facts({ declaredValueMinor: 50000 })).isHighValue).toBe(false);
  });
});

describe('the dates of an order', () => {
  // Break caught: a Sunday promised, an express request accepted, or the SLA clock started anywhere but custody.
  it('refuses a Sunday and a day before the next working day, and counts from custody', () => {
    expect(
      refusalOf(() => priceOrder(configWith(), facts({ requestedDeliveryDate: '2026-11-08' }))),
    ).toBe('SERVICE_DATE_NOT_PERMITTED');
    expect(
      refusalOf(() => priceOrder(configWith(), facts({ requestedDeliveryDate: '2026-11-02' }))),
    ).toBe('VALIDATION_FAILED:requested_before_default');
    // A Saturday custody is delivered on Monday, not on the Sunday after it.
    expect(
      priceOrder(configWith(), facts({ custodyAt: new Date('2026-11-07T09:00:00Z') })).dates
        .committedDate,
    ).toBe('2026-11-09');
    expect(priceOrder(configWith(), facts()).window).toEqual({ start: '10:00', end: '16:00' });
  });
});

describe('what the order keeps of its price', () => {
  // Break caught: a total that is not the sum of its components, or a component that does not name its hub (a frozen price that cannot be explained).
  it('has every component name its hub, and a total equal to their sum', () => {
    const order = priceOrder(
      configWith(),
      facts({
        lane: 'THIRD_PARTY_HANDOFF',
        commercialMode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
        carrierCostMinor: 12345,
        sizeClass: 'LARGE',
        declaredValueMinor: 250000,
        acknowledgedAtBooking: true,
        highValueEvidenceCount: 1,
      }),
    );
    expect(order.snapshot.currency).toBe('GHS');
    expect(order.snapshot.components.every((component) => component.hub_id === LAUNCH_HUB_ID)).toBe(
      true,
    );
    expect(
      order.snapshot.components.reduce((sum, component) => sum + component.amount_minor, 0),
    ).toBe(order.snapshot.total_minor);
    expect(order.snapshot.total_minor).toBe(12345 + 3000 + 3000 + 2000);
    expect(order.references.map((reference) => reference.settingKey)).toEqual([
      'outside_accra_margin',
      'size_class_surcharges',
      'MELARC_HIGH_VALUE_TIERS',
    ]);
  });
});

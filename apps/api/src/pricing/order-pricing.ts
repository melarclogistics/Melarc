import type {
  HubConfiguration,
  ServiceZoneRecord,
  SizeClass,
} from '../platform/settings/hub-configuration.js';
import { SettingMissingError } from '../platform/settings/settings-reader.js';
import {
  deliveryDatesOf,
  deliveryWindowOf,
  DeliveryDateRefusal,
  type DeliveryDates,
  type DeliveryWindow,
} from './delivery-date.js';
import {
  isHighValue,
  priceOf,
  PricingRefusal,
  type Destination,
  type Price,
  type PriceComponent,
} from './price-calculation.js';
import { authorizeZone, resolveZone, type LocationText } from './zone-resolver.js';

/**
 * What an order is priced and promised as (S1.36, `SLICE-001`; itemization.md §5.1 and §5.2; `AC-SLICE-001-47` to `-50`, `-53`, `-54`, `-58`, `-59`): **pure**, it is handed the hub's configuration
 * snapshot and the facts of the parcel and reads nothing. It answers everything the database stores of an order's price and promise, or **refuses with the reason**, in a fixed order:
 *
 * 1. **the size class** (`SIZE_CLASS_REQUIRED`: a judgement of the officer's, never defaulted and never derived);
 * 2. **the declaration** (`VALUE_DECLARATION_REQUIRED`: a declared value above `value_declaration_threshold` that was not acknowledged at booking);
 * 3. **the destination**: a doorstep delivery resolves to an active zone of the hub, by the server or by an authorized selection that the server's own resolution needed (`SETTING_MISSING` when no zone
 *    resolves, `VALIDATION_FAILED` when two do and no selection was given, or when a selection was given that was not needed or names no zone of the hub); a third-party delivery is outside the service
 *    area by definition and resolves no zone (**a reading**: the contract's doorstep rules and its third-party rules do not say what a third-party order's zone is);
 * 4. **the promised date** (`SERVICE_DATE_NOT_PERMITTED`, `VALIDATION_FAILED`: [`deliveryDatesOf`](./delivery-date.ts));
 * 5. **the fee** (`CARRIER_COST_REQUIRED`, `MARGIN_NOT_CONFIGURED`, `SETTING_MISSING`: [`priceOf`](./price-calculation.ts)), with the high-value surcharge stacked on it;
 * 6. **the evidence of a high-value parcel** (`REASON_REQUIRED`: a parcel above the first band, or flagged by an officer, with none).
 *
 * **Every refusal is raised here, when the order is made, even for an order that waits for its parcel**: the check-in that later confirms it must never be refused for a price.
 */

/** The facts of one parcel as the service has judged them: the body's, and what the database says of the request and its custody. */
export interface OrderFacts {
  readonly lane: 'DOORSTEP' | 'THIRD_PARTY_HANDOFF';
  readonly commercialMode: 'STATION_DROP' | 'MELARC_COVERED_THIRD_PARTY_DELIVERY' | undefined;
  readonly sizeClass: SizeClass | undefined;
  readonly carrierCostMinor: number | undefined;
  readonly declaredValueMinor: number | undefined;
  /** An officer's own flag of a parcel of lower value (§23.4). */
  readonly manualHighValue: boolean;
  /** The recipient's location: a doorstep order's zone is resolved from it. */
  readonly location: LocationText;
  readonly authorization: { readonly zoneId: string; readonly note: string } | undefined;
  /** The moment custody passed (pickup custody, never the hub's arrival). */
  readonly custodyAt: Date;
  readonly requestedDeliveryDate: string | undefined;
  /** Whether the request recorded the liability-cap acknowledgement at booking. */
  readonly acknowledgedAtBooking: boolean;
  /** How many pieces of evidence of the parcel's high value were named (their being stored is the database's to judge). */
  readonly highValueEvidenceCount: number;
}

/** A refusal of the destination: the code and the rule that names it. */
export class OrderRuleRefusal extends Error {
  constructor(
    readonly code:
      | 'SIZE_CLASS_REQUIRED'
      | 'VALUE_DECLARATION_REQUIRED'
      | 'SETTING_MISSING'
      | 'VALIDATION_FAILED'
      | 'REASON_REQUIRED',
    readonly rule: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'OrderRuleRefusal';
  }
}

/** What the database keeps of a destination's zone: the zone as it was named, how it was resolved, and the alias or the authorization's note that decided it. */
export interface DestinationSnapshot {
  readonly scope: 'SERVICE_AREA' | 'OUTSIDE_SERVICE_AREA';
  readonly zone_id?: string;
  readonly zone_code?: string;
  readonly zone_name?: string;
  readonly service_area?: string;
  readonly alias?: string;
  readonly authorization_note?: string;
}

/** One component of a frozen price as the order keeps it: the amount and where it came from, **with its hub** (`MSC-DEC-218`; domain-model.md §3.7). A carrier's charge is an observation and names no setting. */
export interface ComponentSnapshot {
  readonly kind: PriceComponent['kind'];
  readonly amount_minor: number;
  readonly hub_id: string;
  readonly setting_key?: string;
  readonly scope_ref?: string;
  readonly effective_version?: number;
}

export interface PriceSnapshot {
  readonly total_minor: number;
  readonly currency: 'GHS';
  readonly components: readonly ComponentSnapshot[];
}

export interface PricedOrder {
  readonly destination: Destination;
  readonly destinationSnapshot: DestinationSnapshot;
  readonly destinationResolution: 'SERVER_RESOLVED' | 'EXPLICITLY_AUTHORIZED';
  readonly isHighValue: boolean;
  readonly price: Price;
  readonly snapshot: PriceSnapshot;
  readonly dates: DeliveryDates;
  readonly window: DeliveryWindow;
  /** The version of each setting the price was read from, for the audit event of the calculation. */
  readonly references: readonly {
    readonly settingKey: string;
    readonly effectiveVersion: number;
  }[];
}

/** The snapshot of a price: each component with its hub, key, scope, version and value. */
export function snapshotOf(hubId: string, price: Price): PriceSnapshot {
  return {
    total_minor: price.totalMinor,
    currency: 'GHS',
    components: price.components.map((component) => ({
      kind: component.kind,
      amount_minor: component.amountMinor,
      hub_id: hubId,
      ...(component.reference === undefined
        ? {}
        : {
            setting_key: component.reference.settingKey,
            scope_ref: component.reference.scopeRef,
            effective_version: component.reference.effectiveVersion,
          }),
    })),
  };
}

const zoneSnapshotOf = (
  zone: ServiceZoneRecord,
  extra: { alias?: string; note?: string },
): DestinationSnapshot => ({
  scope: 'SERVICE_AREA',
  zone_id: zone.id,
  zone_code: zone.code,
  zone_name: zone.name,
  service_area: zone.serviceArea,
  ...(extra.alias === undefined ? {} : { alias: extra.alias }),
  ...(extra.note === undefined ? {} : { authorization_note: extra.note }),
});

/** The destination of a doorstep delivery: the zone the server resolves, or the one an authorized selection names where the server's resolution was silent or ambiguous. */
function resolveDoorstep(
  config: HubConfiguration,
  facts: OrderFacts,
): {
  readonly zone: ServiceZoneRecord;
  readonly snapshot: DestinationSnapshot;
  readonly resolution: 'SERVER_RESOLVED' | 'EXPLICITLY_AUTHORIZED';
} {
  const resolved = resolveZone(config, facts.location);
  if (resolved.kind === 'RESOLVED') {
    if (facts.authorization !== undefined) {
      throw new OrderRuleRefusal(
        'VALIDATION_FAILED',
        'destination_zone_resolved',
        'The address resolves to a zone of the hub; a selection is for an address the server cannot place',
      );
    }
    return {
      zone: resolved.zone,
      snapshot: zoneSnapshotOf(resolved.zone, {
        ...(resolved.alias === undefined ? {} : { alias: resolved.alias }),
      }),
      resolution: 'SERVER_RESOLVED',
    };
  }
  if (facts.authorization === undefined) {
    if (resolved.kind === 'AMBIGUOUS') {
      throw new OrderRuleRefusal(
        'VALIDATION_FAILED',
        'destination_zone_ambiguous',
        'The address matches more than one zone of the hub: an authorized selection is needed',
        { candidates: resolved.zones.map((zone) => ({ zone_id: zone.id, name: zone.name })) },
      );
    }
    throw new OrderRuleRefusal(
      'SETTING_MISSING',
      'destination_zone_unresolved',
      'The address resolves to no active zone of the hub, so the order cannot be priced',
    );
  }
  const authorized = authorizeZone(config, facts.authorization.zoneId);
  if (authorized.kind !== 'RESOLVED') {
    throw new OrderRuleRefusal(
      'VALIDATION_FAILED',
      'destination_zone_not_available',
      'The selected zone is not an active zone of the hub',
    );
  }
  return {
    zone: authorized.zone,
    snapshot: zoneSnapshotOf(authorized.zone, { note: facts.authorization.note }),
    resolution: 'EXPLICITLY_AUTHORIZED',
  };
}

/** What an order is priced and promised as, or the refusal, in the order the module's header says. */
export function priceOrder(config: HubConfiguration, facts: OrderFacts): PricedOrder {
  // 1. The size class.
  if (facts.sizeClass === undefined) {
    throw new OrderRuleRefusal(
      'SIZE_CLASS_REQUIRED',
      'size_class_required',
      'The receiving officer selects a size class; there is no default and nothing derives one',
    );
  }

  // 2. The declaration: a value above the threshold needs the acknowledgement recorded at booking.
  if (facts.declaredValueMinor !== undefined) {
    let threshold: number;
    try {
      threshold = config.companyMoney('value_declaration_threshold');
    } catch (error) {
      if (error instanceof SettingMissingError) {
        throw new OrderRuleRefusal('SETTING_MISSING', 'setting_missing', error.message);
      }
      throw error;
    }
    if (facts.declaredValueMinor > threshold && !facts.acknowledgedAtBooking) {
      throw new OrderRuleRefusal(
        'VALUE_DECLARATION_REQUIRED',
        'declaration_required',
        'A declared value above the threshold needs the liability-cap acknowledgement at booking',
      );
    }
  }

  // 3. The destination.
  let destination: Destination;
  let destinationSnapshot: DestinationSnapshot;
  let destinationResolution: 'SERVER_RESOLVED' | 'EXPLICITLY_AUTHORIZED' = 'SERVER_RESOLVED';
  if (facts.lane === 'DOORSTEP') {
    const doorstep = resolveDoorstep(config, facts);
    destination = { kind: 'IN_AREA_DOORSTEP', serviceArea: doorstep.zone.serviceArea };
    destinationSnapshot = doorstep.snapshot;
    destinationResolution = doorstep.resolution;
  } else {
    destination =
      facts.commercialMode === 'STATION_DROP'
        ? { kind: 'STATION_DROP' }
        : { kind: 'OUTSIDE_SERVICE_AREA', carrierCostMinor: facts.carrierCostMinor };
    destinationSnapshot = { scope: 'OUTSIDE_SERVICE_AREA' };
  }

  // 4. The promised date, which the fee of a corridor depends on.
  let dates: DeliveryDates;
  try {
    dates = deliveryDatesOf(config, destination, facts.custodyAt, facts.requestedDeliveryDate);
  } catch (error) {
    if (error instanceof DeliveryDateRefusal) {
      if (error.code === 'SUNDAY') {
        throw new PricingRefusal('SERVICE_DATE_NOT_PERMITTED', error.message);
      }
      throw new OrderRuleRefusal('VALIDATION_FAILED', 'requested_before_default', error.message);
    }
    throw error;
  }

  // 5. The fee, with the high-value surcharge stacked on it.
  const price = priceOf(config, {
    destination,
    deliveryDate: dates.committedDate,
    sizeClass: facts.sizeClass,
    ...(facts.declaredValueMinor === undefined
      ? {}
      : { declaredValueMinor: facts.declaredValueMinor }),
  });

  // 6. A parcel above the first band, or flagged by an officer, needs its evidence.
  const isHigh =
    facts.manualHighValue ||
    (facts.declaredValueMinor !== undefined && isHighValue(config, facts.declaredValueMinor));
  if (isHigh && facts.highValueEvidenceCount === 0) {
    throw new OrderRuleRefusal(
      'REASON_REQUIRED',
      'high_value_evidence_required',
      'A high-value parcel needs stored evidence at itemization',
    );
  }

  return {
    destination,
    destinationSnapshot,
    destinationResolution,
    isHighValue: isHigh,
    price,
    snapshot: snapshotOf(config.hubId, price),
    dates,
    window: deliveryWindowOf(config),
    references: price.components.flatMap((component) =>
      component.reference === undefined
        ? []
        : [
            {
              settingKey: component.reference.settingKey,
              effectiveVersion: component.reference.effectiveVersion,
            },
          ],
    ),
  };
}

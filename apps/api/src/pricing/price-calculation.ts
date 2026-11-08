import {
  HubSettingMissingError,
  type HubConfiguration,
  type SettingReference,
  type SizeClass,
  type Weekday,
} from '../platform/settings/hub-configuration.js';

/**
 * The fee of a parcel (S1.6, `SLICE-001`; settings.md §7.2; itemization.md §5.1; domain-model.md §6.7 and §3.7; `MSC-DEC-207`,
 * `-209`, `-210`). **Pure**: it is handed the hub’s configuration snapshot and a description of the parcel, reads nothing, and
 * returns the total with the **components** it is made of, each naming the hub, setting key, scope and version it was read from, so
 * that a frozen price can be explained for ever (§3.7).
 *
 * | Destination | Fee |
 * |---|---|
 * | In the service area, doorstep | the service area’s flat fee, **regardless of size**; **origin never changes it** |
 * | A corridor, on its batch day | the same flat fee |
 * | A corridor, on any other operating day | the corridor’s own off-day fee (accepted and priced, never refused) |
 * | Station Drop | `station_drop_fee`, flat, regardless of size |
 * | Outside the service area | the carrier’s actual charge + `outside_accra_margin` + the size-class surcharge |
 *
 * **The size surcharge applies to the last row only** (`MSC-DEC-209`; SMALL adds nothing, and is still read). The size class is the
 * officer’s judgement and is never defaulted: a parcel with none is refused, in every mode, because a pre-selected class quietly
 * becomes the answer. The client sends none of the money here but the carrier’s cost, an observation with a waybill behind it.
 *
 * **The high-value surcharge is not computed here.** `MELARC_HIGH_VALUE_TIERS` is confirmed, but how it enters the locked price is
 * the Product Owner’s decision D-06 and its band boundaries are unstated; it is added to this function when that decision is
 * recorded, as one more component, and not before. A price therefore never carries a surcharge nobody decided.
 */

/** What a destination is, for pricing. The zone and service area are resolved by the server before this is asked. */
export type Destination =
  | { readonly kind: 'IN_AREA_DOORSTEP'; readonly serviceArea: string }
  | { readonly kind: 'STATION_DROP' }
  | { readonly kind: 'OUTSIDE_SERVICE_AREA'; readonly carrierCostMinor: number | undefined };

export interface PriceInput {
  readonly destination: Destination;
  /** The calendar date of the delivery, `YYYY-MM-DD`, on the hub’s clock. Required for a doorstep delivery. */
  readonly deliveryDate?: string;
  /** The receiving officer’s judgement. Required in every mode. */
  readonly sizeClass?: SizeClass;
}

export type PriceComponentKind =
  | 'SERVICE_AREA_BASE_FEE'
  | 'CORRIDOR_OFF_DAY_FEE'
  | 'STATION_DROP_FEE'
  | 'CARRIER_COST'
  | 'OUTSIDE_ACCRA_MARGIN'
  | 'SIZE_CLASS_SURCHARGE';

export interface PriceComponent {
  readonly kind: PriceComponentKind;
  readonly amountMinor: number;
  /** Where the amount came from. Absent for the carrier’s cost, which is an observation and names no setting. */
  readonly reference?: SettingReference;
}

export interface Price {
  readonly totalMinor: number;
  readonly components: readonly PriceComponent[];
}

/** The refusals of pricing, each with the code of the catalogue that names it (errors-and-enums.md). */
export const PRICING_REFUSALS = [
  'SETTING_MISSING',
  'MARGIN_NOT_CONFIGURED',
  'SIZE_CLASS_REQUIRED',
  'CARRIER_COST_REQUIRED',
  'SERVICE_DATE_NOT_PERMITTED',
] as const;
export type PricingRefusalCode = (typeof PRICING_REFUSALS)[number];

export class PricingRefusal extends Error {
  constructor(
    readonly code: PricingRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'PricingRefusal';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The weekday of each `Date#getUTCDay()` (Sunday is 0), while the catalogue's own list (`WEEKDAYS`) starts on Monday. */
const BY_UTC_DAY = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
] as const satisfies readonly Weekday[];

/** The weekday of a calendar date, `YYYY-MM-DD`. A calendar date has no time zone, so this reads it as a UTC date. */
export function weekdayOf(isoDate: string): Weekday {
  const match = ISO_DATE.exec(isoDate);
  if (match === null) throw new RangeError('A date is YYYY-MM-DD');
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError('That is not a calendar date');
  }
  return BY_UTC_DAY[date.getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6];
}

/** A missing hub value as the refusal the caller can name; any other failure (an invalid value) is rethrown unchanged. */
export function refuseIfMissing<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof HubSettingMissingError) {
      throw new PricingRefusal('SETTING_MISSING', error.message);
    }
    throw error;
  }
}

/** The operating calendar of a service area: the weekdays on which its flat fee applies. */
function inArea(
  config: HubConfiguration,
  serviceArea: string,
  deliveryDate: string | undefined,
): PriceComponent {
  if (deliveryDate === undefined) {
    throw new PricingRefusal(
      'SERVICE_DATE_NOT_PERMITTED',
      'A doorstep delivery is priced for a delivery date',
    );
  }
  const weekday = weekdayOf(deliveryDate);
  const base = refuseIfMissing(() => config.baseFee(serviceArea));
  if (base.value.days.includes(weekday)) {
    return {
      kind: 'SERVICE_AREA_BASE_FEE',
      amountMinor: base.value.amountMinor,
      reference: base.reference,
    };
  }
  // Only a corridor has a batch day; Accra & Tema operates every day Monday to Saturday and nothing else. A day on which the service
  // area has no base fee and no off-day fee is not a day the hub serves it.
  if (serviceArea === 'ACCRA_TEMA' || weekday === 'SUN') {
    throw new PricingRefusal(
      'SERVICE_DATE_NOT_PERMITTED',
      'The service area does not operate on that day',
    );
  }
  const off = refuseIfMissing(() => config.corridorOffDayFee(serviceArea));
  return { kind: 'CORRIDOR_OFF_DAY_FEE', amountMinor: off.value, reference: off.reference };
}

export function priceOf(config: HubConfiguration, input: PriceInput): Price {
  if (input.sizeClass === undefined) {
    throw new PricingRefusal(
      'SIZE_CLASS_REQUIRED',
      'The receiving officer selects a size class; there is no default',
    );
  }
  const components: PriceComponent[] = [];
  const { destination } = input;

  switch (destination.kind) {
    case 'IN_AREA_DOORSTEP': {
      components.push(inArea(config, destination.serviceArea, input.deliveryDate));
      break;
    }
    case 'STATION_DROP': {
      const fee = refuseIfMissing(() => config.money('station_drop_fee'));
      components.push({
        kind: 'STATION_DROP_FEE',
        amountMinor: fee.value,
        reference: fee.reference,
      });
      break;
    }
    case 'OUTSIDE_SERVICE_AREA': {
      const cost = destination.carrierCostMinor;
      if (cost === undefined || !Number.isSafeInteger(cost) || cost <= 0) {
        throw new PricingRefusal(
          'CARRIER_COST_REQUIRED',
          'A parcel outside the service area needs the carrier’s actual charge, transcribed from the waybill',
        );
      }
      let margin;
      try {
        margin = config.money('outside_accra_margin');
      } catch (error) {
        if (error instanceof HubSettingMissingError) {
          // Refused, not priced at cost: shipping at zero margin silently is worse than declining.
          throw new PricingRefusal('MARGIN_NOT_CONFIGURED', error.message);
        }
        throw error;
      }
      const surcharges = refuseIfMissing(() => config.sizeClassSurcharges());
      components.push(
        { kind: 'CARRIER_COST', amountMinor: cost },
        { kind: 'OUTSIDE_ACCRA_MARGIN', amountMinor: margin.value, reference: margin.reference },
        {
          kind: 'SIZE_CLASS_SURCHARGE',
          amountMinor: surcharges.value[input.sizeClass],
          reference: surcharges.reference,
        },
      );
      break;
    }
  }

  return {
    totalMinor: components.reduce((sum, component) => sum + component.amountMinor, 0),
    components,
  };
}

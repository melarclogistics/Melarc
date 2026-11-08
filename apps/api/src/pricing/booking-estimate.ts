import {
  HubSettingMissingError,
  type HubConfiguration,
  type SettingReference,
} from '../platform/settings/hub-configuration.js';
import {
  PricingRefusal,
  priceOf,
  refuseIfMissing,
  weekdayOf,
  type Destination,
} from './price-calculation.js';

/**
 * The booking estimate (S1.6, `SLICE-001`; `MSC-DEC-211`, which reversed §23.6 and `MSC-DEC-175`; pickup-request.md §5.1; domain-model.md
 * §6.2). **Indicative, never a quote, never a price.** Every booking shows one, computed by the server from the hub’s configuration
 * in force, and what is kept is its **inputs** (each component names its hub, setting key, scope and version) so that the figure shown
 * can be reproduced and is visibly distinct from the frozen price that itemization sets later, from the size class the receiving
 * officer selects. It assumes the smallest class and an in-area doorstep delivery, and **excludes the size and the high-value
 * surcharges**, which it cannot know.
 *
 * - **A standard request (two or more packages)** has no destination yet (itemization captures it), so the estimate is the in-area
 *   flat fee times the package count.
 * - **A one-package exception** carries the recipient’s delivery address (§21.1), so the destination is known and the estimate is the
 *   fee that actually applies there, plus the single-package pickup fee: the in-area fee; a corridor’s flat fee on its batch day or
 *   its own off-day fee on another day (the service date is the date asked about); and **nothing for a destination outside the service
 *   area**, because the carrier’s charge is unknowable until itemization and a number invented for it would be worse than none.
 * - **A missing value never blocks a booking and is never estimated at zero.** An operational decision is not held hostage to missing
 *   commercial configuration (§33.4 forbids borrowing another hub’s value), so the estimate is *unavailable* and says why.
 *
 * The client sends an address and never a price. Pure: it is handed the snapshot and reads nothing.
 */

export type EstimateStatus =
  'AVAILABLE' | 'UNAVAILABLE_OUTSIDE_SERVICE_AREA' | 'UNAVAILABLE_SETTING_MISSING';

export interface EstimateComponent {
  readonly kind: 'SERVICE_AREA_BASE_FEE' | 'CORRIDOR_OFF_DAY_FEE' | 'SINGLE_PACKAGE_PICKUP_FEE';
  readonly reference: SettingReference;
  readonly quantity: number;
  readonly amountMinor: number;
}

export interface BookingEstimate {
  readonly status: EstimateStatus;
  readonly provisional: true;
  /** Null unless `AVAILABLE`. */
  readonly totalMinor: number | null;
  /** Always the smallest class: the receiving officer selects the real one at itemization. */
  readonly assumesSizeClass: 'SMALL';
  readonly excludes: readonly ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'];
  readonly components: readonly EstimateComponent[];
}

export interface EstimateInput {
  readonly packageCount: number;
  /** The scheduled service date, `YYYY-MM-DD`. A day the hub does not operate is refused before an estimate is asked for. */
  readonly serviceDate: string;
  /** Present only for a one-package exception, whose delivery address is mandatory (§21.1). */
  readonly singlePackageDestination?: Destination;
}

const unavailable = (status: Exclude<EstimateStatus, 'AVAILABLE'>): BookingEstimate => ({
  status,
  provisional: true,
  totalMinor: null,
  assumesSizeClass: 'SMALL',
  excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
  components: [],
});

export function bookingEstimate(config: HubConfiguration, input: EstimateInput): BookingEstimate {
  if (!Number.isSafeInteger(input.packageCount) || input.packageCount < 1) {
    throw new RangeError('A booking has at least one package');
  }
  // Refused here only as a caller’s defect: the booking validates the service date before it asks for an estimate.
  weekdayOf(input.serviceDate);

  try {
    const destination = input.singlePackageDestination;
    if (destination === undefined) {
      const fee = refuseIfMissing(() => config.baseFee('ACCRA_TEMA'));
      const weekday = weekdayOf(input.serviceDate);
      if (!fee.value.days.includes(weekday)) {
        throw new PricingRefusal(
          'SERVICE_DATE_NOT_PERMITTED',
          'The service area does not operate on that day',
        );
      }
      const amountMinor = fee.value.amountMinor * input.packageCount;
      return available(amountMinor, [
        {
          kind: 'SERVICE_AREA_BASE_FEE',
          reference: fee.reference,
          quantity: input.packageCount,
          amountMinor,
        },
      ]);
    }

    if (destination.kind === 'OUTSIDE_SERVICE_AREA') {
      return unavailable('UNAVAILABLE_OUTSIDE_SERVICE_AREA');
    }

    // The destination fee is the price function’s own, for the smallest class, so the estimate and the price can never diverge on a
    // rule: they share it. Station Drop is an outbound mode chosen after itemization and is not a booking destination.
    if (destination.kind === 'STATION_DROP') {
      throw new RangeError('A station drop is not a booking destination');
    }
    const delivery = priceOf(config, {
      destination,
      deliveryDate: input.serviceDate,
      sizeClass: 'SMALL',
    });
    const pickup = refuseIfMissing(() => config.money('single_package_pickup_fee'));
    const components: EstimateComponent[] = delivery.components.map((component) => {
      if (
        component.reference === undefined ||
        (component.kind !== 'SERVICE_AREA_BASE_FEE' && component.kind !== 'CORRIDOR_OFF_DAY_FEE')
      ) {
        throw new Error('An in-area delivery price is made of a flat fee and nothing else');
      }
      return {
        kind: component.kind,
        reference: component.reference,
        quantity: 1,
        amountMinor: component.amountMinor,
      };
    });
    components.push({
      kind: 'SINGLE_PACKAGE_PICKUP_FEE',
      reference: pickup.reference,
      quantity: 1,
      amountMinor: pickup.value,
    });
    return available(delivery.totalMinor + pickup.value, components);
  } catch (error) {
    if (error instanceof PricingRefusal && error.code === 'SETTING_MISSING') {
      return unavailable('UNAVAILABLE_SETTING_MISSING');
    }
    if (error instanceof HubSettingMissingError) return unavailable('UNAVAILABLE_SETTING_MISSING');
    throw error;
  }
}

function available(totalMinor: number, components: readonly EstimateComponent[]): BookingEstimate {
  return {
    status: 'AVAILABLE',
    provisional: true,
    totalMinor,
    assumesSizeClass: 'SMALL',
    excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
    components,
  };
}

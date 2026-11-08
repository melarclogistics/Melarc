import type { HubConfiguration } from '../platform/settings/hub-configuration.js';
import { bookingEstimate, type BookingEstimate } from '../pricing/booking-estimate.js';
import { resolveZone } from '../pricing/zone-resolver.js';
import type { IndicativeEstimateView, LocationView } from './pickup-request-view.js';

/**
 * The booking estimate as the contract's `IndicativeEstimate` (domain-model.md section 6.2, `MSC-DEC-211`). It is **provisional and
 * never a price**: a figure computed from the hub's settings in force, with the inputs of each component named by hub, setting key and
 * effective version, so that it can be reproduced and is visibly distinct from the price that itemization freezes. What is stored on the
 * request (`estimate_snapshot`) is this representation: the inputs, from which the amount is derived.
 */
export function estimateViewOf(hubId: string, estimate: BookingEstimate): IndicativeEstimateView {
  return {
    status: estimate.status,
    provisional: true,
    total:
      estimate.totalMinor === null ? null : { amount_minor: estimate.totalMinor, currency: 'GHS' },
    assumes_size_class: estimate.assumesSizeClass,
    excludes: estimate.excludes,
    components: estimate.components.map((component) => ({
      kind: component.kind,
      hub_id: hubId,
      setting_key: component.reference.settingKey,
      effective_version: String(component.reference.effectiveVersion),
      quantity: component.quantity,
      amount: { amount_minor: component.amountMinor, currency: 'GHS' },
    })),
  };
}

/**
 * The estimate of a request as an operation that computes one answers it (booking, confirmation). Pure over the configuration it is handed.
 *
 * - **A standard request (two packages or more)**: the base fee times the packages, with no destination to name (itemization captures it).
 * - **A single package with an approved exception** carries the recipient's delivery address (section 21.1), so the destination is known
 *   and the estimate is the fee that applies there plus the single-package pickup fee: the in-area fee, a corridor's flat fee on its batch
 *   day or its own off-day fee on another day. The address is resolved to a zone by the hub's own aliases (`resolveZone`: a free-text
 *   address is never authoritative, section 23.3). **Where it resolves to no zone, or to more than one, there is no estimate**: a number
 *   invented for an address nobody has mapped would be worse than none, and the alias data is the Product Owner's to supply. A single
 *   package with no address given has none either.
 */
export function estimateOf(
  config: HubConfiguration,
  request: {
    readonly packageCount: number;
    readonly serviceDate: string;
    /** The recipient's delivery address, for a single package whose exception is approved. */
    readonly deliveryLocation?: LocationView;
  },
): IndicativeEstimateView | null {
  const { packageCount, serviceDate, deliveryLocation } = request;
  if (packageCount >= 2) {
    return estimateViewOf(config.hubId, bookingEstimate(config, { packageCount, serviceDate }));
  }
  if (deliveryLocation === undefined) return null;
  const resolution = resolveZone(config, deliveryLocation);
  if (resolution.kind !== 'RESOLVED') return null;
  return estimateViewOf(
    config.hubId,
    bookingEstimate(config, {
      packageCount,
      serviceDate,
      singlePackageDestination: {
        kind: 'IN_AREA_DOORSTEP',
        serviceArea: resolution.zone.serviceArea,
      },
    }),
  );
}

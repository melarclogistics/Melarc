import type { SeedPlan } from '../../platform/database/seed/seed-helper.js';
import type { ServiceArea } from '../../platform/database/schema/hub-configuration.js';
import { HUBS } from './hubs.js';

/**
 * The launch hub's configuration (`SLICE-001`, the Product Owner's decision of 29 October 2026, D-02: a bounded launch-fee seed;
 * MIGRATION_AND_SEEDING.md section 4; domain-model.md section 6.20): the seven service zones of settings.md section 7.2 and the
 * confirmed hub-scoped values of sections 7.2 and 7.3, for the Accra hub. `seed-data.test.ts` reads settings.md and fails when this
 * list and the document's confirmed values differ, so a value changes in the document and here in one change.
 *
 * **Only what the document confirms, with the value it gives.** An `OPEN` key is absent (`intake_lock_idle_ttl_minutes`, the
 * fuel-record thresholds) and so is `MELARC_HIGH_VALUE_TIERS`, which is `CONFIRMED` but whose bands have no stated boundary
 * (the first is "GH₵500–2,000" and the second "above GH₵2,000") and whose place in the price is the owner's decision D-06; it is
 * seeded when that decision is recorded. A missing value fails visibly where it is needed (`SETTING_MISSING`); none is invented.
 * **No zone alias is seeded**: the data that places an address in a zone is the Product Owner's to supply (OB-S1-02).
 *
 * Money is integer pesewas (GH₵35 is 3500). A per-service-area value has one row per service area, named by `scopeRef`; a base fee
 * also states the weekdays it applies on, which is how a corridor's batch day (Friday, for both corridors) is held. The two
 * corridors' off-day fees are separate values (GH₵70 and GH₵80, the owner's answer of 29 October 2026).
 *
 * **The grouping of the seven zones into three service areas is a reading.** settings.md names the base fee per service area
 * ("Accra & Tema", "Amasaman & Environs", "Kasoa Corridor") and the zone catalogue as seven zones, two of them the corridors; the
 * five others are Accra & Tema. Nothing states it as a table, so it is recorded here as the reading and surfaced for confirmation.
 */

/** The hub every row belongs to: the launch hub of `hubs.ts`. */
const [LAUNCH_HUB] = HUBS;
if (LAUNCH_HUB === undefined) throw new Error('The seed has no launch hub');
export const LAUNCH_HUB_ID = LAUNCH_HUB.id;

export interface ServiceZoneSeed {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly serviceArea: ServiceArea;
}

const zone = (
  n: number,
  code: string,
  name: string,
  serviceArea: ServiceArea,
): ServiceZoneSeed => ({
  id: `5eed0101-0000-4000-8000-${String(n).padStart(12, '0')}`,
  code,
  name,
  serviceArea,
});

/** The launch hub's seven zones (settings.md section 7.2, `MSC-DEC-050`), in the document's order. */
export const SERVICE_ZONES: readonly ServiceZoneSeed[] = [
  zone(1, 'TEMA', 'Tema', 'ACCRA_TEMA'),
  zone(2, 'ACCRA_CENTRAL', 'Accra Central', 'ACCRA_TEMA'),
  zone(3, 'LAPAZ_SOWUTUOM', 'Lapaz/Sowutuom', 'ACCRA_TEMA'),
  zone(4, 'MADINA_ADENTA', 'Madina/Adenta', 'ACCRA_TEMA'),
  zone(5, 'DANSOMAN', 'Dansoman', 'ACCRA_TEMA'),
  zone(6, 'AMASAMAN_ENVIRONS', 'Amasaman & Environs', 'AMASAMAN_ENVIRONS'),
  zone(7, 'KASOA_CORRIDOR', 'Kasoa Corridor', 'KASOA_CORRIDOR'),
];

export interface HubSettingSeed {
  readonly key: string;
  /** Empty for a hub-wide value; a service-area code for a per-service-area one. */
  readonly scopeRef: string;
  readonly value: unknown;
  readonly unit: string;
}

const MON_TO_SAT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const wide = (key: string, value: unknown, unit: string): HubSettingSeed => ({
  key,
  scopeRef: '',
  value,
  unit,
});

const perArea = (
  key: string,
  scopeRef: ServiceArea,
  value: unknown,
  unit: string,
): HubSettingSeed => ({ key, scopeRef, value, unit });

/**
 * The confirmed hub-scoped values for the launch hub (settings.md sections 7.2 and 7.3), in the document's order.
 * Version 1 of each, effective from the seed.
 */
export const HUB_SETTINGS: readonly HubSettingSeed[] = [
  // 7.2 pricing
  perArea(
    'service_area_base_fee',
    'ACCRA_TEMA',
    { amount_minor: 3500, days: MON_TO_SAT },
    'pesewas',
  ),
  perArea(
    'service_area_base_fee',
    'AMASAMAN_ENVIRONS',
    { amount_minor: 3500, days: ['FRI'] },
    'pesewas',
  ),
  perArea(
    'service_area_base_fee',
    'KASOA_CORRIDOR',
    { amount_minor: 3500, days: ['FRI'] },
    'pesewas',
  ),
  perArea('corridor_off_day_fee', 'AMASAMAN_ENVIRONS', { amount_minor: 7000 }, 'pesewas'),
  perArea('corridor_off_day_fee', 'KASOA_CORRIDOR', { amount_minor: 8000 }, 'pesewas'),
  wide('station_drop_fee', 2000, 'pesewas'),
  wide('redelivery_fee_minor', 2000, 'pesewas'),
  wide('flat_return_fee_amount', 2000, 'pesewas'),
  wide('single_package_pickup_fee', 2000, 'pesewas'),
  wide('cancellation_charge_amount', 2000, 'pesewas'),
  wide('size_class_surcharges', { SMALL: 0, MEDIUM: 2000, LARGE: 3000 }, 'pesewas by size class'),
  wide('outside_accra_margin', 3000, 'pesewas'),
  // 7.3 operational
  wide('vendor_credit_grace_window_minutes', 60, 'minutes'),
  wide('booking_cutoff_time', '10:00', 'time of day, Africa/Accra'),
  wide('MELARC_MAX_PICKUP_ATTEMPTS', 3, 'attempts'),
  wide('auto_reschedule', false, 'switch'),
  wide('stale_failure_backstop_hours', 24, 'hours'),
  wide('intake_parcel_cap', 100, 'parcels'),
  wide('pickup_service_window_start', '11:00', 'time of day, Africa/Accra'),
  wide('pickup_service_window_end', '16:00', 'time of day, Africa/Accra'),
  wide('rider_door_wait_minutes', 10, 'minutes'),
];

/**
 * The plan that adds the launch hub's configuration to a database (`melarc.seed_hub_configuration`, migration 0042). It is **once**,
 * as the other seed functions are: it refuses (`SeedRefusedError`) unless the three tables are empty. `effective_from` is the seed
 * transaction's own time and `created_by` the reserved system actor, both set by the function; no alias is in the plan (none exists).
 */
export function hubConfigurationPlan(): SeedPlan {
  return {
    policyKeys: { bundleIds: [], fixedPolicies: [] },
    entryPoint: 'seed_hub_configuration',
    payload: {
      service_zone: SERVICE_ZONES.map((each) => ({
        id: each.id,
        hub_id: LAUNCH_HUB_ID,
        code: each.code,
        name: each.name,
        service_area: each.serviceArea,
      })),
      hub_setting: HUB_SETTINGS.map((each) => ({
        hub_id: LAUNCH_HUB_ID,
        setting_key: each.key,
        scope_ref: each.scopeRef,
        version: 1,
        value: each.value,
        unit: each.unit,
      })),
    },
  };
}

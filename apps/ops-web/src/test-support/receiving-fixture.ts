import type { components } from '@melarc/api-client';

import { INTAKE_HUB_ID } from './hub-intake-fixture';

/**
 * Real-shaped answers of the receiving screens of a run (S1.35c), for tests. Every field the contract requires is present and each value is synthetic; the types are the contract's, so nothing here
 * describes the wire a second time. **The rider's number of a blind-count vendor of a test is `PLANTED_BLIND_NUMBER`** and is planted only where a test is proving that a screen never draws it.
 */
type Parcel = components['schemas']['IntakeParcel'];
type Vendor = components['schemas']['ReceivingVendor'];
type Run = components['schemas']['ReceivingRun'];
type Summary = components['schemas']['ReceivingRunSummary'];
type Missing = components['schemas']['MissingParcel'];
type Lock = components['schemas']['ReceivingLock'];

export const RUN_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const RUN_CODE = 'ACC-MF-7KQ2MZ';
export const OTHER_RUN_ID = '1b2c3d4e-5f60-4b7c-8d8e-0f1a2b3c4d5e';
export const OTHER_RUN_CODE = 'ACC-MF-4PX8RT';
export const KENTE_INTAKE_ID = '2c3d4e5f-6071-4c8d-9e9f-1a2b3c4d5e6f';
export const KENTE_INTAKE_CODE = 'ACC-IN-3HN7WD';
export const SHEA_INTAKE_ID = '3d4e5f60-7182-4d9e-8fa0-2b3c4d5e6f70';
export const SHEA_INTAKE_CODE = 'ACC-IN-9BC2KE';
export const BLIND_INTAKE_ID = '4e5f6071-8293-4eaf-90b1-3c4d5e6f7081';
export const BLIND_INTAKE_CODE = 'ACC-IN-6TF5MJ';
export const KENTE = 'Kente Crafts';
export const SHEA = 'Shea Naturals';
export const BLIND_VENDOR = 'Adwoa Stalls';
export const RIDER_NAME = 'Kofi Boateng';
export const RECEIVER_NAME = 'Ama Owusu';
export const HUB_NAME = 'Accra hub';

/** What a blind-count vendor's rider declared, in tests: **a number no screen of the run may ever draw before the count.** Not a number a count could be by chance. */
export const PLANTED_BLIND_NUMBER = 4137;

/** A uuid for the nth thing of a kind: valid version 4 shapes, distinct across kinds. */
export const uuid = (kind: number, n: number): string =>
  `${kind.toString(16).padStart(8, 'a')}-${n.toString(16).padStart(4, '0')}-4a5b-8c6d-${n.toString(16).padStart(12, '0')}`;

export const PARCEL_KIND = 0xb0;
export const PHOTO_KIND = 0xc0;

/** The nth parcel of a vendor whose door photo is the nth: expected, not checked in, no condition recorded yet. */
export function parcelFixture(n: number, overrides: Partial<Parcel> = {}): Parcel {
  return {
    id: uuid(PARCEL_KIND, n),
    ordinal: n,
    origin: 'DOOR_PHOTO',
    state: 'EXPECTED',
    photo_evidence_id: uuid(PHOTO_KIND, n),
    arrived_by_name: null,
    arrived_at: null,
    missing_marked_at: null,
    condition: null,
    ...overrides,
  };
}

/** A parcel that was checked in by an officer. */
export const arrivedParcel = (n: number, overrides: Partial<Parcel> = {}): Parcel =>
  parcelFixture(n, {
    state: 'ARRIVED',
    arrived_by_name: RECEIVER_NAME,
    arrived_at: '2026-11-14T09:12:00Z',
    ...overrides,
  });

/** An extra: a parcel found on the table with no door photo, `ARRIVED` at once. */
export const extraParcel = (n: number, overrides: Partial<Parcel> = {}): Parcel =>
  parcelFixture(n, {
    origin: 'HUB_EXTRA',
    state: 'ARRIVED',
    photo_evidence_id: uuid(0xd0, n),
    arrived_by_name: RECEIVER_NAME,
    arrived_at: '2026-11-14T09:14:00Z',
    ...overrides,
  });

export const lockFixture = (overrides: Partial<Lock> = {}): Lock => ({
  holder_name: RECEIVER_NAME,
  held_by_you: false,
  opened_at: '2026-11-14T09:12:00Z',
  last_seen_at: '2026-11-14T09:13:00Z',
  ...overrides,
});

/** The counts a photo vendor's parcels give, as the database derives them (what a screen is told, never what it works out). */
export function countsOf(parcels: readonly Parcel[]) {
  const door = parcels.filter((parcel) => parcel.origin === 'DOOR_PHOTO').length;
  return {
    parcels_expected: door,
    arrived_count: parcels.filter((parcel) => parcel.state === 'ARRIVED').length,
    missing_count: parcels.filter((parcel) => parcel.state === 'MISSING').length,
    extra_count: parcels.filter(
      (parcel) => parcel.origin === 'HUB_EXTRA' && parcel.state !== 'VOID',
    ).length,
    damaged_count: parcels.filter(
      (parcel) => parcel.condition !== null && parcel.condition.condition !== 'OK',
    ).length,
  };
}

/** A photo vendor whose twelve (by default: `count`) parcels wait to be checked in. */
export function photoVendorFixture(
  count = 3,
  overrides: Partial<Vendor> = {},
  parcels: readonly Parcel[] = Array.from({ length: count }, (_, index) =>
    parcelFixture(index + 1),
  ),
): Vendor {
  return {
    intake_id: KENTE_INTAKE_ID,
    intake_code: KENTE_INTAKE_CODE,
    intake_etag: '"kente-1"',
    receiving_mode: 'PHOTO_CHECK_IN',
    state: 'AWAITING_COUNT',
    vendor_name: KENTE,
    received_count: null,
    count_variance: null,
    lock: null,
    ...countsOf(parcels),
    parcels: [...parcels],
    ...overrides,
  };
}

/** A vendor counted blind (its stop has no photos): no parcel, and none of the rider's number. */
export function blindVendorFixture(overrides: Partial<Vendor> = {}): Vendor {
  return {
    intake_id: BLIND_INTAKE_ID,
    intake_code: BLIND_INTAKE_CODE,
    intake_etag: '"blind-1"',
    receiving_mode: 'BLIND_COUNT',
    state: 'AWAITING_COUNT',
    vendor_name: BLIND_VENDOR,
    parcels_expected: null,
    arrived_count: null,
    received_count: null,
    count_variance: null,
    lock: null,
    missing_count: 0,
    extra_count: 0,
    damaged_count: 0,
    parcels: [],
    ...overrides,
  };
}

/** A run with the vendors given: the receiving page of a run handed over at 09:00. */
export function runFixture(vendors: readonly Vendor[], overrides: Partial<Run> = {}): Run {
  return {
    run: {
      id: RUN_ID,
      code: RUN_CODE,
      hub_id: INTAKE_HUB_ID,
      hub_name: HUB_NAME,
      service_date: '2026-11-14',
    },
    rider_name: RIDER_NAME,
    handed_over_at: '2026-11-14T09:00:00Z',
    vendors: [...vendors],
    ...overrides,
  };
}

/** One row of the queue by run. */
export function runSummaryFixture(overrides: Partial<Summary> = {}): Summary {
  return {
    run_id: RUN_ID,
    run_code: RUN_CODE,
    hub_id: INTAKE_HUB_ID,
    hub_name: HUB_NAME,
    rider_name: RIDER_NAME,
    vendor_names: [KENTE, SHEA],
    vendors_total: 2,
    vendors_waiting: 2,
    vendors_needing_decision: 0,
    blind_count_vendors: 0,
    parcels_expected: 7,
    missing_searching: 0,
    handed_over_at: '2026-11-14T09:00:00Z',
    checking_in: [],
    ...overrides,
  };
}

export function missingParcelFixture(n: number, overrides: Partial<Missing> = {}): Missing {
  return {
    parcel_id: uuid(PARCEL_KIND, n),
    photo_evidence_id: uuid(PHOTO_KIND, n),
    intake_id: KENTE_INTAKE_ID,
    intake_code: KENTE_INTAKE_CODE,
    run_id: RUN_ID,
    run_code: RUN_CODE,
    vendor_name: KENTE,
    missing_since: '2026-11-14T09:30:00Z',
    written_off_at: null,
    ...overrides,
  };
}

export const runPage = (items: unknown[], next: string | null = null) => ({
  items,
  next_page_token: next,
});

export const EVIDENCE_LIMITS = {
  allowed_content_types: ['image/jpeg', 'image/png'],
  max_byte_size: 10 * 1024 * 1024,
} as const;

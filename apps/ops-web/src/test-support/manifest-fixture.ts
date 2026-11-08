import type { components } from '@melarc/api-client';

import { PICKUP_HUB_ID } from './pickup-fixture';

/**
 * Real-shaped answers of the manifest reads and acts, for tests (S1.25). Every field the contract requires is present and each value is
 * synthetic. The types are the contract's: nothing here describes the wire a second time.
 */
type ManifestBody = components['schemas']['PickupManifest'];
type StopBody = components['schemas']['PickupStop'];
type HandoverBody = components['schemas']['RunCustodyHandover'];

export const MANIFEST_ID = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
export const STOP_ONE_ID = '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a';
export const STOP_TWO_ID = '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b';
export const STOP_THREE_ID = 'af1a2b3c-4d5e-4f6a-8b7c-8d9e0f1a2b3c';
export const REQUEST_ONE_ID = 'b02b3c4d-5e6f-4a7b-8c8d-9e0f1a2b3c4d';
export const REQUEST_TWO_ID = 'c13c4d5e-6f7a-4b8c-8d9e-0f1a2b3c4d5e';
export const REQUEST_THREE_ID = 'd24d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
export const HANDOVER_ID = 'e35e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a';
export { PICKUP_HUB_ID as MANIFEST_HUB_ID };

export function summaryFixture(
  reference: string,
  overrides: Partial<NonNullable<StopBody['pickup_summary']>> = {},
): NonNullable<StopBody['pickup_summary']> {
  return {
    reference,
    sender_display_name: 'Demo Fabrics Ltd',
    declared_package_count: 3,
    resolved_pickup_location: {
      address: '14 Demo Lane, Osu',
      landmark: 'Opposite the demo bakery',
    },
    location_note: null,
    contact_phone: '+233201234567',
    ...overrides,
  };
}

export function stopFixture(overrides: Partial<StopBody> = {}): StopBody {
  return {
    id: STOP_ONE_ID,
    pickup_manifest_id: MANIFEST_ID,
    pickup_request_id: REQUEST_ONE_ID,
    sequence: 1,
    state: 'PENDING',
    arrived_at: null,
    failure_category: null,
    failure: null,
    skipped: null,
    ...overrides,
  };
}

/** A draft manifest of three pending stops, with no rider: the state in which it can be ordered, given a rider and dispatched. */
export function manifestFixture(overrides: Partial<ManifestBody> = {}): ManifestBody {
  return {
    id: MANIFEST_ID,
    code: 'ACC-MF-Q92422',
    state: 'DRAFT',
    service_date: '2026-11-04',
    responsible_hub_id: PICKUP_HUB_ID,
    assigned_rider_id: null,
    assigned_at: null,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    stops: [
      stopFixture(),
      stopFixture({ id: STOP_TWO_ID, pickup_request_id: REQUEST_TWO_ID, sequence: 2 }),
      stopFixture({ id: STOP_THREE_ID, pickup_request_id: REQUEST_THREE_ID, sequence: 3 }),
    ],
    ...overrides,
  };
}

/** The list's manifest: it carries neither the stops nor an `ETag`. */
export function listedManifestFixture(overrides: Partial<ManifestBody> = {}): ManifestBody {
  const manifest = manifestFixture(overrides);
  delete manifest.stops;
  return manifest;
}

export function handoverFixture(overrides: Partial<HandoverBody> = {}): HandoverBody {
  return {
    id: HANDOVER_ID,
    manifest_id: MANIFEST_ID,
    from_rider_id: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
    to_rider_id: null,
    to_hub_id: PICKUP_HUB_ID,
    state: 'PENDING',
    parcel_count_taken: null,
    initiated_at: '2026-11-04T10:15:00Z',
    resolved_at: null,
    ...overrides,
  };
}

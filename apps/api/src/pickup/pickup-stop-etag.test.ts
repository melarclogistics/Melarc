import { describe, expect, it } from 'vitest';

import { pickupManifestEtagOf } from './pickup-manifest-etag.js';
import {
  manifestViewOf,
  stopViewOf,
  type PickupManifestRow,
  type PickupStopRow,
} from './pickup-manifest-view.js';
import { pickupStopEtagOf } from './pickup-stop-etag.js';

const STOP: PickupStopRow = {
  id: '5eed0800-0000-4000-8000-000000000001',
  pickup_manifest_id: '5eed0700-0000-4000-8000-000000000001',
  pickup_request_id: '5eed0200-0000-4000-8000-000000000001',
  sequence: 1,
  state: 'PENDING',
  arrived_at: null,
  failure_category: null,
  failure_reason_snapshot: null,
  skip_snapshot: null,
  pickup_summary: null,
};

const view = (over: Partial<PickupStopRow> = {}) => stopViewOf({ ...STOP, ...over });

describe('the ETag of a pickup stop', () => {
  // Break caught: a token that is not the form a client can send back strictly (43 base64url characters between quotes).
  it('is one strong quoted token of a SHA-256 digest', () => {
    expect(pickupStopEtagOf(view(), 1)).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('is the same for the same representation and version, every time', () => {
    expect(pickupStopEtagOf(view(), 3)).toBe(pickupStopEtagOf(view(), 3));
  });

  // Break caught: a token that does not move with the row's version, so that a change the representation does not show goes unseen.
  it('moves with the version', () => {
    expect(pickupStopEtagOf(view(), 2)).not.toBe(pickupStopEtagOf(view(), 1));
  });

  // Break caught: a member of the stop left out of the digest, so that a change the caller can see goes unnoticed.
  it.each([
    ['its identity', { id: '5eed0800-0000-4000-8000-000000000002' }],
    ['its manifest', { pickup_manifest_id: '5eed0700-0000-4000-8000-000000000002' }],
    ['its request', { pickup_request_id: '5eed0200-0000-4000-8000-000000000002' }],
    ['its place', { sequence: 2 }],
    ['its state', { state: 'ARRIVED' as const }],
    ['the moment it was arrived at', { arrived_at: '2026-11-03T09:00:00.000Z' }],
    [
      'its skip',
      {
        state: 'SKIPPED' as const,
        skip_snapshot: { reason_code: 'REQUEST_CANCELLED', skipped_at: '2026-11-03T09:00:00.000Z' },
      },
    ],
    [
      'its summary',
      {
        pickup_summary: {
          reference: 'ACC-PR-7K3M9Q',
          sender_display_name: 'Ama Serwaa Fashions',
          declared_package_count: 4,
          resolved_pickup_location: { address: '12 Oxford Street, Osu' },
          location_note: null,
          contact_phone: '+233201234567',
        },
      },
    ],
  ] as const)('moves with %s', (_label, change) => {
    expect(pickupStopEtagOf(view(change), 1)).not.toBe(pickupStopEtagOf(view(), 1));
  });

  // Break caught: a stop's token that is the manifest's, so that one could be sent for the other.
  it('is not the token of a manifest, even of a manifest of this one stop', () => {
    const manifest: PickupManifestRow = {
      id: STOP.pickup_manifest_id,
      code: 'ACC-MF-7K3M9Q',
      state: 'IN_PROGRESS',
      service_date: '2026-11-03',
      responsible_hub_id: '5eed0100-0000-4000-8000-000000000001',
      assigned_rider_id: null,
      assigned_at: null,
      dispatched_at: null,
      started_at: null,
      completed_at: null,
      version: 1,
      created_at: new Date('2026-11-02T09:00:00.000Z'),
      created_at_text: '2026-11-02 09:00:00+00',
    };
    expect(pickupStopEtagOf(view(), 1)).not.toBe(
      pickupManifestEtagOf(manifestViewOf(manifest, [STOP]), 1),
    );
  });

  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pickupStopEtagOf(view(), version)).toThrow(RangeError);
    }
  });
});

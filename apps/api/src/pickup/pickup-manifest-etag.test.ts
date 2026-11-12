import { describe, expect, it } from 'vitest';

import { pickupManifestEtagMatches, pickupManifestEtagOf } from './pickup-manifest-etag.js';
import {
  manifestViewOf,
  type PickupManifestRow,
  type PickupManifestView,
  type PickupStopRow,
} from './pickup-manifest-view.js';

const MANIFEST: PickupManifestRow = {
  id: '5eed0700-0000-4000-8000-000000000001',
  code: 'ACC-MF-7K3M9Q',
  state: 'DRAFT',
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

const stop = (position: number, overrides: Partial<PickupStopRow> = {}): PickupStopRow => ({
  id: `5eed0800-0000-4000-8000-00000000000${String(position)}`,
  pickup_manifest_id: MANIFEST.id,
  pickup_request_id: `5eed0200-0000-4000-8000-00000000000${String(position)}`,
  sequence: position,
  state: 'PENDING',
  arrived_at: null,
  failure_category: null,
  failure_reason_snapshot: null,
  skip_snapshot: null,
  pickup_summary: null,
  ...overrides,
});

const view = (
  manifest: Partial<PickupManifestRow> = {},
  stops: readonly PickupStopRow[] = [stop(1), stop(2), stop(3)],
): PickupManifestView => manifestViewOf({ ...MANIFEST, ...manifest }, stops);

describe('the ETag of a pickup manifest', () => {
  // Break caught: a token that is not the form a client can send back strictly (43 base64url characters between quotes).
  it('is one strong quoted token of a SHA-256 digest', () => {
    expect(pickupManifestEtagOf(view(), 1)).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('is the same for the same representation and version, every time', () => {
    expect(pickupManifestEtagOf(view(), 4)).toBe(pickupManifestEtagOf(view(), 4));
  });

  // Break caught: a token that does not move with the record's version, so that a change to the row that the representation does not show
  // (a change of its audit columns) is not seen by a client holding the old token.
  it('moves with the version', () => {
    expect(pickupManifestEtagOf(view(), 2)).not.toBe(pickupManifestEtagOf(view(), 1));
  });

  // Break caught: a member of the manifest left out of the digest, so that a change the caller can see goes unnoticed.
  it.each([
    ['its identity', { id: '5eed0700-0000-4000-8000-000000000002' }],
    ['its code', { code: 'ACC-MF-2K3M9Q' }],
    ['its state', { state: 'CANCELLED' as const }],
    ['its day', { service_date: '2026-11-04' }],
    ['its hub', { responsible_hub_id: '5eed0100-0000-4000-8000-000000000002' }],
    ['its rider', { assigned_rider_id: '5eed0900-0000-4000-8000-000000000001' }],
    ['the moment of assignment', { assigned_at: '2026-11-02T10:00:00.000Z' }],
    ['the moment of dispatch', { dispatched_at: '2026-11-02T11:00:00.000Z' }],
    ['the moment it started', { started_at: '2026-11-03T08:00:00.000Z' }],
    ['the moment it finished', { completed_at: '2026-11-03T17:00:00.000Z' }],
  ] as const)('moves with %s', (_label, change) => {
    expect(pickupManifestEtagOf(view(change), 1)).not.toBe(pickupManifestEtagOf(view(), 1));
  });

  // Break caught (run 6, Stage 1.2): the moment the run was made in the digest. It is set once and never changes, so it tells a client nothing the version does not; it was added to the
  // digest with contract 5.100.0 and moved the ETag of every run. A rolling release (DEPLOYMENT_AND_ENVIRONMENTS.md section 7) serves the build before and the build after side by
  // side, so a run read through one and acted on through the other was refused as stale on every assign, dispatch, cancel and stop order until the old build had drained. (This replaces
  // the row 'moves with the moment it was made' of the table above, which asserted the opposite.)
  it('does not move with the moment the run was made: two representations that differ only in created_at have one ETag', () => {
    const earlier = view({ created_at: new Date('2026-11-02T08:00:00.000Z') });
    const later = view({ created_at: new Date('2026-11-02T10:30:00.000Z') });

    expect(earlier.created_at).not.toBe(later.created_at);
    expect(pickupManifestEtagOf(earlier, 1)).toBe(pickupManifestEtagOf(later, 1));
  });

  // Break caught: a member of a stop left out of the digest.
  it.each([
    ['its request', { pickup_request_id: '5eed0200-0000-4000-8000-0000000000ff' }],
    ['its state', { state: 'ARRIVED' as const }],
    ['the moment it was arrived at', { arrived_at: '2026-11-03T09:00:00.000Z' }],
    [
      'its failure',
      {
        state: 'FAILED' as const,
        failure_category: 'VENDOR_UNAVAILABLE' as const,
        failure_reason_snapshot: {
          reason_code: 'CLOSED',
          label: 'Closed',
          attribution: 'EXTERNAL',
          note: 'Shut',
          reported_at: '2026-11-03T09:00:00.000Z',
        },
      },
    ],
    [
      'its skip',
      {
        state: 'SKIPPED' as const,
        skip_snapshot: {
          reason_code: 'ROAD',
          note: 'Flooded',
          skipped_at: '2026-11-03T09:00:00.000Z',
        },
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
  ] as const)('moves with a stop’s %s', (_label, change) => {
    expect(pickupManifestEtagOf(view({}, [stop(1), stop(2, change), stop(3)]), 1)).not.toBe(
      pickupManifestEtagOf(view(), 1),
    );
  });

  // Break caught: a token that cannot tell one order of the same stops from another. A client that read the manifest, and then learned
  // that Ops put the stops in another order, must be refused the `If-Match` it holds (S1.21 compares it under the manifest's lock).
  it('moves with the order of the stops, when nothing else about them has moved', () => {
    const [first, second, third] = [stop(1), stop(2), stop(3)] as [
      PickupStopRow,
      PickupStopRow,
      PickupStopRow,
    ];
    const ordered = view({}, [first, second, third]);
    const swapped = {
      ...ordered,
      stops: [ordered.stops?.[1], ordered.stops?.[0], ordered.stops?.[2]],
    };
    expect(pickupManifestEtagOf(swapped as PickupManifestView, 1)).not.toBe(
      pickupManifestEtagOf(ordered, 1),
    );
  });

  // Break caught: the same, by the way Ops would do it: the stops keep their identities and their requests and exchange their places.
  it('moves when two stops exchange their places in the sequence', () => {
    const exchanged = view({}, [stop(1, { sequence: 2 }), stop(2, { sequence: 1 }), stop(3)]);
    expect(exchanged.stops?.map((each) => each.id)).toEqual([stop(2).id, stop(1).id, stop(3).id]);
    expect(pickupManifestEtagOf(exchanged, 1)).not.toBe(pickupManifestEtagOf(view(), 1));
  });

  // Break caught: the number of a stop's place left out of the digest, so that renumbering the places without moving a stop goes unseen.
  it('moves with the number of a stop’s place, though the order has not changed', () => {
    const renumbered = view({}, [stop(1), stop(2), stop(3, { sequence: 9 })]);
    expect(renumbered.stops?.map((each) => each.id)).toEqual(view().stops?.map((each) => each.id));
    expect(pickupManifestEtagOf(renumbered, 1)).not.toBe(pickupManifestEtagOf(view(), 1));
  });

  // Break caught: a token that does not depend on whether a stop is there.
  it('moves with the stops there are', () => {
    expect(pickupManifestEtagOf(view({}, [stop(1), stop(2)]), 1)).not.toBe(
      pickupManifestEtagOf(view(), 1),
    );
  });

  // Break caught: a token made of the manifest alone for a list, which would not move when a stop did.
  it('is not made for a view that has no stops', () => {
    expect(() => pickupManifestEtagOf(manifestViewOf(MANIFEST), 1)).toThrow(TypeError);
  });

  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pickupManifestEtagOf(view(), version)).toThrow(RangeError);
    }
  });
});

/**
 * The digests a build before contract 5.100.0 (499399c) computed for these two runs, taken by running that build's file over the same representations. The build after must compute
 * the same, member for member and in the same order, or a rolling release that serves both refuses a run read through one and acted on through the other (run 6, Stage 1.2).
 */
describe('the ETag of a run, between the build before contract 5.100.0 and this one', () => {
  const inProgress = view(
    {
      state: 'IN_PROGRESS',
      assigned_rider_id: '5eed0900-0000-4000-8000-000000000001',
      assigned_at: new Date('2026-11-02T10:00:00.000Z'),
      dispatched_at: new Date('2026-11-02T11:00:00.000Z'),
      started_at: new Date('2026-11-03T08:00:00.000Z'),
    },
    [
      stop(1, { state: 'COLLECTED', arrived_at: new Date('2026-11-03T09:00:00.000Z') }),
      stop(2, { state: 'ARRIVED', arrived_at: new Date('2026-11-03T09:30:00.000Z') }),
      stop(3),
    ],
  );

  it.each([
    [
      'a draft of three stops, at version 1',
      view(),
      1,
      '"06rYBRV-F2myyTKM61IiiHaj3PwWQlnW3dQgNzFzzv4"',
    ],
    [
      'a run in progress with its rider and two stops worked, at version 7',
      inProgress,
      7,
      '"thKSuWbjIZROQy-mW3j-OK9X2gW2Rr0WgMHE-11PkKI"',
    ],
  ] as const)('is the ETag that build computed for %s', (_label, run, version, expected) => {
    expect(pickupManifestEtagOf(run, version)).toBe(expected);
  });
});

describe('matching an If-Match header against the ETag of a manifest', () => {
  const current = pickupManifestEtagOf(view(), 1);

  it('accepts exactly the current token', () => {
    expect(pickupManifestEtagMatches(current, current)).toBe(true);
  });

  // Break caught: a weak validator, a list, an unquoted token, a missing header or another token accepted as a match.
  it.each([
    undefined,
    '',
    `W/${current}`,
    `${current}, ${current}`,
    current.slice(1, -1),
    '"short"',
    pickupManifestEtagOf(view(), 2),
  ])('refuses %j', (header) => {
    expect(pickupManifestEtagMatches(header, current)).toBe(false);
  });
});

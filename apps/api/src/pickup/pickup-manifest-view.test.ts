import { describe, expect, it } from 'vitest';

import {
  manifestViewOf,
  stopViewOf,
  type PickupManifestRow,
  type PickupStopRow,
  type PickupStopSummaryView,
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
  version: 7,
  created_at: new Date('2026-11-02T09:00:00.000Z'),
  created_at_text: '2026-11-02 09:00:00.123456+00',
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

describe('a manifest as a read answers it', () => {
  it('states the members of the contract, the moments as instants and the day as text', () => {
    const view = manifestViewOf({
      ...MANIFEST,
      state: 'DISPATCHED',
      assigned_rider_id: '5eed0900-0000-4000-8000-000000000001',
      assigned_at: new Date('2026-11-02T10:00:00.000Z'),
      dispatched_at: '2026-11-02 11:00:00+00',
    });
    expect(view).toEqual({
      id: MANIFEST.id,
      code: 'ACC-MF-7K3M9Q',
      state: 'DISPATCHED',
      service_date: '2026-11-03',
      responsible_hub_id: MANIFEST.responsible_hub_id,
      assigned_rider_id: '5eed0900-0000-4000-8000-000000000001',
      assigned_at: '2026-11-02T10:00:00.000Z',
      dispatched_at: '2026-11-02T11:00:00.000Z',
      started_at: null,
      completed_at: null,
      created_at: '2026-11-02T09:00:00.000Z',
    });
  });

  // Break caught: a list that carries the stops (a heavier answer than the contract's list needs, and one with no ETag to go with it).
  it('has no stops member where none were given, and has one where they were, even if there are none', () => {
    expect('stops' in manifestViewOf(MANIFEST)).toBe(false);
    expect(manifestViewOf(MANIFEST, []).stops).toEqual([]);
  });

  // Break caught: the stops in the order the database happened to return them, and not the order of the sequence.
  it('lists the stops in the order of their sequence', () => {
    const view = manifestViewOf(MANIFEST, [stop(3), stop(1), stop(2)]);
    expect(view.stops?.map((each) => each.sequence)).toEqual([1, 2, 3]);
  });

  // Break caught: a column of the table that the contract does not state (the version, the creator), or a summary that no one has mapped (OB-S1-21), leaking into the
  // representation. The moment of creation is stated since contract 5.100.0 (run 5, Stage 1.7): a run’s history says when it was made.
  it('carries nothing the contract does not state, and no summary of a stop', () => {
    const view = manifestViewOf(MANIFEST, [stop(1)]);
    expect(Object.keys(view).toSorted()).toEqual(
      [
        'assigned_at',
        'assigned_rider_id',
        'code',
        'completed_at',
        'created_at',
        'dispatched_at',
        'id',
        'responsible_hub_id',
        'service_date',
        'started_at',
        'state',
        'stops',
      ].toSorted(),
    );
    expect(Object.keys(view.stops?.[0] ?? {}).toSorted()).toEqual(
      [
        'arrived_at',
        'failure',
        'failure_category',
        'id',
        'pickup_manifest_id',
        'pickup_request_id',
        'sequence',
        'skipped',
        'state',
      ].toSorted(),
    );
  });
});

describe('a stop as a read answers it', () => {
  // Break caught: what the table keeps beside a skip (the label the reason had) reaching the wire, where the contract states three members
  // and no more; and the system's skip, which has no note, shown with a note of nothing.
  it('shows a skip as the three members the contract names, and none that the table keeps beside them', () => {
    const cancelled = {
      reason_code: 'REQUEST_CANCELLED',
      label: 'Request cancelled',
      skipped_at: '2026-11-03T09:30:00.000Z',
    };
    const view = stopViewOf(stop(1, { state: 'SKIPPED', skip_snapshot: cancelled }));
    expect(view.skipped).toEqual({
      reason_code: 'REQUEST_CANCELLED',
      skipped_at: '2026-11-03T09:30:00.000Z',
    });
    expect(Object.keys(view.skipped ?? {}).toSorted()).toEqual(['reason_code', 'skipped_at']);
    expect(
      stopViewOf(stop(2, { state: 'SKIPPED', skip_snapshot: { ...cancelled, note: 'Flooded' } }))
        .skipped,
    ).toEqual({
      reason_code: 'REQUEST_CANCELLED',
      note: 'Flooded',
      skipped_at: cancelled.skipped_at,
    });
  });

  it('is pending with nothing of the later acts', () => {
    expect(stopViewOf(stop(1))).toEqual({
      id: stop(1).id,
      pickup_manifest_id: MANIFEST.id,
      pickup_request_id: stop(1).pickup_request_id,
      sequence: 1,
      state: 'PENDING',
      arrived_at: null,
      failure_category: null,
      failure: null,
      skipped: null,
    });
  });

  it('states the snapshots of a failure and of a skip as the contract names them', () => {
    const failure = {
      reason_code: 'CLOSED',
      note: 'Shut',
      reported_at: '2026-11-03T09:00:00.000Z',
    };
    // What the table keeps of the failure beside those three members (the catalogue's label and attribution, the contact attempts) is never on the wire.
    const kept = {
      ...failure,
      label: 'Closed',
      attribution: 'EXTERNAL',
      contact_attempts: [
        {
          method: 'PHONE_CALL' as const,
          attempted_at: '2026-11-03T08:58:00.000Z',
          outcome: 'No answer',
          note: 'Rang four times',
        },
      ],
    };
    const skip = { reason_code: 'ROAD', note: 'Flooded', skipped_at: '2026-11-03T09:30:00.000Z' };
    expect(
      stopViewOf(
        stop(1, {
          state: 'FAILED',
          failure_category: 'VENDOR_UNAVAILABLE',
          failure_reason_snapshot: kept,
          arrived_at: new Date('2026-11-03T08:55:00.000Z'),
        }),
      ),
    ).toMatchObject({
      state: 'FAILED',
      failure_category: 'VENDOR_UNAVAILABLE',
      failure,
      skipped: null,
      arrived_at: '2026-11-03T08:55:00.000Z',
    });
    expect(
      stopViewOf(
        stop(1, {
          state: 'FAILED',
          failure_category: 'VENDOR_UNAVAILABLE',
          failure_reason_snapshot: kept,
        }),
      ).failure,
    ).toStrictEqual(failure);
    expect(stopViewOf(stop(2, { state: 'SKIPPED', skip_snapshot: skip }))).toMatchObject({
      state: 'SKIPPED',
      failure: null,
      skipped: skip,
    });
  });

  // The summary the stop of a dispatched run carries (S1.21, OB-S1-21; the Product Owner's decision of 2 November 2026).
  const SUMMARY: PickupStopSummaryView = {
    reference: 'ACC-PR-7K3M9Q',
    sender_display_name: 'Ama Serwaa Fashions',
    declared_package_count: 4,
    resolved_pickup_location: {
      address: '12 Oxford Street, Osu',
      landmark: 'Opposite the Total filling station',
      map_link: 'https://maps.example/osu-12',
      latitude: 5.5571,
      longitude: -0.1822,
    },
    location_note: null,
    contact_phone: '+233201234567',
  };

  // Break caught: a stop that has not been dispatched shown with an empty or null summary (the contract types it as the object), or the
  // summary of a stop dropped from a dispatched run, which would send a rider to a door with nothing to find.
  it('states the summary when the stop has one and leaves the member out, not null, when it has none', () => {
    expect('pickup_summary' in stopViewOf(stop(1))).toBe(false);
    expect(stopViewOf(stop(1, { pickup_summary: SUMMARY })).pickup_summary).toEqual(SUMMARY);
  });

  // Break caught: a member of the stored summary, or of its place, reaching the wire because the column holds more than the contract
  // names: the payer, a price, a destination or a recipient must not be one stored value away from a rider.
  it('copies the six members and the five of the place one by one, whatever else the column holds', () => {
    const corrupt = {
      ...SUMMARY,
      payer_intent: 'SENDER_PAYS_FULL',
      price: 3500,
      resolved_pickup_location: { ...SUMMARY.resolved_pickup_location, zone: 'ACCRA' },
    } as unknown as PickupStopSummaryView;
    const shown = stopViewOf(stop(1, { pickup_summary: corrupt })).pickup_summary;
    expect(Object.keys(shown ?? {}).toSorted()).toEqual(
      [
        'contact_phone',
        'declared_package_count',
        'location_note',
        'reference',
        'resolved_pickup_location',
        'sender_display_name',
      ].toSorted(),
    );
    expect(Object.keys(shown?.resolved_pickup_location ?? {}).toSorted()).toEqual(
      ['address', 'landmark', 'latitude', 'longitude', 'map_link'].toSorted(),
    );
  });

  // Break caught: a member of the place that the request does not have, invented as null (the contract types each as present or absent).
  it('leaves out a member of the place the request does not have', () => {
    const bare = { ...SUMMARY, resolved_pickup_location: { address: '12 Oxford Street, Osu' } };
    expect(
      stopViewOf(stop(1, { pickup_summary: bare })).pickup_summary?.resolved_pickup_location,
    ).toEqual({ address: '12 Oxford Street, Osu' });
  });
});

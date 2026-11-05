import { describe, expect, it } from 'vitest';

import {
  handoverFixture,
  listedManifestFixture,
  manifestFixture,
  MANIFEST_ID,
  STOP_ONE_ID,
  STOP_TWO_ID,
  stopFixture,
  summaryFixture,
} from '../../test-support/manifest-fixture';
import {
  parseHandover,
  parseHandoverPage,
  parseManifest,
  parseManifestPage,
  parseStop,
} from './manifest-shape';

describe('a stop', () => {
  it('is read with the fields the screens draw', () => {
    const stop = parseStop(
      stopFixture({
        state: 'ARRIVED',
        arrived_at: '2026-11-04T08:30:00Z',
        pickup_summary: summaryFixture('ACC-PR-7KQ2MZ'),
      }),
    );

    expect(stop).toMatchObject({
      id: STOP_ONE_ID,
      sequence: 1,
      state: 'ARRIVED',
      arrived_at: '2026-11-04T08:30:00Z',
      pickup_summary: {
        reference: 'ACC-PR-7KQ2MZ',
        sender_display_name: 'Demo Fabrics Ltd',
        declared_package_count: 3,
        resolved_pickup_location: { address: '14 Demo Lane, Osu' },
      },
    });
  });

  // Break caught: the rider's contact number carried to a screen that has no use for it (ops-portal.md section 7 names a pickup by its place).
  it('keeps no contact number of the summary', () => {
    const stop = parseStop(
      stopFixture({
        pickup_summary: summaryFixture('ACC-PR-7KQ2MZ', { contact_phone: '+233209999999' }),
      }),
    );

    expect(JSON.stringify(stop)).not.toContain('233209999999');
    expect(JSON.stringify(stop)).not.toContain('contact_phone');
  });

  it('reads a skip with the officer’s note, and a system skip with none', () => {
    const byOfficer = parseStop(
      stopFixture({
        state: 'SKIPPED',
        skipped: {
          reason_code: 'LOCATION_INACCESSIBLE',
          note: 'Gate locked',
          skipped_at: '2026-11-04T09:00:00Z',
        },
      }),
    );
    const bySystem = parseStop(
      stopFixture({
        state: 'SKIPPED',
        skipped: { reason_code: 'REQUEST_CANCELLED', skipped_at: '2026-11-04T09:00:00Z' },
      }),
    );

    expect(byOfficer?.skipped).toEqual({
      reason_code: 'LOCATION_INACCESSIBLE',
      note: 'Gate locked',
      skipped_at: '2026-11-04T09:00:00Z',
    });
    expect(bySystem?.skipped).toEqual({
      reason_code: 'REQUEST_CANCELLED',
      skipped_at: '2026-11-04T09:00:00Z',
    });
  });

  // Break caught: a stop that says it is skipped with no record of a skip, or records one while pending: not a stop the API sends.
  it.each([
    ['skipped with no skip recorded', { state: 'SKIPPED' as const }],
    [
      'pending with a skip recorded',
      { skipped: { reason_code: 'RUN_CUT_SHORT', skipped_at: '2026-11-04T09:00:00Z' } },
    ],
    ['a state the contract does not have', { state: 'LOST' as never }],
    ['a place that is not a whole number from 1', { sequence: 0 }],
    ['a request that is not an identifier', { pickup_request_id: 'nope' }],
    ['a summary reference that is not a code', { pickup_summary: summaryFixture('nope') }],
    [
      'a skip whose reason is not a code',
      {
        state: 'SKIPPED' as const,
        skipped: { reason_code: '<b>', skipped_at: '2026-11-04T09:00:00Z' },
      },
    ],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseStop(stopFixture(overrides))).toBeUndefined();
  });
});

describe('a manifest', () => {
  it('is read with its stops in their sequence, whatever order they arrived in', () => {
    const manifest = parseManifest(
      manifestFixture({
        stops: [
          stopFixture({ id: STOP_TWO_ID, sequence: 2 }),
          stopFixture({ id: STOP_ONE_ID, sequence: 1 }),
        ],
      }),
      'required',
    );

    expect(manifest?.stops?.map((stop) => stop.id)).toEqual([STOP_ONE_ID, STOP_TWO_ID]);
    expect(manifest).toMatchObject({
      id: MANIFEST_ID,
      code: 'ACC-MF-Q92422',
      state: 'DRAFT',
      service_date: '2026-11-04',
    });
  });

  it('leaves out the moments and the rider that the answer leaves out or sends as null', () => {
    const manifest = parseManifest(manifestFixture(), 'required');

    expect(manifest).not.toHaveProperty('assigned_rider_id');
    expect(manifest).not.toHaveProperty('dispatched_at');
  });

  it('reads the moments of a run that has gone out', () => {
    const manifest = parseManifest(
      manifestFixture({
        state: 'IN_PROGRESS',
        assigned_rider_id: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
        assigned_at: '2026-11-03T08:00:00Z',
        dispatched_at: '2026-11-03T09:00:00Z',
        started_at: '2026-11-04T07:30:00Z',
      }),
      'required',
    );

    expect(manifest).toMatchObject({
      assigned_rider_id: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a',
      started_at: '2026-11-04T07:30:00Z',
    });
  });

  it('is a list entry with no stops, and a record only with them', () => {
    expect(parseManifest(listedManifestFixture(), 'optional')).not.toHaveProperty('stops');
    expect(parseManifest(listedManifestFixture(), 'required')).toBeUndefined();
  });

  // Break caught: a record drawn whose stops are another manifest's, repeated, or numbered alike (an order that cannot be sent back).
  it.each([
    ['a stop of another manifest', [stopFixture({ pickup_manifest_id: STOP_TWO_ID })]],
    ['a stop twice', [stopFixture(), stopFixture()]],
    ['two stops in one place', [stopFixture(), stopFixture({ id: STOP_TWO_ID })]],
    [
      'more than 64 stops',
      Array.from({ length: 65 }, (_, index) =>
        stopFixture({
          id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
          sequence: index + 1,
        }),
      ),
    ],
  ])('is refused with %s', (_name, stops) => {
    expect(parseManifest(manifestFixture({ stops }), 'required')).toBeUndefined();
  });

  it.each([
    ['a code that is not an operational code', { code: 'MF-1' }],
    ['a state the contract does not have', { state: 'ASSIGNED' as never }],
    ['a service date that does not exist', { service_date: '2026-02-30' }],
    ['a rider that is not an identifier', { assigned_rider_id: 'rider' }],
    ['a moment that is not a time', { dispatched_at: 'yesterday' }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseManifest(manifestFixture(overrides), 'required')).toBeUndefined();
  });

  it('is a page, or nothing when one entry is not a manifest or one is listed twice', () => {
    const page = parseManifestPage({ items: [listedManifestFixture()], next_page_token: 'next' });
    expect(page?.items).toHaveLength(1);
    expect(page?.nextPageToken).toBe('next');

    expect(
      parseManifestPage({
        items: [listedManifestFixture(), { ...listedManifestFixture(), code: 'x' }],
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(
      parseManifestPage({
        items: [listedManifestFixture(), listedManifestFixture()],
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(parseManifestPage({ items: [], next_page_token: '' })).toBeUndefined();
    expect(parseManifestPage([])).toBeUndefined();
  });
});

describe('a custody handover', () => {
  it('is read as a pending handover to the hub', () => {
    expect(parseHandover(handoverFixture())).toMatchObject({
      state: 'PENDING',
      to_hub_id: expect.any(String) as string,
    });
    expect(parseHandover(handoverFixture())).not.toHaveProperty('to_rider_id');
    expect(parseHandover(handoverFixture())).not.toHaveProperty('parcel_count_taken');
  });

  it('is read as a completed one, with the count the receiver took as a record', () => {
    const handover = parseHandover(
      handoverFixture({
        state: 'COMPLETED',
        parcel_count_taken: 7,
        resolved_at: '2026-11-04T10:30:00Z',
      }),
    );

    expect(handover).toMatchObject({ state: 'COMPLETED', parcel_count_taken: 7 });
  });

  // Break caught: a record that contradicts the contract's own statements of when a count and a resolution are set.
  it.each([
    ['a count on a pending handover', { parcel_count_taken: 3 }],
    [
      'a completed handover with no count',
      { state: 'COMPLETED' as const, resolved_at: '2026-11-04T10:30:00Z' },
    ],
    ['a pending handover that is resolved', { resolved_at: '2026-11-04T10:30:00Z' }],
    ['a failed handover that is not resolved', { state: 'FAILED' as const }],
    ['both destinations', { to_rider_id: '4d5e6f7a-8b9c-4d0e-8f1a-2b3c4d5e6f7a' }],
    ['no destination', { to_hub_id: null }],
    [
      'a negative count',
      { state: 'COMPLETED' as const, parcel_count_taken: -1, resolved_at: '2026-11-04T10:30:00Z' },
    ],
    ['a state the contract does not have', { state: 'LOST' as never }],
  ])('is refused with %s', (_name, overrides) => {
    expect(parseHandover(handoverFixture(overrides))).toBeUndefined();
  });

  it('is a page, refused whole when one entry is not a handover', () => {
    expect(
      parseHandoverPage({ items: [handoverFixture()], next_page_token: null })?.items,
    ).toHaveLength(1);
    expect(
      parseHandoverPage({
        items: [handoverFixture(), { ...handoverFixture(), id: 'x' }],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });
});

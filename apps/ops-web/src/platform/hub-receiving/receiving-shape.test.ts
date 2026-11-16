import { describe, expect, it } from 'vitest';

import {
  PLANTED_BLIND_NUMBER,
  RUN_ID,
  arrivedParcel,
  blindVendorFixture,
  extraParcel,
  lockFixture,
  missingParcelFixture,
  parcelFixture,
  photoVendorFixture,
  runFixture,
  runPage,
  runSummaryFixture,
  uuid,
} from '../../test-support/receiving-fixture';
import {
  nameOf,
  parseCheckIn,
  parseEvidenceLimits,
  parseMissingPage,
  parseParcel,
  parseParcelAnswer,
  parseRunListPage,
  parseRunPage,
  parseRunSummary,
  parseVendor,
} from './receiving-shape';

/**
 * What the receiving screens of a run believe of an answer (`receiving-shape.ts`). Each claim has the break it catches: the rider's number of a blind-count vendor, a telephone number where a name goes, a count
 * that contradicts the parcels it is the count of, a photo or a parcel twice. The shapes are held to the contract by `test/hub-receiving-contract.test.ts`.
 */
const photoVendor = (count = 3) => photoVendorFixture(count);

describe('a run page', () => {
  it('is read with its photo vendor and its blind-count vendor', () => {
    const page = parseRunPage(runFixture([photoVendor(), blindVendorFixture()]));
    expect(page?.run.code).toBe('ACC-MF-7KQ2MZ');
    expect(page?.rider_name).toBe('Kofi Boateng');
    expect(page?.vendors.map((vendor) => vendor.vendor_name)).toEqual([
      'Kente Crafts',
      'Adwoa Stalls',
    ]);
    expect(page?.vendors[0]?.parcels).toHaveLength(3);
    expect(page?.vendors[0]?.intake_etag).toBe('"kente-1"');
  });

  // Break caught: a server that sends the rider's number for a vendor counted blind, in the expected count, the arrived count or as a received count before the count.
  it.each([
    ['an expected count', { parcels_expected: PLANTED_BLIND_NUMBER }],
    ['an arrived count', { arrived_count: PLANTED_BLIND_NUMBER }],
    ['a received count before the count', { received_count: PLANTED_BLIND_NUMBER }],
    ['a variance before the count', { count_variance: 'SHORT' as const }],
    ['a parcel', { parcels: [parcelFixture(1)] }],
    ['a missing count', { missing_count: 2 }],
  ])('is refused whole when a blind-count vendor carries %s', (_name, over) => {
    expect(parseVendor(blindVendorFixture(over))).toBeUndefined();
    expect(parseRunPage(runFixture([photoVendor(), blindVendorFixture(over)]))).toBeUndefined();
  });

  // Break caught: a blind-count vendor refused after its own count, when it has legitimately a received count and a variance (the comparison is the count's own).
  it('takes the received count and the variance of a blind-count vendor once it is counted, and still no expected count', () => {
    const counted = blindVendorFixture({
      state: 'RECONCILIATION_REQUIRED',
      received_count: 5,
      count_variance: 'SHORT',
    });
    expect(parseVendor(counted)?.received_count).toBe(5);
    expect(parseVendor({ ...counted, parcels_expected: 7 })).toBeUndefined();
  });

  // Break caught: an officer or a rider drawn as a telephone number (OB-S1-106: no phone number on the receiving side).
  it.each(['+233 24 123 4567', '0241234567', '024-123-4567', 'Ama (024) 123 4567'])(
    'refuses the name %s',
    (name) => {
      expect(nameOf(name)).toBeUndefined();
      expect(parseRunPage(runFixture([photoVendor()], { rider_name: name }))).toBeUndefined();
      expect(parseVendor(photoVendorFixture(2, { vendor_name: name }))).toBeUndefined();
    },
  );

  it.each(['Ama Owusu', 'Kente Crafts 2', 'Nana Yaa Asantewaa-Mensah', 'Shop 12 Makola'])(
    'takes the name %s',
    (name) => {
      expect(nameOf(name)).toBe(name);
    },
  );

  // Break caught: a photo vendor whose counts say something its parcels do not, so that a screen would show a number that is not the parcels'.
  it.each([
    ['an expected count that is not the door photos', { parcels_expected: 9 }],
    ['an arrived count that is not the arrived parcels', { arrived_count: 3 }],
    ['a missing count that is not the missing parcels', { missing_count: 1 }],
    ['an extra count that is not the extras', { extra_count: 1 }],
  ])('refuses a photo vendor with %s', (_name, over) => {
    expect(parseVendor(photoVendorFixture(3, over))).toBeUndefined();
  });

  // Break caught: a list that repeats a parcel or a photo, or is not in the order the photos were taken.
  it('refuses a parcel twice, a photo twice and parcels out of order', () => {
    const one = parcelFixture(1);
    const two = parcelFixture(2);
    expect(parseVendor(photoVendorFixture(2, {}, [one, one]))).toBeUndefined();
    expect(
      parseVendor(
        photoVendorFixture(2, {}, [one, { ...two, photo_evidence_id: one.photo_evidence_id }]),
      ),
    ).toBeUndefined();
    expect(parseVendor(photoVendorFixture(2, {}, [two, one]))).toBeUndefined();
  });

  it('refuses the same vendor twice in a run', () => {
    expect(parseRunPage(runFixture([photoVendor(), photoVendor()]))).toBeUndefined();
  });

  it('refuses an answer that is not an object or has no vendors list', () => {
    expect(parseRunPage(undefined)).toBeUndefined();
    expect(parseRunPage({ ...runFixture([photoVendor()]), vendors: 'none' })).toBeUndefined();
    expect(parseRunPage({ ...runFixture([photoVendor()]), run: null })).toBeUndefined();
  });
});

describe('a parcel', () => {
  it('says who checked it in and when, or neither', () => {
    expect(parseParcel(arrivedParcel(1))?.arrived_by_name).toBe('Ama Owusu');
    expect(parseParcel(parcelFixture(1))?.arrived_at).toBeNull();
    expect(parseParcel({ ...parcelFixture(1), arrived_by_name: 'Ama Owusu' })).toBeUndefined();
    expect(
      parseParcel({ ...arrivedParcel(1), arrived_at: null, arrived_by_name: null }),
    ).toBeUndefined();
  });

  // Break caught: states the contract does not allow an origin: an extra that is expected or missing, a door parcel that is void.
  it('refuses an extra that is expected or missing and a door parcel that is void', () => {
    expect(parseParcel({ ...extraParcel(4), state: 'EXPECTED' })).toBeUndefined();
    expect(parseParcel({ ...extraParcel(4), state: 'MISSING' })).toBeUndefined();
    expect(parseParcel(parcelFixture(1, { state: 'VOID' }))).toBeUndefined();
    expect(parseParcel(extraParcel(4, { state: 'VOID' }))?.state).toBe('VOID');
  });

  it('carries a condition by its officer’s name, and none until one is recorded', () => {
    const found = parseParcel(
      arrivedParcel(1, {
        condition: {
          condition: 'DAMAGED',
          note: 'Crushed at one corner.',
          evidence_ids: [uuid(0xe0, 1)],
          recorded_by_name: 'Ama Owusu',
          recorded_at: '2026-11-14T09:20:00Z',
        },
      }),
    );
    expect(found?.condition?.condition).toBe('DAMAGED');
    expect(parseParcel(parcelFixture(2))?.condition).toBeNull();
  });

  it('takes no address, key or path: a member that is not the contract’s is not drawn', () => {
    const parcel = parseParcel({
      ...parcelFixture(1),
      url: 'https://store.example/x',
      object_key: 'k',
    });
    expect(parcel).toBeDefined();
    expect(JSON.stringify(parcel)).not.toContain('store.example');
    expect(JSON.stringify(parcel)).not.toContain('object_key');
  });
});

describe('the lock', () => {
  it('is read as who opened the check-in and when', () => {
    const vendor = parseVendor(photoVendorFixture(2, { lock: lockFixture({ held_by_you: true }) }));
    expect(vendor?.lock).toEqual({
      holder_name: 'Ama Owusu',
      held_by_you: true,
      opened_at: '2026-11-14T09:12:00Z',
      last_seen_at: '2026-11-14T09:13:00Z',
    });
    expect(parseVendor(photoVendorFixture(2, { lock: null }))?.lock).toBeNull();
  });

  it('refuses a lock with no holder name or a number for a name', () => {
    expect(
      parseVendor(photoVendorFixture(2, { lock: lockFixture({ holder_name: '+233241234567' }) })),
    ).toBeUndefined();
    expect(
      parseVendor(
        photoVendorFixture(2, { lock: { ...lockFixture(), holder_name: undefined } as never }),
      ),
    ).toBeUndefined();
  });
});

describe('the queue by run', () => {
  it('reads a row of a run with its rider and vendors by name', () => {
    const row = parseRunSummary(
      runSummaryFixture({ checking_in: [{ name: 'Ama Owusu', is_you: true }] }),
    );
    expect(row?.vendor_names).toEqual(['Kente Crafts', 'Shea Naturals']);
    expect(row?.checking_in).toEqual([{ name: 'Ama Owusu', is_you: true }]);
  });

  // Break caught: a row whose counts contradict themselves, so that a queue would say more vendors wait than the run has, or name fewer than it holds.
  it.each([
    ['more waiting than vendors', { vendors_waiting: 3 }],
    ['more needing a decision than vendors', { vendors_needing_decision: 3 }],
    ['fewer names than vendors', { vendor_names: ['Kente Crafts'] }],
  ])('refuses a row with %s', (_name, over) => {
    expect(parseRunSummary(runSummaryFixture(over))).toBeUndefined();
  });

  it('refuses a row that names a rider by number', () => {
    expect(parseRunSummary(runSummaryFixture({ rider_name: '0241234567' }))).toBeUndefined();
  });

  it('reads a page and its token, and refuses a run twice, an empty token and too many rows', () => {
    expect(parseRunListPage(runPage([runSummaryFixture()], 'next'))?.nextPageToken).toBe('next');
    expect(parseRunListPage(runPage([runSummaryFixture()]))?.nextPageToken).toBeNull();
    expect(parseRunListPage(runPage([runSummaryFixture(), runSummaryFixture()]))).toBeUndefined();
    expect(parseRunListPage(runPage([runSummaryFixture()], ''))).toBeUndefined();
    expect(
      parseRunListPage(runPage(Array.from({ length: 101 }, () => runSummaryFixture()))),
    ).toBeUndefined();
  });
});

describe('the missing list', () => {
  it('reads a page of missing parcels with their picture, vendor, run and moment', () => {
    const page = parseMissingPage(runPage([missingParcelFixture(1), missingParcelFixture(2)]));
    expect(page?.items.map((item) => item.vendor_name)).toEqual(['Kente Crafts', 'Kente Crafts']);
    expect(page?.items[0]?.written_off_at).toBeNull();
  });

  it('refuses a parcel twice and a parcel with no picture', () => {
    expect(
      parseMissingPage(runPage([missingParcelFixture(1), missingParcelFixture(1)])),
    ).toBeUndefined();
    expect(
      parseMissingPage(runPage([{ ...missingParcelFixture(1), photo_evidence_id: 'not-an-id' }])),
    ).toBeUndefined();
  });
});

describe('the answers of the acts', () => {
  const counts = {
    parcels_expected: 3,
    arrived_count: 1,
    received_count: null,
    count_variance: null,
    missing_count: 0,
    extra_count: 0,
    damaged_count: 0,
  };

  it('reads the parcel an act answers with, the vendor’s token and its counts', () => {
    const answer = parseParcelAnswer({
      parcel: arrivedParcel(1),
      intake_etag: '"kente-2"',
      counts,
    });
    expect(answer?.parcel.state).toBe('ARRIVED');
    expect(answer?.intake_etag).toBe('"kente-2"');
    expect(answer?.counts.arrived_count).toBe(1);
    expect(parseParcelAnswer({ parcel: arrivedParcel(1), counts })).toBeUndefined();
  });

  it('reads the vendor’s record as the third intake shape and refuses the other two', () => {
    const parcels = [
      arrivedParcel(1),
      arrivedParcel(2),
      parcelFixture(3, { state: 'MISSING', missing_marked_at: '2026-11-14T09:30:00Z' }),
    ];
    const record = {
      id: uuid(0x22, 1),
      code: 'ACC-IN-3HN7WD',
      hub_id: uuid(0x33, 1),
      pickup_request_id: uuid(0x44, 1),
      pickup_manifest_id: RUN_ID,
      run_code: 'ACC-MF-7KQ2MZ',
      state: 'RECONCILIATION_REQUIRED',
      count_phase: 'CHECK_IN',
      receiving_mode: 'PHOTO_CHECK_IN',
      vendor_name: 'Kente Crafts',
      handed_over_by_name: 'Kofi Boateng',
      handed_over_at: '2026-11-14T09:00:00Z',
      parcels_expected: 3,
      rider_declared_count: 3,
      arrived_count: 2,
      received_count: 2,
      count_variance: 'SHORT',
      count_difference: -1,
      counted_at: '2026-11-14T09:30:00Z',
      counted_by_name: 'Ama Owusu',
      lock: null,
      parcels,
      missing_count: 1,
      extra_count: 0,
      damaged_count: 0,
      condition: 'OK',
      condition_findings: [],
    };
    const view = parseCheckIn(record);
    expect(view?.rider_declared_count).toBe(3);
    expect(view?.count_variance).toBe('SHORT');
    expect(view?.parcels).toHaveLength(3);
    expect(parseCheckIn({ ...record, count_phase: 'POST_COUNT' })).toBeUndefined();
    expect(parseCheckIn({ ...record, receiving_mode: 'BLIND_COUNT' })).toBeUndefined();
    expect(parseCheckIn({ ...record, missing_count: 0 })).toBeUndefined();
  });

  it('reads the limits of a file of evidence and refuses an empty list of types or no size', () => {
    expect(
      parseEvidenceLimits({ allowed_content_types: ['image/jpeg'], max_byte_size: 1048576 }),
    ).toEqual({ allowed_content_types: ['image/jpeg'], max_byte_size: 1048576 });
    expect(
      parseEvidenceLimits({ allowed_content_types: [], max_byte_size: 1048576 }),
    ).toBeUndefined();
    expect(parseEvidenceLimits({ allowed_content_types: ['image/jpeg'] })).toBeUndefined();
    expect(
      parseEvidenceLimits({ allowed_content_types: ['not a type'], max_byte_size: 10 }),
    ).toBeUndefined();
  });
});

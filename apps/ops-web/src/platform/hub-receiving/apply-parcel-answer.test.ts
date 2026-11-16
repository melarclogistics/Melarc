import { describe, expect, it } from 'vitest';

import {
  KENTE_INTAKE_ID,
  SHEA_INTAKE_ID,
  arrivedParcel,
  countsOf,
  extraParcel,
  parcelFixture,
  photoVendorFixture,
  runFixture,
} from '../../test-support/receiving-fixture';
import { applyParcelAnswer } from './apply-parcel-answer';
import { parseRunPage, parseParcelAnswer } from './receiving-shape';

/**
 * What a parcel's act answers, taken into the run's page that was read. The counts and the token are the API's and are copied as they came; nothing is counted here, and an answer for a vendor the page does not
 * hold changes nothing.
 */
const page = () => {
  const parsed = parseRunPage(
    runFixture([
      photoVendorFixture(3),
      photoVendorFixture(2, {
        intake_id: SHEA_INTAKE_ID,
        vendor_name: 'Shea Naturals',
        intake_code: 'ACC-IN-9BC2KE',
      }),
    ]),
  );
  if (parsed === undefined) throw new Error('the page of the test is not one');
  return parsed;
};

const answerFor = (
  parcels: ReturnType<typeof parcelFixture>[],
  target: number,
  token = '"kente-2"',
) => {
  const answer = parseParcelAnswer({
    parcel: parcels[target],
    intake_etag: token,
    counts: {
      ...countsOf(parcels),
      received_count: null,
      count_variance: null,
    },
  });
  if (answer === undefined) throw new Error('the answer of the test is not one');
  return answer;
};

describe('a tap taken into the page', () => {
  it('replaces the parcel, takes the vendor’s token and counts as the API gave them, and touches no other vendor', () => {
    const before = page();
    const tapped = [arrivedParcel(1), parcelFixture(2), parcelFixture(3)];
    const after = applyParcelAnswer(before, KENTE_INTAKE_ID, answerFor(tapped, 0));
    expect(after.vendors[0]?.parcels[0]?.state).toBe('ARRIVED');
    expect(after.vendors[0]?.arrived_count).toBe(1);
    expect(after.vendors[0]?.intake_etag).toBe('"kente-2"');
    expect(after.vendors[1]).toBe(before.vendors[1]);
    expect(after.vendors[0]?.parcels[1]).toBe(before.vendors[0]?.parcels[1]);
  });

  // Break caught: a count worked out here from the parcels instead of taken from the answer (a page that counts is a page that can disagree with the API).
  it('takes the counts from the answer and counts nothing itself', () => {
    const before = page();
    const tapped = [arrivedParcel(1), parcelFixture(2), parcelFixture(3)];
    const answer = answerFor(tapped, 0);
    const lying = { ...answer, counts: { ...answer.counts, arrived_count: 99 } };
    const after = applyParcelAnswer(before, KENTE_INTAKE_ID, lying);
    expect(after.vendors[0]?.arrived_count).toBe(99);
  });

  // Break caught: an answer for another run's vendor drawn into this page.
  it('changes nothing for a vendor the page does not hold', () => {
    const before = page();
    const after = applyParcelAnswer(
      before,
      '55555555-5555-4555-8555-555555555555',
      answerFor([arrivedParcel(1)], 0),
    );
    expect(after).toBe(before);
  });
});

describe('an extra taken into the page', () => {
  it('is added after the parcels the door photos gave, in the API’s order, with the new counts', () => {
    const before = page();
    const parcels = [parcelFixture(1), parcelFixture(2), parcelFixture(3), extraParcel(4)];
    const after = applyParcelAnswer(before, KENTE_INTAKE_ID, answerFor(parcels, 3, '"kente-9"'));
    expect(after.vendors[0]?.parcels.map((parcel) => parcel.origin)).toEqual([
      'DOOR_PHOTO',
      'DOOR_PHOTO',
      'DOOR_PHOTO',
      'HUB_EXTRA',
    ]);
    expect(after.vendors[0]?.extra_count).toBe(1);
    expect(after.vendors[0]?.intake_etag).toBe('"kente-9"');
  });
});

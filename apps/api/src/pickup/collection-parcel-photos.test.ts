import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ENGINEERING_DEFAULTS } from '../platform/config/config-settings.js';
import { ApiException } from '../platform/http/api-exception.js';
import { COLLECTION_RECORD_CREATE_BODY } from './collection-schemas.js';
import { checkedParcelPhotoIds } from './collection-parcel-photos.js';

/**
 * The number of parcel photos of a count, judged by the application before anything is written (D-A10; pickup-collection.md section 5.5): one for each parcel counted, or none for a stop
 * Ops let through without them, and none named twice. The database holds the same number for every writer (`parcel-photos.db.test.ts`); this is the check that answers the caller first.
 */
const ids = (count: number): string[] => Array.from({ length: count }, () => randomUUID());

function refusalOf(work: () => unknown): { code: string; rule?: string } | undefined {
  try {
    work();
    return undefined;
  } catch (error) {
    if (!(error instanceof ApiException)) throw error;
    const violations = (error.details as { violations?: { rule?: string }[] } | undefined)
      ?.violations;
    const rule = violations?.[0]?.rule;
    return { code: error.code, ...(rule === undefined ? {} : { rule }) };
  }
}

describe('checkedParcelPhotoIds', () => {
  // Break caught: a count that takes more or fewer photos than parcels, or none, as if the number were the client's to choose.
  it.each([
    [3, 0],
    [3, 2],
    [3, 4],
    [1, 2],
    [200, 199],
  ])('refuses a count of %i parcels with %i photos, as parcel_photo_count', (collected, named) => {
    expect(refusalOf(() => checkedParcelPhotoIds(ids(named), collected, false))).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'parcel_photo_count',
    });
  });

  it('refuses a count with no list at all the same as one with an empty list', () => {
    expect(refusalOf(() => checkedParcelPhotoIds(undefined, 3, false))?.rule).toBe(
      'parcel_photo_count',
    );
    expect(refusalOf(() => checkedParcelPhotoIds([], 3, false))?.rule).toBe('parcel_photo_count');
  });

  it.each([1, 3, 200, 2000])('takes %i photos for %i parcels, in lower case', (count) => {
    const given = ids(count).map((id) => id.toUpperCase());
    expect(checkedParcelPhotoIds(given, count, false)).toEqual(given.map((id) => id.toLowerCase()));
  });

  // Break caught: the same photo named for two parcels, which would make the number right with one photo too few.
  it('refuses a photo named twice, in any case, as duplicate', () => {
    const [one, two] = ids(2);
    expect(
      refusalOf(() => checkedParcelPhotoIds([one ?? '', two ?? '', one ?? ''], 3, false)),
    ).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'duplicate',
    });
    expect(
      refusalOf(() => checkedParcelPhotoIds([(one ?? '').toUpperCase(), one ?? ''], 2, false))
        ?.rule,
    ).toBe('duplicate');
  });

  // Break caught: a stop let through without photos that takes some all the same, or one that takes none while the number is owed.
  it('takes none for a stop let through without photos, and refuses any named for it', () => {
    expect(checkedParcelPhotoIds(undefined, 3, true)).toEqual([]);
    expect(checkedParcelPhotoIds([], 3, true)).toEqual([]);
    expect(refusalOf(() => checkedParcelPhotoIds(ids(3), 3, true))?.rule).toBe(
      'parcel_photo_count',
    );
    expect(refusalOf(() => checkedParcelPhotoIds(ids(1), 3, true))?.rule).toBe(
      'parcel_photo_count',
    );
  });
});

describe('the body that names the photos of a large pickup', () => {
  // Break caught (D-A10: no cap; the body limit must admit 200 parcels, "prove and record the reading"): a body limit, or a cap on the list, that makes the photos of a large pickup
  // unsendable. The reading recorded: an identifier is 36 characters, quoted and followed by a comma, 39 bytes; the application's default body limit is 102,400 bytes, which admits a
  // list of about 2,600 photos beside the rest of the body. Two hundred parcels are 7,800 bytes, about a thirteenth of it.
  it('admits two hundred photos under the default body limit, and the schema sets no cap on the list', () => {
    const limit = Number(ENGINEERING_DEFAULTS.HTTP_BODY_LIMIT_BYTES);
    expect(limit).toBe(102_400);
    const body = JSON.stringify({ collected_count: 200, parcel_photo_ids: ids(200) });
    expect(Buffer.byteLength(body)).toBeLessThan(8_100);
    expect(Buffer.byteLength(body)).toBeLessThan(limit / 12);
    // About 2,600 photos fit beside the rest of the body: the transport bounds the list, and the schema does not.
    const largest = Math.floor((limit - 64) / 39);
    expect(largest).toBeGreaterThan(2_500);
    const properties = (
      COLLECTION_RECORD_CREATE_BODY as unknown as { properties: Record<string, object> }
    ).properties;
    expect(properties.parcel_photo_ids).not.toHaveProperty('maxItems');
    expect(properties.parcel_photo_ids).not.toHaveProperty('uniqueItems');
  });
});

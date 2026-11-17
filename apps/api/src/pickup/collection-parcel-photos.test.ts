import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ENGINEERING_DEFAULTS } from '../platform/config/config-settings.js';
import { ApiException } from '../platform/http/api-exception.js';
import { COLLECTION_RECORD_CREATE_BODY, STAGE_PARCEL_PHOTOS_BODY } from './collection-schemas.js';
import {
  checkedParcelPhotoIds,
  checkedStagedBatch,
  MAX_STAGED_BATCH,
} from './collection-parcel-photos.js';

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

describe('checkedParcelPhotoIds with the photos staged beforehand (D-E1)', () => {
  // Break caught: the staged photos left out of the number (a count that staged all of its photos and names none refused), or counted as the named ones are but never
  // checked against the count (a staged set larger or smaller than the parcels let through).
  it.each([
    [5, 2, 3],
    [5, 5, 0],
    [5, 0, 5],
    [1, 0, 1],
    [20_000, 100, 19_900],
  ])(
    'takes a count of %i parcels with %i named and %i staged, and answers the named ones',
    (collected, named, staged) => {
      const given = ids(named);
      expect(checkedParcelPhotoIds(given, collected, false, staged)).toEqual(given);
    },
  );

  it('takes a count whose photos were all staged with no list at all, and with an empty one', () => {
    expect(checkedParcelPhotoIds(undefined, 4, false, 4)).toEqual([]);
    expect(checkedParcelPhotoIds([], 4, false, 4)).toEqual([]);
  });

  // Break caught: named and staged photos that do not add up to the count let through (too few, too many), or the refusal named by another rule.
  it.each([
    [5, 2, 2],
    [5, 3, 3],
    [5, 0, 4],
    [5, 0, 6],
    [5, 6, 0],
    [3, 0, 0],
  ])(
    'refuses a count of %i parcels with %i named and %i staged, as parcel_photo_count',
    (collected, named, staged) => {
      expect(refusalOf(() => checkedParcelPhotoIds(ids(named), collected, false, staged))).toEqual({
        code: 'VALIDATION_FAILED',
        rule: 'parcel_photo_count',
      });
    },
  );

  // Break caught: a stop let through without photos that counts what was staged for it (the staged photos are left as they are, attached to nothing), or that takes a named one.
  it('ignores what is staged for a stop let through without photos, and still refuses a photo named for it', () => {
    expect(checkedParcelPhotoIds(undefined, 3, true, 3)).toEqual([]);
    expect(checkedParcelPhotoIds([], 3, true, 7)).toEqual([]);
    expect(refusalOf(() => checkedParcelPhotoIds(ids(1), 3, true, 2))).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'parcel_photo_count',
    });
  });

  // Break caught: the staged number given the place of the duplicate check, so that a photo named twice passes when the number happens to be right.
  it('still refuses a photo named twice, whatever is staged', () => {
    const [one, two] = ids(2);
    expect(
      refusalOf(() => checkedParcelPhotoIds([one ?? '', two ?? '', one ?? ''], 5, false, 2)),
    ).toEqual({ code: 'VALIDATION_FAILED', rule: 'duplicate' });
    expect(
      refusalOf(() => checkedParcelPhotoIds([(one ?? '').toUpperCase(), one ?? ''], 4, false, 2))
        ?.rule,
    ).toBe('duplicate');
    // And for a stop let through, where the duplicate is judged first as it always was.
    expect(refusalOf(() => checkedParcelPhotoIds([one ?? '', one ?? ''], 4, true, 2))?.rule).toBe(
      'duplicate',
    );
  });

  it('gives the photos named in lower case and in the order named', () => {
    const given = ids(3).map((id) => id.toUpperCase());
    expect(checkedParcelPhotoIds(given, 10, false, 7)).toEqual(given.map((id) => id.toLowerCase()));
  });
});

describe('checkedStagedBatch (D-E1: one to 500 photos of a request)', () => {
  // Break caught: an empty batch let through (it stages nothing and answers a count that moved nothing), or one that is not a list.
  it('refuses no photo at all as minItems, for an empty list and for anything that is not a list', () => {
    for (const given of [[], undefined, null, 'x', {}, 7]) {
      expect(
        refusalOf(() => checkedStagedBatch(given)),
        JSON.stringify(given),
      ).toEqual({
        code: 'VALIDATION_FAILED',
        rule: 'minItems',
      });
    }
  });

  // Break caught: the limit of a request moved or lost: a batch above it reaching the database as one statement of any length.
  it('refuses 501 photos as maxItems, and takes 500 in lower case', () => {
    expect(MAX_STAGED_BATCH).toBe(500);
    expect(refusalOf(() => checkedStagedBatch(ids(501)))).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'maxItems',
    });
    expect(refusalOf(() => checkedStagedBatch(ids(5_000)))?.rule).toBe('maxItems');
    const given = ids(500).map((id) => id.toUpperCase());
    expect(checkedStagedBatch(given)).toEqual(given.map((id) => id.toLowerCase()));
    expect(checkedStagedBatch(ids(1))).toHaveLength(1);
  });

  // Break caught: a value that is not an identifier reaching the statement's array literal (a comma or a brace in it would make another list).
  it.each([
    ['text that is not an identifier', 'not-a-uuid'],
    ['an identifier with a comma after it', `${randomUUID()},${randomUUID()}`],
    ['a brace', '{}'],
    ['an empty text', ''],
    ['a number', 7],
    ['nothing', null],
  ])('refuses %s as format', (_what, bad) => {
    expect(refusalOf(() => checkedStagedBatch([randomUUID(), bad]))).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'format',
    });
  });

  // Break caught: a photo named twice in a batch (a no-op for the database, but a batch that says it twice is a malformed one), in any case.
  it('refuses a photo named twice, in any case, as duplicate', () => {
    const [one, two] = ids(2);
    expect(refusalOf(() => checkedStagedBatch([one, two, one]))).toEqual({
      code: 'VALIDATION_FAILED',
      rule: 'duplicate',
    });
    expect(refusalOf(() => checkedStagedBatch([(one ?? '').toUpperCase(), one]))?.rule).toBe(
      'duplicate',
    );
  });

  // Break caught: the order of judgement moved, so that a batch that is both too long and wrong says one rule at one time and another at another.
  it('judges the size before the identifiers', () => {
    expect(refusalOf(() => checkedStagedBatch([...ids(500), 'x']))?.rule).toBe('maxItems');
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

  // Break caught (D-E4: a limit on a request and never on a pickup): a batch limit whose body the transport does not admit, or a schema that says another limit than the application's.
  // The reading recorded: 500 identifiers are 19,500 bytes with their quotes and commas, about a fifth of the default body limit of 102,400 bytes.
  it('admits a batch of 500 photos under the default body limit with room to spare, and the schema says the same limit', () => {
    const limit = Number(ENGINEERING_DEFAULTS.HTTP_BODY_LIMIT_BYTES);
    const body = JSON.stringify({ parcel_photo_ids: ids(MAX_STAGED_BATCH) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(19_500);
    expect(Buffer.byteLength(body)).toBeLessThan(20_000);
    expect(Buffer.byteLength(body)).toBeLessThan(limit / 5);
    const photos = (
      STAGE_PARCEL_PHOTOS_BODY as unknown as {
        properties: { parcel_photo_ids: { minItems: number; maxItems: number } };
      }
    ).properties.parcel_photo_ids;
    expect(photos.minItems).toBe(1);
    expect(photos.maxItems).toBe(MAX_STAGED_BATCH);
  });
});

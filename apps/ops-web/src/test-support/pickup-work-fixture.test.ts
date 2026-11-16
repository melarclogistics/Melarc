import { describe, expect, it } from 'vitest';

import {
  evidenceItemFixture,
  evidenceListFixture,
  exceptionFixture,
  letThroughListFixture,
} from './pickup-work-fixture';

/**
 * The fixture of a stop's evidence list is held to what the server can answer (the review of Run B, finding 9). **A stop let through without parcel photos is a stop whose photos could not be made or
 * sent**: Ops makes the exception before the count, when the camera failed or the photos cannot be sent (`authoriseParcelPhotoException`, pickup-collection.md section 5.5), and the server then answers
 * its list with the exception on it and no photo that made it. The browser's stand-in drew "40 of 40 parcel photos uploaded" beside "Counted without parcel photos", which the exception is never
 * for: no screen test may assert on that state, so the fixture refuses to build it.
 */
const EVERY_PHOTO_IN = { declared: 3, stored: 3, pending: 0, expired: 0 } as const;

describe('the evidence list of a stop that was let through without parcel photos', () => {
  // Break caught: a fixture that builds a stop with every photo uploaded and the exception beside it, a state the exception is not made for.
  it('is never one whose parcel photos are all uploaded', () => {
    expect(() =>
      evidenceListFixture({
        items: [evidenceItemFixture()],
        parcel_photos: EVERY_PHOTO_IN,
        parcel_photo_exception: exceptionFixture(),
      }),
    ).toThrow(/let through without parcel photos/);
  });

  // Break caught: a guard that refuses the states the exception is for.
  it.each([
    ['no photo at all: the camera failed', { declared: 0, stored: 0, pending: 0, expired: 0 }],
    ['photos still waiting to upload', { declared: 3, stored: 1, pending: 2, expired: 0 }],
    ['photos whose upload window ran out', { declared: 0, stored: 0, pending: 0, expired: 3 }],
    [
      'some photos that never came, and the rest uploaded',
      { declared: 2, stored: 2, pending: 0, expired: 1 },
    ],
  ])('can be a stop with %s', (_name, progress) => {
    const list = evidenceListFixture({
      items: [],
      parcel_photos: progress,
      parcel_photo_exception: exceptionFixture(),
    });

    expect(list.parcel_photo_exception).not.toBeNull();
    expect(list.parcel_photos).toEqual(progress);
  });

  it('is built whole by the one fixture made for it: no photo, the progress at zero, the exception on it', () => {
    const list = letThroughListFixture();

    expect(list.items).toEqual([]);
    expect(list.parcel_photos).toEqual({ declared: 0, stored: 0, pending: 0, expired: 0 });
    expect(list.parcel_photo_exception).toEqual(exceptionFixture());
  });

  it('does not touch an ordinary stop: every photo uploaded and no exception is the common state', () => {
    const list = evidenceListFixture({ parcel_photos: EVERY_PHOTO_IN });

    expect(list.parcel_photo_exception).toBeNull();
    expect(list.parcel_photos).toEqual(EVERY_PHOTO_IN);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **No photo of a stop, and no number of them, is on any page of the receiving side** (surfaces/ops-portal.md section 7, `/manifests/{id}/stops/{stopId}`; hub-intake.md section 5.3): the photos tell the
 * receiving officer what the rider counted (the number of parcel photos *is* the rider's count), so one who counts what they receive must not see them before their own count commits: the hub's blind count
 * (MSC-DEC-194). This holds the portal's source to it in two ways. **The photos have one home**: the files outside `platform/pickup-work/` that read a stop's evidence, ask for the authorization of a
 * photo or draw the progress of its photos are the stop's pages and no others, so a page that begins to draw them must be added to the list below, on purpose and in review. **The receiving side has none**:
 * no file whose name says it is the receiving side (an intake, a receiving, a custody handover: the act of one who counts what is handed to them) names any of them. A file of the receiving side that is
 * added later is held to the same, whatever the list says.
 */
const SRC = join(import.meta.dirname, '../src');

/** What reads a stop's photos, asks for the picture of one, or tells their number: by name, as a source writes it. */
const PHOTOS = [
  'useStopEvidence',
  'usePhotoAuthorization',
  'createRetrievalAuthorization',
  'stopEvidenceKey',
  'STOP_EVIDENCE_PAGE_SIZE',
  'parseStopEvidencePage',
  'parseStopEvidenceItem',
  'StopEvidencePageView',
  'StopEvidenceItemView',
  'ParcelPhotoProgressView',
  'RetrievalAuthorizationView',
  'StopPhotos',
  'EvidenceRead',
  'parcel_photos',
  'parcel_photo_exception',
  'PARCEL_PHOTO',
  'COLLECTION_PROOF',
] as const;

/** The number of the photos a failure carries is the failure queue's, which is not the receiving side: a count of what the rider attached to a failed stop, which nobody counts a delivery against. */
const FAILURE_PHOTO_COUNT = 'photo_count';

/** The pages that draw a stop's photos: the stop's own page and what it is made of. Nothing else outside the platform folder of this work. */
const HOMES = [
  `app${sep}pages${sep}manifests${sep}StopPhotos.tsx`,
  `app${sep}pages${sep}manifests${sep}StopPage.tsx`,
  `app${sep}pages${sep}manifests${sep}StopExceptionPage.tsx`,
].map((path) => path.replaceAll('\\', '/'));

/** Where a failure's number of photos is drawn: the failure queue, and no other page. */
const FAILURE_HOMES = [
  `app/pages/pickup-work/FailurePanel.tsx`,
  `app/pages/pickup-work/FailedPickupsPage.tsx`,
];

/** A file that says by its name that it is the receiving side: it counts what is handed to its officer. */
const RECEIVING = /intake|receiv|custody/i;

interface Source {
  readonly path: string;
  readonly text: string;
}

function sources(directory: string): Source[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // The showcase and the test fixtures are not screens: a fixture of the contract's answers carries these names on purpose.
    if (entry.isDirectory()) {
      return entry.name === 'showcase' || entry.name === 'test-support' ? [] : sources(path);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) return [];
    return [{ path: relative(SRC, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }];
  });
}

const mentions = (text: string, names: readonly string[]): string[] =>
  names.filter((name) => new RegExp(`\\b${name}\\b`).test(text));

/** What is wrong with a set of sources, in words: the files that draw a photo and are not its home, and the files of the receiving side that name one. */
export function offenders(files: readonly Source[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (
      file.path.startsWith('platform/pickup-work/') ||
      file.path === 'platform/problem/pickup-work-copy.ts'
    ) {
      continue;
    }
    const photos = mentions(file.text, PHOTOS);
    if (photos.length > 0 && !HOMES.includes(file.path)) {
      found.push(
        `${file.path} names ${photos.join(', ')}: a stop's photos are drawn by the stop's pages alone.`,
      );
    }
    if (RECEIVING.test(file.path)) {
      const names = mentions(file.text, [...PHOTOS, FAILURE_PHOTO_COUNT]);
      if (names.length > 0) {
        found.push(`${file.path} is of the receiving side and names ${names.join(', ')}.`);
      }
    }
    if (
      mentions(file.text, [FAILURE_PHOTO_COUNT]).length > 0 &&
      !FAILURE_HOMES.includes(file.path)
    ) {
      found.push(
        `${file.path} names ${FAILURE_PHOTO_COUNT}: the number of a failure's photos is the failure queue's.`,
      );
    }
  }
  return found;
}

describe('the photos of a stop and the receiving side', () => {
  const real = sources(SRC);

  it('reads the portal’s source', () => {
    expect(real.length).toBeGreaterThan(200);
    expect(real.some((file) => file.path === 'app/pages/manifests/StopPhotos.tsx')).toBe(true);
  });

  // Break caught: a page that begins to draw a stop's photos, or their number, that is not the stop's own page.
  it('has no page that draws a stop’s photos but the stop’s own', () => {
    expect(offenders(real)).toEqual([]);
  });

  it('has the stop’s page drawing the photos it is the home of', () => {
    const page = real.find((file) => file.path === 'app/pages/manifests/StopPhotos.tsx');
    expect(mentions(page?.text ?? '', PHOTOS)).toEqual(
      expect.arrayContaining(['StopPhotos', 'usePhotoAuthorization']),
    );
    const stop = real.find((file) => file.path === 'app/pages/manifests/StopPage.tsx');
    expect(mentions(stop?.text ?? '', ['useStopEvidence', 'StopPhotos'])).toHaveLength(2);
  });

  // Break caught: a guard that finds nothing because its patterns match nothing: each kind of offence, written in a source of the receiving side, is found.
  describe('finds each kind of offence', () => {
    const synthetic = (path: string, text: string): string[] => offenders([{ path, text }]);

    it.each([
      [
        'an intake page that reads the evidence',
        'app/pages/hub/IntakeCountPage.tsx',
        'const e = useStopEvidence(id, undefined);',
      ],
      [
        'a receiving page that draws the progress of the photos',
        'app/pages/hub/ReceivingPage.tsx',
        'return <p>{page.parcel_photos.declared}</p>;',
      ],
      [
        'a custody page that names a failure’s photo count',
        'app/pages/manifests/CustodySection.tsx',
        'const n = failure.photo_count;',
      ],
      [
        'a custody page that asks for the authorization of a photo',
        'app/pages/manifests/CustodySection.tsx',
        'usePhotoAuthorization(id, true)',
      ],
      [
        'a page that is not the stop’s and draws a photo',
        'app/pages/pickup/PickupRequestDetailPage.tsx',
        'import { StopPhotos } from "./StopPhotos";',
      ],
      [
        'a page that is not the failure queue and draws a failure’s photo count',
        'app/pages/pickup/ApprovalsPage.tsx',
        'row.photo_count',
      ],
    ])('finds %s', (_name, path, text) => {
      expect(synthetic(path, text).length).toBeGreaterThan(0);
    });

    it('finds nothing in the stop’s own page or in the failure queue', () => {
      expect(
        synthetic(
          'app/pages/manifests/StopPage.tsx',
          'useStopEvidence(stopId, undefined, true); <StopPhotos />',
        ),
      ).toEqual([]);
      expect(synthetic('app/pages/pickup-work/FailurePanel.tsx', 'failure.photo_count')).toEqual(
        [],
      );
    });

    it('does not take a word that merely contains a name for the name', () => {
      expect(
        synthetic(
          'app/pages/hub/IntakePage.tsx',
          'const NOT_A_PARCEL_PHOTO_X = 1; xuseStopEvidencex;',
        ),
      ).toEqual([]);
    });
  });

  it('has a receiving side that is not empty of files, so that the guard has something to hold', () => {
    // The custody handover of a run is the receiving side that exists in the portal today: an intake page is added later and is held to the same.
    expect(real.some((file) => RECEIVING.test(file.path))).toBe(true);
  });
});

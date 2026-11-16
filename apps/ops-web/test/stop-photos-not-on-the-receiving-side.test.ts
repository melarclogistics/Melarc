import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **Where a photo is drawn, and what the receiving side may draw** (surfaces/ops-portal.md section 7; D-D1 of Run D, which reversed what this held for a photo vendor). Until Run D no photo of a stop was on any
 * page of the receiving side before the count: the number of the parcel photos *was* the rider's count, so an officer who counted what they received must not see them (MSC-DEC-194). **The door photos are now the
 * reference of a photo check-in**: the receiving officer is shown each parcel's photo from the handover on and taps each one that is on the table. What stayed is **the blind count of a vendor whose photos Ops
 * excused**: its read carries no parcel and no number of the rider's, so there is no photo of it to draw (the run's page draws none for it, which the page's tests and the browser's leak scan hold). This
 * holds the portal's source to what is left, in four ways. **The stop's photos have one home**: the files outside `platform/pickup-work/` that read a stop's evidence, ask for the authorization of a photo or
 * draw the progress of its photos are the stop's pages and the one dialog that opens a photo. **The receiving side never reads a stop's evidence**: it draws the photo of a *parcel* (the identifier the parcel
 * carries), through the one hook that gives a picture's address, and no file whose name says it is the receiving side names any of the stop's machinery. **The picture and the grid have one door each**: the hook that
 * gives the address of a picture, and the grid of tiles, are named by the files of the receiving run's page that draw them and by nothing else, so that the queue, the blind count and the decision do not begin to
 * draw a photo without being added to the list below, on purpose and in review. **The dialog that opens a photo** is named by the stop's photos, the photos of a counted intake and nothing else.
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
  `app${sep}pages${sep}evidence${sep}EvidencePhotoDialog.tsx`,
].map((path) => path.replaceAll('\\', '/'));

/** The one platform hook that asks for the address of a picture and is not the stop's: the receiving side's pictures are drawn from it, and it shares the stop's call. */
const PICTURE_HOOK_FILE = 'platform/evidence/use-photo-link.ts';

/** The dialog that opens one stored photo, and who may name it: the stop's photos, and the photos of a counted intake (the one file of the receiving side that may). */
const PHOTO_DIALOG = 'EvidencePhotoDialog';
const DIALOG_USERS = [
  'app/pages/manifests/StopPhotos.tsx',
  'app/pages/evidence/EvidencePhotoDialog.tsx',
  'app/pages/intakes/IntakePhotos.tsx',
];
/** The photos of a counted intake, and who may name them: the file itself and the intake's record page. */
const INTAKE_PHOTOS = 'IntakePhotos';
const INTAKE_PHOTOS_USERS = [
  'app/pages/intakes/IntakePhotos.tsx',
  'app/pages/intakes/IntakePage.tsx',
];

/**
 * The hook that gives the address of a picture, and the grid of photo tiles: named by their own files and by the files of the receiving run's page that draw a parcel's photo. A page of the receiving side
 * that is not in the list (the queue, the blind count, a decision) draws no photo.
 */
const PICTURE_HOOK = 'usePhotoLink';
const PICTURE_USERS = [
  PICTURE_HOOK_FILE,
  // The kit's one component that draws the picture of a stored photo from its link (the grid and the viewer are generic and draw what a page gives them).
  'app/pages/evidence/PhotoPicture.tsx',
  'app/pages/receiving/ParcelPicture.tsx',
];
/** The kit's component that draws a picture from a stored photo's link: named by itself and by the receiving run's picture. */
const PICTURE_COMPONENT = 'PhotoPicture';
const PICTURE_COMPONENT_USERS = [
  'app/pages/evidence/PhotoPicture.tsx',
  'app/pages/receiving/ParcelPicture.tsx',
];
const PHOTO_GRID = 'PhotoGrid';
const GRID_USERS = ['components/ui/photo-grid/PhotoGrid.tsx', 'app/pages/receiving/ParcelGrid.tsx'];

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

/** What is wrong with a set of sources, in words: the files that draw a photo and are not its home, and the files of the receiving side that name the stop's. */
export function offenders(files: readonly Source[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (
      file.path.startsWith('platform/pickup-work/') ||
      file.path === 'platform/problem/pickup-work-copy.ts'
    ) {
      continue;
    }
    if (file.path !== PICTURE_HOOK_FILE) {
      const photos = mentions(file.text, PHOTOS);
      if (photos.length > 0 && !HOMES.includes(file.path)) {
        found.push(
          `${file.path} names ${photos.join(', ')}: a stop's photos are drawn by the stop's pages alone.`,
        );
      }
      if (RECEIVING.test(file.path)) {
        const names = mentions(file.text, [...PHOTOS, FAILURE_PHOTO_COUNT]);
        if (names.length > 0) {
          found.push(
            `${file.path} is of the receiving side and names ${names.join(', ')}: the receiving side draws the photo of a parcel, never a stop's.`,
          );
        }
      }
    }
    if (mentions(file.text, [PHOTO_DIALOG]).length > 0 && !DIALOG_USERS.includes(file.path)) {
      found.push(
        `${file.path} names ${PHOTO_DIALOG}: only the stop's photos and the photos of a counted intake open a photo.`,
      );
    }
    if (
      mentions(file.text, [INTAKE_PHOTOS]).length > 0 &&
      !INTAKE_PHOTOS_USERS.includes(file.path)
    ) {
      found.push(
        `${file.path} names ${INTAKE_PHOTOS}: the photos of a counted intake are drawn by the intake's record page alone.`,
      );
    }
    if (mentions(file.text, [PICTURE_HOOK]).length > 0 && !PICTURE_USERS.includes(file.path)) {
      found.push(
        `${file.path} names ${PICTURE_HOOK}: the address of a picture is asked for by the run's parcel picture alone.`,
      );
    }
    if (
      mentions(file.text, [PICTURE_COMPONENT]).length > 0 &&
      !PICTURE_COMPONENT_USERS.includes(file.path)
    ) {
      found.push(
        `${file.path} names ${PICTURE_COMPONENT}: a picture is drawn from a stored photo's link by the kit's component and the run's parcel picture alone.`,
      );
    }
    if (mentions(file.text, [PHOTO_GRID]).length > 0 && !GRID_USERS.includes(file.path)) {
      found.push(
        `${file.path} names ${PHOTO_GRID}: the grid of photos is drawn by the run's parcel grid alone.`,
      );
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

describe('where a photo is drawn, and what the receiving side may draw', () => {
  const real = sources(SRC);

  it('reads the portal’s source', () => {
    expect(real.length).toBeGreaterThan(200);
    expect(real.some((file) => file.path === 'app/pages/manifests/StopPhotos.tsx')).toBe(true);
  });

  // Break caught: a page that begins to draw a stop's photos, their number, a parcel's picture or the grid, without being added to the list on purpose.
  it('has no page that draws a photo but the one that is its home', () => {
    expect(offenders(real)).toEqual([]);
  });

  it('has the stop’s page drawing the photos it is the home of', () => {
    const page = real.find((file) => file.path === 'app/pages/manifests/StopPhotos.tsx');
    expect(mentions(page?.text ?? '', PHOTOS)).toEqual(
      expect.arrayContaining(['StopPhotos', 'EvidenceRead']),
    );
    // The picture of a photo is asked for in the one dialog both the stop and a counted intake open it with.
    const dialog = real.find((file) => file.path === 'app/pages/evidence/EvidencePhotoDialog.tsx');
    expect(mentions(dialog?.text ?? '', PHOTOS)).toContain('usePhotoAuthorization');
    const stop = real.find((file) => file.path === 'app/pages/manifests/StopPage.tsx');
    expect(mentions(stop?.text ?? '', ['useStopEvidence', 'StopPhotos'])).toHaveLength(2);
  });

  // Break caught: a guard that stops looking because the files it names were renamed: the doors it holds are there.
  it('has the doors it holds', () => {
    for (const door of [...PICTURE_USERS, ...GRID_USERS].filter(
      (path) => path.startsWith('platform/') || path.startsWith('components/'),
    )) {
      expect(
        real.some((file) => file.path === door),
        door,
      ).toBe(true);
    }
  });

  // Break caught: a guard that finds nothing because its patterns match nothing: each kind of offence, written in a source of the receiving side, is found.
  describe('finds each kind of offence', () => {
    const synthetic = (path: string, text: string): string[] => offenders([{ path, text }]);

    it.each([
      [
        'an intake page that reads the stop’s evidence',
        'app/pages/hub/IntakeCountPage.tsx',
        'const e = useStopEvidence(id, undefined);',
      ],
      [
        'a receiving page that draws the progress of the stop’s photos',
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
      [
        'a page of the receiving run that asks the platform for the stop’s picture instead of the parcel’s',
        'app/pages/receiving/ParcelPicture.tsx',
        'createRetrievalAuthorization(client, id)',
      ],
    ])('finds %s', (_name, path, text) => {
      expect(synthetic(path, text).length).toBeGreaterThan(0);
    });

    // Break caught: the photo kit's two doors (the hook that asks for the link of a picture and the component that draws it) used by a page that was not added to the list, so that a page of the receiving side
    // draws a photo by them and nothing fails: the dialog and the stop's tiles are not the only way to a picture any more.
    it.each([
      [
        'an intake page drawing a photo by the kit’s picture',
        'app/pages/intakes/IntakeCountPage.tsx',
        '<PhotoPicture evidenceId={id} near />',
      ],
      [
        'a custody page asking for the link of a photo',
        'app/pages/manifests/CustodySection.tsx',
        'const link = usePhotoLink(id, true);',
      ],
      [
        'a page that is not a home drawing a photo by the kit’s picture',
        'app/pages/pickup/PickupRequestDetailPage.tsx',
        'import { PhotoPicture } from "../evidence/PhotoPicture";',
      ],
      [
        'a page that is not a home asking for the link of a photo',
        'app/pages/pickup/ApprovalsPage.tsx',
        'usePhotoLink(evidenceId, near)',
      ],
      [
        'another file of the evidence platform asking for the authorization of a photo',
        'platform/evidence/evidence-view.ts',
        'await createRetrievalAuthorization(client, evidenceId);',
      ],
    ])('finds %s', (_name, path, text) => {
      expect(synthetic(path, text).length).toBeGreaterThan(0);
    });

    // Break caught: the queue, the blind count or a decision beginning to draw a photo without the list being changed on purpose.
    it.each([
      [
        'the queue drawing a picture',
        'app/pages/receiving/ReceivingQueuePage.tsx',
        'const link = usePhotoLink(id, true);',
      ],
      [
        'the blind count drawing a picture',
        'app/pages/intakes/IntakeCountPage.tsx',
        'const link = usePhotoLink(id, true);',
      ],
      [
        'the queue drawing the grid',
        'app/pages/receiving/ReceivingQueuePage.tsx',
        '<PhotoGrid label="x" items={[]} renderPicture={() => null} />',
      ],
      [
        'a vendor’s section drawing the grid itself',
        'app/pages/receiving/VendorSection.tsx',
        'import { PhotoGrid } from "../../../components/ui/photo-grid/PhotoGrid";',
      ],
    ])('finds %s', (_name, path, text) => {
      expect(synthetic(path, text).length).toBeGreaterThan(0);
    });

    // Break caught: the door that opens a photo named by a page of the receiving side that is not the counted intake's own photos, so that a photo is opened where it should not be.
    it.each([
      [
        'the queue opening a photo',
        'app/pages/receiving/ReceivingQueuePage.tsx',
        'import { EvidencePhotoDialog } from "../evidence/EvidencePhotoDialog";',
      ],
      [
        'the count page opening a photo',
        'app/pages/intakes/IntakeCountPage.tsx',
        '<EvidencePhotoDialog evidenceId={id} />',
      ],
      [
        'a page of another folder opening a photo',
        'app/pages/pickup/PickupRequestDetailPage.tsx',
        '<EvidencePhotoDialog evidenceId={id} />',
      ],
      [
        'the count page drawing the photos of a counted intake',
        'app/pages/intakes/IntakeCountPage.tsx',
        '<IntakePhotos ids={ids} />',
      ],
      [
        'the adjudication drawing the photos of a counted intake',
        'app/pages/intakes/IntakeDiscrepancyPage.tsx',
        'import { IntakePhotos } from "./IntakePhotos";',
      ],
    ])('finds %s', (_name, path, text) => {
      expect(synthetic(path, text).length).toBeGreaterThan(0);
    });

    // Break caught: the guard widened until it flags the kit's own two doors: the file that asks for the authorization and the component that draws the picture are the homes of those names.
    it('finds nothing in the file that asks for a photo’s link or in the component that draws the picture', () => {
      expect(
        synthetic(
          'platform/evidence/use-photo-link.ts',
          'import { createRetrievalAuthorization } from "../pickup-work/pickup-work-commands";',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'app/pages/evidence/PhotoPicture.tsx',
          'const view = usePhotoLink(evidenceId, near); export function PhotoPicture() {}',
        ),
      ).toEqual([]);
    });

    it('finds nothing in the doors: the parcel’s picture, the run’s grid, the hook, the counted intake’s photos, the record page and the dialog', () => {
      expect(
        synthetic(
          'app/pages/receiving/ParcelPicture.tsx',
          'import { usePhotoLink } from "../../../platform/evidence/use-photo-link"; usePhotoLink(evidenceId, near);',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'app/pages/receiving/ParcelGrid.tsx',
          'import { PhotoGrid } from "../../../components/ui/photo-grid/PhotoGrid"; <PhotoGrid />',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'platform/evidence/use-photo-link.ts',
          'createRetrievalAuthorization(client, evidenceId); export function usePhotoLink() {}',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'app/pages/intakes/IntakePhotos.tsx',
          'import { EvidencePhotoDialog } from "../evidence/EvidencePhotoDialog"; <EvidencePhotoDialog />',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'app/pages/intakes/IntakePage.tsx',
          '<IntakePhotos ids={intake.parcel_photo_ids} />',
        ),
      ).toEqual([]);
      expect(
        synthetic(
          'app/pages/evidence/EvidencePhotoDialog.tsx',
          'usePhotoAuthorization(evidenceId, true)',
        ),
      ).toEqual([]);
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
          'const NOT_A_PARCEL_PHOTO_X = 1; xuseStopEvidencex; xusePhotoLinkx; PhotoGridish;',
        ),
      ).toEqual([]);
    });
  });

  it('has a receiving side that is not empty of files, so that the guard has something to hold', () => {
    // The custody handover of a run is the receiving side that exists in the portal today: an intake page is added later and is held to the same.
    expect(real.some((file) => RECEIVING.test(file.path))).toBe(true);
  });
});

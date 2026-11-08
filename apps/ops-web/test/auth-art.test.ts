import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AUTH_ART, artFor } from '../src/app/pages/pre-sign-in/auth-art';
import { PRE_SIGN_IN_ROUTES } from '../src/app/pages/pre-sign-in/pre-sign-in-routes';

const APP_ROOT = resolve(import.meta.dirname, '..');
const FOLDER = resolve(APP_ROOT, 'src/assets/auth');
const README = resolve(FOLDER, 'README.md');
const ORIGINALS = resolve(APP_ROOT, '../../design/images');

/** Ordinary photographs, sized for a window: past this the sign-in page is slow for what it shows. */
const MAX_BYTES = 350_000;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

interface Row {
  readonly copy: string;
  readonly source: string;
  readonly sourceSha: string;
  readonly copySha: string;
}

/** The table of the README: one row for each copy, with the checksums it records. */
async function rows(): Promise<Row[]> {
  const readme = await readFile(README, 'utf8');
  return [
    ...readme.matchAll(
      /^\|\s*`(auth-art-\d+\.webp)`\s*\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|.*\|\s*`([0-9a-f]{64})`\s*\|$/gm,
    ),
  ].map((match) => ({
    copy: match[1] ?? '',
    source: match[2] ?? '',
    sourceSha: match[3] ?? '',
    copySha: match[4] ?? '',
  }));
}

async function copies(): Promise<string[]> {
  return (await readdir(FOLDER)).filter((name) => name.endsWith('.webp')).toSorted();
}

describe('the photographs of the split-screen sign-in', () => {
  // Break caught: a copy edited, replaced or re-exported without its record, so that the README vouches for a picture that is no longer the
  // one the page shows.
  it('are the copies the README records, by checksum, and every copy is recorded', async () => {
    const recorded = await rows();
    const present = await copies();

    expect(present.length).toBeGreaterThanOrEqual(1);
    expect(recorded.map((row) => row.copy).toSorted()).toEqual(present);
    for (const row of recorded) {
      expect(sha256(await readFile(resolve(FOLDER, row.copy)))).toBe(row.copySha);
    }
  });

  // Break caught: the copy made from another picture than the README says, when the originals are at hand to compare (they are the Product
  // Owner's, in design/images; a checkout without them is not wrong, so the comparison is made where they are).
  it('were made from the originals the README names', async () => {
    for (const row of await rows()) {
      const original = resolve(ORIGINALS, row.source);
      if (existsSync(original)) expect(sha256(await readFile(original))).toBe(row.sourceSha);
    }
  });

  // Break caught: an original shipped to every visitor (6 to 12 MB each), or a copy that carries the place, the time and the camera of the
  // photograph (EXIF, XMP, ICC and every other chunk that is not the picture).
  it('are web-sized WebP files with no metadata in them', async () => {
    for (const name of await copies()) {
      const bytes = await readFile(resolve(FOLDER, name));

      expect(bytes.length, name).toBeLessThanOrEqual(MAX_BYTES);
      expect(bytes.subarray(0, 4).toString('latin1'), name).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString('latin1'), name).toBe('WEBP');
      const text = bytes.toString('latin1');
      for (const chunk of ['EXIF', 'XMP ', 'ICCP'])
        expect(text.includes(chunk), `${name} ${chunk}`).toBe(false);
    }
  });
});

describe('the table of screens and photographs', () => {
  const screens = PRE_SIGN_IN_ROUTES.flatMap((route) => route.children ?? [])
    .flatMap((route) => route.children ?? [])
    .map((route) => `/${route.path ?? ''}`);

  it('names exactly the screens of the pre-sign-in family', () => {
    expect(screens.toSorted()).toEqual(Object.keys(AUTH_ART).toSorted());
    // The five of S0.43 and the two recovery screens of S0.52a.
    expect(screens).toHaveLength(7);
  });

  // Break caught: a screen shown a stand-in picture, or the first photograph for an address that is none of the seven.
  it('gives a photograph to each of them, and none to any other address', () => {
    for (const screen of screens) expect(artFor(screen), screen).toBeTypeOf('string');
    expect(artFor('/sign-in/')).toBe(artFor('/sign-in'));
    for (const other of ['/', '/admin/staff', '/sign-in/other', '/setup', '/recovery/other']) {
      expect(artFor(other), other).toBeUndefined();
    }
  });

  it('uses every photograph there is, so that none is shipped for nothing', async () => {
    const used = new Set(Object.values(AUTH_ART));
    expect(used.size).toBe((await copies()).length);
  });
});

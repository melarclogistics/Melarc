import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The largest count of parcels is one number in one file (`src/platform/api/count-range.ts`), and the ceilings that the review of 17 November 2026 found in the guards and the form (1,000 photos, 100 pieces
 * of evidence for a finding, 200 findings, 5,000 parcels of a vendor, 1,000,000 parcels taken, 10,000,000 in the door-and-failure figures) do not come back under any name. The platform sets no limit on the
 * parcels of a pickup (OB-S1-97), the contract and the API set none on the lists below, and a screen that invents one refuses a valid record and, with it, the whole page that holds it.
 */
const SRC = resolve(import.meta.dirname, '..', 'src');
const HOME = ['platform', 'api', 'count-range.ts'].join(sep);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, 'utf8'),
}));

describe('the largest count of parcels', () => {
  // Break caught: a second copy of the number, which is how a ceiling gets out of step with the database and the API.
  it('is written in one file of the application', () => {
    const copies = files.filter((file) => /2_147_483_647|2147483647/.test(file.text));
    expect(copies.map((file) => file.path)).toEqual([HOME]);
  });

  // Break caught: a ceiling that comes back under its old name, in a guard or in a form.
  it.each([
    'MAX_PHOTOS',
    'MAX_EVIDENCE_PER_FINDING',
    'MAX_EVIDENCE',
    'MAX_FINDINGS',
    'MAX_PARCELS_OF_A_VENDOR',
    'MAX_PARCELS_TAKEN',
    'MAX_PARCELS_TYPED',
  ])('has no %s', (name) => {
    const found = files.filter((file) => new RegExp(`\\b${name}\\b`).test(file.text));
    expect(found.map((file) => file.path)).toEqual([]);
  });

  // Break caught: a list of identifiers checked with a ceiling or entry by entry (fourteen seconds at twenty thousand): the lists are read by the one helper.
  it('has no list of evidence or photos read by a second helper', () => {
    const found = files.filter((file) => /\bevidenceIdsOf\b/.test(file.text));
    expect(found.map((file) => file.path)).toEqual([]);
  });

  it('is read from that file by the guards of every count of parcels', () => {
    for (const path of [
      ['platform', 'hub-intake', 'hub-intake-shape.ts'],
      ['platform', 'pickup-work', 'pickup-work-shape.ts'],
      ['platform', 'manifest', 'manifest-shape.ts'],
      ['app', 'pages', 'manifests', 'ManifestActDialogs.tsx'],
    ]) {
      const file = files.find((one) => one.path === path.join(sep));
      expect(file?.text, path.join('/')).toMatch(/api\/count-range/);
    }
  });
});

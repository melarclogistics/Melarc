import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { licenceTextOf, treeOf } from './support/third-party-licences';

/*
 * The licences of Motion and what it brings (MIT asks that the notice travel with the work). The build test (build.test.ts) holds each shipped file to
 * the package's own, byte for byte; this one holds the list of packages to the lockfile, so that an upgrade that brings a new package, or drops one, is
 * noticed here and not in an audit. Two texts are shipped: Motion's own, which three of the packages carry (Motion B.V., 2024), and Framer's, which
 * framer-motion carries (Framer B.V., 2018).
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const LICENCES = join(APP_ROOT, 'public/licenses');

const MOTION = 'Motion-MIT.txt';
const FRAMER = 'Framer-Motion-MIT.txt';

/** Every package of the tree, with the licence file that covers it, or the reason it needs none. */
const ACCOUNTED: Readonly<Record<string, string>> = {
  motion: MOTION,
  'motion-dom': MOTION,
  'motion-utils': MOTION,
  'framer-motion': FRAMER,
  // The helper library that Motion builds on. 0BSD grants use, copying and distribution with no condition, so no notice is owed.
  tslib: 'none: 0BSD asks for no notice',
};

const tree = treeOf(APP_ROOT, ['motion']);

describe('the licences of Motion and what it brings', () => {
  // Break caught: a package arriving with an upgrade of Motion, bundled into the portal with no licence shipped for it; or an entry kept after its package left.
  it('account for every package in the tree, and for nothing that is not in it', () => {
    expect([...tree.keys()].sort()).toEqual(Object.keys(ACCOUNTED).sort());
  });

  // Break caught: a licence file named here and never added (or deleted), so that the build ships a notice of nothing.
  it('are all in the licences folder', () => {
    const shipped = new Set(readdirSync(LICENCES));
    const named = Object.values(ACCOUNTED).filter((file) => file.endsWith('.txt'));

    expect(named.length).toBeGreaterThan(1);
    for (const file of named) expect(shipped.has(file), file).toBe(true);
  });

  // Break caught: one licence file standing for packages whose licence is another text, so that a notice is missing for part of the tree.
  it('are the text of each package, which is what the file for it ships', () => {
    for (const [name, folders] of tree) {
      const file = ACCOUNTED[name];
      if (file?.endsWith('.txt') !== true) continue;
      const shipped = readFileSync(join(LICENCES, file), 'utf8');
      for (const folder of folders) expect(licenceTextOf(folder), name).toBe(shipped);
    }
  });

  // Break caught: the two texts taken for one: the copyright lines differ, and a notice must be the one of the work it covers.
  it('ship two texts, one for Motion B.V. and one for Framer B.V.', () => {
    expect(readFileSync(join(LICENCES, MOTION), 'utf8')).toContain('Motion');
    expect(readFileSync(join(LICENCES, MOTION), 'utf8')).not.toContain('Framer');
    expect(readFileSync(join(LICENCES, FRAMER), 'utf8')).toContain('Framer B.V.');
  });
});

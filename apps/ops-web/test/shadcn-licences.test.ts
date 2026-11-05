import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  covers,
  entryFor,
  licenceFileOf,
  licenceTextOf,
  ownDirectory,
  SHADCN_ACCOUNTED,
  SHADCN_ROOTS,
  SHADCN_SOURCE,
  treeOf,
} from './support/third-party-licences';

/*
 * The licences of what the shadcn/ui primitives bring (MIT asks that the notice travel with the work, Apache-2.0 that a copy of the licence does).
 * The build test (build.test.ts) holds each shipped file to the package's own, byte for byte; this one holds the list of packages to the
 * lockfile, so that an upgrade that brings a new package, or drops one, is noticed here and not in an audit. aria-licences.test.ts does the same
 * for React Aria Components.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const LICENCES = join(APP_ROOT, 'public/licenses');

const tree = treeOf(APP_ROOT, SHADCN_ROOTS);
const names = [...tree.keys()].sort();

const fileOf = (entry: ReturnType<typeof entryFor>): string | undefined =>
  typeof entry === 'string' ? entry : undefined;

describe('the licences of the shadcn/ui primitives and what they bring', () => {
  it('read a tree of the size the lockfile has, so that the check below is not empty', () => {
    expect(names.length).toBeGreaterThan(60);
    expect(names).toContain('radix-ui');
    expect(names).toContain('@floating-ui/dom');
    expect(names).toContain('react-remove-scroll');
  });

  // Break caught: a package arriving with an upgrade of Radix UI or of another library, bundled into the portal with no licence shipped for it.
  it('account for every package in the tree', () => {
    expect(names.filter((name) => entryFor(name) === undefined)).toEqual([]);
  });

  // Break caught: an entry kept after its package left the tree, so that the list says the portal brings something it no longer does.
  it('account for nothing that is not in the tree', () => {
    expect(
      Object.keys(SHADCN_ACCOUNTED).filter((entry) => !names.some((name) => covers(entry, name))),
    ).toEqual([]);
  });

  // Break caught: a package covered by two entries, so that the file one of them names is not the one that gets checked against the package.
  it('give each package one entry', () => {
    const doubled = names.filter(
      (name) => Object.keys(SHADCN_ACCOUNTED).filter((entry) => covers(entry, name)).length !== 1,
    );

    expect(doubled).toEqual([]);
  });

  // Break caught: a licence file named here and never added (or deleted), so that the build ships a notice of nothing.
  it('are all in the licences folder', () => {
    const shipped = new Set(readdirSync(LICENCES));
    const named = [
      ...Object.values(SHADCN_ACCOUNTED).filter((entry) => typeof entry === 'string'),
      SHADCN_SOURCE.file,
    ];

    for (const file of named) expect(shipped.has(file), file).toBe(true);
  });

  // Break caught: one licence file standing for packages whose licence is another text, so that a notice (a name, a year) is missing for part of
  // the tree; or a file that is not the package's own text. Every package that a file covers holds exactly that text.
  it("are the packages' own texts, byte for byte, for every package that a file covers", () => {
    const wrong: string[] = [];
    for (const name of names) {
      const file = fileOf(entryFor(name));
      if (file === undefined) continue;
      const shipped = readFileSync(join(LICENCES, file), 'utf8');
      for (const directory of tree.get(name) ?? []) {
        if (licenceTextOf(directory) !== shipped)
          wrong.push(`${name} (${directory}) is not ${file}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  // Break caught: a package that now holds a licence file where the list says it holds none (or the other way round), so that its notice stops
  // travelling, or the reason given for shipping nothing is no longer true.
  it('say truly which packages hold a licence file of their own and which do not', () => {
    const wrong: string[] = [];
    for (const name of names) {
      const entry = entryFor(name);
      if (entry === undefined || typeof entry === 'string') continue;
      for (const directory of tree.get(name) ?? []) {
        if ((licenceFileOf(directory) !== undefined) !== entry.holdsLicenceFile) {
          wrong.push(`${name}: ${entry.none}`);
        }
      }
    }

    expect(wrong).toEqual([]);
  });

  // Break caught: the licence of the registry's source missing or changed. The primitives are the source of shadcn/ui's components (MIT, the notice
  // must come with it), and the package that holds that notice is the command-line tool the portal pins.
  it('ship the licence of the source of the primitives, the shadcn package own text', () => {
    const own = licenceTextOf(ownDirectory(APP_ROOT, SHADCN_SOURCE.package));

    expect(readFileSync(join(LICENCES, SHADCN_SOURCE.file), 'utf8')).toBe(own);
    expect(own).toContain('MIT License');
    expect(own).toContain('shadcn');
  });
});

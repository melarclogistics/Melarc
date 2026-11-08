import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import { packageDirectory } from './support/package-directory';

/*
 * The licences of what React Aria Components brings (Apache-2.0 asks that a copy of the licence travel with the work, MIT that the notice
 * does). The build test (build.test.ts) holds each shipped file to the package's own, byte for byte; this one holds the list of packages to
 * the lockfile, so that an upgrade that brings a new package, or drops one, is noticed here and not in an audit.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const LICENCES = join(APP_ROOT, 'public/licenses');
const LOCKFILE = resolve(APP_ROOT, '../../pnpm-lock.yaml');

const ADOBE = 'React-Aria-Apache-2.0.txt';

/** Every package of the tree, with the licence file that covers it, or the reason it needs none. */
const ACCOUNTED: Readonly<Record<string, string>> = {
  'react-aria-components': ADOBE,
  'react-aria': ADOBE,
  'react-stately': ADOBE,
  '@internationalized/date': ADOBE,
  '@internationalized/number': ADOBE,
  '@internationalized/string': ADOBE,
  '@react-types/shared': ADOBE,
  '@swc/helpers': 'swc-helpers-Apache-2.0.txt',
  'use-sync-external-store': 'use-sync-external-store-MIT.txt',
  clsx: 'clsx-MIT.txt',
  'aria-hidden': 'aria-hidden-MIT.txt',
  // MIT by its package.json; it holds no licence file and no code of its own (an empty module that marks code as for the client).
  'client-only': 'none: an empty module',
  // What @swc/helpers builds on. 0BSD grants use, copying and distribution with no condition, so no notice is owed.
  tslib: 'none: 0BSD asks for no notice',
};

interface Snapshot {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

const nameOf = (key: string): string => /^(@?[^@]+)@/.exec(key)?.[1] ?? key;

/** The names of the packages React Aria Components needs, read from the lockfile; React itself is the application's. */
function treeOfReactAria(): string[] {
  const lock = parse(readFileSync(LOCKFILE, 'utf8')) as { snapshots: Record<string, Snapshot> };
  const names = new Set<string>();
  const queue = Object.keys(lock.snapshots).filter(
    (key) => nameOf(key) === 'react-aria-components',
  );
  const seen = new Set(queue);
  while (queue.length > 0) {
    const key = queue.shift() ?? '';
    names.add(nameOf(key));
    const snapshot = lock.snapshots[key];
    const children = { ...snapshot?.dependencies, ...snapshot?.optionalDependencies };
    for (const [name, version] of Object.entries(children)) {
      if (name === 'react' || name === 'react-dom') continue;
      const child = `${name}@${version}`;
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return [...names].sort();
}

describe('the licences of React Aria Components and what it brings', () => {
  // Break caught: a package arriving with an upgrade of the library, bundled into the portal with no licence shipped for it.
  it('account for every package in the tree, and for nothing that is not in it', () => {
    expect(treeOfReactAria()).toEqual(Object.keys(ACCOUNTED).sort());
  });

  // Break caught: a licence file named here and never added (or deleted), so that the build ships a notice of nothing.
  it('are all in the licences folder', () => {
    const shipped = new Set(readdirSync(LICENCES));
    const named = Object.values(ACCOUNTED).filter((file) => file.endsWith('.txt'));

    for (const file of named) expect(shipped.has(file), file).toBe(true);
  });

  // Break caught: one licence file standing for packages whose licence is another text, so that a notice is missing for part of the tree.
  it("are one text for Adobe's packages, which is what the one file ships", () => {
    const aria = packageDirectory(APP_ROOT, 'react-aria-components');
    const reactAria = packageDirectory(aria, 'react-aria');
    /** A package is found through the one that depends on it: most through the library itself, a few through react-aria. */
    const locate = (name: string): string => {
      if (name === 'react-aria-components') return aria;
      try {
        return packageDirectory(aria, name);
      } catch {
        return packageDirectory(reactAria, name);
      }
    };
    const shipped = readFileSync(join(LICENCES, ADOBE), 'utf8');
    const adobe = Object.entries(ACCOUNTED)
      .filter(([, file]) => file === ADOBE)
      .map(([name]) => name);
    expect(adobe.length).toBeGreaterThan(1);

    for (const name of adobe) {
      const directory = locate(name);
      const licence = readdirSync(directory).find((entry) => /^licen[cs]e$/i.test(entry));
      expect(licence, `${name} has a licence file`).toBeDefined();
      expect(readFileSync(join(directory, licence ?? ''), 'utf8'), name).toBe(shipped);
    }
  });
});

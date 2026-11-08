import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { moduleSpecifiers } from './support/wire-type-scan';

const APP_ROOT = resolve(import.meta.dirname, '..');

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const sources = (await sourceFiles(join(APP_ROOT, 'src'))).map((path) => ({
  path: relative(APP_ROOT, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

const importersOf = (specifier: string): string[] =>
  sources
    .filter((source) => moduleSpecifiers(source.text, source.path).includes(specifier))
    .map((source) => source.path)
    .sort();

describe('the two QR dependencies of S0.39c (plan section 7.35 records the review)', () => {
  const manifest = JSON.parse(readFileSync(join(APP_ROOT, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };

  // Break caught: the encoder reached for from many places, so that replacing it, or finding what draws a credential,
  // means searching the application. One file owns it.
  it('keeps the encoder behind one file', () => {
    expect(importersOf('uqr')).toEqual(['src/components/ui/qr-code/qr-matrix.ts']);
  });

  // Break caught: the test-only decoder reaching the application, and so the production bundle. It exists to check the
  // encoder's output from outside, and is only ever imported by the test helper that does so.
  it('keeps the decoder in test code', () => {
    const importers = importersOf('jsqr');

    expect(importers).toEqual(['src/test-support/qr-decode.ts']);
    expect(manifest.dependencies).not.toHaveProperty('jsqr');
    expect(manifest.devDependencies).toHaveProperty('jsqr');
  });

  // Break caught: application code importing the test helpers, which is how a test-only library gets into the bundle.
  it('lets no application file import the test helpers', () => {
    const offenders = sources
      .filter(
        (source) =>
          !source.path.startsWith('src/test-support/') &&
          !/\.test\.tsx?$/.test(source.path) &&
          moduleSpecifiers(source.text, source.path).some((specifier) =>
            specifier.includes('test-support'),
          ),
      )
      .map((source) => source.path);

    expect(offenders).toEqual([]);
  });

  // Break caught: a range that lets the encoder change under the project without a review (the decision of 9 October 2026
  // is "exactly pinned"; `scripts/dependency-policy.ts` enforces the form for the whole repository).
  it('pins both exactly, the encoder as a dependency and the decoder as a development one', () => {
    expect(manifest.dependencies.uqr).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.devDependencies.jsqr).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

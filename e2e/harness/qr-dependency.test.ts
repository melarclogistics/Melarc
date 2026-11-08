import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const E2E_ROOT = resolve(import.meta.dirname, '..');
const manifestOf = (root: string) =>
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

function sourcesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourcesUnder(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * The QR decoder of the rider journeys (S0.62): `jsqr`, the same exact version as the Ops Portal's test-only decoder (plan sections 7.35
 * and 7.49), used to read the enrolment code from the picture the Ops screen draws. It reads a picture the product made, from outside; it
 * is never the product's.
 */
describe('the QR decoder of the journeys (S0.62)', () => {
  // Break caught: the decoder at a version the Ops Portal's review did not cover, or ranged so that it moves by itself.
  it('is a development dependency, exact, and the version the Ops Portal pins', () => {
    const mine = manifestOf(E2E_ROOT);
    const portal = manifestOf(resolve(E2E_ROOT, '../apps/ops-web'));
    expect(mine.dependencies ?? {}).not.toHaveProperty('jsqr');
    expect(mine.devDependencies?.jsqr).toMatch(/^\d+\.\d+\.\d+$/);
    expect(mine.devDependencies?.jsqr).toBe(portal.devDependencies?.jsqr);
  });

  // Break caught: the decoder reached for from many places, so that finding what reads a credential means searching the harness.
  it('is imported by the one file that reads the code', () => {
    const importers = [...sourcesUnder(E2E_ROOT)]
      .filter(
        (path) =>
          readFileSync(path, 'utf8').includes("from 'jsqr'") &&
          !path.endsWith('qr-dependency.test.ts'),
      )
      .map((path) => relative(E2E_ROOT, path).split(sep).join('/'));
    expect(importers).toEqual(['harness/journeys/rider-handset.ts']);
  });
});

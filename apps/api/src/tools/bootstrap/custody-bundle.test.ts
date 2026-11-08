import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUNDLE_FILE_NAME,
  BUNDLE_MAGIC,
  BUNDLE_TARGET,
  bundleTargetOf,
  renderBundle,
  startsLikeBundle,
  type BundleContent,
} from './custody-bundle.js';

const TARGET = 'd4'.repeat(16);

const content = (overrides: Partial<BundleContent> = {}): BundleContent => ({
  target: TARGET,
  purpose: 'BOOTSTRAP_SETUP',
  custodian: { fullName: 'Kofi Boateng', workEmail: 'kofi.boateng@melarc.example' },
  secret: 'sentinel-NOT-A-SECRET-0000000000000000000000',
  issuedAt: new Date('2026-10-21T08:00:00.000Z'),
  expiresAt: null,
  ...overrides,
});

describe('the custody bundle (S0.30)', () => {
  // Break caught: the target dropped from the text, or written below the line the sweep reads it from (it reads the head of the file).
  it('begins with the magic line and the target of the database it was written for, and then the rest', () => {
    const lines = renderBundle(content()).split('\n');

    expect(lines[0]).toBe(BUNDLE_MAGIC);
    expect(lines[1]).toBe(`target: ${TARGET}`);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe('custodian: Kofi Boateng <kofi.boateng@melarc.example>');
  });

  it('is read back for its target from the head of the file alone, in either line ending', () => {
    const text = renderBundle(content());
    expect(bundleTargetOf(text.slice(0, 160))).toBe(TARGET);
    expect(bundleTargetOf(text.replaceAll('\n', '\r\n').slice(0, 160))).toBe(TARGET);
    expect(startsLikeBundle(text.slice(0, 160))).toBe(true);
  });

  // Break caught: a target taken from a file that is not a bundle, or from a line that is not the second, or one that is no target.
  it('names no target for anything that is not a bundle with a well-formed one on its second line', () => {
    for (const head of [
      '',
      `target: ${TARGET}`,
      BUNDLE_MAGIC,
      `${BUNDLE_MAGIC}\n`,
      `${BUNDLE_MAGIC}\n\ntarget: ${TARGET}`,
      `${BUNDLE_MAGIC}\ntarget:${TARGET}`,
      `${BUNDLE_MAGIC}\ntarget: ${TARGET.toUpperCase()}`,
      `${BUNDLE_MAGIC}\ntarget: ${TARGET}0`,
      `${BUNDLE_MAGIC}\ntarget: ${TARGET.slice(1)}`,
      `${BUNDLE_MAGIC}x\ntarget: ${TARGET}`,
      `x${BUNDLE_MAGIC}\ntarget: ${TARGET}`,
    ]) {
      expect(bundleTargetOf(head), JSON.stringify(head)).toBeUndefined();
    }
    expect(BUNDLE_TARGET.test(TARGET)).toBe(true);
  });

  // Break caught: the two copies of what marks a bundle drifting apart: `scripts/package-source.ts` is a script of the repository root
  // and cannot import the tool, so it holds the first line and the file name pattern itself, and refuses a file that begins with the
  // first line even when it is renamed. A change to one without the other would let a bundle into an archive that is shared for review.
  it('is marked in scripts/package-source.ts by the same first line and the same file name', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../../../../../scripts/package-source.ts', import.meta.url)),
      'utf8',
    );

    expect(script).toContain(`const CUSTODY_BUNDLE_MAGIC = '${BUNDLE_MAGIC}';`);
    expect(script).toContain(`const CUSTODY_BUNDLE_NAME = ${String(BUNDLE_FILE_NAME)};`);
  });
});

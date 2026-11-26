import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ASSETS = resolve(import.meta.dirname, '../src/showcase/assets');
const LABEL = resolve(ASSETS, 'label-sample.png');
const MAKER = resolve(ASSETS, 'make-label-sample.mjs');
const SHOWCASE = resolve(import.meta.dirname, '../src/showcase/kit/PhotosGroup.tsx');

/**
 * The sample label of the photo viewer's showcase (Run G2, OB-S1-168): the photo the viewer's zoom and turn are looked at with, in the shape of a parcel's label. The viewer's browser specs measure the photo against
 * its size and look for its marks (a red square top-left, a blue bar at the right edge), so the file is held to them here, and to being the file its maker makes.
 */
describe('the sample label of the showcase', () => {
  // Break caught: a label that is replaced by another picture (the specs' sizes and marks no longer mean anything), or that is landscape (the case the viewer is for is a parcel photographed on its side).
  it('is a portrait PNG of 800 x 1200 pixels', () => {
    const bytes = readFileSync(LABEL);

    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.readUInt32BE(16)).toBe(800);
    expect(bytes.readUInt32BE(20)).toBe(1200);
  });

  // Break caught: a label edited by hand, so that it can no longer be made again the way the record says.
  it('is exactly what its maker makes, every time', () => {
    const folder = mkdtempSync(join(tmpdir(), 'label-sample-'));
    try {
      const made = join(folder, 'label.png');
      execFileSync(process.execPath, [MAKER, made], { stdio: 'pipe' });
      expect(readFileSync(made).equals(readFileSync(LABEL))).toBe(true);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  // Break caught: a picture that is a made-up parcel of a real person: the label says so of itself, and the showcase says it is drawn.
  it('is said in the showcase to be drawn and not photographed', () => {
    const page = readFileSync(SHOWCASE, 'utf8');

    expect(page).toContain('drawn, not photographed');
  });
});

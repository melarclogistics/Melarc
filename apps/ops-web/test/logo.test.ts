import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const MASTER = resolve(APP_ROOT, '../../design/assets/brand/master/melarc-logo-primary.svg');
const RUNTIME = resolve(APP_ROOT, 'src/assets/brand/melarc-logo-primary.svg');
const README = resolve(APP_ROOT, '../../design/assets/brand/README.md');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('the logo the Ops Portal serves', () => {
  // Break caught: the runtime copy edited, recoloured or replaced while the master stays as it was (DESIGN_SYSTEM
  // 26.1: a runtime copy is copied from the master and nobody edits it there; BRAND_FOUNDATION 4.3: the artwork is
  // never redrawn, traced or recoloured).
  it('is the approved master, byte for byte', async () => {
    const [master, runtime] = await Promise.all([readFile(MASTER), readFile(RUNTIME)]);

    expect(master.length).toBeGreaterThan(1000);
    expect(runtime.equals(master)).toBe(true);
  });

  // Break caught: the README's record of the file drifting from the file, so a reader trusts a checksum that no longer
  // describes the artwork.
  it('is the file the brand README records, by its checksum', async () => {
    const [master, readme] = await Promise.all([readFile(MASTER), readFile(README, 'utf8')]);

    expect(readme).toContain(sha256(master));
  });

  // Break caught: a logo that can run code or reach out when it is shown: a script, an event handler, a link to another
  // file or address, an embedded raster, or text in a font the browser would have to substitute (BRAND_FOUNDATION 4.6:
  // never recreate the wordmark in a substitute font). The artwork is plain shapes, which is what a strict
  // Content-Security-Policy and an `img` element can show.
  it('is plain shapes: no script, no handler, no reference, no embedded raster and no live text', async () => {
    const svg = await readFile(RUNTIME, 'utf8');

    expect(svg).toMatch(/^<\?xml[^>]*\?>\s*<svg\b/);
    expect(svg).not.toMatch(
      /<script\b|\son[a-z]+\s*=|<foreignObject\b|<image\b|<use\b|<text\b|<a\b/i,
    );
    expect(svg).not.toMatch(/\b(?:xlink:)?href\s*=/i);
    expect(svg).not.toMatch(/url\(|@import|data:/i);
    // The only address in the file is the XML namespace.
    expect([...svg.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0])).toEqual([
      'http://www.w3.org/2000/svg',
    ]);
  });

  // Break caught: a logo whose proportions are not the ones the CSS assumes (it sets the height only), or a viewBox
  // that has been cropped so the descriptor is cut off.
  it('keeps the viewBox of the full horizontal logo', async () => {
    const svg = await readFile(RUNTIME, 'utf8');

    expect(svg).toContain('viewBox="0 0 217.24 69.34"');
  });
});

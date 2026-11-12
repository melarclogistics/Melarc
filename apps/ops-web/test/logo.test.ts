import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const MASTER = resolve(APP_ROOT, '../../design/assets/brand/master/melarc-logo-primary.svg');
const RUNTIME = resolve(APP_ROOT, 'src/assets/brand/melarc-logo-primary.svg');
const README = resolve(APP_ROOT, '../../design/assets/brand/README.md');
// The all-white lockup: as the owner supplied it (two spaces in the name), as it is filed, and as the application serves it.
const SUPPLIED_DARK = resolve(APP_ROOT, '../../design/assets/Transparent White  Logo.svg');
const EXPORT_DARK = resolve(APP_ROOT, '../../design/assets/brand/exports/melarc-logo-dark.svg');
const RUNTIME_DARK = resolve(APP_ROOT, 'src/assets/brand/melarc-logo-dark.svg');

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

/** The proportions of a logo: the width of its viewBox over its height. */
function proportions(svg: string): number {
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (box === null) throw new Error('The logo has no viewBox of the form "0 0 width height".');
  return Number(box[1]) / Number(box[2]);
}

describe('the all-white lockup the Ops Portal draws on a dark ground', () => {
  // Break caught: the runtime copy edited, recoloured or replaced while the approved file stays as it was, or the filed export drifting from
  // the file the Product Owner supplied (BRAND_FOUNDATION 4.7: approved on 5 November 2026 as supplied; 4.3: never redrawn or recoloured).
  it('is the approved export and the supplied file, byte for byte', async () => {
    const [supplied, exported, runtime] = await Promise.all([
      readFile(SUPPLIED_DARK),
      readFile(EXPORT_DARK),
      readFile(RUNTIME_DARK),
    ]);

    expect(exported.length).toBeGreaterThan(1000);
    expect(exported.equals(supplied)).toBe(true);
    expect(runtime.equals(exported)).toBe(true);
  });

  // Break caught: the README's record of the file drifting from the file, so a reader trusts a checksum that no longer describes the artwork.
  it('is the file the brand README records, by its checksum', async () => {
    const [exported, readme] = await Promise.all([readFile(EXPORT_DARK), readFile(README, 'utf8')]);

    expect(readme).toContain(sha256(exported));
  });

  // Break caught: a lockup that can run code or reach out when it is shown, as for the primary logo; the one address is the XML namespace.
  it('is plain shapes: no script, no handler, no reference, no embedded raster and no live text', async () => {
    const svg = await readFile(RUNTIME_DARK, 'utf8');

    expect(svg).toMatch(/^<\?xml[^>]*\?>\s*<svg\b/);
    expect(svg).not.toMatch(
      /<script\b|\son[a-z]+\s*=|<foreignObject\b|<image\b|<use\b|<text\b|<a\b/i,
    );
    expect(svg).not.toMatch(/\b(?:xlink:)?href\s*=/i);
    expect(svg).not.toMatch(/url\(|@import|data:/i);
    expect([...svg.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0])).toEqual([
      'http://www.w3.org/2000/svg',
    ]);
  });

  // Break caught: a lockup that is not all white drawn on the dark ground (the black wordmark of the primary logo is what it replaces, and a
  // red or black part left in it would vanish or clash there), or a different one swapped in under the same name.
  it('is all white: no colour in it but white', async () => {
    const svg = await readFile(RUNTIME_DARK, 'utf8');
    const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) =>
      match[0].toLowerCase(),
    );

    expect(colours.length).toBeGreaterThan(0);
    expect(new Set(colours)).toEqual(new Set(['#fff']));
    expect(svg).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/i);
  });

  // Break caught: a lockup whose proportions are not the primary logo's, which the banner's CSS (it sets the height only) would draw wider or
  // narrower, so that the logo jumps when the theme changes.
  it("has the proportions of the primary logo, so that the banner's height gives the same width", async () => {
    const [primary, dark] = await Promise.all([
      readFile(RUNTIME, 'utf8'),
      readFile(RUNTIME_DARK, 'utf8'),
    ]);

    expect(Math.abs(proportions(dark) - proportions(primary))).toBeLessThan(0.001);
  });
});

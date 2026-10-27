import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const APP_ROOT = resolve(import.meta.dirname, '..');
const SYMBOL = resolve(APP_ROOT, '../../design/assets/brand/exports/melarc-symbol.svg');
const RUNTIME = resolve(APP_ROOT, 'public/favicon.svg');
const PAGE = resolve(APP_ROOT, 'index.html');
const README = resolve(APP_ROOT, '../../design/assets/brand/README.md');
const FOUNDATION = resolve(APP_ROOT, '../../design/BRAND_FOUNDATION.md');
const LOCKUP = resolve(APP_ROOT, 'src/components/brand/BrandLockup.tsx');

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * The browser-tab icon of the Ops Portal (the Product Owner's approval of 25 October 2026): the symbol they supplied, unchanged,
 * used as the favicon and for nothing else (no app icon, no installable icon: BRAND_FOUNDATION section 4.3, DESIGN_SYSTEM section 26.1).
 */
describe('the favicon the Ops Portal serves', () => {
  // Break caught: the runtime copy edited, recoloured, cropped to a square or replaced while the supplied symbol stays as it was (a
  // runtime copy is copied from `exports/` and nobody edits it there; the artwork is never redrawn, traced or recoloured).
  it('is the approved symbol, byte for byte', async () => {
    const [symbol, runtime] = await Promise.all([readFile(SYMBOL), readFile(RUNTIME)]);

    expect(symbol.length).toBeGreaterThan(500);
    expect(runtime.equals(symbol)).toBe(true);
  });

  // Break caught: a favicon in use that the README does not say is approved (the README said "approval not recorded, so no application
  // uses it"), or a checksum that no longer describes the file.
  it('is recorded in the brand README by its checksum, as approved for this use and no other', async () => {
    const [symbol, readme] = await Promise.all([readFile(SYMBOL), readFile(README, 'utf8')]);
    const row = readme.split('\n').find((line) => line.includes('exports/melarc-symbol.svg')) ?? '';

    expect(row).toContain(sha256(symbol));
    expect(row).toMatch(/approved by the Product Owner on 25 October 2026/i);
    expect(row).toMatch(/favicon/i);
    expect(row).toMatch(/no other use|only/i);
    expect(readme).toContain('apps/ops-web/public/favicon.svg');
  });

  // Break caught: the symbol drawn in the page as a mark (the side menu, the split screen's band) while the brand record still says that no other
  // use is approved and nothing says that this use is waiting for the Product Owner. `BrandLockup` is where the symbol is drawn; the day it
  // stops drawing it, this test fails and the record is brought back to the tab icon alone.
  it('is recorded as in provisional use as the in-page mark, for the owner to confirm, while BrandLockup draws it', async () => {
    const [lockup, readme, foundation] = await Promise.all([
      readFile(LOCKUP, 'utf8'),
      readFile(README, 'utf8'),
      readFile(FOUNDATION, 'utf8'),
    ]);
    const row = readme.split('\n').find((line) => line.includes('exports/melarc-symbol.svg')) ?? '';
    const status =
      foundation.split('\n').find((line) => line.startsWith('| Symbol-only production logo')) ?? '';

    expect(lockup).toContain("'/favicon.svg'");
    for (const record of [row, status]) {
      expect(record).toMatch(/BrandLockup/);
      expect(record).toMatch(/owner to confirm/i);
      expect(record).toMatch(/side menu/i);
    }
  });

  // Break caught: the page not saying where its icon is, so that the browser asks for `/favicon.ico` on its own and gets a 404, or an
  // icon named by an address that leaves the origin (`img-src 'self'`).
  it('is the one icon the page declares, from its own origin', async () => {
    const html = await readFile(PAGE, 'utf8');
    const icons = [...html.matchAll(/<link\b[^>]*\brel="(?:shortcut )?icon"[^>]*>/gi)].map(
      (match) => match[0],
    );

    expect(icons).toHaveLength(1);
    expect(icons[0]).toContain('type="image/svg+xml"');
    expect(icons[0]).toContain('href="/favicon.svg"');
    expect(html).not.toMatch(/apple-touch-icon|rel="manifest"|mask-icon/i);
  });

  // Break caught: an icon that can run code or reach out when the browser shows it: a script, a handler, a link, an embedded raster or
  // a reference to another file or address. It is plain shapes (the style block only sets two fills).
  it('is plain shapes: no script, no handler, no reference and no embedded raster', async () => {
    const svg = await readFile(RUNTIME, 'utf8');

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

  // Break caught: the full horizontal logo (viewBox 217.24 by 69.34) or a cropped one used where the symbol alone belongs.
  it('has the viewBox of the symbol alone', async () => {
    const svg = await readFile(RUNTIME, 'utf8');

    expect(svg).toContain('viewBox="0 0 54.44 69.33"');
  });
});

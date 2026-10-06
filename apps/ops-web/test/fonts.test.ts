import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The typeface the Ops Portal ships (design/DESIGN_SYSTEM.md section 5.1): Inter, self-hosted, approved by the Product
 * Owner on 6 October 2026. These checks hold what the section promises: only files the repository records, the licence
 * beside them, and a stylesheet that names nothing outside the app.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const FONT_DIRECTORY = resolve(APP_ROOT, 'src/assets/fonts');
const FONT_STYLES = resolve(APP_ROOT, 'src/styles/fonts.css');

interface Manifest {
  family: string;
  version: string;
  source: string;
  licence: { name: string; file: string };
  files: Record<string, string>;
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(join(FONT_DIRECTORY, 'fonts.json'), 'utf8')) as Manifest;
}

/** Every `@font-face` rule of the stylesheet, as its declarations. */
async function readFontFaces(): Promise<Map<string, string>[]> {
  const css = await readFile(FONT_STYLES, 'utf8');
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map(([, body]) => {
    const declarations = new Map<string, string>();
    for (const [, name, value] of (body ?? '').matchAll(/([a-z-]+)\s*:\s*([^;]+);/g)) {
      declarations.set(name ?? '', (value ?? '').trim());
    }
    return declarations;
  });
}

describe('the self-hosted typeface', () => {
  // Break caught: a font file that is not the one the repository records, replaced or edited without a trace.
  it('ships the files its manifest records, byte for byte, and no other', async () => {
    const manifest = await readManifest();
    const shipped = (await readdir(FONT_DIRECTORY)).filter((name) => name.endsWith('.woff2'));

    expect(manifest.family).toBe('Inter');
    expect(shipped.sort()).toEqual(Object.keys(manifest.files).sort());
    expect(shipped.length).toBeGreaterThan(0);
    for (const [name, sha256] of Object.entries(manifest.files)) {
      const bytes = await readFile(join(FONT_DIRECTORY, name));
      expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha256);
    }
  });

  // Break caught: a typeface shipped without its licence, or with a manifest that does not say where it came from.
  it('records where the files came from and keeps the licence text', async () => {
    const manifest = await readManifest();
    const licence = await readFile(resolve(APP_ROOT, manifest.licence.file), 'utf8');

    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.source).toMatch(/^https:\/\//);
    expect(manifest.licence.name).toBe('SIL Open Font License 1.1');
    expect(licence).toContain('Copyright (c) 2016 The Inter Project Authors');
    expect(licence).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(licence).toContain('PERMISSION AND CONDITIONS');
  });

  // Break caught: a stylesheet that loads a font from another origin, loads a file nobody recorded, leaves text
  // invisible while a file loads, or declares weights the type scale does not use.
  it('declares each recorded file once, from the app itself, with the fallback showing while it loads', async () => {
    const manifest = await readManifest();
    const faces = await readFontFaces();
    const css = await readFile(FONT_STYLES, 'utf8');

    expect(css).not.toMatch(/@import\b|https?:\/\/|\/\//);
    expect(faces).toHaveLength(Object.keys(manifest.files).length);
    const named: string[] = [];
    for (const face of faces) {
      expect(face.get('font-family')?.replaceAll(/['"]/g, '')).toBe('Inter');
      expect(face.get('font-style')).toBe('normal');
      expect(face.get('font-display')).toBe('swap');
      // The type scale uses 400, 500 and 600 only (section 5.2); the variable file is declared for that range.
      expect(face.get('font-weight')).toBe('400 600');
      expect(face.get('unicode-range')).toMatch(/^U\+[0-9A-F]/);
      const source =
        /^url\(['"]?\.\.\/assets\/fonts\/([^'")]+\.woff2)['"]?\)\s*format\(['"]woff2['"]\)$/.exec(
          face.get('src') ?? '',
        );
      expect(source, face.get('src')).not.toBeNull();
      named.push(source?.[1] ?? '');
    }
    expect(named.sort()).toEqual(Object.keys(manifest.files).sort());
  });
});

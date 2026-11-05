import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The typefaces the Ops Portal ships (design/DESIGN_SYSTEM.md section 5.1): Inter for everything people read (approved by the
 * Product Owner on 6 October 2026) and JetBrains Mono for operational codes only (approved on 5 November 2026), both self-hosted. These
 * checks hold what the section promises: only files the repository records, each family's licence beside them, a stylesheet that names
 * nothing outside the app, and the monospace face reached only through its token.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const FONT_DIRECTORY = resolve(APP_ROOT, 'src/assets/fonts');
const FONT_STYLES = resolve(APP_ROOT, 'src/styles/fonts.css');
const SOURCE_DIRECTORY = resolve(APP_ROOT, 'src');

/** What each family is declared for. Inter's range is the type scale's (section 5.2); the monospace face is set only at 500 and 600. */
const DECLARED = {
  Inter: { weights: '400 600', copyright: 'Copyright (c) 2016 The Inter Project Authors' },
  'JetBrains Mono': {
    weights: '500 600',
    copyright: 'Copyright 2020 The JetBrains Mono Project Authors',
  },
} as const;

interface Family {
  family: string;
  version: string;
  source: string;
  licence: { name: string; file: string };
  files: Record<string, string>;
}

interface Manifest {
  families: Family[];
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

/** Every stylesheet under src, as a path relative to src and its text. */
async function readStylesheets(directory = SOURCE_DIRECTORY): Promise<[string, string][]> {
  const found: [string, string][] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await readStylesheets(path)));
    else if (entry.name.endsWith('.css')) {
      found.push([
        relative(SOURCE_DIRECTORY, path).replaceAll('\\', '/'),
        await readFile(path, 'utf8'),
      ]);
    }
  }
  return found;
}

describe('the self-hosted typefaces', () => {
  // Break caught: a family dropped from the record, or a third one shipped that the Product Owner never approved.
  it('records Inter and JetBrains Mono, and no other family', async () => {
    const manifest = await readManifest();
    expect(manifest.families.map((family) => family.family)).toEqual(['Inter', 'JetBrains Mono']);
  });

  // Break caught: a font file that is not the one the repository records, replaced or edited without a trace.
  it('ships the files its manifest records, byte for byte, and no other', async () => {
    const manifest = await readManifest();
    const recorded = manifest.families.flatMap((family) => Object.keys(family.files));
    const shipped = (await readdir(FONT_DIRECTORY)).filter((name) => name.endsWith('.woff2'));

    expect(shipped.sort()).toEqual(recorded.sort());
    expect(shipped.length).toBeGreaterThan(0);
    for (const family of manifest.families) {
      expect(Object.keys(family.files).length, family.family).toBeGreaterThan(0);
      for (const [name, sha256] of Object.entries(family.files)) {
        const bytes = await readFile(join(FONT_DIRECTORY, name));
        expect(createHash('sha256').update(bytes).digest('hex'), name).toBe(sha256);
      }
    }
  });

  // Break caught: a typeface shipped without its licence, or with a manifest that does not say where it came from.
  it('records where each family came from and keeps its licence text', async () => {
    const manifest = await readManifest();
    for (const family of manifest.families) {
      const declared = DECLARED[family.family as keyof typeof DECLARED];
      const licence = await readFile(resolve(APP_ROOT, family.licence.file), 'utf8');

      expect(family.version, family.family).toMatch(/^\d+\.\d+\.\d+$/);
      expect(family.source, family.family).toMatch(/^https:\/\//);
      expect(family.licence.name, family.family).toBe('SIL Open Font License 1.1');
      expect(licence, family.family).toContain(declared.copyright);
      expect(licence, family.family).toContain('SIL OPEN FONT LICENSE Version 1.1');
      // The licence ships as each project wrote it: Inter's says "AND", the official text JetBrains Mono ships says "&".
      expect(licence, family.family).toMatch(/PERMISSION (?:AND|&) CONDITIONS/);
    }
  });

  // Break caught: a stylesheet that loads a font from another origin, loads a file nobody recorded, leaves text invisible while a file
  // loads, declares weights the family is not meant to be set in, or declares a file under the wrong family.
  it('declares each recorded file once, from the app itself, with the fallback showing while it loads', async () => {
    const manifest = await readManifest();
    const faces = await readFontFaces();
    const css = await readFile(FONT_STYLES, 'utf8');

    expect(css).not.toMatch(/@import\b|https?:\/\/|\/\//);
    expect(faces).toHaveLength(
      manifest.families.flatMap((family) => Object.keys(family.files)).length,
    );
    const named: string[] = [];
    for (const face of faces) {
      const familyName = face.get('font-family')?.replaceAll(/['"]/g, '') ?? '';
      const family = manifest.families.find((candidate) => candidate.family === familyName);
      expect(family, `a face declared for ${familyName}`).toBeDefined();
      expect(face.get('font-style')).toBe('normal');
      expect(face.get('font-display')).toBe('swap');
      expect(face.get('font-weight'), familyName).toBe(
        DECLARED[familyName as keyof typeof DECLARED].weights,
      );
      expect(face.get('unicode-range')).toMatch(/^U\+[0-9A-F]/);
      const source =
        /^url\(['"]?\.\.\/assets\/fonts\/([^'")]+\.woff2)['"]?\)\s*format\(['"]woff2['"]\)$/.exec(
          face.get('src') ?? '',
        );
      expect(source, face.get('src')).not.toBeNull();
      const file = source?.[1] ?? '';
      expect(Object.keys(family?.files ?? {}), `${file} is recorded under ${familyName}`).toContain(
        file,
      );
      named.push(file);
    }
    expect(named.sort()).toEqual(
      manifest.families.flatMap((family) => Object.keys(family.files)).sort(),
    );
  });

  // Break caught: a component that names the monospace face itself. The face is for operational codes only, and a component reaches it
  // through `--font-family-mono`, which is where the fallback stack is written once (section 5.1).
  it('reaches the monospace face only through its token', async () => {
    const stylesheets = await readStylesheets();
    expect(stylesheets.length).toBeGreaterThan(10);
    const tokens = stylesheets.find(([path]) => path === 'styles/tokens.css')?.[1] ?? '';
    expect(tokens).toMatch(/--font-family-mono\s*:\s*['"]?JetBrains Mono/);
    const naming = stylesheets
      .filter(([path]) => path !== 'styles/fonts.css' && path !== 'styles/tokens.css')
      .filter(([, text]) => /JetBrains/i.test(text.replace(/\/\*[\s\S]*?\*\//g, '')))
      .map(([path]) => path);
    expect(naming).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/*
 * The primitives colour, space and shadow themselves only through the tokens (DESIGN_SYSTEM section 29). scripts/design-tokens.test.ts holds the
 * stylesheets to that; the primitives are written in class strings, which a stylesheet scan never sees, so this holds them to it: no colour of
 * Tailwind's own palette, no colour written out, no shadow but the one floating shadow, and no token named that nothing defines (CSS gives
 * `var(--typo)` no value and no error, so a mistyped name quietly leaves the browser's default in place).
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const SRC = join(APP_ROOT, 'src');

function filesUnder(directory: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(path, pattern));
    else if (pattern.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path);
  }
  return found;
}

/** Code without its comments: they mention the numbers and the colours they explain. */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** The sources that are written in class strings and that the design system owns: the primitives, and the showcase of them. */
const CLASS_SOURCES = [
  ...filesUnder(join(SRC, 'components/primitives'), /\.tsx?$/),
  join(SRC, 'showcase/PrimitivesShowcase.tsx'),
  join(SRC, 'showcase/DataTableDemo.tsx'),
];
const nameOf = (path: string): string => relative(SRC, path).replaceAll('\\', '/');

/** A colour of Tailwind's own palette, as a utility: `bg-red-500`, `text-white`, `border-black/50`. */
const PALETTE_UTILITY =
  /(?<![\w-])(?:bg|text|border|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|accent|caret|placeholder|shadow)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)(?![\w-])/;

/** A colour written out inside an arbitrary value: `bg-[#fff]`, `text-[rgb(0,0,0)]`, `border-[color-mix(...)]`. */
const WRITTEN_COLOUR =
  /\[(?:[a-z-]+:)?(?:#[0-9a-f]{3,8}\b|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix|light-dark|color)\()/i;

/** A shadow that is not the one floating shadow (`shadow-md` and `shadow-lg` are mapped to it; `shadow-none` is no shadow). */
const OTHER_SHADOW =
  /(?<![\w-])shadow-(?:xs|sm|xl|2xl|inner)(?![\w-])|(?<![\w-])drop-shadow|(?<![\w-])text-shadow/;

const stylesheetText = filesUnder(SRC, /\.css$/)
  .map((path) => readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .join('\n');
const DEFINED = new Set(
  [...stylesheetText.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((match) => match[1] ?? ''),
);
/** What a library sets for itself on its own elements, and so no stylesheet of ours defines: Radix's (`--radix-*`), Tailwind's own, and Sonner's. */
const LIBRARY_VARIABLE = /^--(?:radix-|tw-)/;
const SONNER_VARIABLES = new Set([
  '--normal-bg',
  '--normal-text',
  '--normal-border',
  '--border-radius',
]);

/** The properties a class string defines for its own element: `[--cell-size:...]`. */
const definedInClasses = (code: string): Set<string> =>
  new Set([...code.matchAll(/\[(--[a-z][a-z0-9-]*):/gi)].map((match) => match[1] ?? ''));

describe('the primitives and their showcase draw through the tokens (DESIGN_SYSTEM section 29)', () => {
  it('finds the sources it is meant to scan', () => {
    const names = CLASS_SOURCES.map(nameOf);

    expect(names.length).toBeGreaterThan(24);
    expect(names).toContain('components/primitives/button.tsx');
    expect(names).toContain('showcase/PrimitivesShowcase.tsx');
    expect(DEFINED.has('--color-action-primary')).toBe(true);
  });

  // Break caught: a colour of Tailwind's palette in a class string (`bg-red-500`), which draws a colour that no theme changes and no token owns.
  it('use no colour of the Tailwind palette', () => {
    const found = CLASS_SOURCES.filter((path) => PALETTE_UTILITY.test(codeOf(path))).map(nameOf);

    expect(found).toEqual([]);
  });

  // Break caught: a colour written out in a class string (`bg-[#fff]`), which does the same by another way.
  it('write out no colour', () => {
    const found = CLASS_SOURCES.filter((path) => WRITTEN_COLOUR.test(codeOf(path))).map(nameOf);

    expect(found).toEqual([]);
  });

  // Break caught: a second shadow beside the one the design system has (design system section 8): a card with `shadow-sm`, a drop shadow.
  it('use no shadow but the one floating shadow', () => {
    const found = CLASS_SOURCES.filter((path) => OTHER_SHADOW.test(codeOf(path))).map(nameOf);

    expect(found).toEqual([]);
  });

  // Break caught: a mistyped token in a class string (`bg-(color:--color-status-dangr-background)`), which CSS reads as no value at all.
  it('name no custom property that nothing defines', () => {
    const undefinedNames: string[] = [];
    for (const path of CLASS_SOURCES) {
      const code = codeOf(path);
      const own = definedInClasses(code);
      for (const match of code.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/gi)) {
        const name = match[1] ?? '';
        if (DEFINED.has(name) || own.has(name) || LIBRARY_VARIABLE.test(name)) continue;
        if (nameOf(path) === 'components/primitives/sonner.tsx' && SONNER_VARIABLES.has(name)) {
          continue;
        }
        undefinedNames.push(`${nameOf(path)}: ${name}`);
      }
    }

    expect(undefinedNames).toEqual([]);
  });

  // Break caught: Tailwind's palette left in the theme, so that a utility of it draws a colour silently, and the scans above are the only thing
  // standing between it and the page. The theme clears every colour before it defines the mapped ones.
  it("clears Tailwind's palette from the theme before it maps the tokens", () => {
    const css = readFileSync(join(SRC, 'styles/tailwind.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const clears = css.search(/@theme\s*\{[^}]*--color-\*\s*:\s*initial\s*;[^}]*\}/);
    const maps = css.search(/@theme\s+inline\s*\{/);

    expect(clears).toBeGreaterThanOrEqual(0);
    expect(maps).toBeGreaterThan(clears);
  });

  // Break caught: a scan that reads one way of writing a thing and misses the next, so that the checks above pass because they look in the wrong place.
  it('reads every way of writing a palette colour, a written colour, a second shadow and a custom property', () => {
    for (const code of [
      'bg-red-500',
      'hover:text-slate-900',
      'border-zinc-200/50',
      'text-white',
      'bg-black/80',
      'ring-blue-600',
      'dark:bg-neutral-950',
    ]) {
      expect(PALETTE_UTILITY.test(code), code).toBe(true);
    }
    for (const code of [
      'bg-background',
      'text-(color:--color-text-link)',
      'border-transparent',
      'bg-(color:--color-status-white-background)',
      'text-foreground',
      'ring-ring',
      'shadow-md',
    ]) {
      expect(PALETTE_UTILITY.test(code), code).toBe(false);
    }
    for (const code of [
      'bg-[#fff]',
      'text-[rgb(0,0,0)]',
      'bg-[color:#112233]',
      'border-[color-mix(in_srgb,red,blue)]',
    ]) {
      expect(WRITTEN_COLOUR.test(code), code).toBe(true);
    }
    for (const code of [
      'bg-(color:--color-surface-default)',
      'w-[calc(100%-1rem)]',
      'size-[--cell-size]',
    ]) {
      expect(WRITTEN_COLOUR.test(code), code).toBe(false);
    }
    for (const code of [
      'shadow-sm',
      'shadow-xs',
      'shadow-xl',
      'drop-shadow-lg',
      'drop-shadow',
      'shadow-2xl',
    ]) {
      expect(OTHER_SHADOW.test(code), code).toBe(true);
    }
    for (const code of ['shadow-md', 'shadow-lg', 'shadow-none', 'data-[state=open]:shadow-md']) {
      expect(OTHER_SHADOW.test(code), code).toBe(false);
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI = join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ui');

/**
 * The stylesheets of the components write no type size, line height or animation length of their own (DESIGN_SYSTEM section 5.2, 9 and 10; task R5.2, M13). The number is written once, in
 * `styles/tokens.css`, and a component takes it from there: a size that a component writes is a size that the tokens cannot change, that enlarged text may not enlarge, and that the
 * document does not record. The three that stay are named here, each with its reason; a fourth is a token, or an entry here with a reason the Product Owner can read.
 */
const STAYS: readonly { readonly file: string; readonly property: string; readonly why: string }[] =
  [
    {
      file: 'avatar/avatar.css',
      property: 'font-size',
      why: 'the 11px initials of the 24px tile: a size of the tile, which has no other use and no token (the scale starts at 12px for text, section 5.2)',
    },
    {
      file: 'loading/loading.css',
      property: 'animation',
      why: 'a spinner: its length is its own, and it has its own rule for reduced motion (section 9)',
    },
    {
      file: 'skeleton/skeleton.css',
      property: 'animation',
      why: 'the earlier Skeleton (ACTIVE, section 17) keeps its 1.4 s pulse; the kit’s Skeleton v2 takes --motion-pulse',
    },
  ];

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly property: string;
  readonly value: string;
}

function stylesheets(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Every font size, line height and animation or transition length written as a literal in a stylesheet of `src/components/ui`. */
function literalsIn(file: string, text: string): Literal[] {
  const found: Literal[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\/\*.*?\*\//g, '');
    const size = /(?:^|[\s;{])font-size\s*:\s*([^;]+);/.exec(line);
    if (size?.[1] !== undefined && !/^(var\(|inherit|100%|1em)/.test(size[1].trim())) {
      found.push({ file, line: index + 1, property: 'font-size', value: size[1].trim() });
    }
    const height = /(?:^|[\s;{])line-height\s*:\s*([^;]+);/.exec(line);
    if (height?.[1] !== undefined && !/^(var\(|inherit|normal|1$|1\.\d+$)/.test(height[1].trim())) {
      found.push({ file, line: index + 1, property: 'line-height', value: height[1].trim() });
    }
    const moving =
      /(?:^|[\s;{])(animation(?:-duration)?|transition(?:-duration)?)\s*:\s*([^;]+);/.exec(line);
    if (moving?.[1] !== undefined && moving[2] !== undefined) {
      const withoutVariables = moving[2].replace(/var\([^)]*\)/g, '');
      if (/\b\d*\.?\d+m?s\b/.test(withoutVariables)) {
        found.push({ file, line: index + 1, property: moving[1], value: moving[2].trim() });
      }
    }
  });
  return found;
}

describe('the sizes and lengths of the kit’s stylesheets (task R5.2, M13)', () => {
  const all = stylesheets(UI).flatMap((path) =>
    literalsIn(relative(UI, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')),
  );

  // Break caught: a component writing 1.375rem, a 28px line or a 1.6 s pulse itself, so that the number lives in two places and the token file stops being the one source.
  it('write none but the three named ones', () => {
    const unnamed = all.filter(
      (found) =>
        !STAYS.some((stays) => stays.file === found.file && stays.property === found.property),
    );

    expect(unnamed).toEqual([]);
  });

  // Break caught: an entry kept after its literal went (a list that only grows), or a reason left out.
  it('names nothing that is no longer written', () => {
    for (const stays of STAYS) {
      expect(
        all.some((found) => found.file === stays.file && found.property === stays.property),
        `${stays.file} no longer writes a ${stays.property}`,
      ).toBe(true);
      expect(stays.why.length).toBeGreaterThan(20);
    }
    expect(STAYS).toHaveLength(3);
  });

  // The scan proved on text it must find: each kind of literal, and each form it must leave alone.
  it('finds a size, a line height and a length, and leaves a token, an inherited size and a unitless line height alone', () => {
    const css = [
      '.a { font-size: 1.375rem; }',
      '.b { line-height: 1.75rem; }',
      '.c { animation: pulse 1.6s ease-in-out infinite; }',
      '.d { transition: opacity 200ms; }',
      '.e { font-size: var(--text-body-md-size); line-height: var(--text-body-md-line-height); }',
      '.f { font-size: inherit; line-height: 1; transition: opacity var(--motion-fast) ease; }',
      '.g { animation: pulse var(--motion-pulse) ease-in-out infinite; }',
      '/* font-size: 2rem; */',
    ].join('\n');

    expect(literalsIn('x.css', css).map((found) => [found.property, found.value])).toEqual([
      ['font-size', '1.375rem'],
      ['line-height', '1.75rem'],
      ['animation', 'pulse 1.6s ease-in-out infinite'],
      ['transition', 'opacity 200ms'],
    ]);
  });

  // Break caught: the toast written with its own offsets again, as strings of rem that no token owns.
  it('leaves the toast’s offsets to the spacing tokens', () => {
    const toast = readFileSync(join(UI, 'toast', 'Toast.tsx'), 'utf8');

    expect(toast).not.toMatch(/(?:offset|mobileOffset)\s*=\s*["'][\d.]+(?:rem|px)["']/);
    expect(toast).toContain('offset="var(--space-6)"');
    // The phone's bottom offset is the token plus the clearance a bar that sticks to the bottom publishes (task R5.2, M11); its sides are the token alone.
    expect(toast).toContain("bottom: 'calc(var(--space-4) + var(--ui-toast-clearance, 0px))'");
    expect(toast).toContain("left: 'var(--space-4)'");
    expect(toast).toContain("right: 'var(--space-4)'");
  });
});

/**
 * A minimum width in rem that a screen can be narrower than, once the text is enlarged (a rem is 32px at 200%: `14rem` is 448px, wider than a 320px phone, and a minimum wins
 * over a maximum). It is bounded by the screen where it is written, `min(14rem, calc(100vw - 1rem))`, unless the box is one that scrolls and takes focus (task R5.2, M9).
 */
const SCROLLS_INSIDE: readonly string[] = [
  // The table shell's table is inside its named, focusable scroller (COMPONENT_PATTERNS section 19).
  'table/table.css',
];

function wideMinimums(file: string, text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/\/\*.*?\*\//g, '');
    const match = /(?:^|[\s;{])min-width\s*:\s*([\d.]+)rem\s*;/.exec(line);
    if (match?.[1] !== undefined && Number(match[1]) >= 10) {
      found.push(`${file}:${String(index + 1)} min-width: ${match[1]}rem`);
    }
  });
  return found;
}

describe('the minimum widths of the kit’s stylesheets (task R5.2, M9)', () => {
  // Break caught: a menu, a popover or a panel with a minimum width in rem alone, which is wider than the screen when the text is at 200% (found in the action menu and the three
  // menus of the top bar, whose boxes were 448px to 512px on a 320px screen).
  it('bound every wide one by the screen, except in a box that scrolls', () => {
    const unbounded = stylesheets(UI)
      .map(
        (path) => [relative(UI, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')] as const,
      )
      .filter(([file]) => !SCROLLS_INSIDE.includes(file))
      .flatMap(([file, text]) => wideMinimums(file, text));

    expect(unbounded).toEqual([]);
  });

  // The scan proved on text it must find and text it must leave alone.
  it('finds a bare rem minimum and leaves a bounded one, a small one and a token alone', () => {
    const css = [
      '.a { min-width: 14rem; }',
      '.b { min-width: min(14rem, calc(100vw - 1rem)); }',
      '.c { min-width: 1.5rem; }',
      '.d { min-width: var(--control-height-sm); }',
      '/* min-width: 20rem; */',
    ].join('\n');

    expect(wideMinimums('x.css', css)).toEqual(['x.css:1 min-width: 14rem']);
  });
});

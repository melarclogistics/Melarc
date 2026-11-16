import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { after, ruleOf, rulesOf } from './support/css-rule';

const ROOT = resolve(import.meta.dirname, '..');
const GRID = readFileSync(
  join(ROOT, 'src', 'components', 'ui', 'photo-grid', 'photo-grid.css'),
  'utf8',
);
const PICTURE = readFileSync(
  join(ROOT, 'src', 'app', 'pages', 'evidence', 'photo-picture.css'),
  'utf8',
);
const TOKENS = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8');

/** A length of tokens.css written in rem (a spacing or a control height), as a number of rem. */
function rem(token: string): number {
  const match = new RegExp(`${token}:\\s*([\\d.]+)rem;`).exec(TOKENS);
  if (match?.[1] === undefined) throw new Error(`${token} is not a rem length in tokens.css`);
  return Number(match[1]);
}

/**
 * The look of the photo grid (COMPONENT_PATTERNS, *PhotoGrid*; the Product Owner's decisions of 15 November 2026): tiles of one shape whatever the picture is, three to a row on a 390 px phone, a
 * target of the hub floor's 56 px, a state told in a strip of words that is readable on any picture, and a look that survives forced colours and reduced motion. jsdom sees the class and not the pixels,
 * so the sheet is read here and the pixels are measured in the showcase's browser spec.
 */
describe('the photo grid’s stylesheet', () => {
  const tile = ruleOf(GRID, '.ui-photo-tile');
  const grid = ruleOf(GRID, '.ui-photo-grid');

  // Break caught: a tile written as a literal height, or one whose minimum is the medium control's.
  it('makes every tile a target at least the hub floor’s 56 px on a side, by the token', () => {
    expect(tile).toBeDefined();
    expect(tile).toMatch(/min-height:\s*var\(--control-height-lg\)\s*;/);
    expect(tile).toMatch(/min-width:\s*var\(--control-height-lg\)\s*;/);
    expect(tile).not.toMatch(/min-(?:height|width):[^;]*\d+px/);
  });

  // Break caught: a tile whose box follows its picture, so that the grid jumps while pictures arrive, fail or differ in shape.
  it('gives every tile one shape, whatever the picture is', () => {
    const picture = ruleOf(GRID, '.ui-photo-tile__picture');

    expect(tile).toMatch(/aspect-ratio:\s*1\s*\/\s*1\s*;/);
    expect(tile).toMatch(/overflow:\s*hidden\s*;/);
    expect(picture).toMatch(/position:\s*absolute\s*;/);
    expect(picture).toMatch(/inset:\s*0\s*;/);
  });

  // Break caught: a column minimum so wide that a phone gets two tiles to a row, one so narrow that a tile is under the floor, or a grid that is not filled by as many columns as fit.
  it('puts three tiles to a row on a 390 px phone, never a tile under the floor, and as many as fit on a desk', () => {
    expect(grid).toMatch(/display:\s*grid\s*;/);
    expect(grid).toMatch(/grid-template-columns:\s*repeat\(auto-fill,/);
    expect(grid).toMatch(/gap:\s*var\(--space-3\)\s*;/);
    const minimum = /minmax\(min\(100%,\s*([\d.]+)rem\),\s*1fr\)/.exec(grid ?? '');
    expect(minimum?.[1]).toBeDefined();
    const column = Number(minimum?.[1]);
    const gap = rem('--space-3');

    // A 390 px phone less 16 px of the page on each side and 16 px of a panel on each side leaves 326 px: three tiles fit in it...
    expect(3 * column + 2 * gap).toBeLessThanOrEqual((390 - 64) / 16);
    // ...and four do not fit in the 358 px that the page's own gutter leaves, so that it is three and not four.
    expect(4 * column + 3 * gap).toBeGreaterThan((390 - 32) / 16);
    expect(column).toBeGreaterThanOrEqual(rem('--control-height-lg'));
  });

  // Break caught: a state told in a colour that the status tokens do not own, or drawn without a background of its own, so that its words cannot be read on a picture.
  it.each([
    ['.ui-photo-tile--selected .ui-photo-tile__mark', 'success'],
    ['.ui-photo-tile--marked .ui-photo-tile__mark', 'warning'],
    ['.ui-photo-tile--dimmed .ui-photo-tile__mark', 'neutral'],
  ])(
    'draws the strip of `%s` in the %s status tokens, on a background of its own',
    (selector, status) => {
      const strip = ruleOf(GRID, selector);

      expect(strip).toMatch(
        new RegExp(`background:\\s*var\\(--color-status-${status}-background\\)\\s*;`),
      );
      expect(strip).toMatch(
        new RegExp(`color:\\s*var\\(--color-status-${status}-foreground\\)\\s*;`),
      );
    },
  );

  // Break caught: a selected or a marked tile that is told by its strip alone (the border is the second sign, in the same tokens), or by a border in another colour.
  it('draws a selected and a marked tile’s border in the colour of its strip', () => {
    expect(ruleOf(GRID, '.ui-photo-tile--selected')).toMatch(
      /border-color:\s*var\(--color-status-success-foreground\)\s*;/,
    );
    expect(ruleOf(GRID, '.ui-photo-tile--marked')).toMatch(
      /border-color:\s*var\(--color-status-warning-foreground\)\s*;/,
    );
  });

  // Break caught: the whole tile faded for a dimmed photo, which fades the words that say why and fails their contrast; only the picture is dimmed.
  it('dims the picture of a dimmed tile and never its words or the tile', () => {
    expect(ruleOf(GRID, '.ui-photo-tile--dimmed .ui-photo-tile__picture')).toMatch(
      /opacity:\s*0?\.\d+\s*;/,
    );
    expect(ruleOf(GRID, '.ui-photo-tile--dimmed') ?? '').not.toMatch(/opacity/);
    expect(ruleOf(GRID, '.ui-photo-tile__mark') ?? '').not.toMatch(/opacity/);
  });

  // Break caught: a badge with no surface of its own, which cannot be read on a bright picture.
  it('puts the badge on a surface of its own', () => {
    const badge = ruleOf(GRID, '.ui-photo-tile__badge');

    expect(badge).toMatch(/background:\s*var\(--color-surface-default\)\s*;/);
    expect(badge).toMatch(/color:\s*var\(--color-text-primary\)\s*;/);
  });

  // Break caught: a tile that forced colours leave without a border (the system drops the fills) or a selected tile that looks like the others.
  it('draws a border on every tile when colours are forced, the selected one in the system’s highlight', () => {
    const forced = after(GRID, '@media (forced-colors: active)');

    expect(forced).toBeDefined();
    expect(ruleOf(forced ?? '', '.ui-photo-tile')).toMatch(/border-color:\s*ButtonText\s*;/);
    expect(ruleOf(forced ?? '', '.ui-photo-tile--selected')).toMatch(
      /border-color:\s*Highlight\s*;/,
    );
    expect(ruleOf(forced ?? '', '.ui-photo-tile:disabled')).toMatch(/border-color:\s*GrayText\s*;/);
    expect(ruleOf(forced ?? '', '.ui-photo-tile__mark')).toMatch(
      /border-top:\s*1px solid CanvasText\s*;/,
    );
  });

  // Break caught: a border that still fades when the person asked for less motion.
  it('stops the tile’s transition for a person who asks for less motion', () => {
    const reduced = after(GRID, '@media (prefers-reduced-motion: reduce)');

    expect(reduced).toBeDefined();
    expect(ruleOf(reduced ?? '', '.ui-photo-tile')).toMatch(/transition:\s*none\s*;/);
  });
});

/**
 * The look of the picture of a stored photo (`PhotoPicture`): in a tile it fills the box the tile makes and is cropped to it, never stretched; in the viewer it is drawn whole within its window, never wider
 * than the box or taller than the screen; a picture that is not drawn yet, or cannot be, is an icon (and short words) centred in the box.
 */
describe('the stylesheet of the picture of a stored photo', () => {
  // Break caught: a tile picture that is stretched out of its shape (a photo of a parcel made to look wide), or one that does not fill its box.
  it('fills the box of a tile and crops the photo to it, never stretching it', () => {
    const tile = ruleOf(PICTURE, '.photo-picture--tile');

    expect(tile).toMatch(/width:\s*100%\s*;/);
    expect(tile).toMatch(/height:\s*100%\s*;/);
    expect(tile).toMatch(/object-fit:\s*cover\s*;/);
  });

  // Break caught: a photo in the viewer cropped to its window (a part of the evidence cut off), or one taller than the screen.
  it('draws the photo of the viewer whole, within its window and the height of the screen', () => {
    const full = ruleOf(PICTURE, '.photo-picture--full');

    expect(full).toMatch(/object-fit:\s*contain\s*;/);
    expect(full).toMatch(/max-inline-size:\s*100%\s*;/);
    expect(full).toMatch(/max-block-size:\s*70vh\s*;/);
  });

  // Break caught: a placeholder or a line of words that sits at a corner of the tile, or in a colour the tokens do not own.
  it('centres what stands for a photo that is not drawn, in the tokens’ colours', () => {
    const placeholder = ruleOf(PICTURE, '.photo-picture__wait');
    const unavailable = rulesOf(PICTURE, '.photo-picture__unavailable').join(' ');

    expect(placeholder).toMatch(/justify-content:\s*center\s*;/);
    expect(placeholder).toMatch(/align-items:\s*center\s*;/);
    expect(unavailable).toMatch(/justify-content:\s*center\s*;/);
    expect(unavailable).toMatch(/align-items:\s*center\s*;/);
    expect(placeholder).toMatch(/color:\s*var\(--color-text-muted\)\s*;/);
    expect(unavailable).toMatch(/color:\s*var\(--color-text-secondary\)\s*;/);
    expect(unavailable).toMatch(/font-size:\s*var\(--text-label-sm-size\)\s*;/);
  });
});

describe('the reader of a stylesheet’s blocks', () => {
  // The reader proved on text it must find and text it must leave alone.
  it('finds the rules after a marker, and not a marker that is in a comment or is not there', () => {
    const text =
      '.a { x: 1; } /* @media (forced-colors: active) { .a { z: 3; } } */ @media (forced-colors: active) { .a { y: 2; } }';

    expect(ruleOf(after(text, '@media (forced-colors: active)') ?? '', '.a')).toContain('y: 2');
    expect(ruleOf(text, '.a')).toContain('x: 1');
    expect(after('.a { x: 1; }', '@media (forced-colors: active)')).toBeUndefined();
  });

  it('finds every rule of a selector, the shared one and its own, in the order written', () => {
    const text = '.a, .b { x: 1; } .b { y: 2; } /* .b { z: 3; } */ .c { w: 4; }';

    expect(rulesOf(text, '.b')).toEqual([' x: 1; ', ' y: 2; ']);
    expect(rulesOf(text, '.c')).toEqual([' w: 4; ']);
    expect(rulesOf(text, '.d')).toEqual([]);
  });
});

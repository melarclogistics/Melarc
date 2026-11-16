import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ruleOf } from './support/css-rule';

const ROOT = resolve(import.meta.dirname, '..');
const SHEET = readFileSync(
  join(ROOT, 'src', 'app', 'pages', 'receiving', 'receiving-pages.css'),
  'utf8',
);

/**
 * The look of the receiving screens of a run (S1.35c; the hub floor, DESIGN_SYSTEM sections 11 and 12): a tablet in a hand, at a table, with a rider waiting. jsdom sees the class and not the pixel, so the
 * sheet is read here and the pixels are measured in the receiving spec's browser. What is held: **the action bar of the vendor in work is at the foot of the visible screen** (sticky, by the modifier
 * `receiving-actions--sticky`, and by no other: a bar kept there for every vendor was drawn over the name of its own card), **above the on-screen keyboard** (`--keyboard-inset`, written from the visual
 * viewport) and **clear of the home indicator** (the safe area), and every size, space and colour of the sheet is a token.
 */
describe('the receiving screens’ stylesheet', () => {
  const plain = ruleOf(SHEET, '.receiving-actions');
  const bar = ruleOf(SHEET, '.receiving-actions--sticky');

  // Break caught (the pictures' review, defect 3): the plain bar of every vendor kept at the foot of the screen, which drew the bar of a vendor whose card began there over its own card's name.
  it('keeps no bar at the foot of the screen but the vendor in work’s', () => {
    expect(plain).toBeDefined();
    expect(plain).not.toMatch(/position:\s*(?:sticky|fixed)\s*;/);
    expect(plain).not.toMatch(/inset-block-end:/);
  });

  // Break caught (the second review, defect 3 again): the photos and the bars without a block of their own, so that the bar is kept within the whole card and is drawn over the card's name; or that block
  // without the card's gap, so that the bar stands against the photos.
  it('gives the photos and the bars a block of their own, with the card’s gap', () => {
    const work = ruleOf(SHEET, '.receiving-vendor__work');

    expect(work).toBeDefined();
    expect(work).toMatch(/display:\s*grid\s*;/);
    expect(work).toMatch(/gap:\s*var\(--space-3\)\s*;/);
    // It is not itself kept anywhere: the bar in it is.
    expect(work).not.toMatch(/position:\s*(?:sticky|fixed)\s*;/);
  });

  // Break caught: a bar that scrolls away with the photos, so that "All 12 here" is a scroll back from the thumb; or one that is fixed over the page and hides the last photos.
  it('keeps the action bar of the vendor in work at the foot of the visible screen without covering what is above it', () => {
    expect(bar).toBeDefined();
    expect(bar).toMatch(/position:\s*sticky\s*;/);
    expect(bar).toMatch(/inset-block-end:/);
    expect(bar).not.toMatch(/position:\s*fixed\s*;/);
  });

  // Break caught: a bar that stays behind the on-screen keyboard at 768 px, so that the officer closes the keyboard to reach the button.
  it('lifts the bar above the on-screen keyboard by the inset the page writes, and is whole without it', () => {
    expect(bar).toMatch(/inset-block-end:\s*var\(--keyboard-inset,\s*0px\)\s*;/);
  });

  // Break caught: a bar under the home indicator of a tablet, where a press is a swipe up.
  it('keeps the bar clear of the home indicator', () => {
    expect(bar).toMatch(
      /padding-block-end:\s*calc\(var\(--space-3\)\s*\+\s*env\(safe-area-inset-bottom,\s*0px\)\)\s*;/,
    );
  });

  // Break caught: a bar over the buttons it holds (a background that is transparent over the photos).
  it('draws the bar on a surface of its own, above the photos it overlaps', () => {
    expect(bar).toMatch(/background:\s*var\(--color-surface-default\)\s*;/);
    expect(bar).toMatch(/z-index:\s*1\s*;/);
  });

  // Break caught: buttons of the bar side by side at a width that makes each narrower than its words, or buttons that do not wrap on a phone.
  it('lets the buttons of the bar wrap, each as wide as its words need', () => {
    expect(plain).toMatch(/display:\s*flex\s*;/);
    expect(plain).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(ruleOf(SHEET, '.receiving-actions > *')).toMatch(/flex:\s*1\s+1\s+14rem\s*;/);
  });

  // Break caught (the second review of the pictures, steps 2, 4, 5 and 13): the three buttons of the bar one under the other on a phone, a quarter of the screen: the first takes the row, and the others share
  // the next while they fit (and stand one under the other where they do not).
  it('gives the first button of the bar the row on a phone, and lets the others share the next while they fit', () => {
    const phone = /@media \(max-width: 30rem\) \{([\s\S]*?)\n\}/.exec(SHEET)?.[1] ?? '';

    expect(ruleOf(phone, '.receiving-actions > :first-child')).toMatch(/flex:\s*1\s+1\s+100%\s*;/);
    expect(ruleOf(phone, '.receiving-actions > :not(:first-child)')).toMatch(
      /flex:\s*1\s+1\s+9rem\s*;/,
    );
  });

  // Break caught: a section whose long vendor name or sentence runs past the box on a 320 px phone.
  it('lets a name or a sentence of a vendor break, so that nothing runs past its box', () => {
    expect(ruleOf(SHEET, '.receiving-vendor p')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
    expect(ruleOf(SHEET, '.receiving-vendor__head h2')).toMatch(/overflow-wrap:\s*anywhere\s*;/);
  });

  // Break caught (DESIGN_SYSTEM section 5 and 9): a size, a colour or a space written as a number, which the tokens cannot change and enlarged text may not enlarge.
  it('writes no colour, no length and no type size of its own: tokens only, and the zero of a safe area', () => {
    const clean = SHEET.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(clean).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(clean).not.toMatch(/\b(?:rgb|hsl|oklch)a?\(/i);
    expect(clean).not.toMatch(/font-size:\s*[\d.]+(?:px|rem|em)/);
    const lengths = [...clean.matchAll(/(?<![\w-])(\d+(?:\.\d+)?)(px|rem)\b/g)].map(
      (match) => `${match[1] ?? ''}${match[2] ?? ''}`,
    );
    // The outline of a focused notice (2px, a line and not a size of the page), the width of a button of the bar (14rem, and 9rem on a phone, where the bar starts to share its rows at 30rem) and the zero
    // of the safe area.
    expect(new Set(lengths)).toEqual(new Set(['2px', '1px', '14rem', '9rem', '30rem', '0px']));
  });
});

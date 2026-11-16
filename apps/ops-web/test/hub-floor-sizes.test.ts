import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ruleOf } from './support/css-rule';

const UI = join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ui');
const TOKENS = join(resolve(import.meta.dirname, '..'), 'src', 'styles', 'tokens.css');

const css = (file: string): string => readFileSync(join(UI, file), 'utf8');

/**
 * The hub floor's 56 px (DESIGN_SYSTEM sections 11 and 12, the Product Owner's decision of 5 November 2026: hub-floor tasks are tablet-first at 768 px, with 56 px touch rows and controls). The size is
 * the token `--control-height-lg` (3.5rem) and the row `--density-row-touch`, and a component takes it from there: a literal 56px written in a stylesheet would be a second place for the number, and the
 * jsdom tests of the components can see the class and not the pixels.
 */
describe('the hub floor’s 56 px, held to the tokens', () => {
  // Break caught: the token redefined (a floor that is no longer 56 px at the root size), or the two named alike drifting apart.
  it('is one token, 3.5rem, and the touch row is the same value', () => {
    const tokens = readFileSync(TOKENS, 'utf8');

    expect(tokens).toMatch(/--control-height-lg:\s*3\.5rem;/);
    expect(tokens).toMatch(/--density-row-touch:\s*var\(--control-height-lg\);/);
  });

  // Break caught: a floor button written as a literal height, or a minimum that is the medium one's.
  it('makes the floor button at least the large control, by the token', () => {
    const rule = ruleOf(css('button/button.css'), '.ui-button--lg');

    expect(rule).toBeDefined();
    expect(rule).toMatch(/min-height:\s*var\(--control-height-lg\)\s*;/);
    expect(rule).not.toMatch(/\d+px/);
  });

  // Break caught: a floor radio whose target is the 20 px circle and not the row, or a row below the touch height.
  it('makes each floor choice of a radio group a row at least the touch row high', () => {
    const rule = ruleOf(css('radio/radio.css'), '.ui-radio-group--lg .ui-radio__label');

    expect(rule).toBeDefined();
    expect(rule).toMatch(/min-height:\s*var\(--density-row-touch\)\s*;/);
    expect(rule).toMatch(/align-items:\s*center\s*;/);
    expect(rule).not.toMatch(/\d+px/);
  });

  // Break caught: a floor checkbox whose label is not as high as the touch row.
  it('makes the label of a floor checkbox at least the touch row high', () => {
    const rule = ruleOf(css('checkbox/checkbox.css'), '.ui-checkbox--lg .ui-checkbox__label');

    expect(rule).toBeDefined();
    expect(rule).toMatch(/min-height:\s*var\(--density-row-touch\)\s*;/);
    expect(rule).not.toMatch(/\d+px/);
  });

  // Break caught (the pictures' review, defect 7): a floor scope that leaves the views, the lookup, the Filter button, the way up the trail or Refresh at their working height, or that writes the number as a
  // literal (a second place for it).
  it('raises the parts of a floor page that the page does not draw itself to the touch height, by the token', () => {
    const floor = css('hub-floor/hub-floor.css');

    for (const selector of [
      '.ui-hub-floor .ui-view-tabs__tab',
      '.ui-hub-floor .ui-input',
      '.ui-hub-floor .ui-filter-bar__search .ui-filter-bar__search-field',
      '.ui-hub-floor .ui-filter-bar__search button',
      '.ui-hub-floor .ui-filter-bar .ui-filter-bar__add',
      '.ui-hub-floor .ui-page-head__trail a',
      '.ui-hub-floor .ui-page-head__freshness .ui-page-head__refresh',
      '.ui-hub-floor .ui-data-table__card-title a',
    ]) {
      const rule = ruleOf(floor, selector);
      expect(rule, selector).toBeDefined();
      expect(rule, selector).toMatch(/min-height:\s*var\(--control-height-lg\)\s*;/);
      // No height is written as a literal (the 1px of a view's baseline is a line, not a height).
      expect(rule, selector).not.toMatch(/(?:min-|max-)?height:\s*[\d.]+(?:px|rem)/);
    }
    // The code of a row is as tall as its row, which is its own token (56px at the touch density).
    expect(ruleOf(floor, '.ui-hub-floor .ui-data-table__title a')).toMatch(
      /min-height:\s*calc\(var\(--ui-data-table-row\) - 1px\)\s*;/,
    );
  });

  // Break caught: a row of views that scrolls under a fade where the floor wants every view in sight, so that a view behind the edge is found by no thumb.
  it('wraps the views of a floor page and does not scroll them', () => {
    const floor = css('hub-floor/hub-floor.css');

    expect(ruleOf(floor, '.ui-hub-floor .ui-view-tabs__list')).toMatch(/flex-wrap:\s*wrap\s*;/);
    expect(ruleOf(floor, '.ui-hub-floor .ui-view-tabs__scroll')).toMatch(
      /overflow-x:\s*visible\s*;/,
    );
  });

  // Break caught (the second review of the pictures, new defect 4): wrapped views with a gap between the rows and a view alone on its row, so that the underline of the current view reads as the line between
  // the rows; every view carries its own baseline (the line is a token's colour, 1px) and takes its share of its row.
  it('gives each wrapped view its own baseline and its share of its row, with no gap between the rows', () => {
    const floor = css('hub-floor/hub-floor.css');
    const tab = ruleOf(floor, '.ui-hub-floor .ui-view-tabs__tab');

    expect(ruleOf(floor, '.ui-hub-floor .ui-view-tabs__list')).toMatch(/gap:\s*0\s*;/);
    expect(tab).toMatch(/flex:\s*1\s+1\s+auto\s*;/);
    expect(tab).toMatch(
      /background-image:\s*linear-gradient\(var\(--color-border-default\),\s*var\(--color-border-default\)\)\s*;/,
    );
    expect(tab).toMatch(/background-size:\s*100%\s+1px\s*;/);
    expect(tab).toMatch(/background-origin:\s*border-box\s*;/);
  });

  // Break caught (the second review of the pictures, new defect 5): the help line of a choice back to floating midway between its own choice and the next, or a dead strip that a press on it does not reach.
  it('keeps the help line of a choice under its own choice, inside its reach, and the choices further apart than a choice and its help', () => {
    const floor = css('hub-floor/hub-floor.css');
    const label = ruleOf(
      floor,
      '.ui-hub-floor .ui-radio-group--lg .ui-radio:has(.ui-radio__help) .ui-radio__label',
    );

    expect(label).toMatch(/grid-row:\s*1\s*\/\s*span\s*2\s*;/);
    expect(label).toMatch(/align-items:\s*flex-start\s*;/);
    expect(ruleOf(floor, '.ui-hub-floor .ui-radio-group--lg .ui-radio__help')).toMatch(
      /pointer-events:\s*none\s*;/,
    );
    expect(ruleOf(floor, '.ui-hub-floor .ui-radio-group--lg .ui-radio-group__choices')).toMatch(
      /gap:\s*var\(--space-4\)\s*;/,
    );
  });

  // The reader proved on text it must find and text it must leave alone.
  it('finds a rule by one of its selectors and leaves the rule of another alone', () => {
    const text = '/* .a { x: 1; } */ .b, .c { min-height: 1rem; } .d { min-height: 2rem; }';

    expect(ruleOf(text, '.c')).toContain('1rem');
    expect(ruleOf(text, '.d')).toContain('2rem');
    expect(ruleOf(text, '.a')).toBeUndefined();
  });
});

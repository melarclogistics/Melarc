import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const UI = join(resolve(import.meta.dirname, '..'), 'src', 'components', 'ui');
const TOKENS = join(resolve(import.meta.dirname, '..'), 'src', 'styles', 'tokens.css');

const css = (file: string): string => readFileSync(join(UI, file), 'utf8');

/**
 * The body of the first rule whose selector list contains `selector` exactly (a rule written as `a, b { … }` counts for both), with its comments taken out. The stylesheets of the kit are flat
 * (no nesting), so a rule ends at the first closing brace.
 */
function ruleOf(text: string, selector: string): string | undefined {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (match[1] ?? '').split(',').map((part) => part.trim());
    if (selectors.includes(selector)) return match[2] ?? '';
  }
  return undefined;
}

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

  // The reader proved on text it must find and text it must leave alone.
  it('finds a rule by one of its selectors and leaves the rule of another alone', () => {
    const text = '/* .a { x: 1; } */ .b, .c { min-height: 1rem; } .d { min-height: 2rem; }';

    expect(ruleOf(text, '.c')).toContain('1rem');
    expect(ruleOf(text, '.d')).toContain('2rem');
    expect(ruleOf(text, '.a')).toBeUndefined();
  });
});

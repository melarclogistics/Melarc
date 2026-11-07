import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bezierOf,
  millisecondsOf,
  MOTION_FALLBACK,
} from '../src/components/ui/motion/motion-tokens';

const TOKENS = readFileSync(
  join(resolve(import.meta.dirname, '..'), 'src/styles/tokens.css'),
  'utf8',
);

/** The value `tokens.css` gives a custom property in the light theme (the `:root` block), as written. */
function tokenValue(name: string): string {
  const match = new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(TOKENS);
  if (match?.[1] === undefined) throw new Error(`tokens.css has no ${name}`);
  return match[1].trim();
}

describe('the motion tokens as Motion takes them (DESIGN_SYSTEM section 9)', () => {
  // Break caught: the numbers the code falls back on drifting from the token file, so that a unit test and the browser animate for different times.
  it('are the ones tokens.css holds', () => {
    for (const name of ['fast', 'normal', 'slow', 'highlight'] as const) {
      expect(millisecondsOf(tokenValue(`--motion-${name}`)), name).toBe(
        MOTION_FALLBACK.duration[name],
      );
    }
    for (const name of ['enter', 'exit'] as const) {
      expect(bezierOf(tokenValue(`--motion-ease-${name}`)), name).toEqual(
        MOTION_FALLBACK.ease[name],
      );
    }
  });

  // Break caught: under reduced motion the token file giving a duration back, so that the JavaScript that reads it (and the stylesheet) would still move.
  it('are all zero under prefers-reduced-motion, in the token file', () => {
    const reduced =
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(TOKENS)?.[1] ??
      '';

    for (const name of ['fast', 'normal', 'slow', 'highlight']) {
      expect(reduced, name).toMatch(new RegExp(`--motion-${name}\\s*:\\s*0ms`));
    }
  });

  // Break caught: a time read in the wrong unit (0.28s taken for 0.28 ms) or text that is not a time taken for one (NaN or 0 into an animation).
  it('reads a time in either unit, and refuses what is not one', () => {
    expect(millisecondsOf('280ms')).toBe(280);
    expect(millisecondsOf('0.28s')).toBe(280);
    expect(millisecondsOf('0ms')).toBe(0);
    expect(millisecondsOf('0')).toBe(0);
    expect(millisecondsOf(' 120ms ')).toBe(120);
    for (const text of ['', 'fast', '1m', 'calc(1s + 1ms)', '-5ms']) {
      expect(millisecondsOf(text), text).toBeUndefined();
    }
  });

  // Break caught: an easing read with a number lost (three of four) or text that is not one taken for a curve, which Motion would draw as a jump.
  it('reads a cubic-bezier, and refuses what is not one', () => {
    expect(bezierOf('cubic-bezier(0.2, 0.8, 0.2, 1)')).toEqual([0.2, 0.8, 0.2, 1]);
    expect(bezierOf('cubic-bezier(0.4,0,1,1)')).toEqual([0.4, 0, 1, 1]);
    for (const text of ['', 'ease', 'cubic-bezier(1, 2, 3)', 'cubic-bezier(a, b, c, d)']) {
      expect(bezierOf(text), text).toBeUndefined();
    }
  });
});

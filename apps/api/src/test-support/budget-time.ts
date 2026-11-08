import type { SourceFile } from './platform-boundary.js';

/**
 * Checks of source text that keep the execution budget's time honest (plan task S0.6; section 3, "Time"). Each takes the source
 * files as `{ path, text }` with paths relative to `src/`, and reports one line per breach. They read text, so they hold against
 * code that is written plainly and say so.
 */

/** Where elapsed time for a budget, a deadline or a wait is measured: through the injected `Clock`, and nowhere else. */
const MEASURES_ELAPSED_TIME = ['platform/execution/', 'platform/database/'];

/**
 * `new Date()` with no argument reads the machine's clock; `new Date(value)` builds a date from a value it was given (the database's
 * text, a stored instant) and reads none.
 */
const OWN_CLOCK = /\b(?:Date\.now|performance\.now)\s*\(|\bnew\s+Date\s*\(\s*\)/g;

/** Comments are prose: a doc comment may name `performance.now()` to explain why it is not used. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * A production file in `platform/execution/` or `platform/database/` reads no clock of its own: not `Date.now()`, not
 * `performance.now()`, not `new Date()`. Elapsed time for a budget is the injected `Clock`'s monotonic reading, so that a test
 * controls it and a correction of the machine's wall clock cannot expire a budget at once or extend it. Timers (`setTimeout`)
 * are not time sources: a timer is the event, and the `Clock` decides whether the time is up.
 */
export function findOwnClockViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path.endsWith('.test.ts') || file.path.startsWith('test-support/')) continue;
    if (!MEASURES_ELAPSED_TIME.some((directory) => file.path.startsWith(directory))) continue;
    for (const match of withoutComments(file.text).matchAll(OWN_CLOCK)) {
      violations.push(
        `${file.path} reads the clock itself (${match[0].replace(/\s*\($/, '()')}); elapsed time here is the injected Clock's monotonic reading`,
      );
    }
  }
  return violations;
}

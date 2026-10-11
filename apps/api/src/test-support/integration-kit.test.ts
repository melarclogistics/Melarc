import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONFIG_KEYS } from '../platform/config/load-config.js';

/**
 * The integration kit may move time, break a write and read around the application, and none of it may exist in the application
 * (S0.10, "Does not: add a production time-travel switch"). The kit's own tests are `test/database/integration-kit.db.test.ts`;
 * these are the two properties that need no database.
 */
const SRC = resolve(import.meta.dirname, '..');

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** Every production source file: not a test, and not test support. */
const PRODUCTION = sources(SRC).filter((path) => {
  const name = relative(SRC, path).replaceAll('\\', '/');
  return !name.endsWith('.test.ts') && !name.startsWith('test-support/');
});

/** An import, a side-effect import, a dynamic import or a require of a path inside test support. */
const IMPORTS_TEST_SUPPORT = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*['"][^'"]*test-support\//;

describe('the matcher for an import of test support', () => {
  it.each([
    "import { ManualClock } from './test-support/manual-clock.js';",
    "import './test-support/manual-clock.js';",
    "const clock = await import('../test-support/manual-clock.js');",
    "const clock = require('../test-support/manual-clock.js');",
    "export { ManualClock } from './test-support/manual-clock.js';",
  ])('finds %j', (line) => {
    expect(IMPORTS_TEST_SUPPORT.test(line)).toBe(true);
  });

  it.each([
    "import { Clock } from './platform/auth/ports/clock.port.js';",
    '// the kit lives in test-support/ and is not imported here',
    "const name = 'test-support';",
  ])('does not find %j', (line) => {
    expect(IMPORTS_TEST_SUPPORT.test(line)).toBe(false);
  });
});

describe('the kit stays out of the application', () => {
  // Break caught: a production file that imports the kit or a manual clock, which would put a way to set the time (or to break a
  // write) into what ships. The build excludes test support, but an import would pull it in regardless.
  it('is imported by no production source file', () => {
    expect(PRODUCTION.length).toBeGreaterThan(100);
    const offenders = PRODUCTION.filter((path) =>
      IMPORTS_TEST_SUPPORT.test(readFileSync(path, 'utf8')),
    ).map((path) => relative(SRC, path).replaceAll('\\', '/'));
    expect(offenders).toEqual([]);
  });

  // Break caught: a setting that moves the application's time. The injected clock is a composition-root option of a test, not a
  // configuration key and not an environment variable.
  it('is not reachable by any setting of the application', () => {
    const timeTravel =
      /(^|_)(CLOCK|NOW|FROZEN|FAKE_?TIME|TIME_?TRAVEL|TIME_?OFFSET|DATE_?OVERRIDE)(_|$)/;
    expect(CONFIG_KEYS.filter((key) => timeTravel.test(key))).toEqual([]);
  });

  // Break caught: the entry point passing a port binding, the only way the composition root takes a clock it did not make.
  it('is not reachable from the process entry point, which passes the application module no port binding', () => {
    const main = readFileSync(join(SRC, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/\bports\b/);
    expect(main).not.toMatch(/ManualClock|test-support/);
  });
});

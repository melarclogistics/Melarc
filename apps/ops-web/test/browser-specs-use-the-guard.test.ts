import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const BROWSER = join(resolve(import.meta.dirname), 'browser');

const specs = readdirSync(BROWSER)
  .filter((name) => name.endsWith('.spec.ts'))
  .sort();

/** The values a spec imports from Playwright (a `import type` is no value). */
function valuesImported(text: string, from: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/^import\s+(?!type\b)\{([^}]*)\}\s+from\s+'([^']+)';/gm)) {
    if (match[2] !== from) continue;
    found.push(
      ...(match[1] ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '' && !part.startsWith('type ')),
    );
  }
  return found;
}

describe('every browser spec runs under the guard against a permission key on a screen (run 7, Stage 2.3)', () => {
  it('has specs to hold', () => {
    expect(specs.length).toBeGreaterThan(20);
  });

  // Break caught: a spec (or a new one) that takes `test` from Playwright, so that a key drawn in it fails nothing unless the test happens to assert the watch, which is how seven of
  // seventy-seven tests of the pickup spec came to hold it.
  it('takes `test` from the guarded one and never from Playwright', () => {
    const outside: string[] = [];
    const missing: string[] = [];
    for (const name of specs) {
      const text = readFileSync(join(BROWSER, name), 'utf8');
      if (valuesImported(text, '@playwright/test').includes('test')) outside.push(name);
      if (!valuesImported(text, './support/guarded-test').includes('test')) missing.push(name);
    }

    expect(outside).toEqual([]);
    expect(missing).toEqual([]);
  });

  // Break caught (the Product Owner's review of 67bc979): `permissionKeysOnPurpose` set by a spec of a screen, which allows that screen to draw a permission key and so turns the guard off for it. The
  // allowance is the proof that the watch hears a key, and only the guard's own tests (the page watcher's, in the shell spec) may draw one.
  it('lets only the guard’s own tests set the allowance to draw a key on purpose', () => {
    const GUARD_OWN_SPECS = ['shell.spec.ts'];
    const setting = specs.filter((name) =>
      readFileSync(join(BROWSER, name), 'utf8').includes('permissionKeysOnPurpose'),
    );

    expect(setting.filter((name) => !GUARD_OWN_SPECS.includes(name))).toEqual([]);
    // The guard's own tests do set it: were they to stop, this would hold nothing.
    expect(setting).toEqual(GUARD_OWN_SPECS);
  });

  // Break caught: the fixture made one a test has to ask for.
  it('has a guard that is an automatic fixture', () => {
    const text = readFileSync(join(BROWSER, 'support', 'guarded-test.ts'), 'utf8');

    expect(text).toMatch(/\{\s*auto:\s*true\s*\}/);
  });
});

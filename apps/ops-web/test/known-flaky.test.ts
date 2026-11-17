import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  hostedWebkit,
  KNOWN_FLAKY_ON_HOSTED_WEBKIT,
  MAX_KNOWN_FLAKY,
  reasonOf,
} from './browser/support/known-flaky-list';

/**
 * What the Product Owner accepted as known flaky on the hosted WebKit run (17 November 2026) is a closed list, each entry of it is a real test or a real step of one, each is left out
 * once and only where the list says, and nothing is left out anywhere else. Without this, a "known flaky" skip is a place where a test can be switched off and forgotten.
 */
const BROWSER = resolve(import.meta.dirname, 'browser');
const specs = readdirSync(BROWSER).filter((name) => name.endsWith('.spec.ts'));
const source = (file: string): string => readFileSync(resolve(BROWSER, file), 'utf8');

const CALLS = /\b(skipWhereKnownFlaky|leavesOutStep)\(\s*browserName\s*,\s*'([a-z0-9-]+)'\s*\)/g;

/** Every use of either function in the specs: the function, the id, the spec and the place. */
const uses = specs.flatMap((file) =>
  [...source(file).matchAll(CALLS)].map((match) => ({
    fn: match[1] ?? '',
    id: match[2] ?? '',
    file,
    at: match.index,
  })),
);

describe('the list of what is known flaky on the hosted WebKit run', () => {
  it('is closed: no more than the Product Owner accepted, and each entry says what, why and where it failed', () => {
    expect(KNOWN_FLAKY_ON_HOSTED_WEBKIT.length).toBeLessThanOrEqual(MAX_KNOWN_FLAKY);
    expect(new Set(KNOWN_FLAKY_ON_HOSTED_WEBKIT.map((entry) => entry.id)).size).toBe(
      KNOWN_FLAKY_ON_HOSTED_WEBKIT.length,
    );
    for (const entry of KNOWN_FLAKY_ON_HOSTED_WEBKIT) {
      expect(entry.what.length, entry.id).toBeGreaterThan(10);
      expect(entry.failedIn.length, entry.id).toBeGreaterThan(0);
      for (const run of entry.failedIn) expect(run, entry.id).toMatch(/^#\d+$/);
      expect(reasonOf(entry), entry.id).toContain('17 November 2026');
    }
  });

  // Break caught: an entry whose test was renamed or removed, so that the list names nothing and the skip is attached to another test or to none.
  it.each(KNOWN_FLAKY_ON_HOSTED_WEBKIT.map((entry) => [entry.id, entry] as const))(
    '%s names one real test, and its one use is inside that test',
    (_id, entry) => {
      const text = source(entry.file);
      const titleAt = text.indexOf(`'${entry.title}'`);
      expect(titleAt, `the title of ${entry.id} is in ${entry.file}`).toBeGreaterThan(-1);
      expect(text.indexOf(`'${entry.title}'`, titleAt + 1), `the title is there once`).toBe(-1);

      const own = uses.filter((use) => use.id === entry.id);
      expect(own, `${entry.id} is used exactly once`).toHaveLength(1);
      const [use] = own;
      expect(use?.file).toBe(entry.file);
      expect(use?.fn).toBe(entry.scope === 'test' ? 'skipWhereKnownFlaky' : 'leavesOutStep');

      // Inside the test: after its title and before the next test of the file begins.
      const next = text.slice(titleAt + 1).search(/\n\s{2,4}test(?:\.describe)?\(/);
      const end = next === -1 ? text.length : titleAt + 1 + next;
      expect(use?.at).toBeGreaterThan(titleAt);
      expect(use?.at).toBeLessThan(end);
    },
  );

  // Break caught: a test left out on the hosted WebKit run that the list does not hold, which is how a skip is added and forgotten.
  it('is the only place a test is left out for that reason: every use is an entry of the list', () => {
    const known = new Set<string>(KNOWN_FLAKY_ON_HOSTED_WEBKIT.map((entry) => entry.id));
    for (const use of uses) expect(known.has(use.id), `${use.file}: ${use.id}`).toBe(true);
    expect(uses).toHaveLength(KNOWN_FLAKY_ON_HOSTED_WEBKIT.length);
  });

  // Break caught: a skip that reaches a developer's machine or another engine, which would take the test out of the one place it is a proof.
  it('is the hosted WebKit run and nothing else: WebKit, and the value only CI sets', () => {
    expect(hostedWebkit('webkit', { MELARC_WEBKIT_HEADED: '1' })).toBe(true);
    expect(hostedWebkit('webkit', {})).toBe(false);
    expect(hostedWebkit('webkit', { MELARC_WEBKIT_HEADED: '0' })).toBe(false);
    expect(hostedWebkit('webkit', { MELARC_WEBKIT_HEADED: '' })).toBe(false);
    expect(hostedWebkit('chromium', { MELARC_WEBKIT_HEADED: '1' })).toBe(false);
    expect(hostedWebkit('firefox', { MELARC_WEBKIT_HEADED: '1' })).toBe(false);
  });

  it('reads the process environment by default, as the helper does', () => {
    const was = process.env.MELARC_WEBKIT_HEADED;
    try {
      process.env.MELARC_WEBKIT_HEADED = '1';
      expect(hostedWebkit('webkit')).toBe(true);
      Reflect.deleteProperty(process.env, 'MELARC_WEBKIT_HEADED');
      expect(hostedWebkit('webkit')).toBe(false);
    } finally {
      if (was === undefined) Reflect.deleteProperty(process.env, 'MELARC_WEBKIT_HEADED');
      else process.env.MELARC_WEBKIT_HEADED = was;
    }
  });
});

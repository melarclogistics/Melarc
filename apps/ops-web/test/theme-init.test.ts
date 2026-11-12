import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '../src/platform/theme/theme-choice';

/**
 * The script that applies the stored choice of theme before the first paint (`public/theme-init.js`, redesign step R4). It is a file of its own
 * and not part of the bundle, so nothing else ties it to the module that writes the choice: this does. It is run here in a context that has only
 * a `document` and a `localStorage` of the test's making, so that it is held to doing what it says and nothing else.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = readFileSync(resolve(APP_ROOT, 'public/theme-init.js'), 'utf8');

interface Page {
  readonly attributes: Map<string, string>;
  readonly reads: string[];
}

function run(storage: 'blocked' | Record<string, string>): Page {
  const attributes = new Map<string, string>();
  const reads: string[] = [];
  runInNewContext(SCRIPT, {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes.set(name, value);
        },
      },
    },
    localStorage: {
      getItem: (key: string) => {
        reads.push(key);
        if (storage === 'blocked') throw new Error('The browser refuses storage.');
        return Object.hasOwn(storage, key) ? storage[key] : null;
      },
    },
  });
  return { attributes, reads };
}

describe('the pre-paint theme script', () => {
  // Break caught: a script that reads another key than the module writes (a renamed constant, a typo), so that the stored choice is applied
  // only after the page has painted once in the system theme.
  it('reads the one key the application writes', () => {
    const { reads } = run({});

    expect(reads).toEqual([THEME_STORAGE_KEY]);
    expect(SCRIPT).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it.each(['light', 'dark'])('puts a stored %s on the root', (choice) => {
    const { attributes } = run({ [THEME_STORAGE_KEY]: choice });

    expect(attributes.get('data-theme')).toBe(choice);
  });

  // Break caught: a stored value that is not a choice written onto the root, where no token answers to it, or "system" written as an attribute,
  // which hands the theme to nobody (the system is followed by the attribute's absence).
  it.each(['', 'system', 'blue', 'Dark', 'null'])(
    'leaves the root alone for a stored %j',
    (choice) => {
      const { attributes } = run({ [THEME_STORAGE_KEY]: choice });

      expect(attributes.size).toBe(0);
    },
  );

  it('leaves the root alone when nothing is stored', () => {
    expect(run({}).attributes.size).toBe(0);
  });

  // Break caught: a script that throws when storage is blocked: an error in the head of the page, on every load, for every person whose
  // browser refuses site data.
  it('does not throw, and leaves the root alone, when the browser refuses storage', () => {
    expect(() => run('blocked')).not.toThrow();
    expect(run('blocked').attributes.size).toBe(0);
  });

  // Break caught: a script that grew a network call, a write or a clearing of storage, a second job, or a way out of the page. It runs on every load
  // of every page, before anything is painted: it is a few lines that read one value and set one attribute, and **the names it may use are listed**
  // (a list of what it may do, and not of what it may not: `localStorage.clear()`, `navigator.sendBeacon`, `new WebSocket`, `new Image().src` and
  // `document.write` are all new names, and a list of banned words names only the ones somebody thought of). The reading of the stub in `run` shows
  // only what the script did with the two objects it was given, and a failure inside its `try` is swallowed by design.
  it('uses only the names of its one read and its one attribute, and the strings of its keys and choices', () => {
    const { identifiers, strings } = namesIn(SCRIPT);

    expect(identifiers.filter((name) => !ALLOWED_NAMES.has(name))).toEqual([]);
    expect(strings.filter((text) => !ALLOWED_STRINGS.has(text))).toEqual([]);
  });

  // The pieces of script below are text for the checker to read: none is run.
  it.each([
    ['clears storage', 'localStorage.clear();'],
    ['writes a property of storage', 'localStorage.last = 1;'],
    ['writes storage', "localStorage.setItem('a', 'b');"],
    ['sends a beacon', "navigator.sendBeacon('/x');"],
    ['opens a socket', "new WebSocket('wss://x');"],
    ['loads an image', "new Image().src = '/x';"],
    ['writes the document', "document.write('x');"],
    ['reads the cookie', 'var c = document.cookie;'],
    ['calls out', "fetch('/x');"],
    ['evaluates', "eval('1');"],
  ])('refuses a script that %s', (_what, code) => {
    const { identifiers } = namesIn(`(function () { try { ${code} } catch {} })();`);

    expect(identifiers.filter((name) => !ALLOWED_NAMES.has(name)).length).toBeGreaterThan(0);
  });
});

/** The names the script may use: the shape of its function and `try`, the one read of storage and the one setting of an attribute of the root. */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  'function',
  'try',
  'catch',
  'var',
  'if',
  'choice',
  'localStorage',
  'getItem',
  'document',
  'documentElement',
  'setAttribute',
]);

/** The strings it may hold: its key, the two choices it applies, and the attribute it sets. */
const ALLOWED_STRINGS: ReadonlySet<string> = new Set([
  THEME_STORAGE_KEY,
  'light',
  'dark',
  'data-theme',
]);

/** The identifiers and the string literals of a script, comments left out: what it can name, and what it can say. */
function namesIn(code: string): { identifiers: string[]; strings: string[] } {
  const strings: string[] = [];
  const withoutComments = code.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
  const withoutStrings = withoutComments.replaceAll(
    /'([^'\\]*)'|"([^"\\]*)"/g,
    (_all, single, double) => {
      strings.push((single ?? double) as string);
      return "''";
    },
  );
  const identifiers = [...withoutStrings.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
  return { identifiers: [...new Set(identifiers)], strings };
}

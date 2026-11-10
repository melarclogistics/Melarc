import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The permission keys of the catalogue (`contracts/permissions.md`), read once, for every check that holds a key off the screen: the guard that reads the source
 * (`no-permission-key-on-screen.test.ts`), the table of words (`capability-words.test.ts`), the render helpers of the page tests (`src/test-support/permission-keys.ts`)
 * and the page watcher of the browser tests (`test/browser/support/page.ts`). One reader, so that no check holds a shorter list than another.
 */
export const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../../..');

let cached: ReadonlySet<string> | undefined;

/** The first cell of each row of the catalogue's tables that is a key. */
export function catalogueKeys(): ReadonlySet<string> {
  if (cached !== undefined) return cached;
  const keys = new Set<string>();
  const text = readFileSync(join(REPOSITORY_ROOT, 'contracts', 'permissions.md'), 'utf8');
  for (const line of text.split('\n')) {
    const cell = /^\|\s*`([a-z]+(?:\.[a-z_]+){1,3})`/.exec(line);
    if (cell?.[1] !== undefined) keys.add(cell[1]);
  }
  cached = keys;
  return keys;
}

/**
 * The pattern that finds a key of the catalogue in a text: the longest key first, not part of a longer word or dotted name before it or a longer name after it
 * (a full stop that ends a sentence is not one). It is a source and flags and not a RegExp, because the browser tests send it into the page.
 */
export function keyPatternSource(keys: ReadonlySet<string> = catalogueKeys()): string {
  const escaped = [...keys]
    .sort((a, b) => b.length - a.length)
    .map((key) => key.replaceAll('.', String.raw`\.`));
  return String.raw`(?<![\w.])(?:${escaped.join('|')})(?![\w])`;
}

/** The flags of {@link keyPatternSource}. */
export const KEY_PATTERN_FLAGS = 'g';

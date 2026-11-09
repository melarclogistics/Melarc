import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_KEYS,
  ASK_FOR_ACCESS,
  capabilityOf,
  cannotText,
} from '../src/platform/problem/capability-words';

/**
 * A refusal names the capability in plain words and never a key (PRODUCT_DESIGN_DIRECTION section 6.5). The words are in one table, and this holds the table to the two
 * things it is for: the catalogue of permissions (a key that is not one has no place in it) and the portal's own source (a key a screen names has its words, and a word
 * is not left for a key no screen names).
 */
const ROOT = resolve(import.meta.dirname, '../../..');
const SOURCE = join(ROOT, 'apps', 'ops-web', 'src');

/** The permission keys of the catalogue: the first cell of each row of `contracts/permissions.md`'s tables that is a key. */
function catalogueKeys(): ReadonlySet<string> {
  const text = readFileSync(join(ROOT, 'contracts', 'permissions.md'), 'utf8');
  const keys = new Set<string>();
  for (const line of text.split('\n')) {
    const cell = /^\|\s*`([a-z]+(?:\.[a-z_]+){1,3})`/.exec(line);
    if (cell?.[1] !== undefined) keys.add(cell[1]);
  }
  return keys;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      return name === 'showcase' || name === 'test-support' ? [] : sourceFiles(path);
    }
    const isSource = /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name);
    return isSource && name !== 'capability-words.ts' ? [path] : [];
  });
}

/** The keys of the catalogue that the portal's source names as a string. */
function namedByTheSource(keys: ReadonlySet<string>): ReadonlySet<string> {
  const named = new Set<string>();
  for (const file of sourceFiles(SOURCE)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/['"`]([a-z]+(?:\.[a-z_]+){1,3})['"`]/g)) {
      if (match[1] !== undefined && keys.has(match[1])) named.add(match[1]);
    }
  }
  return named;
}

describe('the words of a refusal', () => {
  const catalogue = catalogueKeys();

  // Break caught: a catalogue that was not read (a table held to nothing), or a key written in it that is not a permission (a typo that would never be asked for).
  it('read the catalogue, and name no key that is not one', () => {
    expect(catalogue.size).toBeGreaterThan(100);
    const strangers = CAPABILITY_KEYS.filter((key) => !catalogue.has(key));
    expect(strangers).toEqual([]);
  });

  // Break caught: a screen that names a permission whose refusal would then be told as "do this", which is no help to the person, or worse, a screen that draws the key
  // because it found no words. Every key the portal names has its words.
  it('exist for every permission the portal names', () => {
    const named = namedByTheSource(catalogue);
    expect(named.size).toBeGreaterThan(20);
    const without = [...named].filter((key) => capabilityOf(key) === undefined);
    expect(without).toEqual([]);
  });

  // Break caught: words kept for a key no screen asks for any more (a table that grows and is never tidied).
  it('are kept only for permissions the portal names', () => {
    const named = namedByTheSource(catalogue);
    expect(CAPABILITY_KEYS.filter((key) => !named.has(key))).toEqual([]);
  });

  // Break caught: a refusal that names the key (the finding of the review of 5edada2: "This needs the permission pickup.read"), or one that names a role.
  it('make a sentence that names the capability, and never the key or a role', () => {
    for (const key of CAPABILITY_KEYS) {
      const sentence = cannotText(key);
      expect(sentence, key).toBe(
        `Your account can’t ${capabilityOf(key) ?? ''}. ${ASK_FOR_ACCESS}`,
      );
      expect(sentence, key).not.toContain(key);
      expect(sentence, key).not.toMatch(/\b[a-z]+\.[a-z_]+\b/);
      expect(sentence, key).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance|Auditor/);
    }
    expect(cannotText('pickup.read')).toBe(
      'Your account can’t see pickup requests. Ask an administrator for access.',
    );
  });

  // Break caught (the review of 499399c): the list of pickup runs refused in the words of the pickup requests it is not about. The sentence is the table's, and a page that reads another
  // thing with the same key says what it is ("see pickup runs"), without making a sentence of its own.
  it('make the same sentence of a page’s own words for what the key reads there', () => {
    expect(cannotText('pickup.read', 'see pickup runs')).toBe(
      `Your account can’t see pickup runs. ${ASK_FOR_ACCESS}`,
    );
    expect(cannotText('pickup.read', 'see pickup runs')).not.toContain('pickup.read');
    expect(cannotText('pickup.read')).toBe(
      'Your account can’t see pickup requests. Ask an administrator for access.',
    );
  });

  // Break caught: a key that has no words told as the key.
  it('tell a key with no words as "do this", and the absence of a key the same way', () => {
    expect(cannotText('made.up.key')).toBe(`Your account can’t do this. ${ASK_FOR_ACCESS}`);
    expect(cannotText(undefined)).toBe(`Your account can’t do this. ${ASK_FOR_ACCESS}`);
  });
});

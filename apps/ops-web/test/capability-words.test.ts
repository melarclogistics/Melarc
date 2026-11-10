import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAPABILITY_KEYS,
  CAPABILITY_WORDS,
  OUTSIDE_HUBS_SENTENCES,
  ASK_FOR_ACCESS,
  capabilityOf,
  cannotAllText,
  lackedText,
  cannotText,
  refusalText,
} from '../src/platform/problem/capability-words';
import { catalogueKeys, REPOSITORY_ROOT } from './support/permission-catalogue';

/**
 * A refusal names the capability in plain words and never a key (PRODUCT_DESIGN_DIRECTION section 6.5). The words are in one table, and this holds the table to the two
 * things it is for: the catalogue of permissions (a key that is not one has no place in it) and the portal's own source (a key a screen names has its words, and a word
 * is not left for a key no screen names).
 */
const SOURCE = join(REPOSITORY_ROOT, 'apps', 'ops-web', 'src');

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

  // Break caught (the review of f6cf02b): `doing` was free text, so `cannotText('pickup.read', 'pickup.read')` drew a key and passed. The words are a value of the table (a type),
  // so the compiler refuses any other text: the precheck's typecheck fails on an unused `@ts-expect-error` here when the type is widened to a string again. Vitest does not typecheck,
  // so what this test does at run time is the second half: no wording of the table holds a key, or anything shaped like one.
  it('are the table’s words and no free text, and none of them holds a key', () => {
    // @ts-expect-error free text is not words of the table
    expect(cannotText('pickup.read', 'pickup.read')).toContain('pickup.read');
    // @ts-expect-error nor is a sentence a page might write
    expect(cannotText(undefined, 'see everything')).toContain('see everything');
    expect(CAPABILITY_WORDS.length).toBeGreaterThan(30);
    for (const words of CAPABILITY_WORDS) {
      expect(catalogue.has(words), words).toBe(false);
      expect(words, words).not.toMatch(/\b[a-z]+\.[a-z_]+\b/);
      expect(words, words).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance|Auditor/);
    }
  });

  // Break caught (the review of f6cf02b): the sentence of a refusal written by a page, so that two screens told one refusal in two ways, and the staff list told every kind of refusal as a
  // missing key. One function tells every kind, and each kind has its own words.
  it('are told by one function: each kind in its own words, and a missing key as what the account cannot do', () => {
    expect(refusalText('permission-missing', 'pickup.read')).toBe(cannotText('pickup.read'));
    expect(refusalText(undefined, 'staff.read')).toBe(cannotText('staff.read'));
    expect(refusalText('permission-missing', 'pickup.read', { doing: 'see pickup runs' })).toBe(
      cannotText('pickup.read', 'see pickup runs'),
    );
    expect(refusalText('insufficient-authority', 'staff.read')).toBe(
      'This needs a higher authority than your session has.',
    );
    expect(refusalText('outside-hubs', 'staff.read')).toBe(
      'This record belongs to a hub your session does not act in.',
    );
    expect(refusalText('approval-required', 'pickup.exception.approve')).toBe(
      'A different approver decides this.',
    );
    expect(refusalText('unavailable-here', undefined)).toBe(
      'This cannot be done for this record as it stands.',
    );
    const sentences = new Set(
      (
        [
          'permission-missing',
          'insufficient-authority',
          'outside-hubs',
          'approval-required',
          'unavailable-here',
        ] as const
      ).map((kind) => refusalText(kind, 'staff.read')),
    );
    expect(sentences.size).toBe(5);
  });

  it('tell a hub as the hub of what a page holds, in plain words with no key and no role', () => {
    expect(OUTSIDE_HUBS_SENTENCES.length).toBeGreaterThanOrEqual(8);
    expect(refusalText('outside-hubs', 'pickup.read', { of: 'pickup requests' })).toBe(
      'These pickup requests are at a hub your account does not work in.',
    );
    expect(refusalText('outside-hubs', 'dispatch.read', { of: 'riders' })).toBe(
      'These riders are at a hub your account does not work in.',
    );
    expect(refusalText('outside-hubs', 'staff.read', { of: 'this person' })).toBe(
      'This person is at a hub your account does not work in.',
    );
    for (const sentence of OUTSIDE_HUBS_SENTENCES) {
      expect(sentence).toMatch(/hub your (account|session)/);
      expect(sentence).not.toMatch(/\b[a-z]+\.[a-z_]+\b/);
      expect(sentence).not.toMatch(/Ops Staff|Senior Ops|Platform Admin|Finance|Auditor/);
      for (const key of catalogue) expect(sentence).not.toContain(key);
    }
  });

  // Break caught (the review of f6cf02b): a page that lacks several keys told only the first (a draft pickup run offers three acts). One sentence names every one, each in its words, once.
  it('name every key a session lacks, in one sentence with the way out said once', () => {
    expect(cannotAllText(['pickup.manifest.assign'])).toBe(cannotText('pickup.manifest.assign'));
    expect(cannotAllText(['pickup.manifest.assign', 'pickup.manifest.dispatch'])).toBe(
      `Your account can’t assign a rider to a pickup run or send a pickup run out. ${ASK_FOR_ACCESS}`,
    );
    expect(
      cannotAllText([
        'pickup.manifest.assign',
        'pickup.manifest.dispatch',
        'pickup.manifest.create',
      ]),
    ).toBe(
      `Your account can’t assign a rider to a pickup run, send a pickup run out or build or cancel a pickup run. ${ASK_FOR_ACCESS}`,
    );
    // A key with no words is told as "do this", once, and none at all is told so as well; never as the key.
    expect(cannotAllText(['made.up.key', 'another.made.up'])).toBe(
      `Your account can’t do this. ${ASK_FOR_ACCESS}`,
    );
    expect(cannotAllText([])).toBe(`Your account can’t do this. ${ASK_FOR_ACCESS}`);
    for (const key of CAPABILITY_KEYS)
      expect(cannotAllText([key, 'pickup.read'])).not.toContain(key);
  });

  it('tell what a session lacks of the keys a page names, and nothing when it holds them all', () => {
    const keys = ['pickup.manifest.assign', 'pickup.manifest.dispatch', 'pickup.manifest.create'];
    expect(lackedText(() => true, keys)).toBeUndefined();
    expect(lackedText((key) => key === 'pickup.manifest.dispatch', keys)).toBe(
      cannotAllText(['pickup.manifest.assign', 'pickup.manifest.create']),
    );
    expect(lackedText(() => false, keys)).toBe(cannotAllText(keys));
    expect(lackedText(() => false, [])).toBeUndefined();
  });

  // Break caught: a key that has no words told as the key.
  it('tell a key with no words as "do this", and the absence of a key the same way', () => {
    expect(cannotText('made.up.key')).toBe(`Your account can’t do this. ${ASK_FOR_ACCESS}`);
    expect(cannotText(undefined)).toBe(`Your account can’t do this. ${ASK_FOR_ACCESS}`);
  });
});

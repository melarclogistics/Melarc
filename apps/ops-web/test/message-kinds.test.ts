import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  MESSAGE_KIND_LABELS,
  messageKindLabel,
} from '../src/app/pages/messages/message-presentation';
import { MESSAGE_KIND } from '../src/platform/notifications/notification-shape';

/**
 * The message log names every message by its kind in plain words (`message-presentation.ts`), and the kinds are the API's list
 * (`apps/api/src/platform/notifications/message-list.ts`: the messages whose events exist, and the ones planned with their documents). The Ops
 * Portal must not import the API, so the list is read as text, as `scripts/shell-bundles.test.ts` reads the seed: a message added there without
 * words here fails this test, and a label for a message the API dropped fails it too. (A kind the screen does not know is still shown, in
 * sentence case, so this is about the words being the owner's and not about the screen working.)
 */
const LIST = resolve(import.meta.dirname, '../../api/src/platform/notifications/message-list.ts');

/** The `kind: 'NAME'` of every entry of the two lists, wired and planned, in the order written. */
function kindsOf(text: string): string[] {
  return [...text.matchAll(/^[ \t]+kind: '([A-Z][A-Z0-9_]+)',[ \t\r]*$/gm)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

describe('the messages of the API and their words', () => {
  const kinds = kindsOf(readFileSync(LIST, 'utf8'));

  // Break caught: a reader that finds nothing, which would let the comparisons below pass over empty lists.
  it('reads the list of the API: its two wired messages first, and the planned ones', () => {
    expect(kinds.length).toBeGreaterThanOrEqual(14);
    expect(kinds.slice(0, 2)).toEqual(['PICKUP_CONFIRMED_SENDER', 'PICKUP_CONFIRMED_VENDOR_FEED']);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('has words for every message the API lists', () => {
    expect(kinds.filter((kind) => !Object.hasOwn(MESSAGE_KIND_LABELS, kind))).toEqual([]);
  });

  it('has no words for a message the API does not list', () => {
    expect(Object.keys(MESSAGE_KIND_LABELS).filter((kind) => !kinds.includes(kind))).toEqual([]);
  });

  // Break caught: a kind the contract would refuse, or words that are the kind's name.
  it('names only kinds the contract’s pattern takes, in words and not in names', () => {
    for (const kind of kinds) {
      expect(MESSAGE_KIND.test(kind), kind).toBe(true);
      expect(messageKindLabel(kind), kind).not.toBe(kind);
      expect(messageKindLabel(kind), kind).not.toMatch(/_/);
    }
  });

  it('can find a kind: the reader finds the ones it is given, and not a comment about them', () => {
    expect(kindsOf("  kind: 'A_KIND',\n    // kind: 'NOT_ONE',\n  kind: 'ANOTHER_ONE',")).toEqual([
      'A_KIND',
      'ANOTHER_ONE',
    ]);
  });
});

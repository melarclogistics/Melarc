import { describe, expect, it } from 'vitest';

import { MAX_ALLOW_LIST_ENTRIES, isAllowed, parseAllowList } from './delivery-allow-list.js';

describe('the allow-list of the controlled real-provider window', () => {
  // Break caught: a list that cannot be read as the addresses and numbers it names, or that keeps the wrong channel for an entry.
  it('reads addresses and numbers, and tells the channel from the shape of the entry', () => {
    const list = parseAllowList('ama@example.test, +233201234567 ,Kofi.Mensah@Example.Test');

    expect(list).toBeDefined();
    if (list === undefined) throw new Error('unreachable');
    expect([...list.addresses].toSorted()).toEqual([
      'ama@example.test',
      'kofi.mensah@example.test',
    ]);
    expect([...list.numbers]).toEqual(['+233201234567']);
  });

  // Break caught: a message to anyone off the list being let through, or an address matched without regard to its channel.
  it('allows a destination on the list for its own channel only, comparing addresses without case', () => {
    const list = parseAllowList('ama@example.test,+233201234567');
    if (list === undefined) throw new Error('unreachable');

    expect(isAllowed(list, 'EMAIL', 'ama@example.test')).toBe(true);
    expect(isAllowed(list, 'EMAIL', 'AMA@Example.Test')).toBe(true);
    expect(isAllowed(list, 'SMS', '+233201234567')).toBe(true);
    expect(isAllowed(list, 'EMAIL', 'kofi@example.test')).toBe(false);
    expect(isAllowed(list, 'SMS', '+233201234568')).toBe(false);
    // A number on the list is no address, and an address on the list is no number.
    expect(isAllowed(list, 'EMAIL', '+233201234567')).toBe(false);
    expect(isAllowed(list, 'SMS', 'ama@example.test')).toBe(false);
    // A prefix or a longer name is not the entry.
    expect(isAllowed(list, 'EMAIL', 'ama@example.test.evil.test')).toBe(false);
    expect(isAllowed(list, 'EMAIL', 'xama@example.test')).toBe(false);
  });

  // Break caught: a list with something in it that no message could be addressed to, an empty list (which would allow nobody and
  // look like a configured window), a repeated entry, or a list longer than a window needs.
  it.each([
    ['empty', ''],
    ['an empty entry', 'ama@example.test,'],
    ['a name that is not an address or a number', 'ama'],
    ['a number without its plus', '233201234567'],
    ['an address with a space', 'ama mensah@example.test'],
    ['two destinations in one entry', 'ama@example.test;kofi@example.test'],
    ['the same address twice, in another case', 'ama@example.test,AMA@example.test'],
    ['the same number twice', '+233201234567,+233201234567'],
  ])('refuses a list that is %s', (_label, text) => {
    expect(parseAllowList(text)).toBeUndefined();
  });

  it('refuses a list longer than the bound and accepts one of exactly the bound', () => {
    const entries = (count: number): string =>
      Array.from({ length: count }, (_, index) => `person${String(index)}@example.test`).join(',');

    // The bound is the document's: fifty, by the figures and not by the constant that carries them.
    expect(MAX_ALLOW_LIST_ENTRIES).toBe(50);
    expect(parseAllowList(entries(50))).toBeDefined();
    expect(parseAllowList(entries(51))).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';

import { codePointCount, isWellFormedUnicode } from './unicode.js';

describe('isWellFormedUnicode', () => {
  it.each([
    ['empty text', ''],
    ['plain ASCII', 'a passphrase with spaces'],
    ['a surrogate pair (one astral code point)', '\u{1F600}'],
    ['a pair between ordinary text', 'a\u{1F600}b'],
    ['a BMP character that is not a surrogate', 'ﬃ'],
    ['U+FFFD, which is a real character and not a repair marker', '�'],
  ])('accepts %s', (_label, text) => {
    expect(isWellFormedUnicode(text)).toBe(true);
  });

  // Break caught: a check that looks only for a high surrogate, or only at the end of the text, so that a lone low surrogate or a
  // reversed pair would be encoded to U+FFFD by the first UTF-8 encoder it met and hash like another credential (§13.4a).
  it.each([
    ['a lone high surrogate', '\uD800'],
    ['a lone low surrogate', '\uDC00'],
    ['a lone high surrogate at the end', 'abc\uD83D'],
    ['a lone low surrogate at the start', '\uDE00abc'],
    ['a pair in the wrong order', '\uDE00\uD83D'],
    ['a high surrogate followed by an ordinary character', '\uD83Dx'],
    ['a valid pair followed by a lone low surrogate', '\u{1F600}\uDE00'],
  ])('refuses %s', (_label, text) => {
    expect(isWellFormedUnicode(text)).toBe(false);
  });
});

describe('codePointCount', () => {
  it('counts code points and not UTF-16 units', () => {
    expect(codePointCount('abc', 100)).toBe(3);
    expect(codePointCount('\u{1F600}\u{1F600}', 100)).toBe(2);
    expect(codePointCount('a\u{1F600}b', 100)).toBe(3);
    expect(codePointCount('', 100)).toBe(0);
  });

  // Break caught: counting a whole 100 KiB body to say it is too long. The count stops one past the limit, so the work is bounded
  // by the limit and not by the input.
  it('stops one past the limit it is given', () => {
    expect(codePointCount('x'.repeat(1000), 128)).toBe(129);
    expect(codePointCount('x'.repeat(128), 128)).toBe(128);
    expect(codePointCount('\u{1F600}'.repeat(500), 128)).toBe(129);
  });
});

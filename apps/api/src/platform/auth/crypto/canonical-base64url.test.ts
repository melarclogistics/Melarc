import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeBase64Url32 } from './canonical-base64url.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The same 32 bytes spelt with a spare bit of the last character set: the one non-canonical spelling a decoder may take. */
function withSpareBitSet(valid: string): string {
  return valid.slice(0, 42) + ALPHABET.charAt(ALPHABET.indexOf(valid.charAt(42)) | 1);
}

describe('decodeBase64Url32 (the form of a token, a challenge and a key: SECURITY_DESIGN.md §14.9)', () => {
  it('reads 43 characters of unpadded base64url as the 32 bytes they spell', () => {
    for (let round = 0; round < 50; round += 1) {
      const bytes = randomBytes(32);
      const decoded = decodeBase64Url32(bytes.toString('base64url'));

      expect(decoded).toBeDefined();
      expect(Buffer.from(decoded ?? []).equals(bytes)).toBe(true);
    }
  });

  it('reads the extremes: all zero bits and all one bits', () => {
    // Worked by hand: 256 one bits are 42 characters of 111111 ("_") and the last four bits with two zero spare bits, 111100 ("8").
    const allOnes = `${'_'.repeat(42)}8`;

    expect(Buffer.alloc(32, 0xff).toString('base64url')).toBe(allOnes);
    expect(decodeBase64Url32('A'.repeat(43))).toEqual(Buffer.alloc(32, 0));
    expect(decodeBase64Url32(allOnes)).toEqual(Buffer.alloc(32, 0xff));
  });

  // Break caught: a decoder that takes a length that merely decodes, or a spelling that merely decodes to the same bytes, so a
  // token has more than one text (the QR payload, the rate-limit key and the stored hash would then disagree).
  it.each([
    ['an empty string', ''],
    ['42 characters', 'A'.repeat(42)],
    ['44 characters', 'A'.repeat(44)],
    ['43 characters with padding', `${'A'.repeat(42)}=`],
    ['43 characters of standard base64', `${'A'.repeat(40)}+/A`],
    ['a space', `${'A'.repeat(42)} `],
    ['a newline', `${'A'.repeat(42)}\n`],
    ['a leading space', ` ${'A'.repeat(42)}`],
    ['a non-ASCII letter', `${'A'.repeat(42)}é`],
    ['a full-width letter', `${'A'.repeat(42)}Ａ`],
    ['a NUL', `${'A'.repeat(42)}\u0000`],
    ['an emoji', `${'A'.repeat(41)}\u{1F600}`],
  ])('refuses %s', (_label, text) => {
    expect(decodeBase64Url32(text)).toBeUndefined();
  });

  it('refuses the non-canonical spelling of a value', () => {
    const valid = randomBytes(32).toString('base64url');
    const spelling = withSpareBitSet(valid);

    // A canonical last character has both spare bits clear, so setting one always gives a different text for the same bytes,
    // which is what a decoder that only decodes would take.
    expect(spelling).not.toBe(valid);
    expect(Buffer.from(spelling, 'base64url').equals(Buffer.from(valid, 'base64url'))).toBe(true);
    expect(decodeBase64Url32(spelling)).toBeUndefined();
  });

  it('is not misled by a type that is not text', () => {
    for (const value of [undefined, null, 42, {}, [], Buffer.alloc(32)]) {
      expect(decodeBase64Url32(value)).toBeUndefined();
    }
  });
});

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { KeyHolding } from '../../config/key-material.js';
import { Secret } from '../../config/secret.js';
import { HandshakeCodes } from './handshake-codes.js';

const STOP = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
const OTHER_STOP = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e02';

const material = (): string => randomBytes(32).toString('base64url');

/** The key custody of a process that holds the `credential_delivery` purpose under the given versions. */
function holding(versions: readonly number[], active: number): KeyHolding {
  return {
    custody: 'local',
    purposes: {
      credential_delivery: {
        activeVersion: active,
        versions: Object.fromEntries(versions.map((v) => [v, new Secret(material())])),
      },
    },
  } as unknown as KeyHolding;
}

/**
 * The handshake code of a stop (S1.27): derived, never stored. The database keeps a keyed digest of the code and the generation number, and the
 * code is made again from the stop, the generation and the key when it is needed (to show the rider, to text the sender). So nothing in Melarc holds
 * a code at rest, in clear or sealed, and a code is only as guessable as the key is findable.
 */
describe('HandshakeCodes', () => {
  // Break caught: a code that is not the same twice (the SMS lane and the API would then disagree), or that does not depend on its generation.
  it('derives the same code from the same stop, generation and key, and another from another', () => {
    const codes = new HandshakeCodes(holding([1], 1));
    const first = codes.codeFor(STOP, 1, 1, 4);
    expect(codes.codeFor(STOP, 1, 1, 4)).toBe(first);
    const seen = new Set([first]);
    for (let generation = 2; generation <= 40; generation += 1) {
      seen.add(codes.codeFor(STOP, generation, 1, 4));
    }
    // 40 generations of a 4-digit code are not all the same code (the chance of that is 10^-117).
    expect(seen.size).toBeGreaterThan(30);
    expect(codes.codeFor(OTHER_STOP, 1, 1, 4)).not.toBeUndefined();
  });

  // Break caught: a code of the wrong length or with a letter in it, or one that loses its leading zeros (a code "0042" typed as 42).
  it.each([4, 6, 8])('is exactly %i digits, leading zeros kept', (length) => {
    const codes = new HandshakeCodes(holding([1], 1));
    let withLeadingZero = 0;
    for (let generation = 1; generation <= 2000; generation += 1) {
      const code = codes.codeFor(STOP, generation, 1, length);
      expect(code).toMatch(new RegExp(`^[0-9]{${String(length)}}$`));
      if (code.startsWith('0')) withLeadingZero += 1;
    }
    // About one in ten begins with a zero; a code that was a number would have none that kept its zero.
    expect(withLeadingZero).toBeGreaterThan(100);
  });

  // Break caught: a length no setting allows being accepted (a 1-digit code is a coin toss; a 12-digit one overflows the arithmetic).
  it.each([0, 3, 9, 12, 4.5, -4, Number.NaN])('refuses a length of %s', (length) => {
    const codes = new HandshakeCodes(holding([1], 1));
    expect(() => codes.codeFor(STOP, 1, 1, length)).toThrow(RangeError);
  });

  // Break caught: a generation that is not a positive whole number (generation 0 is "no code yet").
  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('refuses a generation of %s', (generation) => {
    const codes = new HandshakeCodes(holding([1], 1));
    expect(() => codes.codeFor(STOP, generation, 1, 4)).toThrow(RangeError);
  });

  // Break caught: a different key giving the same code (the code would then be derivable without the key), or the key version ignored.
  it('depends on the key and on its version', () => {
    const a = new HandshakeCodes(holding([1], 1));
    const b = new HandshakeCodes(holding([1], 1));
    const differ = Array.from({ length: 50 }, (_, i) => i + 1).filter(
      (generation) => a.codeFor(STOP, generation, 1, 6) !== b.codeFor(STOP, generation, 1, 6),
    );
    expect(differ.length).toBeGreaterThan(45);
    const two = new HandshakeCodes(holding([1, 2], 2));
    expect(two.codeFor(STOP, 1, 1, 6)).not.toBe(two.codeFor(STOP, 1, 2, 6));
    expect(() => two.codeFor(STOP, 1, 3, 6)).toThrow(
      expect.objectContaining({ condition: 'KEY_VERSION_UNKNOWN' }),
    );
  });

  // Break caught: the digest of a code that does not depend on the stop (a code for one stop would then verify at another) or on the code.
  it('gives a 32-byte digest per held key version, bound to the stop and to the code', () => {
    const codes = new HandshakeCodes(holding([1, 2], 2));
    const digests = codes.digestsOf(STOP, '1234');
    expect(digests.map((digest) => digest.version)).toEqual([1, 2]);
    for (const digest of digests) expect(digest.bytes).toHaveLength(32);
    const again = codes.digestsOf(STOP, '1234');
    expect(again.map((digest) => digest.bytes.toString('hex'))).toEqual(
      digests.map((digest) => digest.bytes.toString('hex')),
    );
    const otherCode = codes.digestsOf(STOP, '1235');
    const otherStop = codes.digestsOf(OTHER_STOP, '1234');
    for (const [i, digest] of digests.entries()) {
      expect(otherCode[i]?.bytes.equals(digest.bytes)).toBe(false);
      expect(otherStop[i]?.bytes.equals(digest.bytes)).toBe(false);
    }
    // The two versions give different digests of the same code.
    expect(digests[0]?.bytes.equals(digests[1]?.bytes ?? Buffer.alloc(0))).toBe(false);
  });

  // Break caught: the digest of the code being a digest of anything else made under the key, or the code being recoverable from the digest's key:
  // the code key and the digest key are different keys of the one purpose, and the digest of a code is not the code's own derivation.
  it('keeps the code key and the digest key apart', () => {
    const codes = new HandshakeCodes(holding([1], 1));
    const code = codes.codeFor(STOP, 1, 1, 8);
    const [digest] = codes.digestsOf(STOP, code);
    expect(digest?.bytes.toString('hex')).not.toContain(code);
    expect(codes.digestOfVersion(STOP, code, 1).equals(digest?.bytes ?? Buffer.alloc(0))).toBe(
      true,
    );
    expect(() => codes.digestOfVersion(STOP, code, 9)).toThrow(
      expect.objectContaining({ condition: 'KEY_VERSION_UNKNOWN' }),
    );
  });

  // Break caught: composed without its key (a deployment that holds no `credential_delivery` key must not be able to make a code), or with an
  // active version it does not hold.
  it('is not composed without the purpose key or without its active version', () => {
    expect(
      () => new HandshakeCodes({ custody: 'local', purposes: {} } as unknown as KeyHolding),
    ).toThrow(expect.objectContaining({ condition: 'PURPOSE_KEY_ABSENT' }));
    expect(() => new HandshakeCodes(holding([1], 2))).toThrow(
      expect.objectContaining({ condition: 'KEY_VERSION_UNKNOWN' }),
    );
    expect(() => new HandshakeCodes({ custody: 'describe' } as unknown as KeyHolding)).toThrow(
      expect.objectContaining({ condition: 'PURPOSE_KEY_ABSENT' }),
    );
  });

  // Break caught: the active version not being the one new codes are made under.
  it('names the active version and the versions it holds', () => {
    const codes = new HandshakeCodes(holding([3, 1, 2], 2));
    expect(codes.activeVersion).toBe(2);
    expect(codes.versions).toEqual([1, 2, 3]);
  });
});

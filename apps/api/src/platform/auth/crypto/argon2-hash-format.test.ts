import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { decodeArgon2idHash, encodeArgon2idHash, type Argon2idHash } from './argon2-hash-format.js';

const SALT = Buffer.alloc(16, 0x02);
const TAG = Buffer.alloc(32, 0x03);
// Worked by hand: sixteen bytes of 0x02 are "AgIC" five times and "Ag" (22 characters); thirty-two bytes of 0x03 are "AwMD" ten
// times and "AwM" (43 characters).
const SALT_TEXT = 'AgIC'.repeat(5) + 'Ag';
const TAG_TEXT = 'AwMD'.repeat(10) + 'AwM';

const hash = (overrides: Partial<Argon2idHash> = {}): Argon2idHash => ({
  parameters: { memoryKiB: 19456, passes: 2, parallelism: 1 },
  pepperVersion: 3,
  salt: SALT,
  tag: TAG,
  ...overrides,
});
const GOLDEN = `$argon2id$v=19$m=19456,t=2,p=1,pv=3$${SALT_TEXT}$${TAG_TEXT}`;

describe('the encoded Argon2id hash', () => {
  it('is the PHC-style string that carries its algorithm, version, parameters, pepper version, salt and tag', () => {
    expect(encodeArgon2idHash(hash())).toBe(GOLDEN);
  });

  it('decodes back to what was encoded', () => {
    const decoded = decodeArgon2idHash(GOLDEN);

    expect(decoded).toBeDefined();
    expect(decoded?.parameters).toEqual({ memoryKiB: 19456, passes: 2, parallelism: 1 });
    expect(decoded?.pepperVersion).toBe(3);
    expect(Buffer.from(decoded?.salt ?? []).equals(SALT)).toBe(true);
    expect(Buffer.from(decoded?.tag ?? []).equals(TAG)).toBe(true);
  });

  it('round-trips random salts and tags, at several parameter sets and pepper versions', () => {
    for (const [parameters, pepperVersion] of [
      [{ memoryKiB: 8, passes: 1, parallelism: 1 }, 1],
      [{ memoryKiB: 65536, passes: 2, parallelism: 1 }, 999999],
      [{ memoryKiB: 1024, passes: 16, parallelism: 16 }, 42],
    ] as const) {
      const original = hash({
        parameters,
        pepperVersion,
        salt: randomBytes(16),
        tag: randomBytes(32),
      });
      const decoded = decodeArgon2idHash(encodeArgon2idHash(original));

      expect(decoded?.parameters).toEqual(parameters);
      expect(decoded?.pepperVersion).toBe(pepperVersion);
      expect(Buffer.from(decoded?.salt ?? []).equals(original.salt)).toBe(true);
      expect(Buffer.from(decoded?.tag ?? []).equals(original.tag)).toBe(true);
    }
  });

  it('writes the salt and tag as unpadded standard base64: 22 and 43 characters', () => {
    const text = encodeArgon2idHash(
      hash({ salt: Buffer.alloc(16, 0xfb), tag: Buffer.alloc(32, 0xff) }),
    );

    expect(text).toMatch(
      /^\$argon2id\$v=19\$m=\d+,t=\d+,p=\d+,pv=\d+\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    // 0xFB 0xFB 0xFB is "+/v7" in the standard alphabet: the alphabet the PHC string format uses, and not base64url.
    expect(text).toContain('$+/v7+/v7');
  });

  it('refuses to encode a hash it could not read back', () => {
    expect(() => encodeArgon2idHash(hash({ salt: Buffer.alloc(15) }))).toThrow(RangeError);
    expect(() => encodeArgon2idHash(hash({ tag: Buffer.alloc(31) }))).toThrow(RangeError);
    expect(() => encodeArgon2idHash(hash({ pepperVersion: 0 }))).toThrow(RangeError);
    expect(() => encodeArgon2idHash(hash({ pepperVersion: 1_000_000 }))).toThrow(RangeError);
    expect(() =>
      encodeArgon2idHash(hash({ parameters: { memoryKiB: 65537, passes: 2, parallelism: 1 } })),
    ).toThrow(RangeError);
  });

  // The decoder reads data from a database column, which is not trusted to be what this service wrote: a tampered or foreign
  // value must be refused before any hashing starts, and must not be able to ask for unbounded memory or time.
  describe('refuses, with no result, anything that is not exactly what the encoder writes', () => {
    const VALID_PARAMS = 'm=19456,t=2,p=1,pv=3';
    const rebuilt = (parts: {
      head?: string;
      version?: string;
      params?: string;
      salt?: string;
      tag?: string;
    }) =>
      `$${parts.head ?? 'argon2id'}$${parts.version ?? 'v=19'}$${parts.params ?? VALID_PARAMS}$${parts.salt ?? SALT_TEXT}$${parts.tag ?? TAG_TEXT}`;

    it('accepts the rebuilt valid string, so the cases below differ from it in one thing only', () => {
      expect(rebuilt({})).toBe(GOLDEN);
      expect(decodeArgon2idHash(rebuilt({}))).toBeDefined();
    });

    // Break caught: a decoder that is lenient about anything, so two different strings are one hash or a foreign hash is accepted.
    it.each([
      ['an empty string', ''],
      ['a string that is not a hash', 'not a hash'],
      ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'],
      ['argon2i', rebuilt({ head: 'argon2i' })],
      ['argon2d', rebuilt({ head: 'argon2d' })],
      ['an upper-case algorithm name', rebuilt({ head: 'ARGON2ID' })],
      ['an older Argon2 version', rebuilt({ version: 'v=16' })],
      ['no version', GOLDEN.replace('$v=19', '')],
      ['a version with a leading zero', rebuilt({ version: 'v=019' })],
      ['no pepper version', rebuilt({ params: 'm=19456,t=2,p=1' })],
      ['parameters in another order', rebuilt({ params: 't=2,m=19456,p=1,pv=3' })],
      ['a repeated parameter', rebuilt({ params: 'm=19456,m=19456,t=2,p=1,pv=3' })],
      ['an extra parameter', rebuilt({ params: `${VALID_PARAMS},keyid=abc` })],
      ['a space in the parameters', rebuilt({ params: 'm=19456, t=2,p=1,pv=3' })],
      ['a leading zero in the memory', rebuilt({ params: 'm=019456,t=2,p=1,pv=3' })],
      ['a leading zero in the pepper version', rebuilt({ params: 'm=19456,t=2,p=1,pv=03' })],
      ['a plus sign', rebuilt({ params: 'm=+19456,t=2,p=1,pv=3' })],
      ['a hexadecimal number', rebuilt({ params: 'm=0x4c00,t=2,p=1,pv=3' })],
      ['an exponent', rebuilt({ params: 'm=1e4,t=2,p=1,pv=3' })],
      ['a negative number', rebuilt({ params: 'm=-19456,t=2,p=1,pv=3' })],
      ['zero passes', rebuilt({ params: 'm=19456,t=0,p=1,pv=3' })],
      ['zero lanes', rebuilt({ params: 'm=19456,t=2,p=0,pv=3' })],
      ['pepper version zero', rebuilt({ params: 'm=19456,t=2,p=1,pv=0' })],
      ['a pepper version of seven digits', rebuilt({ params: 'm=19456,t=2,p=1,pv=1000000' })],
      ['memory below the minimum for its lanes', rebuilt({ params: 'm=24,t=2,p=4,pv=3' })],
      ['memory that is not a multiple of 4 per lane', rebuilt({ params: 'm=19457,t=2,p=1,pv=3' })],
      ['memory of a terabyte', rebuilt({ params: 'm=1073741824,t=2,p=1,pv=3' })],
      [
        'a number too large to be exact',
        rebuilt({ params: 'm=99999999999999999999,t=2,p=1,pv=3' }),
      ],
      ['passes of a thousand', rebuilt({ params: 'm=19456,t=1000,p=1,pv=3' })],
      ['a thousand lanes', rebuilt({ params: 'm=19456,t=2,p=1000,pv=3' })],
      ['a salt one character short', rebuilt({ salt: SALT_TEXT.slice(1) })],
      ['a salt one character long', rebuilt({ salt: `${SALT_TEXT}A` })],
      ['a tag one character short', rebuilt({ tag: TAG_TEXT.slice(1) })],
      ['a tag one character long', rebuilt({ tag: `${TAG_TEXT}A` })],
      ['padding on the salt', rebuilt({ salt: `${SALT_TEXT}==` })],
      ['padding on the tag', rebuilt({ tag: `${TAG_TEXT}=` })],
      ['a base64url character in the tag', rebuilt({ tag: `${'AwMD'.repeat(10)}Aw-` })],
      ['a base64url underscore in the salt', rebuilt({ salt: `${'AgIC'.repeat(5)}A_` })],
      ['a non-canonical salt (spare bits set)', rebuilt({ salt: `${'AgIC'.repeat(5)}Ah` })],
      ['a non-canonical tag (spare bits set)', rebuilt({ tag: `${'AwMD'.repeat(10)}AwN` })],
      ['an empty salt', rebuilt({ salt: '' })],
      ['an empty tag', rebuilt({ tag: '' })],
      ['a leading space', ` ${GOLDEN}`],
      ['a trailing space', `${GOLDEN} `],
      ['a trailing newline', `${GOLDEN}\n`],
      ['a trailing dollar sign', `${GOLDEN}$`],
      ['an extra field', `${GOLDEN}$extra`],
      ['a missing leading dollar sign', GOLDEN.slice(1)],
      ['a NUL character', `${GOLDEN}\u0000`],
      ['a very long string', `${GOLDEN}${'A'.repeat(100_000)}`],
    ])('%s', (_label, text) => {
      expect(decodeArgon2idHash(text)).toBeUndefined();
    });
  });
});

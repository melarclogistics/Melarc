import { describe, expect, it } from 'vitest';

import { decodeBase32 } from '../../../test-support/base32.js';
import { Rfc6238TotpVerifier } from '../crypto/rfc6238.totp-verifier.adapter.js';
import { base32, otpauthUri } from './otpauth.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

/** RFC 4648 section 10, without the padding. */
const VECTORS: readonly (readonly [string, string])[] = [
  ['', ''],
  ['f', 'MY'],
  ['fo', 'MZXQ'],
  ['foo', 'MZXW6'],
  ['foob', 'MZXW6YQ'],
  ['fooba', 'MZXW6YTB'],
  ['foobar', 'MZXW6YTBOI'],
];

describe('the provisioning material of a TOTP factor (S0.31)', () => {
  // Break caught: a base32 that is not RFC 4648's (a different alphabet, a lost trailing group, padding left on): an authenticator
  // would compute codes from another secret and the enrolment could never be proven.
  it.each(VECTORS)('writes %j as %j', (plain, expected) => {
    expect(base32(bytes(plain))).toBe(expected);
  });

  it('writes the 20 bytes of a seed as 32 characters of the alphabet and no padding, and reads back to the seed', () => {
    const seed = new Rfc6238TotpVerifier({ now: () => new Date(0) }).newSeed();
    const text = base32(seed);
    expect(text).toMatch(/^[A-Z2-7]{32}$/);
    expect(Array.from(decodeBase32(text))).toEqual(Array.from(seed));
  });

  it('writes every possible byte value without losing or inventing a bit', () => {
    const all = Uint8Array.from({ length: 256 }, (_, at) => at);
    expect(Array.from(decodeBase32(base32(all)))).toEqual(Array.from(all));
  });

  describe('the key URI', () => {
    const seed = bytes('12345678901234567890');
    const uri = new URL(
      otpauthUri({ issuer: 'Melarc', account: 'ama.mensah@melarc.example', seed }),
    );

    // Break caught: a URI an authenticator reads differently from the server's verifier: another algorithm, digits or period, or a
    // secret that is not the seed (the sealed seed and the provisioned one must be the same bytes).
    it('names the TOTP scheme, the account under the issuer, and the parameters the verifier is built on', () => {
      expect(uri.protocol).toBe('otpauth:');
      expect(uri.hostname).toBe('totp');
      expect(decodeURIComponent(uri.pathname.slice(1))).toBe('Melarc:ama.mensah@melarc.example');
      expect(uri.searchParams.get('issuer')).toBe('Melarc');
      expect(uri.searchParams.get('algorithm')).toBe('SHA1');
      expect(uri.searchParams.get('digits')).toBe('6');
      expect(uri.searchParams.get('period')).toBe('30');
      expect([...uri.searchParams.keys()].toSorted()).toEqual([
        'algorithm',
        'digits',
        'issuer',
        'period',
        'secret',
      ]);
    });

    it('carries the seed, as base32, and nothing else secret', () => {
      const secret = uri.searchParams.get('secret') ?? '';
      expect(secret).toBe(base32(seed));
      expect(Array.from(decodeBase32(secret))).toEqual(Array.from(seed));
    });

    // Break caught: an account label that breaks the URI (a plus tag, an at sign, a space or a colon read as a separator).
    it('percent-encodes an issuer and an account that hold characters of the URI', () => {
      const awkward = otpauthUri({ issuer: 'Mel arc', account: 'a+b c:d@melarc.example', seed });
      expect(awkward).toContain('otpauth://totp/Mel%20arc:a%2Bb%20c%3Ad%40melarc.example?');
      expect(awkward).toContain('&issuer=Mel%20arc&');
      const parsed = new URL(awkward);
      expect(parsed.searchParams.get('issuer')).toBe('Mel arc');
    });

    it('refuses a URI with no seed, no issuer or no account', () => {
      expect(() =>
        otpauthUri({ issuer: 'Melarc', account: 'a@b.example', seed: new Uint8Array(0) }),
      ).toThrow(TypeError);
      expect(() => otpauthUri({ issuer: ' ', account: 'a@b.example', seed })).toThrow(TypeError);
      expect(() => otpauthUri({ issuer: 'Melarc', account: '', seed })).toThrow(TypeError);
    });
  });

  it('makes a URI whose seed verifies a code the server computes from the same bytes', () => {
    const verifier = new Rfc6238TotpVerifier({ now: () => new Date(59_000) });
    const seed = bytes('12345678901234567890');
    const fromUri = decodeBase32(
      new URL(otpauthUri({ issuer: 'Melarc', account: 'a@b.example', seed })).searchParams.get(
        'secret',
      ) ?? '',
    );
    // RFC 6238 appendix B: at T = 59 s the 6-digit code for this seed is 287082.
    expect(verifier.verify(fromUri, '287082', null)).toEqual({ outcome: 'ACCEPTED', step: 1 });
  });
});

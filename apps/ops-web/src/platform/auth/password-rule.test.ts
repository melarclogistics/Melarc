import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX, PASSWORD_MIN, passwordFault, signInPasswordTooLong } from './password-rule';

/**
 * The credential rule of contracts/openapi.yaml `CredentialSetup` and SECURITY_DESIGN section 13.4a, as the page can check it for a person's
 * convenience: 12 to 128 characters counted in Unicode code points, both as typed and after NFKC normalisation, and both must hold; spaces
 * allowed; no composition rule. The server counts again and decides.
 */
describe('passwordFault: the length rule of a new password', () => {
  it('has the contract’s bounds', () => {
    expect(PASSWORD_MIN).toBe(12);
    expect(PASSWORD_MAX).toBe(128);
  });

  it('accepts 12 and 128 characters and nothing needs a mixture', () => {
    expect(passwordFault('a'.repeat(12))).toBeUndefined();
    expect(passwordFault('a'.repeat(128))).toBeUndefined();
    expect(passwordFault('lowercase only here')).toBeUndefined();
  });

  it('refuses 11 characters as too short, and 129 as too long', () => {
    expect(passwordFault('a'.repeat(11))).toBe('too-short');
    expect(passwordFault('')).toBe('too-short');
    expect(passwordFault('a'.repeat(129))).toBe('too-long');
  });

  // Break caught: a page that trims what the person typed, or demands a mixture the rule does not have.
  it('lets spaces count and does not trim them', () => {
    expect(passwordFault(' '.repeat(12))).toBeUndefined();
    expect(passwordFault(`  ${'a'.repeat(10)}  `)).toBeUndefined();
    expect(passwordFault(`${'a'.repeat(5)} ${'b'.repeat(5)}`)).toBe('too-short');
  });

  // Break caught: counting UTF-16 units, so that a phrase of 12 characters outside the basic plane is "24" and a long one is refused early.
  it('counts code points and not UTF-16 units', () => {
    expect(passwordFault('😀'.repeat(12))).toBeUndefined();
    expect(passwordFault('😀'.repeat(11))).toBe('too-short');
    expect(passwordFault('😀'.repeat(128))).toBeUndefined();
    expect(passwordFault('😀'.repeat(129))).toBe('too-long');
  });

  // The contract's own example (AC-SLICE-000-87): four U+FB03 ligatures are 4 code points as typed and 12 after NFKC, and are refused.
  it('holds both counts: four ligatures that normalise to twelve are still too short as typed', () => {
    const ligatures = 'ﬃ'.repeat(4);
    expect(Array.from(ligatures)).toHaveLength(4);
    expect(Array.from(ligatures.normalize('NFKC'))).toHaveLength(12);
    expect(passwordFault(ligatures)).toBe('too-short');
  });

  // Break caught: counting only the typed text, so a value that normalises past the bound is sent and refused by the server instead.
  it('is too long when the text is within the bound as typed and past it after normalisation', () => {
    const expanding = 'ﬃ'.repeat(43);
    expect(Array.from(expanding)).toHaveLength(43);
    expect(Array.from(expanding.normalize('NFKC'))).toHaveLength(129);
    expect(passwordFault(expanding)).toBe('too-long');
  });

  // Break caught: a value that is long enough as typed but shorter than the minimum after normalisation.
  it('is too short when the text has twelve code points as typed and fewer after normalisation', () => {
    // "e" followed by a combining acute accent is two code points as typed and one ("é") once composed.
    const composing = 'é'.repeat(6);
    expect(Array.from(composing)).toHaveLength(12);
    expect(Array.from(composing.normalize('NFKC'))).toHaveLength(6);
    expect(passwordFault(composing)).toBe('too-short');
    // A full-width letter is one code point either way, and counts.
    expect(passwordFault('Ａ'.repeat(12))).toBeUndefined();
  });
});

describe('signInPasswordTooLong: the one bound a sign-in has', () => {
  // The schema caps the password as sent at 128 and checks no minimum: a short guess is simply a wrong password.
  it('is true only above 128 code points as typed', () => {
    expect(signInPasswordTooLong('a'.repeat(128))).toBe(false);
    expect(signInPasswordTooLong('a'.repeat(129))).toBe(true);
    expect(signInPasswordTooLong('a')).toBe(false);
    expect(signInPasswordTooLong('😀'.repeat(128))).toBe(false);
    expect(signInPasswordTooLong('😀'.repeat(129))).toBe(true);
  });
});

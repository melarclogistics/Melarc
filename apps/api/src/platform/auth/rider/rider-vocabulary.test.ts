import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_BYTES,
  CHALLENGE_CHARACTERS,
  CHALLENGE_PATTERN,
  DEVICE_BINDABLE_RIDER_STATUSES,
  DEVICE_PUBLIC_KEY_BYTES,
  DEVICE_PUBLIC_KEY_CHARACTERS,
  DEVICE_PUBLIC_KEY_PATTERN,
  DEVICE_SIGNATURE_MAX_CHARACTERS,
  DEVICE_SIGNATURE_MIN_CHARACTERS,
  DEVICE_SIGNATURE_PATTERN,
  RIDER_CHALLENGE_PURPOSE,
  RIDER_CHALLENGE_STATES,
  RIDER_DEVICE_KIND,
  RIDER_PHONE_PATTERN,
  RIDER_PIN_PATTERN,
  RIDER_STATUSES,
  canonicalRiderPhone,
  isRiderPin,
} from './rider-vocabulary.js';

describe('the closed sets and the shapes of the rider’s records', () => {
  // Break caught: a status added or dropped on one side of the table's CHECK and the code, which the CHECK is built from.
  it('has the five statuses of a rider, and no others', () => {
    expect([...RIDER_STATUSES]).toEqual([
      'ACTIVE',
      'INACTIVE',
      'TEMPORARILY_UNAVAILABLE',
      'SUSPENDED',
      'OFFBOARDED',
    ]);
  });

  // Break caught: a rider whose access has ended being given a credential (a status added), or a rider who may be enrolled ahead of time
  // being refused one (a status dropped). The line is a finding for the Product Owner (plan section 7.47); this holds it where it is drawn.
  it('lets a device be bound to a rider who is active, inactive or temporarily unavailable, and to no other', () => {
    expect([...DEVICE_BINDABLE_RIDER_STATUSES]).toEqual([
      'ACTIVE',
      'INACTIVE',
      'TEMPORARILY_UNAVAILABLE',
    ]);
    for (const status of RIDER_STATUSES) {
      expect(DEVICE_BINDABLE_RIDER_STATUSES.includes(status)).toBe(
        status === 'ACTIVE' || status === 'INACTIVE' || status === 'TEMPORARILY_UNAVAILABLE',
      );
    }
  });

  it('reads an E.164 number as itself and any other text as no number', () => {
    expect(RIDER_PHONE_PATTERN).toBe('^\\+[1-9][0-9]{7,14}$');
    expect(canonicalRiderPhone('+233201234567')).toBe('+233201234567');
    expect(canonicalRiderPhone('+23320123')).toBe('+23320123');
    expect(canonicalRiderPhone('+233201234567890')).toBe('+233201234567890');
    for (const text of [
      '+2332012',
      '+2332012345678901',
      '+0233201234567',
      '233201234567',
      '+233201234567 ',
      ' +233201234567',
      '+233201234567\n',
      '',
    ]) {
      expect(canonicalRiderPhone(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  // Break caught: a PIN of another length or alphabet, a number in place of its text, or a pattern left open at either end.
  it('takes a PIN of exactly six decimal digits and nothing else', () => {
    expect(RIDER_PIN_PATTERN).toBe('^[0-9]{6}$');
    for (const pin of ['000000', '123456', '999999']) expect(isRiderPin(pin)).toBe(true);
    for (const pin of [
      '12345',
      '1234567',
      '1234',
      ' 123456',
      '123456 ',
      '12345a',
      '١٢٣٤٥٦',
      '123456\n',
      '',
    ]) {
      expect(isRiderPin(pin), JSON.stringify(pin)).toBe(false);
    }
    for (const pin of [123456, null, undefined, ['123456'], { pin: '123456' }]) {
      expect(isRiderPin(pin)).toBe(false);
    }
  });

  describe('the key and the signature of the handset', () => {
    const key = Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      Buffer.alloc(65, 7),
    ]).toString('base64');

    it('is a 91-byte key in 124 characters of canonical base64', () => {
      expect(DEVICE_PUBLIC_KEY_BYTES).toBe(91);
      expect(DEVICE_PUBLIC_KEY_CHARACTERS).toBe(124);
      expect(key).toHaveLength(DEVICE_PUBLIC_KEY_CHARACTERS);
      expect(new RegExp(DEVICE_PUBLIC_KEY_PATTERN).test(key)).toBe(true);
    });

    it.each([
      ['a key one character short', key.slice(0, 123)],
      ['a key one character long', `${key}A`],
      ['a key without its padding', key.replace(/=+$/, '')],
      ['a key whose last group has a spare bit set', `${key.slice(0, 121)}B==`],
      ['a key with a character outside the alphabet', `-${key.slice(1)}`],
      ['a key with a newline', `${key}\n`],
      ['a key with text before it', `x${key}`],
    ])('does not take %s', (_label, text) => {
      expect(new RegExp(DEVICE_PUBLIC_KEY_PATTERN).test(text)).toBe(false);
    });

    it('is a signature of 12 to 96 characters in the canonical spelling', () => {
      expect(DEVICE_SIGNATURE_MIN_CHARACTERS).toBe(12);
      expect(DEVICE_SIGNATURE_MAX_CHARACTERS).toBe(96);
      const pattern = new RegExp(DEVICE_SIGNATURE_PATTERN);
      expect(pattern.test('AAAAAAAAAAAA')).toBe(true);
      expect(pattern.test(`${'A'.repeat(94)}==`)).toBe(true);
      for (const text of [
        'AAAAAAAAAAA',
        'AAAAAAAAAAAAA',
        'AAAA AAAA',
        'AAAAAAA=A=A=',
        'AAAA-AAA',
      ]) {
        expect(pattern.test(text), text).toBe(false);
      }
    });
  });

  // Break caught: a challenge or a grant token of another length, or in an alphabet that is not URL-safe, which the handset and the API would
  // read differently.
  it('has a challenge of 32 random bytes in 43 URL-safe characters', () => {
    expect(CHALLENGE_BYTES).toBe(32);
    expect(CHALLENGE_CHARACTERS).toBe(43);
    const pattern = new RegExp(CHALLENGE_PATTERN);
    expect(pattern.test('A'.repeat(43))).toBe(true);
    expect(pattern.test(`${'a-_'.repeat(14)}A`)).toBe(true);
    for (const text of [
      'A'.repeat(42),
      'A'.repeat(44),
      `${'A'.repeat(42)}+`,
      `${'A'.repeat(42)}/`,
      `${'A'.repeat(42)}=`,
      ` ${'A'.repeat(43)}`,
      `${'A'.repeat(43)}\n`,
    ]) {
      expect(pattern.test(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('names the states, the purpose and the device kind of the sign-in challenge', () => {
    expect([...RIDER_CHALLENGE_STATES]).toEqual(['PENDING', 'CONSUMED', 'EXPIRED', 'UNUSABLE']);
    expect(RIDER_CHALLENGE_PURPOSE).toBe('RIDER_SIGN_IN');
    expect(RIDER_DEVICE_KIND).toBe('RIDER_ANDROID_KEYPAIR');
  });
});

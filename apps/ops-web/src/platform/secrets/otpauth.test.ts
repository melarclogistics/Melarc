import { describe, expect, it } from 'vitest';

import { groupedKey, manualKeyOf } from './otpauth';

const URI =
  'otpauth://totp/Melarc:ama%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Melarc&period=30';

describe('manualKeyOf', () => {
  // Break caught: the manual-entry key not matching the key in the QR code, which makes the accessible alternative
  // enrol a different factor from the one the QR code does.
  it('is the secret of the provisioning URI, exactly', () => {
    expect(manualKeyOf(URI)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('finds the secret wherever it is among the parameters', () => {
    expect(manualKeyOf('otpauth://totp/x?issuer=Melarc&secret=MFRGGZDFMZTWQ2LK&period=30')).toBe(
      'MFRGGZDFMZTWQ2LK',
    );
  });

  it('keeps a secret as long as the standard authenticators accept', () => {
    const long = 'A'.repeat(64);
    expect(manualKeyOf(`otpauth://totp/x?secret=${long}`)).toBe(long);
  });

  // Break caught: something that is not a provisioning URI being shown as a key, or a secret that is not base32.
  it.each([
    ['an empty string', ''],
    ['a web address', 'https://example.com/?secret=JBSWY3DPEHPK3PXP'],
    ['a URI of another scheme', 'otpauth-migration://offline?data=AAAA'],
    ['a URI of another type', 'otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1'],
    ['no secret', 'otpauth://totp/x?issuer=Melarc'],
    ['an empty secret', 'otpauth://totp/x?secret='],
    ['a secret with characters outside base32', 'otpauth://totp/x?secret=jbswy3dp0189'],
    ['a secret too short to be a key', 'otpauth://totp/x?secret=AAAA'],
    ['a secret too long to be a key', `otpauth://totp/x?secret=${'A'.repeat(200)}`],
    ['two secrets', 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&secret=MFRGGZDFMZTWQ2LK'],
    ['not a URL at all', 'secret=JBSWY3DPEHPK3PXP'],
  ])('is nothing for %s', (_label, uri) => {
    expect(manualKeyOf(uri)).toBeUndefined();
  });
});

describe('groupedKey', () => {
  // Break caught: a long key shown as one unbroken run, which is hard to read aloud and to type without losing the place.
  it('shows the key in groups of four', () => {
    expect(groupedKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
  });

  it('keeps a last group that is shorter', () => {
    expect(groupedKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });

  it('takes a size', () => {
    expect(groupedKey('ABCDEFGHIJ', 5)).toBe('ABCDE FGHIJ');
  });

  it('adds nothing but the spaces', () => {
    expect(groupedKey('JBSWY3DPEHPK3PXP').replaceAll(' ', '')).toBe('JBSWY3DPEHPK3PXP');
  });
});

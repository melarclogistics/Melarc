import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { KEY_PURPOSES, keyEnvName, parseKeyMaterial, type KeyPurpose } from './key-material.js';

const key = (): string => randomBytes(32).toString('base64url');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The same 32 bytes written with the two spare bits of the last character set: another spelling of one key. */
function nonCanonical(valid: string): string {
  // 32 bytes are 256 bits and 43 characters carry 258: the last character's low two bits are spare and a canonical key has
  // them clear, so setting one gives a different spelling of the same bytes.
  const index = ALPHABET.indexOf(valid.charAt(42));
  return valid.slice(0, 42) + ALPHABET.charAt(index | 1);
}

describe('the key purposes (SECURITY_DESIGN.md §14.9)', () => {
  // Break caught: a purpose added, dropped or renamed without the design saying so.
  it('are the five of the design, each with its own pair of settings', () => {
    expect([...KEY_PURPOSES]).toEqual([
      'totp_seed',
      'credential_delivery',
      'idempotent_replay',
      'limiter_digest',
      'password_pepper',
    ]);
    expect(KEY_PURPOSES.map((purpose) => keyEnvName(purpose, 'MATERIAL'))).toEqual([
      'KEY_TOTP_SEED_MATERIAL',
      'KEY_CREDENTIAL_DELIVERY_MATERIAL',
      'KEY_IDEMPOTENT_REPLAY_MATERIAL',
      'KEY_LIMITER_DIGEST_MATERIAL',
      'KEY_PASSWORD_PEPPER_MATERIAL',
    ]);
    expect(keyEnvName('password_pepper' satisfies KeyPurpose, 'ACTIVE_VERSION')).toBe(
      'KEY_PASSWORD_PEPPER_ACTIVE_VERSION',
    );
  });
});

describe('parseKeyMaterial', () => {
  it('reads one versioned key', () => {
    const value = key();
    const parsed = parseKeyMaterial(`1:${value}`);

    expect(parsed?.map(([version]) => version)).toEqual([1]);
    expect(parsed?.[0]?.[1].reveal()).toBe(value);
  });

  // Break caught: rotation that drops the old key, so records sealed under it can no longer be opened.
  it('reads several versions and keeps all of them, in order', () => {
    const [a, b, c] = [key(), key(), key()];
    const parsed = parseKeyMaterial(`1:${a},2:${b},7:${c}`);

    expect(parsed?.map(([version, secret]) => [version, secret.reveal()])).toEqual([
      [1, a],
      [2, b],
      [7, c],
    ]);
  });

  it.each([
    ['nothing', ''],
    ['a placeholder', '1:CHANGE_ME'],
    ['no version', key()],
    ['a version with no key', '1:'],
    ['version zero', `0:${key()}`],
    ['a leading zero in the version', `01:${key()}`],
    ['a version too large', `1000000:${key()}`],
    ['a negative version', `-1:${key()}`],
    ['a key one character short', `1:${key().slice(1)}`],
    ['a key one character long', `1:${key()}A`],
    ['padding', `1:${key()}=`],
    ['standard base64 characters', `1:${key().slice(0, 40)}+/A`],
    ['whitespace around an entry', ` 1:${key()}`],
    ['whitespace between entries', `1:${key()}, 2:${key()}`],
    ['a trailing comma', `1:${key()},`],
    ['a repeated version', `1:${key()},1:${key()}`],
    ['nine versions', Array.from({ length: 9 }, (_, i) => `${String(i + 1)}:${key()}`).join(',')],
    ['a quoted value', `"1:${key()}"`],
  ])('refuses %s', (_label, text) => {
    expect(parseKeyMaterial(text)).toBeUndefined();
  });

  // Break caught: one key written two ways, so a key compared as text could appear to differ from itself.
  it('refuses a key spelled with its spare bits set, which decodes to the same bytes', () => {
    const valid = key();
    const spelled = nonCanonical(valid);

    expect(Buffer.from(spelled, 'base64url').equals(Buffer.from(valid, 'base64url'))).toBe(true);
    expect(spelled).not.toBe(valid);
    expect(parseKeyMaterial(`1:${spelled}`)).toBeUndefined();
  });

  it('accepts exactly eight versions', () => {
    const text = Array.from({ length: 8 }, (_, i) => `${String(i + 1)}:${key()}`).join(',');

    expect(parseKeyMaterial(text)).toHaveLength(8);
  });
});

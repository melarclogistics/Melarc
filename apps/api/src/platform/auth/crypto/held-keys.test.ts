import { describe, expect, it } from 'vitest';

import { keyBytes, localKeys, purposeKeys } from '../../../test-support/key-config.js';
import { Secret } from '../../config/secret.js';
import { heldKeys } from './held-keys.js';

describe('heldKeys', () => {
  it('holds nothing without key custody, and for a purpose the configuration never held', () => {
    expect(heldKeys({ custody: 'describe' }, 'password_pepper')).toBeUndefined();
    expect(heldKeys(localKeys({}, ['password_pepper']), 'password_pepper')).toBeUndefined();
    expect(heldKeys(localKeys({}, ['password_pepper']), 'totp_seed')).toBeDefined();
  });

  it('decodes every version of the purpose to the 32 bytes it spells, and keeps the active one', () => {
    const keys = purposeKeys([1, 2, 5], 2);

    const held = heldKeys(localKeys({ totp_seed: keys }), 'totp_seed');

    expect(held?.activeVersion).toBe(2);
    expect([...(held?.keys.keys() ?? [])].sort()).toEqual([1, 2, 5]);
    for (const version of [1, 2, 5]) {
      expect(held?.keys.get(version)?.equals(keyBytes(keys, version))).toBe(true);
    }
  });

  it('does not decide whether the active version is held: a configuration made by hand may name one that is not', () => {
    const held = heldKeys(
      localKeys({ totp_seed: { activeVersion: 9, versions: purposeKeys([1]).versions } }),
      'totp_seed',
    );

    expect(held?.activeVersion).toBe(9);
    expect(held?.keys.has(9)).toBe(false);
  });

  // Break caught: a key left as a view into Node's shared 8 KiB Buffer pool, where it shares an ArrayBuffer with every other small
  // Buffer made from a string. A key lives as long as the process, and any later exposure of `.buffer` by unrelated code would
  // then show the pool: the pepper and the AES keys with it.
  it('gives each key an ArrayBuffer of its own, exactly 32 bytes long', () => {
    const held = heldKeys(
      localKeys({ password_pepper: purposeKeys([1, 2, 3]) }),
      'password_pepper',
    );

    expect(held?.keys.size).toBe(3);
    for (const key of held?.keys.values() ?? []) {
      expect(key.length).toBe(32);
      expect(key.byteOffset).toBe(0);
      expect(key.buffer.byteLength).toBe(32);
    }
    const [first, second] = [...(held?.keys.values() ?? [])];
    expect(first?.buffer).not.toBe(second?.buffer);
  });

  it.each([
    ['a key that is not 43 characters', new Secret('SENTINEL-too-short')],
    ['a key with padding', new Secret(`${'A'.repeat(42)}=`)],
    ['a key that is not canonical', new Secret(`${'A'.repeat(42)}B`)],
    ['a key of standard base64', new Secret(`${'A'.repeat(40)}+/A`)],
  ])('refuses %s, and does not repeat it', (_label, secret) => {
    const keys = localKeys({ totp_seed: { activeVersion: 1, versions: { 1: secret } } });
    let thrown: unknown;
    try {
      heldKeys(keys, 'totp_seed');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect(String(thrown)).not.toContain('SENTINEL');
    expect(String(thrown)).not.toContain(secret.reveal());
  });

  it.each([['0'], ['-1'], ['1.5'], ['one']])('refuses the version "%s"', (version) => {
    const keys = localKeys({
      totp_seed: {
        activeVersion: 1,
        versions: { [version]: purposeKeys([1]).versions[1] } as never,
      },
    });

    expect(() => heldKeys(keys, 'totp_seed')).toThrow(TypeError);
  });
});

import { describe, expect, it } from 'vitest';

import type { PortDescriptorShape } from '../ports/port-descriptor.js';
import { HASHER_DESCRIPTOR } from '../ports/hasher.port.js';
import { SECRET_CIPHER_DESCRIPTOR } from '../ports/secret-cipher.port.js';
import { TOKEN_SERVICE_DESCRIPTOR } from '../ports/token-service.port.js';
import { TOTP_VERIFIER_DESCRIPTOR } from '../ports/totp-verifier.port.js';
import { CRYPTO_CONDITIONS, CryptoConditionError } from './condition.js';

const raisedBy = (descriptor: PortDescriptorShape): string[] =>
  Object.values(descriptor.operations).flatMap((operation) =>
    operation.raises === 'none' ? [] : [...operation.raises],
  );

describe('the conditions the cryptographic adapters raise', () => {
  // Break caught: an adapter that raises a name its port never declared, or a declared name that no adapter can raise, so a
  // caller written against the descriptor handles a condition that never comes (or misses one that does).
  it('are exactly the conditions the four port descriptors declare', () => {
    const declared = [
      HASHER_DESCRIPTOR,
      SECRET_CIPHER_DESCRIPTOR,
      TOKEN_SERVICE_DESCRIPTOR,
      TOTP_VERIFIER_DESCRIPTOR,
    ].flatMap(raisedBy);

    expect([...CRYPTO_CONDITIONS].sort()).toEqual([...new Set(declared)].sort());
  });

  it.each(CRYPTO_CONDITIONS)('%s is an Error that carries its name and a fixed message', (name) => {
    const error = new CryptoConditionError(name);

    expect(error).toBeInstanceOf(Error);
    expect(error.condition).toBe(name);
    expect(error.name).toBe('CryptoConditionError');
    expect(error.message.length).toBeGreaterThan(10);
    // The message is the same every time: it is static text and is built from nothing that was supplied.
    expect(new CryptoConditionError(name).message).toBe(error.message);
  });

  it('gives each condition its own message', () => {
    const messages = CRYPTO_CONDITIONS.map((name) => new CryptoConditionError(name).message);

    expect(new Set(messages).size).toBe(CRYPTO_CONDITIONS.length);
  });
});

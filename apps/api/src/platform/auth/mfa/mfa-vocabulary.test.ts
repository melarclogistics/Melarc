import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FACTOR_CREATING_PURPOSES } from '../setup-grants/setup-grant-vocabulary.js';
import {
  FACTOR_COUNTER_PATTERN,
  FACTOR_CREATED_BY_PURPOSES,
  FACTOR_STATUSES,
  FACTOR_TYPES,
  SEALED_NONCE_BYTES,
  SEALED_TAG_BYTES,
  TOTP_SEED_OPERATION,
  isFactorCounter,
} from './mfa-vocabulary.js';

const STATE_MACHINES = readFileSync(
  resolve(import.meta.dirname, '../../../../../../contracts/state-machines.md'),
  'utf8',
).replaceAll('\r', '');

describe('the vocabulary of an MFA factor (domain-model.md §6.8 `MfaFactor`, state-machines.md §18)', () => {
  // Break caught: SMS or any other factor admitted for privileged staff ("SMS is deliberately not a privileged factor").
  it('has one factor type, TOTP', () => {
    expect([...FACTOR_TYPES]).toEqual(['TOTP']);
  });

  it('has the three statuses of the machine, REVOKED terminal', () => {
    expect([...FACTOR_STATUSES]).toEqual(['PENDING', 'ACTIVE', 'REVOKED']);
    expect(STATE_MACHINES).toMatch(
      /States: `PENDING` · `ACTIVE` · `REVOKED`\. Terminal: `REVOKED`\./,
    );
  });

  // Break caught: a factor's creating purposes drifting from the grant's: the column is the purpose of the grant whose consumption
  // created the factor, so the two lists are one.
  it('records as its creating purpose one of the three purposes that create a factor, and no other', () => {
    expect([...FACTOR_CREATED_BY_PURPOSES]).toEqual([...FACTOR_CREATING_PURPOSES]);
  });

  // Break caught: the time step of the last accepted code stored in a form that does not compare, so that replay protection fails.
  it('writes the last accepted time step as plain decimal digits without a leading zero', () => {
    for (const text of ['0', '1', '59000000', '9'.repeat(19)]) {
      expect(isFactorCounter(text), text).toBe(true);
    }
    for (const text of ['', '01', '-1', '1.5', ' 7', 'abc', '9'.repeat(20), '١٢٣']) {
      expect(isFactorCounter(text), text).toBe(false);
    }
    expect(isFactorCounter(7)).toBe(false);
    expect(isFactorCounter(null)).toBe(false);
    expect(FACTOR_COUNTER_PATTERN.test('12')).toBe(true);
  });

  // Break caught: the table's constraint on the envelope drifting from the cipher's (a 96-bit nonce, a 16-byte tag).
  it('holds a seed sealed as the cipher seals it', () => {
    expect(SEALED_NONCE_BYTES).toBe(12);
    expect(SEALED_TAG_BYTES).toBe(16);
  });

  // Break caught: the name the seed is sealed under changing between sealing and opening, which would make every stored seed unreadable.
  it('names the operation the seed is sealed for as one constant', () => {
    expect(TOTP_SEED_OPERATION).toBe('mfa.totp_seed');
  });
});

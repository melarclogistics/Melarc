import { describe, expect, it } from 'vitest';

import { MAX_ADDRESS_BYTES, STAFF_SIGN_IN_LIMIT } from './staff-sign-in-limit.js';

const keyOf = (raw: string): string | undefined => STAFF_SIGN_IN_LIMIT.canonical(raw);

describe('the limit of the staff sign-in (S0.32; AC-SLICE-000-81)', () => {
  // Break caught: the bound the limiter takes a key from and the bound the service refuses above drifting apart, which would let a
  // text between them (or a padded address) reach the lookup with no limit (the service tests send one past the bound).
  it('takes its key from texts up to the bound the service refuses above, and from no longer one', () => {
    expect(STAFF_SIGN_IN_LIMIT.identifier.maxBytes).toBe(MAX_ADDRESS_BYTES);
    expect(MAX_ADDRESS_BYTES).toBe(4 * 320);
  });

  // Break caught: the sign-in's bucket or field changed, or a limit keyed on something other than the address the body carries.
  it('is the staff sign-in bucket, keyed on the address of the body', () => {
    expect(STAFF_SIGN_IN_LIMIT.bucket).toBe('rate_limit_staff_signin');
    expect(STAFF_SIGN_IN_LIMIT.identifier.field).toBe('email');
  });

  // Break caught: two spellings of one address with a key each (one could be used to dodge the count of the other), or a key that is
  // not the canonical form the table's uniqueness is decided on.
  it('keys on the canonical form: trimmed, normalised and lower-cased as a whole, nothing folded', () => {
    expect(keyOf('  Alice@Example.COM \n')).toBe('alice@example.com');
    expect(keyOf('alice@example.com')).toBe('alice@example.com');
    expect(keyOf('a.lice@example.com')).not.toBe(keyOf('alice@example.com'));
    expect(keyOf('alice+tag@example.com')).not.toBe(keyOf('alice@example.com'));
  });

  // Break caught: a key made only for an address that exists (the answer would tell a real address from an invented one): any address
  // in the canonical form is a key.
  it('takes a key for an address that belongs to nobody', () => {
    expect(keyOf('nobody.at.all@example.test')).toBe('nobody.at.all@example.test');
  });

  // Break caught: a text that is not an address filling the limiter's table, or a lone surrogate carried into a key.
  it('takes no key for a text that is not an address, nor for a lone surrogate', () => {
    expect(keyOf('not an address')).toBeUndefined();
    expect(keyOf('alice@example')).toBeUndefined();
    expect(keyOf('alice@example.com\uD800')).toBeUndefined();
    expect(keyOf(`${'a'.repeat(400)}@example.com`)).toBeUndefined();
  });
});

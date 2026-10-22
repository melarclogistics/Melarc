import { describe, expect, it } from 'vitest';

import { STAFF_MFA_SIGN_IN_LIMIT } from './staff-mfa-sign-in-limit.js';

const keyOf = (raw: string): string | undefined => STAFF_MFA_SIGN_IN_LIMIT.canonical(raw);
const REFERENCE = '0192f0a1-7b3c-7d2e-8f41-a5b6c7d8e9f0';

describe('the limit of the second step of the staff sign-in (S0.33)', () => {
  // Break caught: the privileged MFA bucket or the field of the challenge changed, or a limit keyed on the network address.
  it('is the privileged MFA bucket, keyed on the challenge reference of the body', () => {
    expect(STAFF_MFA_SIGN_IN_LIMIT.bucket).toBe('rate_limit_privileged_mfa');
    expect(STAFF_MFA_SIGN_IN_LIMIT.identifier.field).toBe('challenge_id');
  });

  // Break caught: two spellings of one reference with a key each (one could be used to dodge the count of the other).
  it('keys on the reference in lower case, so that its spellings share one count', () => {
    expect(keyOf(REFERENCE.toUpperCase())).toBe(REFERENCE);
    expect(keyOf(REFERENCE)).toBe(REFERENCE);
  });

  // Break caught: a key made only for a reference that names a challenge (the answer would tell a real challenge from an invented
  // one): any well-formed reference is a key.
  it('takes a key for a reference that names no challenge', () => {
    expect(keyOf('00000000-0000-4000-8000-000000000000')).toBe(
      '00000000-0000-4000-8000-000000000000',
    );
  });

  // Break caught: a text that is not a reference filling the limiter's table.
  it('takes no key for a text that is not a UUID', () => {
    for (const text of [
      '',
      'not-a-uuid',
      `${REFERENCE}0`,
      ` ${REFERENCE}`,
      REFERENCE.replaceAll('-', ''),
    ]) {
      expect(keyOf(text), text).toBeUndefined();
    }
  });
});

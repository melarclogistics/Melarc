import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { setupTokenLimit } from './staff-setup-limit.js';

const TOKEN = 'A'.repeat(43);

describe('the limit of a credential setup operation (S0.31; AC-SLICE-000-125)', () => {
  // Break caught: a bucket other than the shared recovery bucket (a seventh bucket, or the sign-in's), or an identifier taken from a
  // member other than the token the request presents.
  it('is the recovery bucket, keyed on the bounded setup token of the body', () => {
    const limit = setupTokenLimit('STAFF_CREDENTIAL_SETUP');

    expect(limit.bucket).toBe('rate_limit_recovery');
    expect(limit.identifier).toEqual({ field: 'setup_token', maxBytes: 128 });
  });

  // Break caught: a key that is the token itself, or any part of it: the limiter would hold a secret in the clear, and the digest it
  // makes of the key would be a digest of the secret.
  it('keys on a digest that holds no part of the token', () => {
    const key = setupTokenLimit('MFA_ENROLMENT').canonical(TOKEN);

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).not.toContain(TOKEN.slice(0, 8));
    // And not the bare SHA-256 of the token either: the purpose is part of what is digested.
    expect(key).not.toBe(createHash('sha256').update(TOKEN, 'utf8').digest('base64url'));
  });

  // Break caught (AC-125: "a value presented to one operation never counts against another operation's purpose"): a key that does
  // not carry the purpose, so that ten attempts at one operation spend the allowance of the other two.
  it('qualifies the key by the purpose, so one value has a key of its own at each operation', () => {
    const keys = (['STAFF_CREDENTIAL_SETUP', 'MFA_ENROLMENT', 'MFA_REENROLMENT'] as const).map(
      (purpose) => setupTokenLimit(purpose).canonical(TOKEN),
    );

    expect(new Set(keys).size).toBe(3);
  });

  it('gives one key to one value at one operation, and another to another value', () => {
    const limit = setupTokenLimit('MFA_REENROLMENT');

    expect(limit.canonical(TOKEN)).toBe(limit.canonical(TOKEN));
    expect(limit.canonical(TOKEN)).not.toBe(limit.canonical(`B${TOKEN.slice(1)}`));
    // Exactly as sent: no case-folding, no trimming, so two spellings are two keys and one cannot be used to dodge the count.
    expect(limit.canonical(TOKEN)).not.toBe(limit.canonical(TOKEN.toLowerCase()));
    expect(limit.canonical(TOKEN)).not.toBe(limit.canonical(` ${TOKEN}`));
  });

  // Break caught: a made-up value taking no key ("taken whether or not the server can resolve it"): any bounded text is a key.
  it('takes a key for text that is not a token at all', () => {
    expect(setupTokenLimit('STAFF_CREDENTIAL_SETUP').canonical('not-a-token')).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
  });
});

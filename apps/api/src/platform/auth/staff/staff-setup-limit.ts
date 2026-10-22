import { createHash } from 'node:crypto';

import type { AnonymousLimit } from '../../routes/access-declaration.js';

/** The longest a submitted setup token may be, in bytes, for the limiter to take it as a key: a token is 43 characters. */
const MAX_TOKEN_BYTES = 128;

/** The namespace of the key: a digest made here is not a digest of anything else. */
const NAMESPACE = 'melarc.setup-token.v1';

/**
 * The limit of one of the three setup operations (settings.md §7.5; `AC-SLICE-000-125`): the `rate_limit_recovery` bucket, keyed on
 * **the purpose-qualified SHA-256 digest of the bounded token the request presents**, whether or not the server can resolve it, so
 * that a value presented to one operation never counts against another operation's purpose, an invented token has a key of its own
 * (the per-address ceiling at the edge bounds the cost of that), and the key holds no part of a token. The limiter digests the key
 * once more under its own key before it stores anything.
 *
 * The qualifier is the **purpose of the grant the operation serves**, so `completeStaffCredentialSetup` (which serves both the
 * ordinary grant and the bootstrap secret) is one operation and one key space.
 */
export function setupTokenLimit(
  purpose: 'STAFF_CREDENTIAL_SETUP' | 'MFA_ENROLMENT' | 'MFA_REENROLMENT',
): AnonymousLimit {
  return {
    bucket: 'rate_limit_recovery',
    identifier: { field: 'setup_token', maxBytes: MAX_TOKEN_BYTES },
    canonical: (token) =>
      createHash('sha256')
        .update(`${NAMESPACE}\u0000${purpose}\u0000`, 'utf8')
        .update(token, 'utf8')
        .digest('base64url'),
  };
}

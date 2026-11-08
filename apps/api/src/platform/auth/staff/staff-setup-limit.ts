import { createHash } from 'node:crypto';

import type { AnonymousLimit } from '../../routes/access-declaration.js';

/** The longest a submitted setup token may be, in bytes, for the limiter to take it as a key: a token is 43 characters. */
const MAX_TOKEN_BYTES = 128;

/** The namespace of the key: a digest made here is not a digest of anything else. */
const NAMESPACE = 'melarc.setup-token.v1';

/**
 * The limit of one of the setup operations (the staff's three, the vendor's two of S0.47 and S0.49 and the rider's enrolment of S0.57; settings.md §7.5; `AC-SLICE-000-125`): the `rate_limit_recovery` bucket, keyed on
 * **the purpose-qualified SHA-256 digest of the bounded token the request presents**, whether or not the server can resolve it, so
 * that a value presented to one operation never counts against another operation's purpose, an invented token has a key of its own
 * (the per-address ceiling at the edge bounds the cost of that), and the key holds no part of a token. The limiter digests the key
 * once more under its own key before it stores anything.
 *
 * The qualifier is the **purpose of the grant the operation serves**, so `completeStaffCredentialSetup` (which serves both the
 * ordinary grant and the bootstrap secret) is one operation and one key space, and so is `completeRiderDeviceEnrolment` (S0.57), which
 * serves both the first binding and the replacement under the qualifier `RIDER_DEVICE_ENROLMENT`.
 */
export function setupTokenLimit(
  purpose:
    | 'STAFF_CREDENTIAL_SETUP'
    | 'MFA_ENROLMENT'
    | 'MFA_REENROLMENT'
    | 'VENDOR_CREDENTIAL_SETUP'
    | 'VENDOR_DEVICE_ENROLMENT'
    | 'RIDER_DEVICE_ENROLMENT',
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

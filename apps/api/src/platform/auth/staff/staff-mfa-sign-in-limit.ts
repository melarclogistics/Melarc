import type { AnonymousLimit } from '../../routes/access-declaration.js';

/** A challenge reference is a UUID: 36 characters, so 64 bytes is room for it and for nothing longer. */
const MAX_REFERENCE_BYTES = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The limit of `completeStaffMfaSignIn` (settings.md §7.5; SECURITY_DESIGN.md §13.4b): the `rate_limit_privileged_mfa` bucket, **keyed
 * on the challenge reference the request carries, whether or not it names a challenge** (a request naming a reference that does not
 * exist is limited exactly as one that does, so `RATE_LIMITED` is never a signal that a challenge is real). A challenge belongs to
 * one principal and to nobody else, so its reference is that principal's key. A text that is not a UUID takes no key: the request is
 * refused by validation, which does no work and counts nothing.
 */
export const STAFF_MFA_SIGN_IN_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_privileged_mfa',
  identifier: { field: 'challenge_id', maxBytes: MAX_REFERENCE_BYTES },
  canonical: (reference) => (UUID.test(reference) ? reference.toLowerCase() : undefined),
};

import { canonicalWorkEmail, isEmailShape } from '../credentials/work-email.js';
import type { AnonymousLimit } from '../../routes/access-declaration.js';

/**
 * The longest an address may be for the limiter to take it as a key, in bytes: 320 characters of up to four bytes each. A longer text
 * takes no key, so a request carrying one meets the coarse limits only. **It must therefore be refused before any work**
 * (`StaffSignInService` does, as `VALIDATION_FAILED`): the service trims before it judges, so a valid address padded with white space
 * past this bound would otherwise skip the limit and be looked up and verified like any other.
 */
export const MAX_ADDRESS_BYTES = 1280;

/**
 * The limit of `staffSignIn` (settings.md §7.5; `AC-SLICE-000-81`): the `rate_limit_staff_signin` bucket, **keyed on the canonical
 * form of the address the request carries, whether or not it belongs to anyone**, and not on the network address. A made-up address is
 * limited exactly as a real one, so `RATE_LIMITED` is never a signal that an address is real. A text that is not an address takes no
 * key: the request is refused by validation, which does no work and counts nothing.
 */
export const STAFF_SIGN_IN_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_staff_signin',
  identifier: { field: 'email', maxBytes: MAX_ADDRESS_BYTES },
  canonical: (raw) => {
    const canonical = canonicalWorkEmail(raw);
    return canonical.ok && isEmailShape(canonical.email) ? canonical.email : undefined;
  },
};

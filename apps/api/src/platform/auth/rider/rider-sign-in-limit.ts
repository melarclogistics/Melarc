import type { AnonymousClient, AnonymousLimit } from '../../routes/access-declaration.js';
import { canonicalRiderPhone } from './rider-vocabulary.js';

/** The longest an E.164 number is, in bytes: a plus sign and fifteen digits. A longer text takes no key and is refused before any work. */
export const MAX_PHONE_BYTES = 16;

/**
 * The limit of the rider's two pre-session sign-in operations (settings.md section 7.5, `rate_limit_rider_challenge`, 20 a minute;
 * SECURITY_DESIGN.md section 13.4b, "rate limiting is separate and first"): **keyed on the canonical form of the number the request carries,
 * whether or not it belongs to a rider**, for the challenge request and for the sign-in that follows it, which draw on one bucket. A number
 * that matched no rider is limited exactly as one that did, so `RATE_LIMITED` is never a signal that a rider exists. A text that is not an
 * E.164 number takes no key: the request is refused by the service as invalid, before any work, and counts nothing.
 */
export const RIDER_PHONE_LIMIT: AnonymousLimit = {
  bucket: 'rate_limit_rider_challenge',
  identifier: { field: 'phone', maxBytes: MAX_PHONE_BYTES },
  canonical: canonicalRiderPhone,
};

/**
 * The Melarc Rider app: a native client that carries no `Origin` under its declared protocol and is never refused for lacking one (S0.25), and
 * that accepts no browser session cookie. The rider's pre-session operations are reachable at the Rider host as well as same-origin.
 */
export const RIDER_NATIVE_CLIENT: AnonymousClient = { kind: 'native' };

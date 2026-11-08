import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * What a rider's sign-in challenge is bound to (domain-model.md section 6.8 `RiderSignInChallenge`; SECURITY_DESIGN.md section 13.6): the
 * canonical phone number it was requested for, the environment and service that issued it, and the rider's `ACTIVE` device at the time. Each
 * is kept as a namespaced SHA-256 digest of the canonical text and never as the text (a row can be compared with a number and a person
 * cannot read one out of it), and a digest made for one purpose is not a digest of anything else.
 *
 * **A digest is a binding and not a privacy control**: the space of telephone numbers is small enough to enumerate, so an unkeyed digest of
 * one does not hide it from a reader of the row. The table is readable by the authentication capability alone, which is what keeps it
 * private (plan section 7.47).
 */
const PHONE_NAMESPACE = 'melarc.rider-challenge.phone.v1';
const DEVICE_NAMESPACE = 'melarc.rider-challenge.device-context.v1';

export const RIDER_CHALLENGE_NO_RIDER = '00000000-0000-0000-0000-000000000000';

/** The binding to a number: the digest of its canonical (E.164) form. A number that matched no rider is bound exactly the same way. */
export function phoneBinding(canonicalPhone: string): Buffer {
  return createHash('sha256').update(`${PHONE_NAMESPACE}\u0000${canonicalPhone}`, 'utf8').digest();
}

/** The binding to the rider's `ACTIVE` device: the digest of its registration id, never the id and never its key. */
export function deviceContextBinding(deviceId: string): Buffer {
  return createHash('sha256')
    .update(`${DEVICE_NAMESPACE}\u0000${deviceId.toLowerCase()}`, 'utf8')
    .digest();
}

/** The environment and service a challenge is issued for: a challenge carried to another one is `CHALLENGE_UNUSABLE`. */
export function riderChallengeAudience(appEnv: string): string {
  return `melarc-api/${appEnv}`;
}

/** Whether two bindings are the same, compared in constant time; an absent binding equals only an absent one. */
export function sameBinding(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && timingSafeEqual(left, right);
}

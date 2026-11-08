/**
 * The closed sets and the shapes of the rider's identity records (domain-model.md section 6.8 `RiderIdentity`, `RegisteredDevice`,
 * `RiderSignInChallenge`; SECURITY_DESIGN.md sections 13.6 and 15.2.1). The tables repeat each set as a CHECK, built from these
 * constants, so the code and the database cannot drift apart. They live in `platform/auth` because the credential services read them; the
 * tables themselves are the staff domain's (`src/staff/`, the rider identity and its devices), which imports these and never the reverse.
 */

/** `RiderIdentity.status` (domain-model.md section 6.8; section 30.6): set by hand, and by SLICE-009's administration, never here. */
export const RIDER_STATUSES = [
  'ACTIVE',
  'INACTIVE',
  'TEMPORARILY_UNAVAILABLE',
  'SUSPENDED',
  'OFFBOARDED',
] as const;
export type RiderStatus = (typeof RIDER_STATUSES)[number];

/**
 * The statuses in which a device may be bound to a rider (the first binding and a replacement). The specifications say who binds a
 * device and what it needs, and are silent on the status of the rider; the build holds the line that costs nothing and gives nothing
 * away: a `SUSPENDED` or an `OFFBOARDED` rider is given no credential (their access has been ended), and a rider who is `INACTIVE` or
 * `TEMPORARILY_UNAVAILABLE` (availability states, set by hand, which sign-in itself refuses as `INVALID_CREDENTIALS`) may still be enrolled
 * so that the handset is ready when the status is lifted. A finding for the Product Owner (plan section 7.47).
 */
export const DEVICE_BINDABLE_RIDER_STATUSES: readonly RiderStatus[] = [
  'ACTIVE',
  'INACTIVE',
  'TEMPORARILY_UNAVAILABLE',
];

/** A phone number as the rider's records hold it: E.164 (domain-model.md section 3.4). Nothing is folded, trimmed or completed. */
export const RIDER_PHONE_PATTERN = '^\\+[1-9][0-9]{7,14}$';
const RIDER_PHONE = new RegExp(RIDER_PHONE_PATTERN);

/** The canonical form of a submitted phone number: the text itself when it is E.164, and nothing otherwise. */
export function canonicalRiderPhone(submitted: string): string | undefined {
  return RIDER_PHONE.test(submitted) ? submitted : undefined;
}

/** The PIN is six decimal digits: a constant of the contract and not a setting (settings.md section 7.5). */
export const RIDER_PIN_PATTERN = '^[0-9]{6}$';
const RIDER_PIN = new RegExp(RIDER_PIN_PATTERN);
export const isRiderPin = (text: unknown): text is string =>
  typeof text === 'string' && RIDER_PIN.test(text);

/**
 * `RegisteredDevice.public_key` (SECURITY_DESIGN.md section 13.6): the canonical standard base64 of the 91-byte DER SubjectPublicKeyInfo of
 * an uncompressed P-256 key, so exactly 124 characters (91 bytes are 30 groups of three and one byte left over, which is `xx==`, and the
 * last character before the padding has its four low bits clear: `A`, `Q`, `g` or `w`).
 */
export const DEVICE_PUBLIC_KEY_BYTES = 91;
export const DEVICE_PUBLIC_KEY_CHARACTERS = 124;
export const DEVICE_PUBLIC_KEY_PATTERN = '^[A-Za-z0-9+/]{121}[AQgw]==$';

/**
 * `RiderSignIn.device_signature` (SECURITY_DESIGN.md section 13.6): the canonical standard base64 of an ASN.1 DER ECDSA signature of 8 to 72
 * bytes, so 12 to 96 characters. The contract's pattern checks the spelling; `parseDeviceSignature` also holds the bounds and the canonical form.
 */
export const DEVICE_SIGNATURE_PATTERN =
  '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$';
export const DEVICE_SIGNATURE_MIN_CHARACTERS = 12;
export const DEVICE_SIGNATURE_MAX_CHARACTERS = 96;

/** A challenge (sign-in or attestation) and a grant token are the same 32 random bytes in the same representation (SECURITY_DESIGN.md 13.6). */
export const CHALLENGE_BYTES = 32;
export const CHALLENGE_CHARACTERS = 43;
export const CHALLENGE_PATTERN = '^[A-Za-z0-9_-]{43}$';

/** `RiderSignInChallenge.state` (domain-model.md section 6.8). */
export const RIDER_CHALLENGE_STATES = ['PENDING', 'CONSUMED', 'EXPIRED', 'UNUSABLE'] as const;
export type RiderChallengeState = (typeof RIDER_CHALLENGE_STATES)[number];

/** The one purpose of a sign-in challenge: an enrolment challenge is another namespace (`SetupGrant.attestation_challenge_hash`). */
export const RIDER_CHALLENGE_PURPOSE = 'RIDER_SIGN_IN';

/** The device kind of a rider's registered device, and the principal type that holds it. */
export const RIDER_DEVICE_KIND = 'RIDER_ANDROID_KEYPAIR';

import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import { isCanonicalBase64Url32 } from '../rider/enrolment-uri.js';
import { DEVICE_PUBLIC_KEY_BYTES, DEVICE_PUBLIC_KEY_PATTERN } from '../rider/rider-vocabulary.js';

/**
 * The rider's device-key protocol (SECURITY_DESIGN.md section 13.6; Product decision, 8 October 2026). The device key is a hardware-backed
 * ECDSA **P-256** key signing with SHA-256, and sign-in is a challenge-response:
 *
 * - `public_key` is the **canonical standard base64 of the 91-byte DER SubjectPublicKeyInfo** of an uncompressed P-256 key (124 characters).
 *   Trailing DER data, another curve, a compressed point, a point that is not on the curve and any other spelling of the same bytes are
 *   refused, and a key is compared with another (the attested key) **after canonicalisation by the reviewed crypto stack, never as
 *   unvalidated strings**: `parseDevicePublicKey` is that canonicalisation, and the key it returns is the one Node's OpenSSL parsed.
 * - The signed message is the UTF-8 bytes of `MELARC-RIDER-SIGNIN-V1`, one `0x0A` byte and the canonical challenge text (the unpadded
 *   base64url of 32 random bytes): no trailing newline and no implicit JSON.
 * - `device_signature` is the **canonical standard base64 of an ASN.1 DER ECDSA signature** of 8 to 72 bytes. The verifier supplies SHA-256
 *   **once** and never pre-hashes; DER is required (the IEEE P1363 form is refused), and OpenSSL refuses a non-canonical DER encoding, a
 *   negative or zero integer and trailing bytes (the published vectors hold it to that).
 *
 * Replay protection is the challenge's state and never the uniqueness of signature bytes, so a signature that is valid in its other
 * (high-S) form is the same signature to ECDSA and is accepted. Nothing here holds, logs or returns a private key, and a refusal names a
 * class and never the value. The published vectors (`apps/api/test/vectors/device-key.v1.json`) are consumed by the tests of this file and
 * are the contract the Android app's tests hold the other side to.
 */

/** What the signed message begins with: the protocol and its version, so a signature made for another purpose or version is no sign-in. */
export const SIGNED_MESSAGE_PREFIX = 'MELARC-RIDER-SIGNIN-V1';
const SEPARATOR = 0x0a;

/** A device signature is a DER `SEQUENCE` of two integers: at least 8 bytes (2 + 3 + 3) and, for P-256, at most 72 (2 + 2 + 33 + 2 + 33). */
export const DEVICE_SIGNATURE_MIN_BYTES = 8;
export const DEVICE_SIGNATURE_MAX_BYTES = 72;

const SIGNATURE_ALPHABET = /^[A-Za-z0-9+/]+={0,2}$/;

/** The bytes a device signs for a challenge. A challenge that is not the canonical text of 32 bytes is a caller's defect. */
export function signedMessage(challenge: string): Buffer {
  if (!isCanonicalBase64Url32(challenge)) {
    throw new TypeError('A sign-in challenge is the canonical base64url text of 32 bytes');
  }
  return Buffer.concat([
    Buffer.from(SIGNED_MESSAGE_PREFIX, 'utf8'),
    Buffer.from([SEPARATOR]),
    Buffer.from(challenge, 'utf8'),
  ]);
}

/** Why a public key was refused: a class and never the text. */
export type PublicKeyRefusal =
  /** Not the 124-character canonical standard base64 of 91 bytes (length, alphabet, padding, spare bits, whitespace, another alphabet). */
  | 'FORMAT'
  /** Not a SubjectPublicKeyInfo the crypto stack accepts: malformed, trailing data, a point not on the curve, or not in the canonical DER. */
  | 'NOT_A_KEY'
  /** A key of another type (RSA, Ed25519, ...). */
  | 'NOT_AN_EC_KEY'
  /** An elliptic-curve key on another curve. */
  | 'WRONG_CURVE';

export type ParsedPublicKey =
  | {
      readonly ok: true;
      readonly key: KeyObject;
      /** The canonical form: the text that was parsed, since only the canonical text is accepted. */
      readonly canonical: string;
    }
  | { readonly ok: false; readonly refusal: PublicKeyRefusal };

const PUBLIC_KEY = new RegExp(DEVICE_PUBLIC_KEY_PATTERN);

/** Reads a device public key: accepted only in its one canonical form, parsed by the crypto stack, an EC key on P-256. */
export function parseDevicePublicKey(text: unknown): ParsedPublicKey {
  if (typeof text !== 'string' || !PUBLIC_KEY.test(text)) return { ok: false, refusal: 'FORMAT' };
  const der = Buffer.from(text, 'base64');
  // The pattern fixes the length and the spare bits; decoding and encoding again states the rule as a rule (one value, one spelling).
  if (der.length !== DEVICE_PUBLIC_KEY_BYTES || der.toString('base64') !== text) {
    return { ok: false, refusal: 'FORMAT' };
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    return { ok: false, refusal: 'NOT_A_KEY' };
  }
  if (key.asymmetricKeyType !== 'ec') return { ok: false, refusal: 'NOT_AN_EC_KEY' };
  if (key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { ok: false, refusal: 'WRONG_CURVE' };
  }
  // What the stack parsed is what was sent: a SubjectPublicKeyInfo it read leniently (trailing data, explicit parameters, another
  // spelling of the curve) does not re-encode to the same bytes.
  const reencoded = key.export({ type: 'spki', format: 'der' });
  if (!reencoded.equals(der)) return { ok: false, refusal: 'NOT_A_KEY' };
  return { ok: true, key, canonical: text };
}

/**
 * Reads a device signature into the DER bytes it carries: the canonical standard base64 of 8 to 72 bytes, or `null`. That it is a
 * well-formed DER signature is the verifier's to decide (OpenSSL refuses every other encoding); this is the bound and the spelling, which
 * are checked before a key is parsed or a verification is spent.
 */
export function parseDeviceSignature(text: unknown): Buffer | null {
  if (typeof text !== 'string' || text.length < 12 || text.length > 96) return null;
  if (!SIGNATURE_ALPHABET.test(text) || text.length % 4 !== 0) return null;
  const der = Buffer.from(text, 'base64');
  if (der.length < DEVICE_SIGNATURE_MIN_BYTES || der.length > DEVICE_SIGNATURE_MAX_BYTES) {
    return null;
  }
  return der.toString('base64') === text ? der : null;
}

/**
 * Whether `signature` (the DER bytes `parseDeviceSignature` returned) is a valid ECDSA P-256 / SHA-256 signature by `key` over the signed
 * message of `challenge`. SHA-256 is applied once, by the verifier; a malformed signature is simply not valid.
 */
export function verifyDeviceSignature(
  key: KeyObject,
  challenge: string,
  signature: Buffer,
): boolean {
  // A challenge that is not 32 bytes in its one spelling is the caller's defect, not "an invalid signature": it throws here, outside the try.
  const message = signedMessage(challenge);
  try {
    return verify('sha256', message, { key, dsaEncoding: 'der' }, signature);
  } catch {
    return false;
  }
}

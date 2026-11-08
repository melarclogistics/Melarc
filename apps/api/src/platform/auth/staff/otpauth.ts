/**
 * The provisioning material of a TOTP factor (S0.31; `MfaProvisioning.otpauth_uri` in the contract): the seed as RFC 4648 base32
 * and the standard key URI that authenticator apps read (the Google Authenticator key URI format): `otpauth://totp/<issuer>:<account>`
 * with the secret, the issuer and the three parameters the verifier is built on (SHA-1, six digits, a 30-second step,
 * SECURITY_DESIGN.md §13.5), so that an app that ignores a parameter still computes what the server expects.
 *
 * The seed is **returned once**, in this URI, in the answer that provisions the factor, with `Cache-Control: no-store`; it is stored
 * only sealed, and is never returned again, logged or written to an audit event. This module holds no seed: it turns the bytes it is
 * handed into text and keeps nothing.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 section 6 base32 with no padding, the form authenticator apps take (padding is optional in the key URI format). */
export function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET.charAt((buffer >>> (bits - 5)) & 31);
      bits -= 5;
    }
    // Only the bits not yet written are kept, so the buffer never grows past twelve bits.
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) output += ALPHABET.charAt((buffer << (5 - bits)) & 31);
  return output;
}

export interface ProvisioningInput {
  /** The service's name in the app: `Melarc`. */
  readonly issuer: string;
  /** What names the account in the app: the work email as the employee entered it. Percent-encoded here. */
  readonly account: string;
  readonly seed: Uint8Array;
}

/** `otpauth://totp/Issuer:account?secret=...&issuer=Issuer&algorithm=SHA1&digits=6&period=30`. */
export function otpauthUri(input: ProvisioningInput): string {
  if (!(input.seed instanceof Uint8Array) || input.seed.length === 0) {
    throw new TypeError('A provisioning URI is made from a seed');
  }
  if (input.issuer.trim() === '' || input.account.trim() === '') {
    throw new TypeError('A provisioning URI names an issuer and an account');
  }
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.account);
  return `otpauth://totp/${issuer}:${account}?secret=${base32(input.seed)}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

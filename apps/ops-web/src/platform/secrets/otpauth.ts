/**
 * The manual-entry key of a TOTP provisioning URI (`otpauth://totp/...?secret=BASE32`, the `MfaProvisioning` of the
 * contract). The QR code and the key typed by hand must enrol the same factor, so the key shown is read from the very
 * URI the QR code encodes and is never held separately.
 *
 * Both are transient credentials. Nothing here stores, logs or sends them.
 */

/** RFC 4648 base32 as authenticators write it: upper case letters and 2 to 7, no padding. 16 characters is 80 bits. */
const BASE32 = /^[A-Z2-7]{16,128}$/;

/**
 * The `secret` of a TOTP provisioning URI, or nothing if the text is not one: another scheme or type (`hotp`), no
 * secret or more than one, or a secret that is not base32 of a plausible length.
 */
export function manualKeyOf(uri: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'otpauth:' || parsed.hostname !== 'totp') return undefined;
  const secrets = parsed.searchParams.getAll('secret');
  const [secret] = secrets;
  if (secrets.length !== 1 || secret === undefined || !BASE32.test(secret)) return undefined;
  return secret;
}

/** The key in groups for reading and typing. Authenticators ignore the spaces. */
export function groupedKey(key: string, size = 4): string {
  const groups: string[] = [];
  for (let at = 0; at < key.length; at += size) groups.push(key.slice(at, at + size));
  return groups.join(' ');
}

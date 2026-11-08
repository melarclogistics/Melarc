const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * RFC 4648 base32 read back to bytes (S0.31), for the tests that take the seed out of a provisioning URI and compute a code from it,
 * as an authenticator app does. It is test support: the application writes base32 and never reads it. A character outside the
 * alphabet is a fault of the test and throws.
 */
export function decodeBase32(text: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of text.replaceAll('=', '')) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) throw new RangeError('Not a base32 character');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
      buffer &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(bytes);
}

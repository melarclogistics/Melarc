import { createHmac } from 'node:crypto';

/**
 * The 31-bit dynamic truncation of HMAC-SHA-1 over an eight-byte big-endian counter (RFC 4226 section 5.3), before it is reduced
 * to digits. The counter is an integer up to 2^53 - 1, which a time step never approaches.
 */
export function hotpTruncated(key: Uint8Array, counter: number): number {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('An HOTP counter is a whole number from 0 to 2^53 - 1.');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  return mac.readUInt32BE(mac.readUInt8(19) & 0x0f) & 0x7fffffff;
}

/**
 * HOTP (RFC 4226) with the given number of digits, 6 to 8: the truncation reduced modulo 10^digits and kept at full width, so a
 * leading zero is a digit of the code. The published values of RFC 4226 Appendix D and RFC 6238 Appendix B are in
 * `hotp.test.ts`.
 */
export function hotp(key: Uint8Array, counter: number, digits: number): string {
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError('An HOTP code has 6 to 8 digits.');
  }
  return String(hotpTruncated(key, counter) % 10 ** digits).padStart(digits, '0');
}

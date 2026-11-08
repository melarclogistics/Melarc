import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hotp, hotpTruncated } from './hotp.js';

// RFC 4226 Appendix D: the key is the ASCII string "12345678901234567890" and the counters are 0 to 9.
const KEY = Buffer.from('12345678901234567890', 'ascii');
const RFC_4226 = [
  { counter: 0, truncated: 0x4c93cf18, decimal: 1284755224, code: '755224' },
  { counter: 1, truncated: 0x41397eea, decimal: 1094287082, code: '287082' },
  { counter: 2, truncated: 0x082fef30, decimal: 137359152, code: '359152' },
  { counter: 3, truncated: 0x66ef7655, decimal: 1726969429, code: '969429' },
  { counter: 4, truncated: 0x61c5938a, decimal: 1640338314, code: '338314' },
  { counter: 5, truncated: 0x33c083d4, decimal: 868254676, code: '254676' },
  { counter: 6, truncated: 0x7256c032, decimal: 1918287922, code: '287922' },
  { counter: 7, truncated: 0x04e5b397, decimal: 82162583, code: '162583' },
  { counter: 8, truncated: 0x2823443f, decimal: 673399871, code: '399871' },
  { counter: 9, truncated: 0x2679dc69, decimal: 645520489, code: '520489' },
] as const;

describe('HOTP (RFC 4226 Appendix D)', () => {
  it.each(RFC_4226)('counter $counter: truncates to $truncated and gives $code', (row) => {
    expect(hotpTruncated(KEY, row.counter)).toBe(row.truncated);
    expect(hotpTruncated(KEY, row.counter)).toBe(row.decimal);
    expect(hotp(KEY, row.counter, 6)).toBe(row.code);
  });

  // RFC 6238 Appendix B, SHA-1 rows: the eight-digit values are the same truncation, modulo 10^8. The six-digit code is the same
  // truncation modulo 10^6, so its last six digits are the last six of the eight.
  it.each([
    [37037036, '07081804'],
    [37037037, '14050471'],
    [41152263, '89005924'],
    [66666666, '69279037'],
    [666666666, '65353130'],
    [1, '94287082'],
  ])(
    'step %i gives the eight-digit value %s and its last six digits as the six-digit code',
    (counter, eight) => {
      expect(hotp(KEY, counter, 8)).toBe(eight);
      expect(hotp(KEY, counter, 6)).toBe(eight.slice(2));
    },
  );

  // Break caught: a counter written as four bytes or little-endian, which agrees with the published values for small counters
  // and nowhere else. This one has a bit above 2^32 and is computed outside the function, from the library's HMAC.
  it('writes the counter as eight big-endian bytes: a counter past 2^32 agrees with an independent computation', () => {
    const counter = 2 ** 32 + 5;
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(counter));
    const mac = createHmac('sha1', KEY).update(bytes).digest();
    const expected = mac.readUInt32BE(mac.readUInt8(19) & 0x0f) & 0x7fffffff;

    expect(hotpTruncated(KEY, counter)).toBe(expected);
    expect(hotpTruncated(KEY, counter)).not.toBe(hotpTruncated(KEY, 5));
  });

  it('keeps the leading zeros of a code', () => {
    expect(hotp(KEY, 37037036, 6)).toBe('081804');
    expect(hotp(KEY, 37037036, 6)).toHaveLength(6);
  });

  it('gives different codes for different keys', () => {
    expect(hotp(Buffer.alloc(20, 1), 0, 6)).not.toBe(hotp(Buffer.alloc(20, 2), 0, 6));
  });

  it.each([
    ['a negative counter', -1],
    ['a fraction', 1.5],
    ['not a number', Number.NaN],
    ['a counter past the safe integers', 2 ** 53],
  ])('refuses %s', (_label, counter) => {
    expect(() => hotp(KEY, counter, 6)).toThrow(RangeError);
  });

  it.each([5, 0, 10, 1.5])('refuses %s digits', (digits) => {
    expect(() => hotp(KEY, 0, digits)).toThrow(RangeError);
  });
});

import { describe, expect, it } from 'vitest';

import { sealedContext } from './sealed-context.js';

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

describe('sealedContext: the authenticated data that ties a sealed value to its principal, operation and record', () => {
  // SECURITY_DESIGN.md §14.9: an envelope "authenticates its purpose, principal, operation, record and envelope version as
  // associated data". The cipher adds the purpose and the version; this is how a caller states the other three, once, the same way.
  it('is each field, length-prefixed with four big-endian bytes, in the order principal, operation, record', () => {
    expect(hex(sealedContext({ principal: 'p', operation: 'o', record: 'r' }))).toBe(
      '00000001' + '70' + '00000001' + '6f' + '00000001' + '72',
    );
    expect(hex(sealedContext({ principal: 'ab', operation: 'c', record: 'def' }))).toBe(
      '00000002' + '6162' + '00000001' + '63' + '00000003' + '646566',
    );
  });

  it('encodes text as UTF-8', () => {
    expect(hex(sealedContext({ principal: 'é', operation: 'o', record: '\u{1F600}' }))).toBe(
      '00000002' + 'c3a9' + '00000001' + '6f' + '00000004' + 'f09f9880',
    );
  });

  // Break caught: fields joined without their lengths, so that ("ab", "c") and ("a", "bc") are one context and a value sealed
  // for one record opens for another.
  it('cannot be made ambiguous by moving a boundary between fields', () => {
    const one = sealedContext({ principal: 'ab', operation: 'c', record: 'd' });
    const two = sealedContext({ principal: 'a', operation: 'bc', record: 'd' });
    const three = sealedContext({ principal: 'a', operation: 'b', record: 'cd' });

    expect(new Set([hex(one), hex(two), hex(three)]).size).toBe(3);
  });

  it('changes when any one field changes', () => {
    const base = { principal: 'staff-1', operation: 'enrol', record: 'factor-1' };
    const reference = hex(sealedContext(base));

    for (const changed of [
      { ...base, principal: 'staff-2' },
      { ...base, operation: 'reset' },
      { ...base, record: 'factor-2' },
    ]) {
      expect(hex(sealedContext(changed))).not.toBe(reference);
    }
    expect(hex(sealedContext({ ...base }))).toBe(reference);
  });

  it.each([
    ['an empty principal', { principal: '', operation: 'o', record: 'r' }],
    ['an empty operation', { principal: 'p', operation: '', record: 'r' }],
    ['an empty record', { principal: 'p', operation: 'o', record: '' }],
    ['a lone surrogate', { principal: 'p\uD800', operation: 'o', record: 'r' }],
    [
      'a field that is not text',
      { principal: 7 as unknown as string, operation: 'o', record: 'r' },
    ],
    [
      'a missing field',
      { principal: 'p', operation: 'o' } as unknown as {
        principal: string;
        operation: string;
        record: string;
      },
    ],
  ])('refuses %s', (_label, parts) => {
    expect(() => sealedContext(parts)).toThrow(TypeError);
  });

  it('refuses a field longer than 1 KiB, which no identifier is', () => {
    expect(() =>
      sealedContext({ principal: 'p'.repeat(1025), operation: 'o', record: 'r' }),
    ).toThrow(RangeError);
    expect(sealedContext({ principal: 'p'.repeat(1024), operation: 'o', record: 'r' }).length).toBe(
      4 + 1024 + 4 + 1 + 4 + 1,
    );
  });
});

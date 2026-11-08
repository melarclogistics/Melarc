import { describe, expect, it } from 'vitest';

import {
  ARGON2ID_LIMITS,
  ARGON2ID_SALT_BYTES,
  ARGON2ID_TAG_BYTES,
  DEVELOPMENT_QUALIFIED_ARGON2ID,
  assertArgon2idParameters,
  isValidArgon2idParameters,
  type Argon2idParameters,
} from './argon2-parameters.js';

const params = (memoryKiB: number, passes: number, parallelism: number): Argon2idParameters => ({
  memoryKiB,
  passes,
  parallelism,
});

describe('Argon2id parameters', () => {
  it('fix the salt at 16 bytes and the tag at 32', () => {
    expect(ARGON2ID_SALT_BYTES).toBe(16);
    expect(ARGON2ID_TAG_BYTES).toBe(32);
  });

  it.each([
    ['the smallest the algorithm allows', params(8, 1, 1)],
    ['a cheap test cost', params(64, 1, 1)],
    ['the RFC 9106 test vector', params(32, 3, 4)],
    ['the development-qualified cost', DEVELOPMENT_QUALIFIED_ARGON2ID],
    ['the largest the limits allow', params(ARGON2ID_LIMITS.maxMemoryKiB, 16, 16)],
  ])('accept %s', (_label, value) => {
    expect(isValidArgon2idParameters(value)).toBe(true);
    expect(() => {
      assertArgon2idParameters(value);
    }).not.toThrow();
  });

  // Break caught: a bound dropped, so that a stored record (or a configuration) can make one verification take unbounded memory
  // or time, or can claim a cost the library will not honour.
  it.each([
    ['memory below 8 KiB per lane', params(4, 1, 1)],
    ['memory below 8 KiB per lane at four lanes', params(24, 1, 4)],
    ['memory that is not a multiple of four KiB per lane', params(65537, 2, 1)],
    ['memory that is not a multiple of four KiB per lane at four lanes', params(1000, 1, 4)],
    ['memory above the limit', params(ARGON2ID_LIMITS.maxMemoryKiB + 4, 1, 1)],
    ['zero passes', params(64, 0, 1)],
    ['passes above the limit', params(64, ARGON2ID_LIMITS.maxPasses + 1, 1)],
    ['zero lanes', params(64, 1, 0)],
    // 272 KiB is 8 KiB per lane at 17 lanes and a multiple of 4 KiB per lane, so only the lane count is wrong.
    ['lanes above the limit', params(272, 1, ARGON2ID_LIMITS.maxParallelism + 1)],
    ['a negative value', params(-64, 1, 1)],
    ['a fraction', params(64.5, 1, 1)],
    ['not-a-number', params(Number.NaN, 1, 1)],
    ['infinity', params(Number.POSITIVE_INFINITY, 1, 1)],
    ['a value past the safe integers', params(2 ** 53, 1, 1)],
  ])('refuse %s', (_label, value) => {
    expect(isValidArgon2idParameters(value)).toBe(false);
    expect(() => {
      assertArgon2idParameters(value);
    }).toThrow(RangeError);
  });

  it('refuse anything that is not an object of three numbers', () => {
    for (const value of [
      undefined,
      null,
      'argon2id',
      42,
      [],
      {},
      { memoryKiB: '64', passes: 1, parallelism: 1 },
      { memoryKiB: 64, passes: 1 },
    ]) {
      expect(isValidArgon2idParameters(value)).toBe(false);
    }
  });

  it('says what is wrong without repeating the value it was given', () => {
    expect(() => {
      assertArgon2idParameters(params(65537, 2, 1));
    }).toThrow(/memory/i);
    try {
      assertArgon2idParameters(params(65537, 2, 1));
    } catch (error) {
      expect(String(error)).not.toContain('65537');
    }
  });

  describe('the development-qualified cost', () => {
    // The cost is a measurement on a recorded machine and is not a production claim (plan S0.3a; S0.65 proposes the deployment
    // values). What can be checked here is that it is a cost the design allows, on one lane, so that a hash occupies one thread
    // of the shared pool.
    it('is valid and uses a single lane', () => {
      expect(isValidArgon2idParameters(DEVELOPMENT_QUALIFIED_ARGON2ID)).toBe(true);
      expect(DEVELOPMENT_QUALIFIED_ARGON2ID.parallelism).toBe(1);
    });

    it('cannot be changed by a caller', () => {
      expect(Object.isFrozen(DEVELOPMENT_QUALIFIED_ARGON2ID)).toBe(true);
    });
  });
});

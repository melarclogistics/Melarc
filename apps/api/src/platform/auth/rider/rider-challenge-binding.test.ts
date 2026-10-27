import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  RIDER_CHALLENGE_NO_RIDER,
  deviceContextBinding,
  phoneBinding,
  riderChallengeAudience,
  sameBinding,
} from './rider-challenge-binding.js';

const PHONE = '+233201234567';
const DEVICE = '018f3d2a-7b1c-7cde-8a12-3456789abcde';

describe('what a rider’s sign-in challenge is bound to', () => {
  // Break caught: a digest that is not 32 bytes, that changes between calls, or that is the plain digest of the number (a digest made
  // for one purpose must not be a digest of anything else).
  it('binds a number by a namespaced SHA-256 of its canonical text', () => {
    const binding = phoneBinding(PHONE);

    expect(binding).toHaveLength(32);
    expect(phoneBinding(PHONE).equals(binding)).toBe(true);
    expect(phoneBinding('+233201234568').equals(binding)).toBe(false);
    expect(createHash('sha256').update(PHONE, 'utf8').digest().equals(binding)).toBe(false);
    expect(phoneBinding(PHONE).equals(deviceContextBinding(PHONE))).toBe(false);
  });

  // Break caught: a device context that depends on the case an identifier happens to be written in (the same device then has two contexts,
  // and a challenge issued for it is refused when it comes back), or on nothing at all.
  it('binds a device by a namespaced SHA-256 of its registration id, whatever the case', () => {
    const binding = deviceContextBinding(DEVICE);

    expect(binding).toHaveLength(32);
    expect(deviceContextBinding(DEVICE.toUpperCase()).equals(binding)).toBe(true);
    expect(deviceContextBinding('018f3d2a-7b1c-7cde-8a12-3456789abcdf').equals(binding)).toBe(
      false,
    );
    expect(createHash('sha256').update(DEVICE, 'utf8').digest().equals(binding)).toBe(false);
  });

  // Break caught: an audience that names the service and not the environment, so that a challenge made in one environment is read in another.
  it('names the environment and the service a challenge is issued for', () => {
    expect(riderChallengeAudience('production')).toBe('melarc-api/production');
    expect(riderChallengeAudience('staging')).toBe('melarc-api/staging');
    expect(riderChallengeAudience('production')).not.toBe(riderChallengeAudience('staging'));
  });

  it('compares two bindings as equal only when they are the same bytes', () => {
    const one = phoneBinding(PHONE);
    const same = Buffer.from(one);
    const other = phoneBinding('+233201234568');

    expect(sameBinding(one, same)).toBe(true);
    expect(sameBinding(one, other)).toBe(false);
    // The same length and one bit apart.
    const flipped = Buffer.from(one);
    flipped[31] = (flipped[31] ?? 0) ^ 1;
    expect(sameBinding(one, flipped)).toBe(false);
  });

  // Break caught: an absent binding (a challenge issued for a number with no device) equal to a present one, or not equal to another absent
  // one, which would refuse every sign-in of a number that has no device to ask; and a comparison that throws on a different length.
  it('takes an absent binding as equal to an absent one only, and never throws on a different length', () => {
    const one = phoneBinding(PHONE);

    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(null, one)).toBe(false);
    expect(sameBinding(one, null)).toBe(false);
    expect(sameBinding(one, one.subarray(0, 31))).toBe(false);
    expect(sameBinding(new Uint8Array(0), one)).toBe(false);
  });

  it('names no rider with the nil identifier', () => {
    expect(RIDER_CHALLENGE_NO_RIDER).toBe('00000000-0000-0000-0000-000000000000');
  });
});

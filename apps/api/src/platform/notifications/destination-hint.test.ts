import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { destinationDigest, destinationHint } from './notification-lane.js';

/**
 * What the table keeps of a number (S1.12a; review m1): a masked hint for the Ops log, and a digest to count by. Every other test compares
 * the lane's hint with the lane's own, which could not see the mask change; these hold the form itself.
 */
describe('the masked form of a number', () => {
  // Break caught: a hint that shows more of the number than the country part and the last three digits, or that changes shape so that two
  // numbers can no longer be told apart in the log.
  it.each([
    ['+233244000111', '+233******111'],
    ['+14155552671', '+141*****671'],
    ['+12345678', '+123**678'],
    ['+123456789012345', '+123*********345'],
  ])('writes %s as %s', (number, hint) => {
    expect(destinationHint(number)).toBe(hint);
  });

  it('keeps the length of the number, shows only its first four and last three characters, and fits the column', () => {
    for (const number of ['+233244000111', '+14155552671', '+12345678', '+123456789012345']) {
      const hint = destinationHint(number);
      expect(hint).toHaveLength(number.length);
      expect(hint.slice(0, 4)).toBe(number.slice(0, 4));
      expect(hint.slice(-3)).toBe(number.slice(-3));
      expect(hint.slice(4, -3)).toMatch(/^\*+$/);
      expect(hint.length).toBeLessThanOrEqual(24);
    }
  });
});

describe('the digest a number is counted by', () => {
  // Break caught: a digest whose namespace moves, which starts every limit again from zero at a deployment; or one that is not a stable
  // function of the number.
  it('is the SHA-256 of the namespaced number, in lower-case hex, and the same for the same number', () => {
    const expected = createHash('sha256')
      .update('melarc.sms.destination.v1\u0000+233244000111')
      .digest('hex');
    expect(destinationDigest('+233244000111')).toBe(expected);
    expect(destinationDigest('+233244000111')).toBe(destinationDigest('+233244000111'));
    expect(destinationDigest('+233244000111')).toMatch(/^[0-9a-f]{64}$/);
    expect(destinationDigest('+233244000112')).not.toBe(destinationDigest('+233244000111'));
    expect(destinationDigest('+233244000111')).not.toBe(
      createHash('sha256').update('+233244000111').digest('hex'),
    );
  });
});

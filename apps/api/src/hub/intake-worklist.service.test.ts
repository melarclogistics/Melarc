import { describe, expect, it } from 'vitest';

import { decodeWorklistToken, encodeWorklistToken } from './intake-worklist.service.js';

const ID = '01a124d3-7400-79f4-bed4-8668f040e253';
const token = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('the position in a worklist', () => {
  // Break caught: a position that does not come back as it went, or that loses the case of the identifier.
  it('comes back as it went', () => {
    expect(decodeWorklistToken(encodeWorklistToken(7, ID))).toEqual({ n: 7, id: ID });
    expect(decodeWorklistToken(encodeWorklistToken(0, ID.toUpperCase()))).toEqual({ n: 0, id: ID });
  });

  // Break caught: text that reaches a statement as anything but a whole number and a UUID.
  it('refuses everything that is not a place and a UUID, and reads no more than that', () => {
    for (const bad of [
      '',
      'not a token!',
      'a'.repeat(129),
      token([1]),
      token([1, ID, 'extra']),
      token([-1, ID]),
      token([1.5, ID]),
      token(['1', ID]),
      token([1, 'not-a-uuid']),
      token([Number.MAX_SAFE_INTEGER + 2, ID]),
      token({ n: 1, id: ID }),
      token(null),
      Buffer.from('{not json').toString('base64url'),
    ]) {
      expect(decodeWorklistToken(bad), bad).toBeUndefined();
    }
  });

  // Break caught: an encoder that signs an impossible position and makes a page that cannot be read.
  it('does not encode a place or an identifier it would refuse to read', () => {
    expect(() => encodeWorklistToken(-1, ID)).toThrow(TypeError);
    expect(() => encodeWorklistToken(1.5, ID)).toThrow(TypeError);
    expect(() => encodeWorklistToken(1, 'nope')).toThrow(TypeError);
  });
});

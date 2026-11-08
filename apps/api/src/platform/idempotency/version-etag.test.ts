import { describe, expect, it } from 'vitest';

import { etagOf, ifMatchVersion, versionMatches } from './version-etag.js';

describe('the ETag of a record version', () => {
  // Break caught: a form other than the strong quoted decimal the clients send back.
  it('writes a version as a quoted decimal', () => {
    expect(etagOf(0)).toBe('"0"');
    expect(etagOf(7)).toBe('"7"');
    expect(etagOf(Number.MAX_SAFE_INTEGER)).toBe(`"${String(Number.MAX_SAFE_INTEGER)}"`);
  });

  // Break caught: a version that is not a whole non-negative number being given an ETag all the same.
  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, '3' as never]) {
      expect(() => etagOf(version)).toThrow(RangeError);
    }
  });

  // Break caught: the header read loosely, so that a weak validator, a list or an unquoted number matches a version.
  it('reads If-Match as exactly one strong quoted decimal, and nothing else', () => {
    expect(ifMatchVersion('"7"')).toBe(7);
    expect(ifMatchVersion('"0"')).toBe(0);

    for (const header of [
      undefined,
      '',
      '7',
      'W/"7"',
      '"7", "8"',
      '*',
      '"07"',
      '"-1"',
      '"1.5"',
      '" 7"',
      '"7" ',
      '"9007199254740993"',
      '"abc"',
    ]) {
      expect(ifMatchVersion(header), String(header)).toBeUndefined();
    }
  });

  // Break caught: a precondition that passes when the header is missing or malformed.
  it('matches only when the header names exactly the current version', () => {
    expect(versionMatches('"7"', 7)).toBe(true);
    expect(versionMatches('"7"', 8)).toBe(false);
    expect(versionMatches(undefined, 7)).toBe(false);
    expect(versionMatches('7', 7)).toBe(false);
    expect(versionMatches('W/"7"', 7)).toBe(false);
  });
});

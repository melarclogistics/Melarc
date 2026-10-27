import { describe, expect, it } from 'vitest';

import { MAX_GRANT_LENGTH, tokenFromHash } from './grant-fragment';

/** A grant as the API makes one: 32 random bytes as 43 characters of unpadded base64url. */
const GRANT = 'kJ3x9Qm2-Zt7_VbN4wYc8LdR1pHs5GfXaUe6OiTjA0E';

describe('tokenFromHash: the grant a link carries in its fragment', () => {
  it('reads the token of "#token=<token>"', () => {
    expect(GRANT).toHaveLength(43);
    expect(tokenFromHash(`#token=${GRANT}`)).toBe(GRANT);
  });

  it('decodes a percent-encoded token', () => {
    expect(tokenFromHash('#token=abc%2Bdef%2Fghi%3D')).toBe('abc+def/ghi=');
  });

  // Break caught: a page that treats "no token" as a token, so an empty link opens a form that cannot succeed, or sends nothing meaningful.
  it.each(['', '#', '#token=', '#token', '#Token=abc', '#other=abc', 'token=abc'])(
    'reads nothing from %j',
    (hash) => {
      expect(tokenFromHash(hash)).toBeUndefined();
    },
  );

  // Break caught: a fragment with more in it than the link carries being read as if it were the link: the extra part is not ours.
  it.each(['#token=abc&token=def', '#token=abc&x=1', '#x=1&token=abc', '#token=abc#more'])(
    'reads nothing from a fragment with more than the token: %j',
    (hash) => {
      expect(tokenFromHash(hash)).toBeUndefined();
    },
  );

  // Break caught: a control character or a space in a grant reaching a request body, a header or a log.
  it.each([
    '#token=%00',
    '#token=ab%0Acd',
    '#token=ab%20cd',
    '#token=ab%09cd',
    '#token=%7F',
    '#token=%C2%A0',
  ])('refuses a token with a control, a space or a non-printing character: %j', (hash) => {
    expect(tokenFromHash(hash)).toBeUndefined();
  });

  it.each([
    '#token=%E0%A4%A',
    '#token=%',
    '#token=%ZZ',
    '#token=a+b',
    '#token=a b',
    '#token=<script>',
  ])('refuses a token that is not made of the characters of a link: %j', (hash) => {
    expect(tokenFromHash(hash)).toBeUndefined();
  });

  // Break caught: an unbounded value being held and sent: a grant is short, and a very long fragment is not one.
  it('refuses a token longer than the bound', () => {
    expect(tokenFromHash(`#token=${'a'.repeat(MAX_GRANT_LENGTH)}`)).toBe(
      'a'.repeat(MAX_GRANT_LENGTH),
    );
    expect(tokenFromHash(`#token=${'a'.repeat(MAX_GRANT_LENGTH + 1)}`)).toBeUndefined();
  });

  it('does not decide what a grant looks like beyond what a link can carry, because the server judges the grant', () => {
    expect(tokenFromHash('#token=short')).toBe('short');
    expect(tokenFromHash('#token=A_b-C.d~e')).toBe('A_b-C.d~e');
  });
});

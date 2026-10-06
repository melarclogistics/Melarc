import { describe, expect, it } from 'vitest';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, readCsrfToken } from './csrf.ts';

describe('the CSRF names', () => {
  // Break caught: a renamed cookie or header, so the token is never found or never accepted. Both names
  // are fixed by the contract (x-cookies.melarc_csrf and the csrfToken security scheme).
  it('are the ones the contract declares', () => {
    expect(CSRF_COOKIE_NAME).toBe('melarc_csrf');
    expect(CSRF_HEADER_NAME).toBe('X-CSRF-Token');
  });
});

describe('readCsrfToken', () => {
  // Break caught: a reader that only works when the CSRF cookie is the only cookie.
  it.each([
    ['alone', 'melarc_csrf=abc123', 'abc123'],
    ['first of several', 'melarc_csrf=abc123; theme=dark', 'abc123'],
    ['last of several', 'theme=dark; melarc_csrf=abc123', 'abc123'],
    ['between others', 'a=1; melarc_csrf=abc123; b=2', 'abc123'],
    ['without a space after the separator', 'a=1;melarc_csrf=abc123', 'abc123'],
  ])('finds the token when it is %s', (_label, cookies, token) => {
    expect(readCsrfToken(cookies)).toBe(token);
  });

  // Break caught: a prefix or suffix match, which would echo another cookie's value as the token. The
  // session cookie is HttpOnly and cannot be read here, but a lookalike must still never be taken.
  it.each([
    ['a longer name', 'melarc_csrf_old=wrong'],
    ['a name it is the tail of', 'x_melarc_csrf=wrong'],
    ['a different case', 'Melarc_Csrf=wrong'],
    ['the name as part of a value', 'other=melarc_csrf=wrong'],
  ])('does not take %s for the token', (_label, cookies) => {
    expect(readCsrfToken(cookies)).toBeUndefined();
  });

  // Break caught: a missing cookie turned into an empty or "undefined" header. Before sign-in there is
  // no token, and the request must go without one.
  it.each([
    ['nothing at all', ''],
    ['unrelated cookies only', 'a=1; b=2'],
    ['an empty value', 'melarc_csrf='],
  ])('reports no token for %s', (_label, cookies) => {
    expect(readCsrfToken(cookies)).toBeUndefined();
  });

  // Break caught: decoding or trimming the value. The contract says the header echoes the cookie, and the
  // server compares a hash of exactly what it issued; '=' padding and '%' must come back untouched.
  it('returns the value exactly as stored, without decoding it', () => {
    expect(readCsrfToken('melarc_csrf=ab%2Fcd==')).toBe('ab%2Fcd==');
    expect(readCsrfToken('melarc_csrf=a=b=c')).toBe('a=b=c');
  });

  // Break caught: an order that depends on later cookies, so a stray duplicate changes the token sent.
  it('uses the first cookie when the name appears twice', () => {
    expect(readCsrfToken('melarc_csrf=first; melarc_csrf=second')).toBe('first');
  });
});

import { describe, expect, it } from 'vitest';

import type { IncomingHttpHeaders } from 'node:http';

import { SESSION_COOKIE_NAME, presentedCredential as presented } from './session-credentials.js';

const TOKEN = 'dGhlIHRva2VuIGlzIDQzIGJhc2U2NHVybCBjaGFyYWN0ZXJz';

/** The credential of some headers; the raw header lines are those of a request that sent each header once, unless a test says. */
const presentedCredential = (headers: IncomingHttpHeaders, rawHeaders: readonly string[] = []) =>
  presented(headers, rawHeaders);

describe('presentedCredential', () => {
  it('uses the name the contract gives the browser session cookie', () => {
    expect(SESSION_COOKIE_NAME).toBe('melarc_session');
  });

  // Break caught: a request with nothing to authenticate with being treated as having a credential, or the reverse.
  it('finds no credential in a request that carries none', () => {
    expect(presentedCredential({})).toEqual({ kind: 'NONE' });
    expect(presentedCredential({ cookie: 'melarc_csrf=abc; theme=dark' })).toEqual({
      kind: 'NONE',
    });
    expect(presentedCredential({ authorization: 'Basic dXNlcjpwYXNz' })).toEqual({ kind: 'NONE' });
  });

  it('reads the session cookie among other cookies', () => {
    expect(
      presentedCredential({ cookie: `theme=dark; melarc_session=${TOKEN}; melarc_csrf=x` }),
    ).toEqual({
      kind: 'COOKIE',
      token: TOKEN,
    });
    expect(presentedCredential({ cookie: `melarc_session=${TOKEN}` })).toEqual({
      kind: 'COOKIE',
      token: TOKEN,
    });
  });

  // Break caught: a cookie of another name, or another case, taken for the session (the name is exact).
  it('matches the cookie name exactly', () => {
    expect(presentedCredential({ cookie: `Melarc_Session=${TOKEN}` })).toEqual({ kind: 'NONE' });
    expect(presentedCredential({ cookie: `xmelarc_session=${TOKEN}` })).toEqual({ kind: 'NONE' });
    expect(presentedCredential({ cookie: `melarc_session_extra=${TOKEN}` })).toEqual({
      kind: 'NONE',
    });
  });

  it('reads a bearer credential, the scheme being case-insensitive', () => {
    expect(presentedCredential({ authorization: `Bearer ${TOKEN}` })).toEqual({
      kind: 'BEARER',
      token: TOKEN,
    });
    expect(presentedCredential({ authorization: `bearer ${TOKEN}` })).toEqual({
      kind: 'BEARER',
      token: TOKEN,
    });
    expect(presentedCredential({ authorization: `BEARER ${TOKEN}` })).toEqual({
      kind: 'BEARER',
      token: TOKEN,
    });
  });

  // Break caught (SECURITY_DESIGN.md §13.8: "refuses an ambiguous combination"): a request with a cookie and a bearer credential
  // authenticated as whichever the code looked at first, so that a browser's cookie could ride on a native client's request.
  it('is ambiguous when a cookie and a bearer credential are both presented', () => {
    expect(
      presentedCredential({ cookie: `melarc_session=${TOKEN}`, authorization: `Bearer ${TOKEN}` }),
    ).toEqual({ kind: 'AMBIGUOUS' });
  });

  // Break caught: a session cookie sent twice (cookie tossing from a sibling path or subdomain) taken as the first or the last.
  it('is ambiguous when the session cookie is presented twice, even with the same value', () => {
    expect(
      presentedCredential({ cookie: `melarc_session=${TOKEN}; melarc_session=other` }),
    ).toEqual({
      kind: 'AMBIGUOUS',
    });
    expect(
      presentedCredential({ cookie: `melarc_session=${TOKEN}; melarc_session=${TOKEN}` }),
    ).toEqual({
      kind: 'AMBIGUOUS',
    });
  });

  // Break caught: a header that is not a bearer credential read as one, or a bearer with nothing after it read as no credential.
  it('treats a bearer scheme with no usable token as a credential that will not match', () => {
    expect(presentedCredential({ authorization: 'Bearer ' })).toEqual({
      kind: 'BEARER',
      token: '',
    });
    expect(presentedCredential({ authorization: 'Bearer' })).toEqual({ kind: 'BEARER', token: '' });
    expect(presentedCredential({ authorization: 'Bearer  two spaces' })).toEqual({
      kind: 'BEARER',
      token: ' two spaces',
    });
    expect(presentedCredential({ authorization: 'Bearerx abc' })).toEqual({ kind: 'NONE' });
  });

  it('does not decode, trim or unquote a value: what is presented is what is hashed', () => {
    expect(presentedCredential({ cookie: 'melarc_session="quoted"' })).toEqual({
      kind: 'COOKIE',
      token: '"quoted"',
    });
    expect(presentedCredential({ cookie: 'melarc_session=%41BC' })).toEqual({
      kind: 'COOKIE',
      token: '%41BC',
    });
    expect(presentedCredential({ cookie: 'melarc_session=' })).toEqual({
      kind: 'COOKIE',
      token: '',
    });
  });

  // Break caught: a header given as a list (a runtime that splits it) read as nothing.
  it('reads a header that arrived as a list', () => {
    expect(presentedCredential({ cookie: [`melarc_session=${TOKEN}`] as never })).toEqual({
      kind: 'COOKIE',
      token: TOKEN,
    });
  });

  // Break caught (found by the review of this batch): two Authorization header lines resolved to the first. Node keeps only the first of
  // a duplicated Authorization header in `headers`, so a proxy that forwards the other one and this server would disagree about
  // which credential the request carries. The raw header lines are where the duplicate can be seen.
  it('is ambiguous when the request carries two Authorization header lines, however alike and in any case', () => {
    const headers = { authorization: `Bearer ${TOKEN}` };

    expect(
      presentedCredential(headers, [
        'Authorization',
        `Bearer ${TOKEN}`,
        'authorization',
        'Bearer other',
      ]),
    ).toEqual({ kind: 'AMBIGUOUS' });
    expect(
      presentedCredential(headers, [
        'Authorization',
        `Bearer ${TOKEN}`,
        'AUTHORIZATION',
        `Bearer ${TOKEN}`,
      ]),
    ).toEqual({ kind: 'AMBIGUOUS' });
    expect(
      presentedCredential({ cookie: `melarc_session=${TOKEN}` }, [
        'Authorization',
        'Basic x',
        'Authorization',
        'Basic y',
      ]),
    ).toEqual({ kind: 'AMBIGUOUS' });
  });

  // Break caught: the count taken over the values as well as the names (a value that reads "authorization"), or over the cookie.
  it('counts header names and not values, and one Authorization line is one credential', () => {
    expect(
      presentedCredential({ authorization: `Bearer ${TOKEN}` }, [
        'Host',
        'authorization',
        'Authorization',
        `Bearer ${TOKEN}`,
        'X-Note',
        'Authorization',
      ]),
    ).toEqual({ kind: 'BEARER', token: TOKEN });
    expect(
      presentedCredential({ authorization: `Bearer ${TOKEN}` }, [
        'Authorization',
        `Bearer ${TOKEN}`,
      ]),
    ).toEqual({ kind: 'BEARER', token: TOKEN });
  });
});

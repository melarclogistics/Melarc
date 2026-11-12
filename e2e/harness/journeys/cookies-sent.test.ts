import { describe, expect, it } from 'vitest';

import {
  cookieNamesSent,
  namesInCookieHeader,
  type CookieJar,
  type SentRequest,
} from './cookies-sent.ts';

const URL_OF_REQUEST = 'https://ops.example.test/api/v1/auth/staff/sign-in';

const requestWith = (headers: Record<string, string>): SentRequest => ({
  allHeaders: () => Promise.resolve(headers),
  url: () => URL_OF_REQUEST,
});

/** A jar that remembers which address it was asked about, and one that must not be asked at all. */
const jarOf = (names: readonly string[]): CookieJar & { asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    cookies: (url) => {
      asked.push(url);
      return Promise.resolve(names.map((name) => ({ name })));
    },
  };
};

describe('the names in a Cookie header', () => {
  // Break caught: a value read as a name (a credential in a failure message), or an empty piece read as a cookie.
  it('keeps the names and never the values, and skips empty pieces', () => {
    expect(
      namesInCookieHeader('melarc_session=abc; melarc_csrf=d=e=f ;; melarc_trusted_browser=x;'),
    ).toEqual(['melarc_session', 'melarc_csrf', 'melarc_trusted_browser']);
    expect(namesInCookieHeader('')).toEqual([]);
  });
});

describe('the cookies a request carried, as the journeys judge it', () => {
  // Break caught: the wire header no longer deciding where an engine reports it (a cookie the browser did not send counted as sent
  // because the jar holds it), which would let a journey pass on a request that went without its credential.
  it('takes the header as it is where the engine reports it, and does not ask the jar', async () => {
    const jar = jarOf(['melarc_trusted_browser', 'melarc_session']);
    const names = await cookieNamesSent(
      jar,
      requestWith({ cookie: 'melarc_session=a; melarc_csrf=b' }),
    );
    expect(names).toEqual(['melarc_session', 'melarc_csrf']);
    expect(names).not.toContain('melarc_trusted_browser');
    expect(jar.asked).toEqual([]);
  });

  // Break caught: WebKit's missing header read as "nothing was sent", which fails a journey that did send the credential, and passes the
  // check that a credential was not sent to a business operation whatever was sent.
  it('asks the browser jar for the address of the request where the engine reports no Cookie header', async () => {
    const reportingNone: Record<string, string>[] = [{}, { cookie: '' }];
    for (const headers of reportingNone) {
      const jar = jarOf(['melarc_session', 'melarc_csrf']);
      expect(await cookieNamesSent(jar, requestWith(headers))).toEqual([
        'melarc_session',
        'melarc_csrf',
      ]);
      expect(jar.asked).toEqual([URL_OF_REQUEST]);
    }
  });

  // Break caught: the fallback counting a cookie whose path does not reach the address: the jar's answer for an address leaves it out.
  it('does not report a cookie the jar leaves out for that address', async () => {
    const names = await cookieNamesSent(jarOf(['melarc_session']), requestWith({}));
    expect(names).not.toContain('melarc_trusted_browser');
  });
});

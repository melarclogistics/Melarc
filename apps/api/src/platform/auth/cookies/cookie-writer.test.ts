import { readFileSync } from 'node:fs';

import type { Response } from 'express';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { Controller, Get, Module, Res } from '@nestjs/common';

import { brokenAttributes, expectedCookie, parseSetCookies } from '../../contract/cookies.js';
import { ContractValidator } from '../../contract/contract-validator.js';
import type { JsonObject } from '../../contract/json.js';
import { locateContract } from '../../contract/locate-contract.js';
import { TechnicalEndpoint } from '../../routes/access-declaration.js';
import { appWith, startTestApp, type TestApp } from '../../../test-support/test-app.js';
import {
  COOKIES,
  expireBrowserSessionCookies,
  issueBrowserSessionCookies,
  issueVendorDeviceCookie,
  setCookieLine,
} from './cookie-writer.js';

const contract = parse(readFileSync(locateContract(import.meta.dirname), 'utf8')) as JsonObject;
const definitions = contract['x-cookies'] as JsonObject;

/** A value of the shape a token has: 43 characters of base64url, as 32 random bytes are written. */
const SESSION = 'a'.repeat(43);
const CSRF = 'B-_'.repeat(14) + 'xy';
const DEVICE = '0123456789abcdefABCDEF-_0123456789abcdefABCDEF-';

/** A response that keeps the header lines appended to it, in order, as Node does for a repeated field. */
function fake(): { response: Response; lines: () => string[] } {
  const lines: string[] = [];
  const response = {
    append(name: string, value: string) {
      if (name.toLowerCase() === 'set-cookie') lines.push(value);
      return this;
    },
  } as unknown as Response;
  return { response, lines: () => lines };
}

const only = (line: string) => {
  const [cookie] = parseSetCookies(line);
  if (cookie === undefined) throw new Error(`not a cookie: ${line}`);
  return cookie;
};

const broken = (line: string): string[] => {
  const cookie = only(line);
  return brokenAttributes(cookie, expectedCookie(cookie.name, definitions[cookie.name]));
};

describe('the cookie names', () => {
  // Break caught: a name that is not the contract's, which no browser or validator would recognise.
  it('are the three cookies the contract’s x-cookies defines, and no other', () => {
    expect(Object.values(COOKIES).toSorted()).toEqual(Object.keys(definitions).toSorted());
  });
});

describe('issuing the browser session cookies', () => {
  // Break caught: an attribute left off or changed, which weakens the cookie without a sign in the code that sets it. The
  // contract's own checker judges what the writer wrote.
  it('writes the session and CSRF cookies with exactly the attributes the contract gives them', () => {
    const { response, lines } = fake();

    issueBrowserSessionCookies(response, { session: SESSION, csrf: CSRF });

    expect(lines()).toEqual([
      `melarc_session=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `melarc_csrf=${CSRF}; Path=/; Secure; SameSite=Lax`,
    ]);
    for (const line of lines()) expect(broken(line), line).toEqual([]);
  });

  // Break caught: the session credential readable by script, or the CSRF cookie hidden from it (the client echoes it).
  it('hides the session from script and shows the CSRF token to it', () => {
    const { response, lines } = fake();

    issueBrowserSessionCookies(response, { session: SESSION, csrf: CSRF });

    expect(only(lines()[0] ?? '').flags.has('httponly')).toBe(true);
    expect(only(lines()[1] ?? '').flags.has('httponly')).toBe(false);
  });

  // Break caught: a browser-session cookie that outlives the browser, which would make the cookie a second place the session
  // lives (SECURITY_DESIGN.md §13.2).
  it('gives them no Max-Age, no Expires and no Domain', () => {
    const { response, lines } = fake();

    issueBrowserSessionCookies(response, { session: SESSION, csrf: CSRF });

    for (const line of lines()) {
      expect(line.toLowerCase()).not.toMatch(/max-age|expires|domain/);
    }
  });

  // Break caught: a value that could end the line, add an attribute or set another cookie.
  it.each([
    ['empty', ''],
    ['short', 'abc'],
    ['with a semicolon', `${'a'.repeat(30)};Domain=evil.example`],
    ['with a comma', `${'a'.repeat(30)},b`],
    ['with a space', `${'a'.repeat(30)} b`],
    ['with a line break', `${'a'.repeat(30)}\r\nSet-Cookie: x=y`],
    ['with an equals sign', `${'a'.repeat(30)}=`],
    ['with a quote', `"${'a'.repeat(30)}"`],
    ['with a non-ASCII character', `${'a'.repeat(30)}é`],
    ['too long', 'a'.repeat(129)],
  ])('refuses a session value that is %s, and writes nothing', (_label, value) => {
    const { response, lines } = fake();

    expect(() => {
      issueBrowserSessionCookies(response, { session: value, csrf: CSRF });
    }).toThrow(TypeError);
    expect(lines()).toEqual([]);
  });

  // Break caught: a character outside base64url allowed by a loosened rule. Each is the only thing wrong with an otherwise valid
  // value, so no other character of the value can be what makes the writer refuse it.
  it.each([
    ';',
    ',',
    ' ',
    '"',
    '\\',
    '=',
    '/',
    '+',
    '.',
    '%',
    '(',
    ')',
    '<',
    '>',
    '@',
    ':',
    '?',
    '[',
    ']',
    '{',
    '}',
    '!',
    '#',
    '$',
    '&',
    "'",
    '*',
    '|',
    '~',
    '`',
    '\t',
    '\r',
    '\n',
    '\0',
    'é',
  ])('refuses a session value whose only fault is the character %j', (character) => {
    const { response, lines } = fake();

    expect(() => {
      issueBrowserSessionCookies(response, {
        session: `${'a'.repeat(30)}${character}`,
        csrf: CSRF,
      });
    }).toThrow(TypeError);
    expect(lines()).toEqual([]);
  });

  it('refuses a CSRF value that is not a token, before writing the session cookie', () => {
    const { response, lines } = fake();

    expect(() => {
      issueBrowserSessionCookies(response, { session: SESSION, csrf: 'bad value' });
    }).toThrow(TypeError);
    expect(lines()).toEqual([]);
  });
});

describe('expiring the browser session cookies', () => {
  // Break caught: the expiry written as Expires in the past or left to the framework (Express's clearCookie writes an Expires
  // and no Max-Age), when the decision is the literal Max-Age=0 with the attributes the cookie was issued with.
  it('writes Max-Age=0 literally, with an empty value and the attributes the cookies were issued with', () => {
    const { response, lines } = fake();

    expireBrowserSessionCookies(response);

    expect(lines()).toEqual([
      'melarc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      'melarc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax',
    ]);
    for (const line of lines()) {
      expect(line).toContain('Max-Age=0');
      expect(line.toLowerCase()).not.toMatch(/expires|domain/);
      expect(broken(line), line).toEqual([]);
    }
  });

  // Break caught: a cookie that is removed from one scope and left in another: the deletion must match the scope it was set in.
  it('matches the scope of the issued cookies: the same path, secure and same-site', () => {
    const issued = fake();
    const expired = fake();

    issueBrowserSessionCookies(issued.response, { session: SESSION, csrf: CSRF });
    expireBrowserSessionCookies(expired.response);

    const scope = (line: string) => {
      const cookie = only(line);
      return [
        cookie.name,
        cookie.values.get('path'),
        cookie.values.get('samesite'),
        [...cookie.flags].toSorted(),
      ];
    };
    expect(expired.lines().map(scope)).toEqual(issued.lines().map(scope));
  });

  // Break caught: signing out of the browser session also deleting the vendor's registered browser, which is what makes the
  // device credential a second factor (SECURITY_DESIGN.md §13.2, §13.8a).
  it('never touches the vendor device cookie', () => {
    const { response, lines } = fake();

    expireBrowserSessionCookies(response);

    expect(lines().some((line) => line.startsWith('melarc_vendor_device'))).toBe(false);
    expect('expireVendorDeviceCookie' in { expireBrowserSessionCookies }).toBe(false);
  });
});

describe('issuing the vendor device cookie', () => {
  it('writes it with the attributes and the 400-day lifetime the contract gives it', () => {
    const { response, lines } = fake();

    issueVendorDeviceCookie(response, DEVICE);

    expect(lines()).toEqual([
      `melarc_vendor_device=${DEVICE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`,
    ]);
    expect(broken(lines()[0] ?? '')).toEqual([]);
  });

  it('refuses a value that is not a token', () => {
    const { response, lines } = fake();

    expect(() => {
      issueVendorDeviceCookie(response, 'x y');
    }).toThrow(TypeError);
    expect(lines()).toEqual([]);
  });
});

describe('setCookieLine: the one place a Set-Cookie line is made', () => {
  // Break caught: a writer that builds a line the checker does not parse the same way a browser would.
  it('is read back by the contract’s parser as the cookie that was meant', () => {
    const line = setCookieLine(COOKIES.session, SESSION, { httpOnly: true });
    const cookie = only(line);

    expect(cookie.name).toBe('melarc_session');
    expect(cookie.values.get('path')).toBe('/');
    expect(cookie.values.get('samesite')).toBe('Lax');
    expect([...cookie.flags].toSorted()).toEqual(['httponly', 'secure']);
  });

  it('refuses a name that is not one of the three cookies', () => {
    expect(() => setCookieLine('analytics' as never, SESSION, { httpOnly: true })).toThrow(
      TypeError,
    );
  });
});

describe('the contract’s validator, judging real sign-out and sign-in answers', () => {
  const validator = new ContractValidator(contract);
  const BROWSER = {
    headers: { cookie: `melarc_session=${SESSION}; melarc_csrf=${CSRF}`, 'x-csrf-token': CSRF },
  };

  const cookieViolations = (
    operationId: string,
    status: number,
    setCookie: string[],
    request: { headers: Record<string, string> },
  ) =>
    validator
      .validateResponse(
        operationId,
        { status, body: undefined, headers: { 'set-cookie': setCookie } },
        request,
      )
      .filter((violation) => violation.in === 'response-cookie');

  // Break caught: the writer and the validator each right by their own tests and wrong together.
  it('finds nothing wrong with a browser sign-out that expires the cookies the writer wrote', () => {
    const { response, lines } = fake();

    expireBrowserSessionCookies(response);

    expect(cookieViolations('signOut', 204, lines(), BROWSER)).toEqual([]);
  });

  it('finds nothing wrong with the cookies of a vendor sign-in the writer issued', () => {
    const { response, lines } = fake();

    issueBrowserSessionCookies(response, { session: SESSION, csrf: CSRF });
    issueVendorDeviceCookie(response, DEVICE);

    expect(
      cookieViolations('vendorSignIn', 200, lines(), {
        headers: { cookie: `melarc_vendor_device=${DEVICE}` },
      }),
    ).toEqual([]);
  });

  // Break caught: the validator accepting what the writer got wrong, which would make the two agreements worthless.
  it('does report a session cookie issued with a lifetime, so the agreement above is not empty', () => {
    const line = `melarc_session=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`;

    expect(broken(line)).toContain('max-age');
  });
});

describe('over a real connection', () => {
  let running: TestApp | undefined;

  afterEach(async () => {
    await running?.stop();
    running = undefined;
  });

  @Controller('cookies')
  @TechnicalEndpoint()
  class CookieFixtureController {
    @Get('in')
    signIn(@Res({ passthrough: true }) response: Response): { ok: boolean } {
      issueBrowserSessionCookies(response, { session: SESSION, csrf: CSRF });
      issueVendorDeviceCookie(response, DEVICE);
      return { ok: true };
    }

    @Get('out')
    signOut(@Res({ passthrough: true }) response: Response): { ok: boolean } {
      expireBrowserSessionCookies(response);
      return { ok: true };
    }
  }

  @Module({ controllers: [CookieFixtureController] })
  class CookieFixtureModule {}

  // Break caught: the cookies joined into one comma-separated header, which no browser stores as three cookies.
  it('sends each cookie as a field line of its own', async () => {
    running = await startTestApp({ rootModule: appWith(CookieFixtureModule) });

    const signedIn = await fetch(`${running.baseUrl}/api/v1/cookies/in`);
    const signedOut = await fetch(`${running.baseUrl}/api/v1/cookies/out`);

    expect(signedIn.headers.getSetCookie()).toEqual([
      `melarc_session=${SESSION}; Path=/; HttpOnly; Secure; SameSite=Lax`,
      `melarc_csrf=${CSRF}; Path=/; Secure; SameSite=Lax`,
      `melarc_vendor_device=${DEVICE}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=34560000`,
    ]);
    expect(signedOut.headers.getSetCookie()).toEqual([
      'melarc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      'melarc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax',
    ]);
    expect(signedIn.headers.get('cache-control')).toBe('no-store');
  });
});

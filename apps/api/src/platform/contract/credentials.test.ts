import { describe, expect, it } from 'vitest';

import { credentialCheck } from './credentials.js';
import {
  ContractValidator,
  type ResponseContext,
  type ResponseParts,
} from './contract-validator.js';
import type { JsonObject } from './json.js';

const BROWSER = { type: 'apiKey', in: 'cookie', name: 'melarc_session' };
const BEARER = { type: 'http', scheme: 'bearer' };
const CSRF = { type: 'apiKey', in: 'header', name: 'X-CSRF-Token' };

describe('credentialCheck: was this credential presented', () => {
  // Break caught: a cookie being matched by a part of its name, or by the first cookie of several. Another
  // cookie that ends in the name (`xmelarc_session`) is not the session.
  it('finds a cookie credential by its exact name among the cookies sent', () => {
    const presented = credentialCheck('browserSession', BROWSER);

    expect(presented({ cookie: 'melarc_session=abc' })).toBe(true);
    expect(presented({ cookie: 'theme=dark; melarc_session=abc; melarc_csrf=def' })).toBe(true);
    expect(presented({ cookie: ['theme=dark', 'melarc_session=abc'] })).toBe(true);
    expect(presented({ cookie: 'xmelarc_session=abc' })).toBe(false);
    expect(presented({ cookie: 'melarc_session_old=abc' })).toBe(false);
    expect(presented({ cookie: 'theme=dark' })).toBe(false);
    expect(presented({})).toBe(false);
  });

  // Break caught: a bearer credential being judged by the header's presence alone, so a `Basic` header or an
  // empty `Bearer` counts as a session.
  it('finds a bearer credential by its scheme word and a token after it', () => {
    const presented = credentialCheck('riderSession', BEARER);

    expect(presented({ authorization: 'Bearer abc.def' })).toBe(true);
    expect(presented({ authorization: 'bearer abc' })).toBe(true);
    expect(presented({ authorization: ['Bearer abc'] })).toBe(true);
    expect(presented({ authorization: 'Basic abc' })).toBe(false);
    expect(presented({ authorization: 'Bearer' })).toBe(false);
    expect(presented({ authorization: 'Bearer ' })).toBe(false);
    expect(presented({ authorization: 'Bearerabc' })).toBe(false);
    expect(presented({})).toBe(false);
  });

  it('finds a header credential by its name, whatever case it came in', () => {
    const presented = credentialCheck('csrfToken', CSRF);

    expect(presented({ 'x-csrf-token': 'abc' })).toBe(true);
    expect(presented({ 'x-other': 'abc' })).toBe(false);
  });

  // Break caught: a scheme this module cannot judge being read as "never presented", which would quietly turn a
  // contract rule off. It cannot be checked, so it is refused.
  it.each([
    ['no definition', undefined],
    ['an oauth2 scheme', { type: 'oauth2', flows: {} }],
    ['a cookie scheme with no name', { type: 'apiKey', in: 'cookie' }],
    ['an apiKey in the query', { type: 'apiKey', in: 'query', name: 'key' }],
    ['an http scheme with no word', { type: 'http' }],
  ])('refuses %s', (_label, definition) => {
    expect(() => credentialCheck('weird', definition as never)).toThrow(/weird/);
  });
});

/**
 * The cookies a response sets depend on how the request was authenticated (audit task 4, sign-out): a browser
 * sign-out expires the session and CSRF cookies, a Rider bearer sign-out sets nothing. The contract says so
 * with `x-set-cookies-for` beside `x-set-cookies`.
 */
describe('cookies set only for a request that presented one credential', () => {
  const ATTRIBUTES = {
    melarc_session: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
      host_only: true,
      read_by_javascript: false,
    },
    melarc_csrf: {
      attributes: 'Secure; SameSite=Lax; Path=/',
      host_only: true,
      read_by_javascript: true,
    },
    melarc_vendor_device: {
      attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
      host_only: true,
      read_by_javascript: false,
    },
  };
  const contractWith = (answer: JsonObject): JsonObject => ({
    openapi: '3.1.0',
    'x-cookies': ATTRIBUTES,
    components: { securitySchemes: { browserSession: BROWSER, riderSession: BEARER } },
    paths: {
      '/session': {
        delete: {
          operationId: 'signOut',
          responses: { '204': { description: 'Signed out', ...answer } },
        },
      },
    },
  });
  const validator = new ContractValidator(
    contractWith({
      'x-set-cookies': ['melarc_session', 'melarc_csrf'],
      'x-set-cookies-for': 'browserSession',
      headers: { 'Set-Cookie': { schema: { type: 'string' } } },
    }),
  );

  const EXPIRED_SESSION = 'melarc_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax';
  const EXPIRED_CSRF = 'melarc_csrf=; Max-Age=0; Path=/; Secure; SameSite=Lax';
  const BROWSER_REQUEST = {
    headers: { cookie: 'melarc_session=S; melarc_csrf=C', 'x-csrf-token': 'C' },
  };
  const RIDER_REQUEST = { headers: { authorization: 'Bearer R' } };

  const cookiesOf = (
    request: { headers: Record<string, string | string[] | undefined> } | undefined,
    setCookie?: string[],
  ) => {
    const parts: ResponseParts = {
      status: 204,
      body: undefined,
      headers: setCookie === undefined ? {} : { 'set-cookie': setCookie },
    };
    return validator
      .validateResponse('signOut', parts, request)
      .filter((violation) => violation.in === 'response-cookie');
  };

  // Break caught: a browser sign-out that leaves the browser holding a session cookie and a CSRF token. The
  // browser then carries a credential the server has already ended.
  it('expects the cookies to be set (expired) on a browser sign-out, and reports each one missing', () => {
    expect(cookiesOf(BROWSER_REQUEST, [EXPIRED_SESSION, EXPIRED_CSRF])).toEqual([]);
    expect(cookiesOf(BROWSER_REQUEST, [EXPIRED_CSRF])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'required' },
    ]);
    expect(
      cookiesOf(BROWSER_REQUEST)
        .map((violation) => violation.pointer)
        .toSorted(),
    ).toEqual(['melarc_csrf', 'melarc_session']);
  });

  // Break caught: an expiry that drops the attributes, so a client treats it as a different cookie and keeps the
  // original: a cookie is cleared by being set again with the attributes it was set with.
  it('holds an expiring cookie to the attributes the cookie was set with', () => {
    expect(
      cookiesOf(BROWSER_REQUEST, [
        'melarc_session=; Max-Age=0; Path=/api; HttpOnly; Secure; SameSite=Lax',
        EXPIRED_CSRF,
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_session', rule: 'path' }]);
    expect(
      cookiesOf(BROWSER_REQUEST, [
        'melarc_session=; Max-Age=0; Path=/; Domain=melarc.example; HttpOnly; Secure; SameSite=Lax',
        EXPIRED_CSRF,
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_session', rule: 'domain' }]);
  });

  // Break caught: the device credential being cleared along with the session. Signing out of a session does not
  // unregister the vendor's browser; clearing it would lock the vendor out of their own sign-in.
  it('refuses any other cookie on a browser sign-out, the vendor device credential included', () => {
    expect(
      cookiesOf(BROWSER_REQUEST, [
        EXPIRED_SESSION,
        EXPIRED_CSRF,
        'melarc_vendor_device=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' }]);
    expect(
      cookiesOf(BROWSER_REQUEST, [EXPIRED_SESSION, EXPIRED_CSRF, 'tracker=1; Path=/']),
    ).toEqual([{ in: 'response-cookie', pointer: '*', rule: 'undeclared' }]);
  });

  // Break caught: the declaration applying to every request of the operation, so that a Rider's sign-out has to
  // carry cookies a native client has no use for.
  it('expects no cookie on a bearer sign-out', () => {
    expect(cookiesOf(RIDER_REQUEST)).toEqual([]);
  });

  // Break caught: a bearer sign-out that sets cookies being accepted because the operation declares some.
  it('refuses a cookie on a bearer sign-out, named when the contract knows it', () => {
    expect(cookiesOf(RIDER_REQUEST, [EXPIRED_SESSION])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
    ]);
    expect(cookiesOf(RIDER_REQUEST, ['tracker=1'])).toEqual([
      { in: 'response-cookie', pointer: '*', rule: 'undeclared' },
    ]);
  });

  // Break caught: a request that presents the browser cookie and a bearer token being let off. When both are
  // presented the browser rule holds, because a cookie a browser still holds is the one to clear.
  it('applies the browser rule when both credentials were presented', () => {
    const both = { headers: { ...BROWSER_REQUEST.headers, authorization: 'Bearer R' } };

    expect(cookiesOf(both, [EXPIRED_SESSION, EXPIRED_CSRF])).toEqual([]);
    expect(cookiesOf(both)).toHaveLength(2);
  });

  it('applies no cookie to a request that presented neither', () => {
    expect(cookiesOf({ headers: {} })).toEqual([]);
    expect(cookiesOf({ headers: {} }, [EXPIRED_SESSION])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_session', rule: 'undeclared' },
    ]);
  });

  // Break caught: the condition being skipped silently when a caller forgets to pass the request, which would
  // turn the rule off in exactly the code that uses it.
  it('fails loudly when it is asked without the request', () => {
    expect(() => cookiesOf(undefined, [EXPIRED_SESSION, EXPIRED_CSRF])).toThrow(/signOut/);
  });

  // Break caught: a response that declares no condition changing with the request. Sign-in sets its cookies
  // whoever asks.
  it('leaves a response with no condition alone, whatever the request', () => {
    const unconditional = new ContractValidator(
      contractWith({ 'x-set-cookies': ['melarc_session', 'melarc_csrf'] }),
    );
    const parts: ResponseParts = { status: 204, body: undefined, headers: {} };

    for (const request of [undefined, BROWSER_REQUEST, RIDER_REQUEST]) {
      expect(
        unconditional
          .validateResponse('signOut', parts, request)
          .map((violation) => violation.pointer)
          .toSorted(),
      ).toEqual(['melarc_csrf', 'melarc_session']);
    }
  });

  // Break caught: a mistyped scheme name failing with a message that does not say which name. Whoever edits the
  // contract needs the name that is wrong.
  it('names the scheme it cannot find', () => {
    const contract = contractWith({
      'x-set-cookies': ['melarc_session'],
      'x-set-cookies-for': 'browserSesion',
    });

    expect(() => {
      new ContractValidator(contract).prepare('signOut');
    }).toThrow(/browserSesion.*does not define/);
  });

  // Break caught: a contract whose condition cannot be checked being read as "always" or "never". Preparing
  // fails, so the application does not start unprotected.
  it.each([
    ['a scheme the contract does not define', { 'x-set-cookies-for': 'ghost' }],
    ['something that is not a scheme name', { 'x-set-cookies-for': ['browserSession'] }],
    ['a scheme this validator cannot judge', { 'x-set-cookies-for': 'oauth' }],
    [
      'a condition with no cookies to apply it to',
      { 'x-set-cookies-for': 'browserSession', 'x-set-cookies': [] },
    ],
  ])('refuses a contract that names %s', (_label, answer) => {
    const contract: JsonObject = {
      ...contractWith({ 'x-set-cookies': ['melarc_session'], ...answer }),
      components: {
        securitySchemes: { browserSession: BROWSER, oauth: { type: 'oauth2', flows: {} } },
      },
    };

    expect(() => {
      new ContractValidator(contract).prepare('signOut');
    }).toThrow(/signOut|x-set-cookies-for/);
  });
});

/**
 * The cookies a response sets can also depend on whose answer it is, which neither the request nor the response
 * says: `completeCredentialRecovery` has one 204 for a vendor (the browser is given a device credential) and for
 * a staff member (no cookie at all). The contract says so with `x-set-cookies-when` beside `x-set-cookies`, and
 * the application says whose answer it is.
 */
describe('cookies set only for one principal type (x-set-cookies-when)', () => {
  const DEVICE = 'melarc_vendor_device=; Max-Age=34560000; Path=/; HttpOnly; Secure; SameSite=Lax';
  const contractWith = (answer: JsonObject): JsonObject => ({
    openapi: '3.1.0',
    'x-cookies': {
      melarc_vendor_device: {
        attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=34560000',
        host_only: true,
        read_by_javascript: false,
      },
      melarc_session: {
        attributes: 'HttpOnly; Secure; SameSite=Lax; Path=/',
        host_only: true,
        read_by_javascript: false,
      },
    },
    components: { securitySchemes: { browserSession: BROWSER, riderSession: BEARER } },
    paths: {
      '/recovery/complete': {
        post: {
          operationId: 'completeRecovery',
          responses: { '204': { description: 'Credential set', ...answer } },
        },
      },
    },
  });
  const validator = new ContractValidator(
    contractWith({
      'x-set-cookies': ['melarc_vendor_device'],
      'x-set-cookies-when': { principal_type: 'VENDOR' },
      headers: { 'Set-Cookie': { schema: { type: 'string' } } },
    }),
  );

  const cookiesOf = (
    context: ResponseContext | undefined,
    setCookie?: string[],
    request?: { headers: Record<string, string | string[] | undefined> },
    judge: ContractValidator = validator,
  ) => {
    const parts: ResponseParts = {
      status: 204,
      body: undefined,
      headers: setCookie === undefined ? {} : { 'set-cookie': setCookie },
    };
    return judge
      .validateResponse('completeRecovery', parts, request, context)
      .filter((violation) => violation.in === 'response-cookie');
  };

  // Break caught: a vendor recovery that completes and leaves the vendor's browser without the device credential
  // it was promised. The old one was revoked, so the browser could never sign in again.
  it('owes the cookie to a vendor answer, and reports it when it is missing', () => {
    expect(cookiesOf({ principalType: 'VENDOR' }, [DEVICE])).toEqual([]);
    expect(cookiesOf({ principalType: 'VENDOR' })).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
    ]);
  });

  // Break caught: the declaration applying to every principal, so that a staff recovery has to carry a vendor's
  // browser credential, or is let off silently when it sets one.
  it('owes a staff answer no cookie, and reports one that sets it', () => {
    expect(cookiesOf({ principalType: 'STAFF' })).toEqual([]);
    expect(cookiesOf({ principalType: 'STAFF' }, [DEVICE])).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' },
    ]);
    expect(cookiesOf({ principalType: 'STAFF' }, ['tracker=1'])).toEqual([
      { in: 'response-cookie', pointer: '*', rule: 'undeclared' },
    ]);
  });

  // Break caught: the type the contract names being replaced by a fixed one in the code, so that a condition on any
  // other type is read as the vendor's. The contract's own type is the one that decides.
  it('owes the cookies to whichever type the contract names', () => {
    const staffOnly = new ContractValidator(
      contractWith({
        'x-set-cookies': ['melarc_vendor_device'],
        'x-set-cookies-when': { principal_type: 'STAFF' },
        headers: { 'Set-Cookie': { schema: { type: 'string' } } },
      }),
    );

    expect(cookiesOf({ principalType: 'STAFF' }, undefined, undefined, staffOnly)).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
    ]);
    expect(cookiesOf({ principalType: 'STAFF' }, [DEVICE], undefined, staffOnly)).toEqual([]);
    expect(cookiesOf({ principalType: 'VENDOR' }, undefined, undefined, staffOnly)).toEqual([]);
    expect(cookiesOf({ principalType: 'VENDOR' }, [DEVICE], undefined, staffOnly)).toEqual([
      { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' },
    ]);
  });

  // Break caught: the principal being compared loosely, so that a type that merely contains or resembles the
  // named one is owed the cookie.
  it.each(['RIDER', 'vendor', 'VENDOR ', 'VENDORS', ''])(
    'owes the answer of %j no cookie either',
    (principalType) => {
      expect(cookiesOf({ principalType })).toEqual([]);
      expect(cookiesOf({ principalType }, [DEVICE])).toHaveLength(1);
    },
  );

  // Break caught: the cookie being checked by name only. The vendor's answer still carries the attributes the
  // contract promises, the lifetime included.
  it('holds the cookie a vendor answer sets to its attributes', () => {
    expect(
      cookiesOf({ principalType: 'VENDOR' }, [
        'melarc_vendor_device=; Path=/; HttpOnly; Secure; SameSite=Lax',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'max-age' }]);
    expect(
      cookiesOf({ principalType: 'VENDOR' }, [
        'melarc_vendor_device=; Max-Age=34560000; Path=/; Secure; SameSite=Lax',
      ]),
    ).toEqual([{ in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'httponly' }]);
  });

  // Break caught: the condition being skipped silently when the application does not say whose answer it is,
  // which would turn the rule off in exactly the code that uses it.
  it('fails loudly when it is asked without the principal, or without a type in it', () => {
    expect(() => cookiesOf(undefined, [DEVICE])).toThrow(/completeRecovery.*x-set-cookies-when/);
    expect(() => cookiesOf({}, [DEVICE])).toThrow(/completeRecovery.*x-set-cookies-when/);
  });

  // Break caught: a condition on the principal being asked for the request as well. It is the application that
  // knows whose answer this is, and a request carrying no credential at all (recovery) is a valid one.
  it('needs no request to judge it', () => {
    expect(cookiesOf({ principalType: 'VENDOR' }, [DEVICE], undefined)).toEqual([]);
    expect(cookiesOf({ principalType: 'STAFF' }, undefined, { headers: {} })).toEqual([]);
  });

  // Break caught: the two conditions on one response being read as either one. Both must hold, so a browser that
  // presented the credential still is owed nothing when the answer is another principal's.
  describe('beside x-set-cookies-for', () => {
    const both = new ContractValidator({
      ...contractWith({
        'x-set-cookies': ['melarc_vendor_device'],
        'x-set-cookies-for': 'browserSession',
        'x-set-cookies-when': { principal_type: 'VENDOR' },
      }),
    });
    const BROWSER_REQUEST = { headers: { cookie: 'melarc_session=S' } };
    const NOBODY = { headers: {} };

    it('owes the cookies only when the credential was presented and the answer is that principal’s', () => {
      expect(cookiesOf({ principalType: 'VENDOR' }, [DEVICE], BROWSER_REQUEST, both)).toEqual([]);
      expect(cookiesOf({ principalType: 'VENDOR' }, undefined, BROWSER_REQUEST, both)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
      ]);
      expect(cookiesOf({ principalType: 'VENDOR' }, undefined, NOBODY, both)).toEqual([]);
      expect(cookiesOf({ principalType: 'STAFF' }, undefined, BROWSER_REQUEST, both)).toEqual([]);
      expect(cookiesOf({ principalType: 'STAFF' }, [DEVICE], BROWSER_REQUEST, both)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'undeclared' },
      ]);
    });

    it('still needs the request for the credential half', () => {
      expect(() => cookiesOf({ principalType: 'VENDOR' }, [DEVICE], undefined, both)).toThrow(
        /completeRecovery.*x-set-cookies-for/,
      );
    });
  });

  // Break caught: a response that names no condition being changed by the new one. Sign-in sets its cookies whoever
  // asks, and no principal need be given.
  it('leaves a response with no condition alone, whatever the principal', () => {
    const unconditional = new ContractValidator(
      contractWith({ 'x-set-cookies': ['melarc_vendor_device'] }),
    );

    for (const context of [undefined, { principalType: 'STAFF' }, { principalType: 'VENDOR' }]) {
      expect(cookiesOf(context, undefined, undefined, unconditional)).toEqual([
        { in: 'response-cookie', pointer: 'melarc_vendor_device', rule: 'required' },
      ]);
    }
  });

  // Break caught: a condition that cannot be checked being read as "always" or "never". Preparing fails, so the
  // application does not start unprotected.
  it.each([
    ['something that is not an object', 'VENDOR'],
    ['a list', ['VENDOR']],
    ['no principal type', {}],
    ['a principal type that is not text', { principal_type: 5 }],
    ['an empty principal type', { principal_type: '' }],
    ['a condition it does not know', { principal_type: 'VENDOR', hub_id: 'x' }],
  ])('refuses a contract whose condition is %s', (_label, condition) => {
    const contract = contractWith({
      'x-set-cookies': ['melarc_vendor_device'],
      'x-set-cookies-when': condition,
    });

    expect(() => {
      new ContractValidator(contract).prepare('completeRecovery');
    }).toThrow(/x-set-cookies-when of response 204 of completeRecovery/);
  });

  it('refuses a condition with no cookies to apply it to', () => {
    const contract = contractWith({
      'x-set-cookies': [],
      'x-set-cookies-when': { principal_type: 'VENDOR' },
    });

    expect(() => {
      new ContractValidator(contract).prepare('completeRecovery');
    }).toThrow(/x-set-cookies-when of response 204 of completeRecovery applies to no cookies/);
  });
});

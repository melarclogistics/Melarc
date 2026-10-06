import { describe, expect, it } from 'vitest';

import { CALL_OPTIONS, checkedCallOptions, checkedMethod } from './call-options.ts';
import { BrowserTransportError } from './send-boundary.ts';

describe('the options a call may use', () => {
  // Break caught: the list of what a call may use growing without a decision. Everything else in the
  // underlying client's options belongs to the transport.
  it('are the contract parameters, the body, how to read the answer, an abort signal and extra headers', () => {
    expect([...CALL_OPTIONS]).toEqual(['params', 'body', 'parseAs', 'signal', 'headers']);
  });

  // Break caught: an allowed option dropped on the way to the client, or the caller's own object handed on
  // (which the caller, or a getter on it, could change afterwards).
  it('hands on a new object holding exactly what was given', () => {
    const signal = new AbortController().signal;
    const given = {
      params: { path: { id: 'x' } },
      body: { a: 1 },
      parseAs: 'text',
      signal,
      headers: { Accept: 'text/csv' },
    };

    const checked = checkedCallOptions(given);

    expect(checked).toEqual(given);
    expect(checked).not.toBe(given);
    expect(checked?.signal).toBe(signal);
  });

  it('are optional', () => {
    expect(checkedCallOptions(undefined)).toBeUndefined();
    expect(checkedCallOptions({})).toEqual({});
  });

  // Break caught (audit F02): any of the options that decide where, how or by what a request is sent being
  // let through. Each is refused by name, and the value it held is not repeated.
  it.each([
    'credentials',
    'redirect',
    'mode',
    'cache',
    'keepalive',
    'referrer',
    'referrerPolicy',
    'integrity',
    'priority',
    'window',
    'duplex',
    'method',
    'baseUrl',
    'fetch',
    'Request',
    'middleware',
    'querySerializer',
    'bodySerializer',
    'pathSerializer',
    'requestInitExt',
  ])('refuses %s, by name and without repeating its value', (name) => {
    let error: unknown;
    try {
      checkedCallOptions({ params: {}, [name]: 'VALUE-CANARY' });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BrowserTransportError);
    expect((error as Error).message).toContain(name);
    expect((error as Error).message).not.toContain('VALUE-CANARY');
  });

  // Break caught: only the first refused option being named.
  it('names every refused option', () => {
    expect(() => checkedCallOptions({ credentials: 'omit', redirect: 'follow' })).toThrow(
      /credentials, redirect/,
    );
  });

  // Break caught: an option present with no value being let through. It would still be a key the client
  // acts on once it is spread, and it says the caller meant to set it.
  it('refuses an option even when its value is undefined', () => {
    expect(() => checkedCallOptions({ credentials: undefined })).toThrow(BrowserTransportError);
  });

  // Break caught: something that is not a set of options being read as one.
  it.each([
    ['a string', 'credentials'],
    ['a number', 5],
    ['null', null],
    ['an array', [{ params: {} }]],
    ['a function', () => undefined],
  ])('refuses %s as the options of a call', (_label, value) => {
    expect(() => checkedCallOptions(value)).toThrow(BrowserTransportError);
  });

  // Break caught: an option inherited from a prototype being read as the caller's own, or one set there
  // reaching the client.
  it('reads only the options the caller owns', () => {
    const inherited = Object.create({
      credentials: 'omit',
      params: { path: { id: 'x' } },
    }) as object;

    expect(checkedCallOptions(inherited)).toEqual({});
  });
});

describe('path parameters that are not one real segment', () => {
  // Break caught: a path parameter that the URL then reads as a dot segment or as nothing. `..` climbs one
  // segment and `.` and an empty value drop one, so the call reaches a different route inside /api/v1 than
  // the operation it names (GET /pickup-requests/{id} with `.` is GET /pickup-requests/). The final boundary
  // cannot see this: the request is still under /api/v1.
  it.each([
    ['..', { id: '..' }],
    ['.', { id: '.' }],
    ['an empty value', { id: '' }],
    ['a list of one dot segment', { id: ['..'] }],
  ])('refuses %s, by parameter name', (_label, path) => {
    let error: unknown;
    try {
      checkedCallOptions({ params: { path } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BrowserTransportError);
    expect((error as Error).message).toContain('id');
  });

  // Break caught: the guard refusing a value that is one real segment, or one that only contains dots. Dots
  // inside a value, a value the URL encodes, and numbers are all fine.
  it.each([
    'abc',
    '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f',
    '...',
    'a.b',
    '.hidden',
    'a..b',
    '%2e%2e',
    '../../x',
    'a/b',
    ' ',
  ])('accepts %j', (id) => {
    expect(checkedCallOptions({ params: { path: { id } } })).toEqual({ params: { path: { id } } });
  });

  it('accepts a number, a list of several values, and a call with no path parameters', () => {
    expect(() => checkedCallOptions({ params: { path: { id: 7 } } })).not.toThrow();
    expect(() => checkedCallOptions({ params: { path: { ids: ['..', 'x'] } } })).not.toThrow();
    expect(() => checkedCallOptions({ params: { query: { limit: 5 } } })).not.toThrow();
    expect(() => checkedCallOptions({ params: undefined })).not.toThrow();
  });

  it('names every parameter that is refused', () => {
    expect(() => checkedCallOptions({ params: { path: { a: '..', b: '.', c: 'ok' } } })).toThrow(
      /a, b/,
    );
  });
});

describe('the method of a generic request', () => {
  it.each(['get', 'GET', 'Post', 'put', 'patch', 'delete', 'options', 'head', 'trace'])(
    'accepts %s',
    (method) => {
      expect(checkedMethod(method)).toBe(method);
    },
  );

  // Break caught: a method the browser forbids, or text that is not a method at all, reaching the client.
  it.each(['connect', 'FOO', '', 'GET ', 'get\n', 'track'])('refuses %j', (method) => {
    expect(() => checkedMethod(method)).toThrow(BrowserTransportError);
  });

  it('refuses what is not text', () => {
    expect(() => checkedMethod(undefined)).toThrow(BrowserTransportError);
    expect(() => checkedMethod(5)).toThrow(BrowserTransportError);
  });
});

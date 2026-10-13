import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { boundedIdentifier } from './bounded-identifier.js';
import { markBodyParseFailure } from './parse-failure.js';

const requestWith = (body: unknown): Request => ({ body }) as unknown as Request;
const EMAIL = { field: 'email', maxBytes: 320 };

describe('boundedIdentifier: what a limiter may take from a body before the body is validated', () => {
  it('takes the named string as it was sent, without trimming or changing it', () => {
    expect(boundedIdentifier(requestWith({ email: ' Ada@Example.com ' }), EMAIL)).toBe(
      ' Ada@Example.com ',
    );
  });

  // Break caught: an identifier taken from the wrong place, or one the limiter has to guess the type of.
  it.each([
    ['no body at all', undefined],
    ['a null body', null],
    ['an array', [{ email: 'a@b.c' }]],
    ['a string', 'a@b.c'],
    ['a number', 7],
    ['an object without the field', { other: 'a@b.c' }],
    ['a number in the field', { email: 12 }],
    ['an array in the field', { email: ['a@b.c'] }],
    ['an object in the field', { email: { value: 'a@b.c' } }],
    ['null in the field', { email: null }],
    ['an empty string', { email: '' }],
  ])('takes nothing from %s, so the request meets the coarse limits', (_label, body) => {
    expect(boundedIdentifier(requestWith(body), EMAIL)).toBeUndefined();
  });

  // Break caught: no bound. The body is within the size limit, but a limiter key is stored and compared, and an identifier of the
  // size of the body is a way to make every request expensive.
  it('takes nothing longer than its bound, counted in bytes and not in characters', () => {
    const exact = 'a'.repeat(320);
    // 161 characters of two bytes each are 322 bytes: under the bound by characters, over it by bytes.
    const wide = 'é'.repeat(161);

    expect(boundedIdentifier(requestWith({ email: exact }), EMAIL)).toBe(exact);
    expect(boundedIdentifier(requestWith({ email: `${exact}a` }), EMAIL)).toBeUndefined();
    expect(boundedIdentifier(requestWith({ email: wide }), EMAIL)).toBeUndefined();
  });

  // Break caught: a prototype member read as if the caller had sent it.
  it('reads only members the body itself holds', () => {
    expect(
      boundedIdentifier(requestWith({}), { field: 'toString', maxBytes: 100 }),
    ).toBeUndefined();
    expect(
      boundedIdentifier(requestWith({}), { field: 'constructor', maxBytes: 100 }),
    ).toBeUndefined();
    expect(
      boundedIdentifier(requestWith({}), { field: '__proto__', maxBytes: 100 }),
    ).toBeUndefined();
  });

  // Break caught: an identifier taken from a body that could not be read. The parser leaves the body empty, and a request whose
  // body is not valid JSON has no identifier: it meets the coarse limits and then, if it gets that far, the validation step.
  it('takes nothing from a request whose body could not be parsed', () => {
    const request = requestWith({ email: 'a@b.c' });
    markBodyParseFailure(request);

    expect(boundedIdentifier(request, EMAIL)).toBeUndefined();
  });

  // Break caught: a bound that is not a bound.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to be asked with a bound of %s',
    (maxBytes) => {
      expect(() =>
        boundedIdentifier(requestWith({ email: 'a' }), { field: 'email', maxBytes }),
      ).toThrow(RangeError);
    },
  );
});

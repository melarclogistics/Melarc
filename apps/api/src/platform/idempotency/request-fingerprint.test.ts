import { describe, expect, it } from 'vitest';

import { requestFingerprint } from './request-fingerprint.js';

const BASE = {
  operationId: 'registerRiderDevice',
  pathParameters: { riderId: '11111111-1111-4111-8111-111111111111' },
  body: { name: 'Ama', device: { model: 'X', slots: [1, 2] } },
};

describe('the fingerprint of a request', () => {
  // Break caught: a fingerprint that is not a fixed-size lower-case hex digest (it is stored and compared as text).
  it('is 64 lower-case hexadecimal characters', () => {
    expect(requestFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  // Break caught: the fingerprint reading the same request differently each time, which would turn every retry into a conflict.
  it('is the same for the same request', () => {
    expect(requestFingerprint({ ...BASE })).toBe(requestFingerprint({ ...BASE }));
  });

  // Break caught: a retry whose body lists its keys in another order being taken for a different request.
  it('does not depend on the order of keys, in the path or the body, at any depth', () => {
    const reordered = {
      operationId: BASE.operationId,
      body: { device: { slots: [1, 2], model: 'X' }, name: 'Ama' },
      pathParameters: { riderId: BASE.pathParameters.riderId },
    };

    expect(requestFingerprint(reordered)).toBe(requestFingerprint(BASE));
  });

  // Break caught: a field left out of the fingerprint, so that a changed request would replay the first answer.
  it('changes with the operation, any path parameter and any part of the body', () => {
    const base = requestFingerprint(BASE);
    const variants = [
      { ...BASE, operationId: 'reregisterRiderDevice' },
      { ...BASE, pathParameters: { riderId: '22222222-2222-4222-8222-222222222222' } },
      { ...BASE, pathParameters: { ...BASE.pathParameters, extra: 'x' } },
      { ...BASE, body: { ...BASE.body, name: 'Ama ' } },
      { ...BASE, body: { ...BASE.body, device: { model: 'X', slots: [2, 1] } } },
      { ...BASE, body: { ...BASE.body, device: { model: 'X', slots: [1, 2], rooted: false } } },
    ];

    for (const variant of variants) expect(requestFingerprint(variant)).not.toBe(base);
  });

  // Break caught: an absent body, a null body and an empty one being the same request.
  it('tells a request with no body from one whose body is null, empty or an empty string', () => {
    const fingerprints = [undefined, null, {}, [], ''].map((body) =>
      requestFingerprint({ operationId: 'signOut', ...(body === undefined ? {} : { body }) }),
    );

    expect(new Set(fingerprints).size).toBe(5);
  });

  // Break caught: two fields run together, so that ("ab", "c") and ("a", "bc") are one request.
  it('keeps one value from running into the next', () => {
    const a = requestFingerprint({ operationId: 'op', pathParameters: { a: 'bc', b: 'd' } });
    const b = requestFingerprint({ operationId: 'op', pathParameters: { a: 'b', b: 'cd' } });

    expect(a).not.toBe(b);
  });

  // Break caught: a value that is not JSON being fingerprinted as though it were one (and so as something else).
  it('refuses a value that JSON cannot hold, or an operation id that is not a name', () => {
    for (const body of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      1n,
      Symbol('x'),
      new Date(0),
    ]) {
      expect(() => requestFingerprint({ operationId: 'op', body })).toThrow(TypeError);
    }
    expect(() => requestFingerprint({ operationId: 'op', body: { a: undefined } })).toThrow(
      TypeError,
    );
    expect(() => requestFingerprint({ operationId: '' })).toThrow(TypeError);
    expect(() => requestFingerprint({ operationId: 'not a name' })).toThrow(TypeError);
  });
});

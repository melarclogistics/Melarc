import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { fingerprintOfRequest } from './request-fingerprint-input.js';

const request = (params: Record<string, string>, body?: unknown): Request =>
  ({ params, body }) as unknown as Request;

describe('fingerprintOfRequest: the pipeline gives the store everything that makes a request this request', () => {
  // Break caught (OB-112): the path parameters forgotten. `registerRiderDevice` has no body and names the rider in the path, so
  // two riders under one key would share a fingerprint, and the second would be answered with the first's sealed enrolment secret.
  it('tells two requests apart that differ only in a path parameter', () => {
    const first = fingerprintOfRequest(request({ riderId: 'rider-1' }), 'registerRiderDevice');
    const second = fingerprintOfRequest(request({ riderId: 'rider-2' }), 'registerRiderDevice');

    expect(first).not.toBe(second);
  });

  it('is the same for the same request, whatever order the body lists its keys in', () => {
    const one = fingerprintOfRequest(
      request({ id: 'x' }, { a: 1, b: { c: 2, d: 3 } }),
      'updateThing',
    );
    const other = fingerprintOfRequest(
      request({ id: 'x' }, { b: { d: 3, c: 2 }, a: 1 }),
      'updateThing',
    );

    expect(one).toBe(other);
  });

  // Break caught: the operation left out, so the same body sent to two operations is one request.
  it('tells two operations apart', () => {
    expect(fingerprintOfRequest(request({}, { a: 1 }), 'createThing')).not.toBe(
      fingerprintOfRequest(request({}, { a: 1 }), 'updateThing'),
    );
  });

  // Break caught: a body that was sent read as one that was not, and the reverse.
  it('tells an absent body from an empty one', () => {
    const absent = fingerprintOfRequest(request({ id: 'x' }), 'updateThing');
    const empty = fingerprintOfRequest(request({ id: 'x' }, {}), 'updateThing');

    expect(absent).not.toBe(empty);
  });

  // Break caught: a path parameter named in the contract and absent from the route, which the pipeline would then not notice.
  it('reads the parameters the router found, however many and whatever they are named', () => {
    const none = fingerprintOfRequest(request({}), 'listThings');
    const two = fingerprintOfRequest(request({ hubId: 'h', riderId: 'r' }), 'listThings');
    const renamed = fingerprintOfRequest(request({ hub: 'h', rider: 'r' }), 'listThings');

    expect(new Set([none, two, renamed]).size).toBe(3);
  });

  // Break caught: a wildcard segment, which Express reads as a list, flattened into a fingerprint that could stand for two requests.
  it('refuses a path parameter that is not a single value', () => {
    const wildcard = { params: { path: ['a', 'b'] } } as unknown as Request;

    expect(() => fingerprintOfRequest(wildcard, 'readThing')).toThrow(TypeError);
  });

  it('is a 64-character lower-case hexadecimal digest', () => {
    expect(fingerprintOfRequest(request({ id: 'x' }, { a: 1 }), 'updateThing')).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });
});

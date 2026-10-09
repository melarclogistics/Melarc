import { describe, expect, it } from 'vitest';

import { parseTrustProxy } from './trust-proxy.js';

describe('parseTrustProxy', () => {
  // Break caught: forwarded headers believed by default, which lets a caller write its own client address
  // (DEPLOYMENT_AND_ENVIRONMENTS.md §12.2: `trust proxy` is off unless a deployment names its topology).
  it('is off, trusting no hop, when it says off', () => {
    expect(parseTrustProxy('off')).toEqual([]);
  });

  it.each([
    ['one address', '10.0.0.1', ['10.0.0.1']],
    ['one range', '10.0.0.0/8', ['10.0.0.0/8']],
    [
      'several hops',
      '10.0.0.1,192.168.1.0/24,fd00::/8',
      ['10.0.0.1', '192.168.1.0/24', 'fd00::/8'],
    ],
    ['an IPv6 address', '::1', ['::1']],
    ['a host route', '203.0.113.7/32', ['203.0.113.7/32']],
  ])('names the trusted hops by address: %s', (_label, text, expected) => {
    expect(parseTrustProxy(text)).toEqual(expected);
  });

  // Break caught: trust switched on unconditionally to get an apparent client address, which the design forbids.
  it.each([
    ['empty', ''],
    ['true', 'true'],
    ['false', 'false'],
    ['a hop count', '1'],
    ['a wildcard', '*'],
    ['Express "loopback"', 'loopback'],
    ['Express "uniquelocal"', 'uniquelocal'],
    ['a host name', 'proxy.example.com'],
    ['every IPv4 address', '0.0.0.0/0'],
    ['every IPv6 address', '::/0'],
    ['a zero-length prefix on any address', '10.0.0.1/0'],
    ['a prefix too long for IPv4', '10.0.0.1/33'],
    ['a prefix too long for IPv6', 'fd00::/129'],
    ['a negative prefix', '10.0.0.1/-1'],
    ['a prefix that is not a number', '10.0.0.1/x'],
    ['a space', '10.0.0.1, 10.0.0.2'],
    ['a trailing comma', '10.0.0.1,'],
    ['off beside an address', 'off,10.0.0.1'],
    [
      'more than sixteen hops',
      Array.from({ length: 17 }, (_, i) => `10.0.0.${String(i + 1)}`).join(','),
    ],
  ])('refuses %s', (_label, text) => {
    expect(parseTrustProxy(text)).toBeUndefined();
  });

  it('accepts exactly sixteen hops', () => {
    const text = Array.from({ length: 16 }, (_, i) => `10.0.0.${String(i + 1)}`).join(',');

    expect(parseTrustProxy(text)).toHaveLength(16);
  });
});

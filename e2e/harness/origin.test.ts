import { describe, expect, it } from 'vitest';

import { canonicalOrigin, isAllowedRequest, isAllowedWebSocket } from './origin.ts';

const STACK = 'http://127.0.0.1:4173';

describe('isAllowedRequest', () => {
  // Break caught: the stack's own pages and API being blocked. A boundary that refuses everything passes every
  // test that checks something is refused, so what must get through is pinned here.
  it.each([
    ['the origin itself', 'http://127.0.0.1:4173'],
    ['the root path', 'http://127.0.0.1:4173/'],
    ['a path, a query and a fragment', 'http://127.0.0.1:4173/api/v1/e2e/notes?x=1#top'],
    ['a scheme and host in capitals', 'HTTP://127.0.0.1:4173/'],
    ['credentials for the stack itself', 'http://user:secret@127.0.0.1:4173/'],
    ['a backslash, which a browser reads as a slash', 'http://127.0.0.1:4173\\@elsewhere.example/'],
    ['a data URL, which is not a request', 'data:text/plain,hello'],
    ['about:blank, which is not a request', 'about:blank'],
    [
      'a blob made by a stack page',
      'blob:http://127.0.0.1:4173/3f2b1c1e-8a3d-4a52-9f0e-9b7a6f7f1c11',
    ],
  ])('allows %s', (_name, url) => {
    expect(isAllowedRequest(url, STACK)).toBe(true);
  });

  // Break caught (audit F06): the origin being compared as text. A URL that begins with the stack's origin is not
  // necessarily a URL on it: a longer port, and a username that looks like the origin, both begin with it.
  it.each([
    ['a port that begins with the stack port', 'http://127.0.0.1:41730/'],
    ['a port that the stack port begins', 'http://127.0.0.1:417/'],
    ['another port', 'http://127.0.0.1:4174/'],
    ['no port, which is port 80', 'http://127.0.0.1/'],
    ['the stack origin as a username', 'http://127.0.0.1:4173@elsewhere.example/'],
    ['the stack origin as a username, with another port', 'http://127.0.0.1:4173@127.0.0.1:9999/'],
    ['the stack origin as a username and password', 'http://127.0.0.1:4173:x@elsewhere.example/'],
    ['the stack origin followed by a domain', 'http://127.0.0.1:4173.elsewhere.example/'],
    ['a host that begins with the stack host', 'http://127.0.0.1.elsewhere.example:4173/'],
    ['the stack origin in the path', 'http://elsewhere.example/http://127.0.0.1:4173/'],
    ['the stack origin in the query', 'http://elsewhere.example/?http://127.0.0.1:4173'],
    ['the other scheme', 'https://127.0.0.1:4173/'],
    ['the name for the same host', 'http://localhost:4173/'],
    ['the same host written another way', 'http://[::ffff:127.0.0.1]:4173/'],
    ['a WebSocket URL, which is not a request on the origin', 'ws://127.0.0.1:4173/'],
    [
      'a blob made by another origin',
      'blob:https://elsewhere.example/3f2b1c1e-8a3d-4a52-9f0e-9b7a6f7f1c11',
    ],
    ['a blob with no origin', 'blob:null/3f2b1c1e-8a3d-4a52-9f0e-9b7a6f7f1c11'],
    ['a file', 'file:///etc/passwd'],
    ['a script URL', 'javascript:alert(1)'],
    ['an extension page', 'chrome-extension://abcdefghijklmnop/page.html'],
    ['text that is not a URL', 'not a url'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isAllowedRequest(url, STACK)).toBe(false);
  });

  it('judges a request on the origin it is asked about, not on a fixed one', () => {
    expect(isAllowedRequest('http://127.0.0.1:9000/', 'http://127.0.0.1:9000')).toBe(true);
    expect(isAllowedRequest('http://127.0.0.1:4173/', 'http://127.0.0.1:9000')).toBe(false);
    expect(isAllowedRequest('https://example.test/x', 'https://example.test')).toBe(true);
    expect(isAllowedRequest('http://example.test/x', 'https://example.test')).toBe(false);
  });
});

describe('isAllowedWebSocket', () => {
  it.each([
    ['the origin as ws', 'ws://127.0.0.1:4173/socket'],
    ['the origin in capitals', 'WS://127.0.0.1:4173/socket'],
  ])('allows %s', (_name, url) => {
    expect(isAllowedWebSocket(url, STACK)).toBe(true);
  });

  it('allows wss only for an https origin', () => {
    expect(isAllowedWebSocket('wss://example.test/socket', 'https://example.test')).toBe(true);
    expect(isAllowedWebSocket('ws://example.test/socket', 'https://example.test')).toBe(false);
    expect(isAllowedWebSocket('wss://127.0.0.1:4173/socket', STACK)).toBe(false);
  });

  it.each([
    ['another port', 'ws://127.0.0.1:41730/socket'],
    ['a longer port', 'ws://127.0.0.1:417/socket'],
    ['the stack origin as a username', 'ws://127.0.0.1:4173@127.0.0.1:9999/socket'],
    ['another host', 'ws://localhost:4173/socket'],
    ['an http URL', 'http://127.0.0.1:4173/socket'],
    ['text that is not a URL', 'not a url'],
    ['nothing', ''],
  ])('refuses %s', (_name, url) => {
    expect(isAllowedWebSocket(url, STACK)).toBe(false);
  });
});

describe('canonicalOrigin', () => {
  it('returns an origin as it is', () => {
    expect(canonicalOrigin('http://127.0.0.1:4173')).toBe('http://127.0.0.1:4173');
  });

  // Break caught: a boundary built from something that is not an origin, such as a URL with a path, which would
  // quietly compare as a different origin from the one meant, or compare as nothing.
  it.each([
    ['a URL with a path', 'http://127.0.0.1:4173/app'],
    ['a trailing slash', 'http://127.0.0.1:4173/'],
    ['a default port written out', 'http://127.0.0.1:80'],
    ['credentials', 'http://user@127.0.0.1:4173'],
    ['a scheme with no network', 'data:text/plain,hello'],
    ['a scheme of another kind', 'ws://127.0.0.1:4173'],
    ['text that is not a URL', 'not a url'],
    ['nothing', ''],
  ])('refuses %s', (_name, origin) => {
    expect(() => canonicalOrigin(origin)).toThrow(/not an origin/);
    expect(() => isAllowedRequest('http://127.0.0.1:4173/', origin)).toThrow(/not an origin/);
  });
});

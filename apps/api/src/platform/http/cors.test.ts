import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RawClient } from '../../test-support/raw-http.js';
import { startTestApp, TEST_CONFIG, type TestApp } from '../../test-support/test-app.js';

/**
 * Credentialed CORS with exact origins, over real HTTP (S0.25; SECURITY_DESIGN.md §13.8 "Client policy"; `GBT-W4`, `GBT-W15`). A
 * configured origin is echoed as the configured string; every other origin gets no CORS header, and a preflight from it is refused
 * and advertises nothing; a wildcard is never sent with credentials; nothing is reflected.
 */
let app: TestApp;
const OPS = TEST_CONFIG.origins.ops;
const VENDOR = TEST_CONFIG.origins.vendor;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.stop();
});

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-expose-headers',
] as const;

async function preflight(
  origin: string | undefined,
  path = '/api/v1/orders',
  extra: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${app.baseUrl}${path}`, {
    method: 'OPTIONS',
    headers: {
      ...(origin === undefined ? {} : { origin }),
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, x-csrf-token',
      ...extra,
    },
  });
}

describe('a preflight from a configured origin', () => {
  // Break caught: the origin reflected from the request instead of the configured string, or a wildcard sent with credentials.
  it.each([
    ['the Ops origin', OPS],
    ['the Vendor origin', VENDOR],
  ])(
    'is answered 204 for %s with that origin, exactly, and credentials allowed',
    async (_label, origin) => {
      const response = await preflight(origin);

      expect(response.status).toBe(204);
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
      expect(await response.text()).toBe('');
    },
  );

  // Break caught: the permitted headers taken from what the request asked for, which lets a page talk the browser into a header
  // the API never meant to accept.
  it('advertises a fixed list of methods and headers and not the ones the request asked for', async () => {
    const response = await preflight(OPS, '/api/v1/orders', {
      'access-control-request-headers': 'x-evil, authorization, x-csrf-token',
      'access-control-request-method': 'TRACE',
    });

    expect(response.headers.get('access-control-allow-methods')).toBe(
      'GET, HEAD, POST, PUT, PATCH, DELETE',
    );
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Content-Type, X-CSRF-Token, Idempotency-Key, If-Match',
    );
    expect(response.headers.get('access-control-allow-headers')).not.toMatch(/evil|authorization/i);
  });

  // Break caught: a preflight passed on to the guards, which would refuse it for having no session, and so break every credentialed
  // cross-origin call; or routed to a handler.
  it('is answered before routing and the guards, on any path', async () => {
    for (const path of ['/api/v1/orders', '/api/v1/access/undeclared', '/nowhere']) {
      expect((await preflight(OPS, path)).status).toBe(204);
    }
  });
});

describe('a preflight from any other origin', () => {
  // Break caught: a not-configured origin given an answer a browser would accept: any CORS header at all, or a 2xx. The origin is
  // never reflected, a wildcard is never sent, and nothing is advertised to it.
  it.each([
    ['an unrelated origin', 'https://evil.example'],
    ['the null origin', 'null'],
    ['the Ops origin as a prefix of a longer host', `${OPS}.evil.example`],
    ['the Ops origin with a trailing slash', `${OPS}/`],
    ['the Ops origin in upper case', OPS.toUpperCase()],
    ['the Ops origin with a path', `${OPS}/app`],
    ['both origins as a list', `${OPS}, ${VENDOR}`],
    ['the wildcard', '*'],
    ['an empty value', ''],
  ])('is refused 403 with no CORS header and no code, for %s', async (_label, origin) => {
    const response = await preflight(origin);

    expect(response.status).toBe(403);
    for (const header of CORS_HEADERS) expect(response.headers.get(header)).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBeUndefined();
    expect(Object.keys(body).toSorted()).toEqual(['message', 'request_id']);
  });

  // Break caught: two Origin lines read as the first, so that an attacker's second line rides on a configured first one.
  it('is refused when the request carries two Origin lines, even if one is configured', async () => {
    const client = await RawClient.connect(app.baseUrl);
    try {
      await client.write(
        `OPTIONS /api/v1/orders HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${OPS}\r\nOrigin: https://evil.example\r\nAccess-Control-Request-Method: POST\r\nConnection: close\r\n\r\n`,
      );
      const response = await client.read();

      expect(response.status).toBe(403);
      for (const header of CORS_HEADERS) expect(response.headers[header]).toBeUndefined();
    } finally {
      client.destroy();
    }
  });

  // Break caught: a request that says it is a preflight but names no Origin being treated as one, or as a CORS answer.
  it('is not treated as a preflight when it carries no Origin', async () => {
    const response = await preflight(undefined, '/api/v1/orders');

    expect(response.status).not.toBe(204);
    for (const header of CORS_HEADERS) expect(response.headers.get(header)).toBeNull();
  });
});

describe('an answer to a request that carries an Origin', () => {
  it('names the configured origin and allows credentials, on a probe and on an error', async () => {
    const probe = await fetch(`${app.baseUrl}/livez`, { headers: { origin: OPS } });
    expect(probe.headers.get('access-control-allow-origin')).toBe(OPS);
    expect(probe.headers.get('access-control-allow-credentials')).toBe('true');
    expect(probe.headers.get('access-control-expose-headers')).toBe('X-Request-Id, ETag');

    const refused = await fetch(`${app.baseUrl}/api/v1/orders`, { headers: { origin: VENDOR } });
    expect(refused.status).toBe(404);
    expect(refused.headers.get('access-control-allow-origin')).toBe(VENDOR);
  });

  // Break caught: the origin of any request echoed back, which is the reflection the policy forbids.
  it('names no origin for a request from one that is not configured, and varies on Origin', async () => {
    const response = await fetch(`${app.baseUrl}/livez`, {
      headers: { origin: 'https://evil.example' },
    });

    expect(response.status).toBe(200);
    for (const header of CORS_HEADERS) expect(response.headers.get(header)).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('adds no CORS header when the request carries no Origin', async () => {
    const response = await fetch(`${app.baseUrl}/livez`);

    for (const header of CORS_HEADERS) expect(response.headers.get(header)).toBeNull();
  });

  // Break caught: a wildcard in any answer, which a credentialed request must never receive.
  it('never sends a wildcard origin', async () => {
    for (const origin of [OPS, VENDOR, 'https://evil.example', 'null', '*']) {
      const response = await fetch(`${app.baseUrl}/livez`, { headers: { origin } });
      expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
    }
  });
});

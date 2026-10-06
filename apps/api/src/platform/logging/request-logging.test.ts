import { afterEach, describe, expect, it } from 'vitest';

import { FixtureModule } from '../../test-support/fixtures.js';
import { appWith, startTestApp, type TestApp } from '../../test-support/test-app.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let running: TestApp | undefined;

async function start(): Promise<TestApp> {
  running = await startTestApp({ rootModule: appWith(FixtureModule) });
  return running;
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe('request ids', () => {
  // Break caught: no correlation id on the response, or none in the log line support will search.
  it('returns an id in X-Request-Id and logs one completion line carrying it', async () => {
    const { baseUrl, logs } = await start();
    const response = await fetch(`${baseUrl}/no-such-route`);
    await response.text();

    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID);
    const completed = logs.records().filter((record) => record.msg === 'request completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      request_id: requestId,
      method: 'GET',
      status: 404,
      route: null,
    });
    expect(typeof completed[0]?.duration_ms).toBe('number');
  });

  // Break caught: trusting a caller-chosen id, which lets a client forge correlation and inject log text.
  it('ignores an id supplied by the client', async () => {
    const { baseUrl, logs } = await start();
    const response = await fetch(`${baseUrl}/no-such-route`, {
      headers: { 'X-Request-Id': 'client-chosen-id' },
    });
    await response.text();

    expect(response.headers.get('x-request-id')).toMatch(UUID);
    expect(logs.text()).not.toContain('client-chosen-id');
  });

  // Break caught: an id lost across an await, or one request's id appearing on another's log lines.
  it('keeps each request id attached to its own log lines under concurrency', async () => {
    const { baseUrl, logs } = await start();
    const [slow, fast] = await Promise.all([
      fetch(`${baseUrl}/api/v1/fixture/slow/slow?ms=150`),
      fetch(`${baseUrl}/api/v1/fixture/slow/fast?ms=10`),
    ]);
    await Promise.all([slow.text(), fast.text()]);

    const byLabel = new Map(
      logs
        .records()
        .filter((record) => record.msg === 'fixture handler finished')
        .map((record) => [record.label, record.request_id]),
    );
    expect(byLabel.get('slow')).toBe(slow.headers.get('x-request-id'));
    expect(byLabel.get('fast')).toBe(fast.headers.get('x-request-id'));
    expect(byLabel.get('slow')).not.toBe(byLabel.get('fast'));
  });
});

describe('what a request log may contain', () => {
  // Break caught: logging the URL, headers or body (the usual default of request-logging libraries).
  it('never writes the query string, headers, cookies or body', async () => {
    const { baseUrl, logs } = await start();
    await (
      await fetch(`${baseUrl}/no-such-route?token=QUERY-SECRET&recovery=RECOVERY-SECRET`, {
        headers: {
          Authorization: 'Bearer HEADER-SECRET',
          Cookie: 'melarc_session=COOKIE-SECRET',
          'X-CSRF-Token': 'CSRF-SECRET',
        },
      })
    ).text();
    await (
      await fetch(`${baseUrl}/no-such-route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'BODY-SECRET', pin: '4321' }),
      })
    ).text();

    // The search below is only meaningful if the requests were in fact logged.
    expect(logs.records().filter((record) => record.msg === 'request completed')).toHaveLength(2);

    const everything = logs.text();
    for (const secret of [
      'QUERY-SECRET',
      'RECOVERY-SECRET',
      'HEADER-SECRET',
      'COOKIE-SECRET',
      'CSRF-SECRET',
      'BODY-SECRET',
      '4321',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  // Break caught: identifiers or tokens carried in path parameters ending up in the log.
  it('logs the route template, not the concrete path', async () => {
    const { baseUrl, logs } = await start();
    await (await fetch(`${baseUrl}/api/v1/fixture/orders/ORDER-SECRET-123`)).text();

    const completed = logs.records().find((record) => record.msg === 'request completed');
    expect(completed?.route).toBe('/api/v1/fixture/orders/:id');
    expect(logs.text()).not.toContain('ORDER-SECRET-123');
  });
});

describe('response headers the platform controls', () => {
  // Break caught: Express adding a body-hash ETag to every response. The contract uses ETag only as an
  // explicit record version (`If-Match`), says lists "carry no ETag", and a generic one would also turn
  // `If-None-Match` into automatic 304s.
  it('does not add an automatic ETag', async () => {
    const { baseUrl } = await start();
    for (const path of ['/livez', '/no-such-route']) {
      const response = await fetch(`${baseUrl}${path}`);
      await response.text();
      expect(response.headers.has('etag')).toBe(false);
    }
  });

  // Break caught: the framework announcing itself on every response.
  it('does not send X-Powered-By', async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/no-such-route`);
    await response.text();
    expect(response.headers.has('x-powered-by')).toBe(false);
  });
});

import type { Server } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { FixtureModule } from '../../../test-support/fixtures.js';
import { chunk, head, RawClient } from '../../../test-support/raw-http.js';
import {
  appWith,
  startTestApp,
  TEST_CONFIG,
  type TestApp,
} from '../../../test-support/test-app.js';
import type { AppConfig, HttpConfig } from '../../config/load-config.js';

/**
 * The transport limits over real HTTP (S0.20). Every refusal here is made by a running server on a real socket: the limits are
 * about how bytes arrive, which an injected controller test cannot show. The deadlines are a few hundred milliseconds, so the
 * tests are quick; the figures are the test's, not the deployment's.
 */
const LIMIT = 1_024;
const SMALL_HTTP: Partial<HttpConfig> = {
  bodyLimitBytes: LIMIT,
  headerTimeoutMs: 400,
  bodyTimeoutMs: 400,
  admissionTimeoutMs: 300,
  admissionConcurrency: 2,
};

function configured(http: Partial<HttpConfig> = {}): AppConfig {
  return { ...TEST_CONFIG, http: Object.freeze({ ...TEST_CONFIG.http, ...SMALL_HTTP, ...http }) };
}

let running: TestApp | undefined;
const clients: RawClient[] = [];

async function start(http: Partial<HttpConfig> = {}): Promise<TestApp> {
  running = await startTestApp({ config: configured(http), rootModule: appWith(FixtureModule) });
  return running;
}

async function raw(app: TestApp): Promise<RawClient> {
  const client = await RawClient.connect(app.baseUrl);
  clients.push(client);
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  await running?.stop();
  running = undefined;
});

const handlerRan = (app: TestApp): boolean =>
  app.logs.records().some((record) => record.msg === 'fixture handler finished');

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A JSON object of exactly `bytes` bytes. */
function jsonOf(bytes: number): string {
  const fill = bytes - '{"a":""}'.length;
  return `{"a":"${'x'.repeat(fill)}"}`;
}

const JSON_POST = (path: string, extra: Readonly<Record<string, string>> = {}) =>
  head(`POST ${path} HTTP/1.1`, {
    Host: 'melarc.test',
    'Content-Type': 'application/json',
    ...extra,
  });

describe('the size of a body', () => {
  // Break caught: a limit that is a constant of the body parser and not the setting, or one that is read after the body is.
  it('refuses a body whose declared length is over the limit at once, without reading any of it', async () => {
    const app = await start();
    const client = await raw(app);

    await client.write(
      JSON_POST('/api/v1/fixture/body/size', { 'Content-Length': String(LIMIT + 1) }),
    );
    const response = await client.read(1_500);

    expect(response.status).toBe(413);
    // The client never sent a byte of the body, and was answered anyway: the server did not wait for it.
    expect(response.json).toEqual({
      message: 'Payload Too Large',
      request_id: response.headers['x-request-id'],
    });
    // The refusal is about what the request says, not how it arrives: the connection is not cut under a client that may be writing.
    expect(response.headers.connection).not.toBe('close');
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: an off-by-one at the limit in either direction.
  it('accepts a body of exactly the limit and refuses one byte more', async () => {
    const app = await start();

    const exact = await fetch(`${app.baseUrl}/api/v1/fixture/body/size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonOf(LIMIT),
    });
    const over = await fetch(`${app.baseUrl}/api/v1/fixture/body/size`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: jsonOf(LIMIT + 1),
    });

    expect(exact.status).toBe(201);
    expect(over.status).toBe(413);
  });

  // Break caught: the limit counting the declared length and not the bytes received, so a chunked request (which declares none)
  // is never limited; or counting them only once the whole body has arrived, which buffers an attacker's body in full.
  it('refuses a chunked body as soon as it crosses the limit, while the client is still sending', async () => {
    const app = await start();
    const client = await raw(app);
    await client.write(JSON_POST('/api/v1/fixture/body/size', { 'Transfer-Encoding': 'chunked' }));

    let sent = 0;
    const piece = chunk('x'.repeat(256));
    while (sent < 400 && !client.received().includes('413')) {
      await client.write(piece);
      sent += 1;
      await sleep(2);
    }
    const response = await client.read(1_500);

    expect(response.status).toBe(413);
    expect(response.json).toEqual({
      message: 'Payload Too Large',
      request_id: response.headers['x-request-id'],
    });
    // 256 bytes a piece and a limit of 1024: answered within a few pieces of crossing it, not after the 400 the loop could send.
    expect(sent).toBeLessThan(40);
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: the limit applying to a chunked body that is smaller than it.
  it('accepts a chunked body inside the limit', async () => {
    const app = await start();
    const client = await raw(app);
    const body = '{"a":1}';

    await client.write(JSON_POST('/api/v1/fixture/body/size', { 'Transfer-Encoding': 'chunked' }));
    await client.write(Buffer.concat([chunk(body), Buffer.from('0\r\n\r\n')]));
    const response = await client.read(1_500);

    expect(response.status).toBe(201);
    expect(response.json).toEqual({ label: 'size', received: { a: 1 } });
  });
});

describe('the encoding and the media type of a body', () => {
  // Break caught: a compressed body being inflated and handed to a handler (the parser inflates by default), which makes the
  // size limit a limit on the compressed size and opens the application to a decompression bomb.
  it.each([
    'gzip',
    'GZIP',
    'br',
    'deflate',
    'compress',
    'zstd',
    'x-gzip',
    'identity, gzip',
    'gzip, identity',
  ])('refuses a body with Content-Encoding %s with 415 before reading it', async (encoding) => {
    const app = await start();
    const client = await raw(app);

    // The head promises a body and none is sent: the answer comes from the head alone.
    await client.write(
      JSON_POST('/api/v1/fixture/body/encoded', {
        'Content-Length': '40',
        'Content-Encoding': encoding,
      }),
    );
    const response = await client.read(1_500);

    expect(response.status).toBe(415);
    expect(response.json).toEqual({
      message: 'Unsupported Media Type',
      request_id: response.headers['x-request-id'],
    });
    expect(handlerRan(app)).toBe(false);
  });

  it('accepts a body that says it is not encoded', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/body/encoded`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' },
      body: '{"a":1}',
    });

    expect(response.status).toBe(201);
  });

  // Break caught: a body of another type being passed on as no body, which a handler that needs one then reads as an empty request.
  // The contract takes JSON only, and a cross-site form can send these types without a preflight.
  it.each([
    ['plain text', 'text/plain'],
    ['a form', 'application/x-www-form-urlencoded'],
    ['a multipart form', 'multipart/form-data; boundary=x'],
    ['XML', 'application/xml'],
    ['a type that only ends like JSON', 'text/json'],
    ['a type that only starts like JSON', 'application/jsonp'],
  ])('refuses a body sent as %s with 415', async (_label, type) => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/body/media`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: 'a=1',
    });

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      message: 'Unsupported Media Type',
      request_id: response.headers.get('x-request-id'),
    });
    expect(handlerRan(app)).toBe(false);
  });

  it('refuses a body that names no type', async () => {
    const app = await start();
    const client = await raw(app);

    await client.write(
      head('POST /api/v1/fixture/body/media HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Length': '7',
      }) + '{"a":1}',
    );

    expect((await client.read(1_500)).status).toBe(415);
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: the media-type rule refusing a request that has no body, such as a bodiless POST that still names a type.
  it.each([
    ['a form type', 'application/x-www-form-urlencoded'],
    ['no type at all', undefined],
    ['JSON', 'application/json'],
  ])('does not refuse a request with no body for its type (%s)', async (_label, type) => {
    const app = await start();
    const client = await raw(app);

    await client.write(
      head('POST /api/v1/fixture/body/empty HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Length': '0',
        ...(type === undefined ? {} : { 'Content-Type': type }),
      }),
    );
    const response = await client.read(1_500);

    expect(response.status).toBe(201);
    expect(handlerRan(app)).toBe(true);
  });

  // Break caught: the UTF-8 rule of the earlier task (S0.19 era) lost in the move.
  it('still refuses JSON that names another charset, with 415', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/body/charset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-16le' },
      body: '{"a":1}',
    });

    expect(response.status).toBe(415);
    expect(handlerRan(app)).toBe(false);
  });
});

describe('a body that cannot be parsed', () => {
  // Break caught: the early reply. A small, bounded syntax error used to be answered 400 by the parser before any step of
  // the refusal order ran, so a caller who may not use the operation learned that its schema had been looked at.
  it('is carried to the validation stage: a guard that refuses answers first, whatever the body', async () => {
    const app = await start();

    const broken = await fetch(`${app.baseUrl}/api/v1/fixture/guarded`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password": "BODY-SECRET", "broken": ',
    });
    const fine = await fetch(`${app.baseUrl}/api/v1/fixture/guarded`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"fine":true}',
    });

    expect(broken.status).toBe(401);
    expect(fine.status).toBe(401);
    // The same answer for both: the guard did not look at the body, so it said nothing about it.
    const withoutId = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });
    expect(withoutId((await broken.json()) as Record<string, unknown>)).toEqual(
      withoutId((await fine.json()) as Record<string, unknown>),
    );
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: a malformed body reaching a handler as an empty one.
  it('is VALIDATION_FAILED, 400, once the guards have let the request through, and the handler is not reached', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/body/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"password": "BODY-SECRET", "broken": ',
    });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'The request is not valid',
      request_id: response.headers.get('x-request-id'),
    });
    expect(text).not.toContain('BODY-SECRET');
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: the marker turning a missing route into a validation answer.
  it('does not turn an unknown route into a validation failure', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/no-such-thing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken": ',
    });

    expect(response.status).toBe(404);
  });

  // Break caught: a body that is too large being treated as a parse failure and carried on.
  it('is not carried on when it is also too large', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/body/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: `{"a":"${'x'.repeat(LIMIT * 2)}`,
    });

    expect(response.status).toBe(413);
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: a parse failure leaking into the next request on the same connection.
  it('does not mark the next request of the same connection', async () => {
    const app = await start();
    const client = await raw(app);
    const bad = '{"broken": ';
    const good = '{"a":1}';

    await client.write(
      JSON_POST('/api/v1/fixture/body/json', { 'Content-Length': String(bad.length) }) + bad,
    );
    expect((await client.read(1_500)).status).toBe(400);

    const second = await fetch(`${app.baseUrl}/api/v1/fixture/body/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: good,
    });
    expect(second.status).toBe(201);
  });
});

describe('the receipt deadlines', () => {
  // Break caught: no deadline on the head, so a client that sends one byte a minute holds a connection for ever.
  it('closes a connection whose head is not complete within the header deadline', async () => {
    const app = await start({ headerTimeoutMs: 400 });
    const client = await raw(app);
    const started = Date.now();

    await client.write(
      head(
        'POST /api/v1/fixture/body/slowhead HTTP/1.1',
        { Host: 'melarc.test', 'Content-Type': 'application/json' },
        { open: true },
      ),
    );
    const closed = await client.until(() => client.closed, 4_000);
    const elapsed = Date.now() - started;

    expect(closed).toBe(true);
    // It waited for the deadline (it was not refused for something else) and did not wait much longer than it.
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_500);
    const text = client.received();
    if (text !== '') expect(text.startsWith('HTTP/1.1 408')).toBe(true);
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: no deadline on the body, so a client that sends the head and then trickles holds a connection for ever.
  it('answers 408 and closes when the body does not arrive within the body deadline', async () => {
    const app = await start({ bodyTimeoutMs: 400 });
    const client = await raw(app);
    const started = Date.now();

    await client.write(
      JSON_POST('/api/v1/fixture/body/slowbody', { 'Content-Length': '50' }) + '{"a":',
    );
    const response = await client.read(3_000);
    const elapsed = Date.now() - started;

    expect(response.status).toBe(408);
    expect(response.json).toEqual({
      message: 'Request Timeout',
      request_id: response.headers['x-request-id'],
    });
    expect(response.headers.connection).toBe('close');
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(elapsed).toBeLessThan(2_000);
    expect(handlerRan(app)).toBe(false);
  });

  // Break caught: the body deadline measured from the connection, or never cleared: a request that arrived in time must not be
  // killed by the deadline of its own body once it has been answered, and a connection kept alive must not be cut by it.
  it('clears the deadline when the body has arrived, so a kept-alive connection outlives it', async () => {
    const app = await start({ bodyTimeoutMs: 400 });
    const client = await raw(app);
    const body = '{"a":1}';

    await client.write(
      JSON_POST('/api/v1/fixture/body/prompt', { 'Content-Length': String(body.length) }) + body,
    );
    expect((await client.read(1_500)).status).toBe(201);
    await sleep(900);

    expect(client.closed).toBe(false);
  });

  it('does not start the body deadline for a request that has no body', async () => {
    const app = await start({ bodyTimeoutMs: 300 });
    const client = await raw(app);

    await client.write(head('GET /api/v1/fixture/orders/1 HTTP/1.1', { Host: 'melarc.test' }));
    expect((await client.read(1_500)).status).toBe(200);
    await sleep(700);

    expect(client.closed).toBe(false);
  });

  // Break caught: the settings applied to the framework's own timers by name only. The deadlines are the setting and the
  // server must hold them; the check interval is what makes Node enforce them promptly instead of up to thirty seconds late.
  it('applies the deadlines to the server, and checks them often enough to mean them', async () => {
    const app = await start({ headerTimeoutMs: 1_000, bodyTimeoutMs: 2_000 });
    const server = app.app.getHttpServer() as Server & { connectionsCheckingInterval: number };

    expect(server.headersTimeout).toBe(1_000);
    expect(server.requestTimeout).toBe(3_000);
    expect(server.connectionsCheckingInterval).toBeLessThanOrEqual(1_000);
    expect(server.connectionsCheckingInterval).toBeGreaterThanOrEqual(100);
  });
});

describe('admission concurrency', () => {
  const slow = (app: TestApp, label: string, ms: number): Promise<Response> =>
    fetch(`${app.baseUrl}/api/v1/fixture/slow/${label}?ms=${String(ms)}`);

  // Break caught: no limit on the requests worked on at once, or a limit that refuses where it should queue.
  it('queues a request for a free slot and serves it when one comes free', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 2_000 });

    const first = slow(app, 'first', 400);
    await sleep(60);
    const started = Date.now();
    const second = await slow(app, 'second', 0);

    expect(second.status).toBe(200);
    // It could not start before the first had finished, and it was not refused for waiting.
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    expect((await first).status).toBe(200);
  });

  // Break caught: a queue with no deadline, which is a connection held open for whoever holds the slot.
  it('refuses a request whose wait for a slot reached the admission deadline, with 503 and no code', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 150 });

    const running = slow(app, 'holder', 900);
    await sleep(50);
    const started = Date.now();
    const waiting = await slow(app, 'waiter', 0);

    expect(waiting.status).toBe(503);
    expect(await waiting.json()).toEqual({
      message: 'Service unavailable',
      request_id: waiting.headers.get('x-request-id'),
    });
    expect(waiting.headers.has('retry-after')).toBe(false);
    expect(Date.now() - started).toBeLessThan(800);
    expect((await running).status).toBe(200);
  });

  // Break caught: a line without a bound.
  it('refuses at once when the line is full: no more may wait than may be admitted', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 5_000 });

    const holder = slow(app, 'holder', 700);
    await sleep(50);
    const queued = slow(app, 'queued', 0);
    await sleep(50);
    const started = Date.now();
    const refused = await slow(app, 'refused', 0);

    expect(refused.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(400);
    expect((await holder).status).toBe(200);
    expect((await queued).status).toBe(200);
  });

  // Break caught: the probes queued behind the traffic they report on, so a saturated instance looks dead and is killed.
  it('never holds back the probes, whatever the gate is doing', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 5_000 });

    const holder = slow(app, 'holder', 700);
    await sleep(50);
    const queued = slow(app, 'queued', 0);
    await sleep(50);
    const started = Date.now();
    const live = await fetch(`${app.baseUrl}/livez`);
    const ready = await fetch(`${app.baseUrl}/readyz`);

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(400);
    await holder;
    await queued;
  });

  // Break caught: a path that merely looks like a probe skipping the gate.
  it('does not let a path that only resembles a probe skip the gate', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 100 });

    const holder = slow(app, 'holder', 600);
    await sleep(50);
    const lookalikes = await Promise.all(
      ['/livez/', '/LIVEZ', '/readyz/x', '/api/v1/livez'].map((path) =>
        fetch(`${app.baseUrl}${path}`),
      ),
    );

    for (const response of lookalikes) expect(response.status).toBe(503);
    await holder;
  });

  // Break caught: a slot that stays taken after the response, which shrinks the gate until it admits nothing.
  it('gives the slot back when the response has been sent, request after request', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 200 });

    for (let index = 0; index < 8; index += 1) {
      expect((await slow(app, `again-${String(index)}`, 0)).status).toBe(200);
    }
  });

  // Break caught: a slot kept by a client that has gone away while its request was running.
  it('gives the slot back when the client goes away while its request is still running', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 100 });
    const controller = new AbortController();

    const gone = fetch(`${app.baseUrl}/api/v1/fixture/slow/gone?ms=1500`, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await sleep(80);
    controller.abort();
    await gone;
    await sleep(100);
    const started = Date.now();
    const next = await slow(app, 'next', 0);

    expect(next.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(600);
  });

  // Break caught: a request that left the line while it waited still being served when a slot came free.
  it('drops a waiting request whose client has gone away', async () => {
    const app = await start({ admissionConcurrency: 1, admissionTimeoutMs: 5_000 });
    const controller = new AbortController();

    const holder = slow(app, 'holder', 400);
    await sleep(50);
    const gone = fetch(`${app.baseUrl}/api/v1/fixture/slow/gone?ms=0`, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await sleep(50);
    controller.abort();
    await gone;
    await holder;
    await sleep(100);

    // The abandoned request never ran: the handler logs when it finishes, and only the holder's own line may be there.
    const finished = app.logs
      .records()
      .filter((record) => record.msg === 'fixture handler finished')
      .map((record) => record.label);
    expect(finished).toEqual(['holder']);
  });
});

describe('the failures of the platform’s own resources, over real HTTP', () => {
  // Break caught: a typed failure reaching the client as the framework's own 500, or carrying text from the failure.
  it.each(['budget', 'deadline', 'saturated', 'acquire', 'closed', 'wrapped'])(
    'answers 503 with fixed text for the failure %s, and copies nothing of it',
    async (kind) => {
      const app = await start();

      const response = await fetch(`${app.baseUrl}/api/v1/fixture/fail/${kind}`);
      const text = await response.text();

      expect(response.status).toBe(503);
      expect(JSON.parse(text)).toEqual({
        message: 'Service unavailable',
        request_id: response.headers.get('x-request-id'),
      });
      expect(response.headers.has('retry-after')).toBe(false);
      expect(text).not.toContain('hunter2');
    },
  );

  // Break caught: a commit that may have happened answered as an outage, which invites a retry that repeats the work.
  it('answers a commit that may have happened with a 500 of its own and no retry hint', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/fail/unknown`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      message: 'The outcome of the request could not be confirmed',
      request_id: response.headers.get('x-request-id'),
    });
    expect(response.headers.has('retry-after')).toBe(false);
    expect(text).not.toContain('hunter2');
    const logged = app.logs
      .records()
      .find((record) => record.msg === 'request failed: the outcome of its commit is unknown');
    expect(logged?.reason).toBe('connection-lost');
    expect(app.logs.text()).not.toContain('hunter2');
  });

  it('answers a definite rollback as any unexpected failure', async () => {
    const app = await start();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/fail/rolled-back`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: 'Internal server error',
      request_id: response.headers.get('x-request-id'),
    });
  });
});

describe('the address of the caller', () => {
  const whoami = async (app: TestApp, forwarded: Record<string, string>) =>
    (await (
      await fetch(`${app.baseUrl}/api/v1/fixture/whoami`, { headers: forwarded })
    ).json()) as {
      ip: string;
      protocol: string;
    };

  // Break caught: a forwarded header believed from anyone, which lets any caller choose the address a limiter would count.
  it('believes no forwarded header when no proxy is trusted', async () => {
    const app = await start({ trustProxy: [] });

    const seen = await whoami(app, {
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Proto': 'https',
    });

    expect(seen.ip).toMatch(/127\.0\.0\.1$/);
    expect(seen.protocol).toBe('http');
  });

  // Break caught: the setting validated and never applied.
  it('believes the forwarded address of a hop it was told to trust, and only that hop', async () => {
    const trusted = await start({ trustProxy: ['127.0.0.1'] });
    const believed = await whoami(trusted, {
      'X-Forwarded-For': '203.0.113.9',
      'X-Forwarded-Proto': 'https',
    });
    await trusted.stop();
    running = undefined;

    const other = await start({ trustProxy: ['192.0.2.1'] });
    const ignored = await whoami(other, { 'X-Forwarded-For': '203.0.113.9' });

    expect(believed.ip).toBe('203.0.113.9');
    expect(believed.protocol).toBe('https');
    expect(ignored.ip).toMatch(/127\.0\.0\.1$/);
  });
});

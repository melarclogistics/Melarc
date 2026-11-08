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
 * What the audit of 11 October 2026 found at the edges of transport admission (F05), over real sockets:
 *
 * - a probe is exempt from the admission gate and the request budget as a probe: a `GET` or `HEAD` of its exact path with no body.
 *   A `POST` of the path, or a request that carries a body, is any other request;
 * - a request that says `Expect: 100-continue` is invited to send its body only after its head has been judged and a slot is held,
 *   never before (Node, left alone, sends `100 Continue` the moment the head arrives);
 * - a refusal that leaves the connection open reads off what the client is still sending within a bound of bytes, of time and of
 *   connections draining at once, and closes the connection beyond it (or at once when too many are draining).
 */
const LIMIT = 1_024;
const SMALL_HTTP: Partial<HttpConfig> = {
  bodyLimitBytes: LIMIT,
  headerTimeoutMs: 600,
  bodyTimeoutMs: 600,
  admissionTimeoutMs: 2_000,
  admissionConcurrency: 1,
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const slow = (app: TestApp, label: string, ms: number): Promise<Response> =>
  fetch(`${app.baseUrl}/api/v1/fixture/slow/${label}?ms=${String(ms)}`);

/** Fills the one slot of the gate and the one place in its line, so that anything else that needs a slot is refused at once. */
async function saturate(app: TestApp): Promise<() => Promise<void>> {
  const holder = slow(app, 'holder', 900);
  await sleep(60);
  const queued = slow(app, 'queued', 0);
  await sleep(60);
  return async () => {
    await holder;
    await queued;
  };
}

describe('a probe is exempt as a probe and as nothing else', () => {
  // Break caught: the exemption read from the path alone, so that any method, with or without a body, to /livez or /readyz skips the
  // gate and the request budget while its body is still received and parsed.
  it('serves a GET and a HEAD of a probe with no body while the gate is full', async () => {
    const app = await start();
    const drain = await saturate(app);

    const live = await fetch(`${app.baseUrl}/livez`);
    const ready = await fetch(`${app.baseUrl}/readyz`, { method: 'HEAD' });

    expect(live.status).toBe(200);
    expect(ready.status).toBe(200);
    await drain();
  });

  it.each([
    ['a POST with a body', 'POST', JSON.stringify({ a: 1 })],
    ['a PUT with a body', 'PUT', JSON.stringify({ a: 1 })],
    ['a POST with no body', 'POST', undefined],
    ['a DELETE', 'DELETE', undefined],
  ])('does not exempt %s to a probe path from the gate', async (_label, method, body) => {
    const app = await start();
    const drain = await saturate(app);

    const response = await fetch(`${app.baseUrl}/livez`, {
      method,
      ...(body === undefined ? {} : { body, headers: { 'Content-Type': 'application/json' } }),
    });

    expect(response.status).toBe(503);
    await drain();
  });

  // Break caught: a probe request that carries a body taken for a bare probe. `fetch` will not send a body on a GET, so the bytes are
  // written to a socket.
  it('does not exempt a GET of a probe that declares a body', async () => {
    const app = await start();
    const drain = await saturate(app);
    const client = await raw(app);

    await client.write(
      head('GET /livez HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Type': 'application/json',
        'Content-Length': '2',
      }) + '{}',
    );
    const response = await client.read(1_500);

    expect(response.status).toBe(503);
    await drain();
  });

  // Break caught: a probe that carries a chunked body, which declares no length, taken for a probe that carries none.
  it('does not exempt a probe request whose body is chunked', async () => {
    const app = await start();
    const drain = await saturate(app);
    const client = await raw(app);

    await client.write(
      head('GET /livez HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      }),
    );
    await client.write(chunk('{}'));
    await client.write('0\r\n\r\n');
    const response = await client.read(1_500);

    expect(response.status).toBe(503);
    await drain();
  });
});

describe('a request that says Expect: 100-continue (Node would invite its body at once)', () => {
  const expecting = (path: string, extra: Readonly<Record<string, string>>) =>
    head(`POST ${path} HTTP/1.1`, {
      Host: 'melarc.test',
      Expect: '100-continue',
      ...extra,
    });

  // Break caught: the invitation sent before the head was judged, so that a client with a body the API will not take is told to send it.
  it.each([
    [
      'declares more than the limit',
      { 'Content-Type': 'application/json', 'Content-Length': String(LIMIT + 1) },
      413,
    ],
    ['is not JSON', { 'Content-Type': 'text/plain', 'Content-Length': '10' }, 415],
    [
      'is encoded',
      { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '10' },
      415,
    ],
  ])('is refused, and never invited, when its body %s', async (_label, headers, status) => {
    const app = await start({ admissionConcurrency: 2 });
    const client = await raw(app);

    await client.write(expecting('/api/v1/fixture/body/expect', headers));
    const response = await client.read(1_500);

    expect(response.status).toBe(status);
    expect(client.received()).not.toContain('100 Continue');
  });

  it('is invited, and answered, when its head is acceptable and a slot is free', async () => {
    const app = await start({ admissionConcurrency: 2 });
    const client = await raw(app);
    const body = '{"a":"b"}';

    await client.write(
      expecting('/api/v1/fixture/body/expect', {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      }),
    );
    const invited = await client.until(() => client.received().includes('100 Continue'), 1_500);
    await client.write(body);
    const answered = await client.until(() => client.received().includes('HTTP/1.1 201'), 1_500);

    expect(invited).toBe(true);
    expect(answered).toBe(true);
    expect(client.received()).toContain('"received":{"a":"b"}');
  });

  // Break caught: the invitation sent while the request waits for a slot, so that a body is uploaded to a request that may yet be
  // refused for want of room.
  it('is not invited while it waits for a slot, and is invited when it has one', async () => {
    const app = await start();
    const holder = slow(app, 'holder', 700);
    await sleep(60);
    const client = await raw(app);
    const body = '{"a":"b"}';

    await client.write(
      expecting('/api/v1/fixture/body/expect', {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      }),
    );
    await sleep(250);
    const earlyInvitation = client.received().includes('100 Continue');
    const invited = await client.until(() => client.received().includes('100 Continue'), 1_500);
    await client.write(body);
    await holder;

    expect(earlyInvitation).toBe(false);
    expect(invited).toBe(true);
  });

  it('is refused for want of room without ever being invited', async () => {
    const app = await start();
    const drain = await saturate(app);
    const client = await raw(app);

    await client.write(
      expecting('/api/v1/fixture/body/expect', {
        'Content-Type': 'application/json',
        'Content-Length': '9',
      }),
    );
    const response = await client.read(1_500);

    expect(response.status).toBe(503);
    expect(client.received()).not.toContain('100 Continue');
    await drain();
  });
});

describe('a refusal that leaves the connection open reads off the rest within bounds', () => {
  /** A refused request: not JSON, with a body far larger than the limit, promised in full. */
  const refusedHead = head('POST /api/v1/fixture/body/refused HTTP/1.1', {
    Host: 'melarc.test',
    'Content-Type': 'text/plain',
    'Content-Length': '100000',
  });

  // Break caught: a body read off for as long as the client cares to send it, up to the request deadline, by as many connections as
  // there are clients: the refusal is cheap, the drain is not.
  it('closes the connection once more than the allowance has been read off after the refusal, and the refusal was delivered', async () => {
    const app = await start({
      admissionConcurrency: 2,
      bodyTimeoutMs: 5_000,
      headerTimeoutMs: 5_000,
    });
    const client = await raw(app);

    await client.write(refusedHead);
    let sent = 0;
    while (!client.closed && sent < 400) {
      await client.write(Buffer.alloc(512, 0x78));
      sent += 1;
      await sleep(2);
    }

    expect(client.received()).toContain('HTTP/1.1 415');
    expect(client.closed).toBe(true);
    // 512 bytes a write and sixteen times a limit of 1024 to read off: cut within a few writes of 32, not after the 400 the loop could send.
    expect(sent).toBeGreaterThan(30);
    expect(sent).toBeLessThan(80);
  });

  // Break caught: a drain with no clock, so that a client that sends a byte now and then holds the connection until the request deadline.
  it('closes the connection when the time allowed for reading it off has passed', async () => {
    const app = await start({
      admissionConcurrency: 2,
      bodyTimeoutMs: 400,
      headerTimeoutMs: 5_000,
    });
    const client = await raw(app);
    const started = Date.now();

    await client.write(refusedHead);
    while (!client.closed && Date.now() - started < 3_000) {
      await client.write('x');
      await sleep(50);
    }

    expect(client.received()).toContain('HTTP/1.1 415');
    expect(client.closed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  // Break caught: the connection cut under a client whose refused body was small enough to read off, which would turn a polite
  // refusal into a reset for every client that sends its body before it reads the answer.
  it('keeps the connection when the body that remains is read off within the bounds, and serves the next request on it', async () => {
    const app = await start({ admissionConcurrency: 2 });
    const client = await raw(app);
    const small = 'y'.repeat(300);

    await client.write(
      head('POST /api/v1/fixture/body/refused HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Type': 'text/plain',
        'Content-Length': String(small.length),
      }),
    );
    await sleep(30);
    await client.write(small);
    await sleep(80);
    await client.write(
      head('GET /api/v1/fixture/slow/next?ms=0 HTTP/1.1', { Host: 'melarc.test' }),
    );
    const answered = await client.until(() => client.received().includes('HTTP/1.1 200'), 1_500);

    expect(client.received()).toContain('HTTP/1.1 415');
    expect(answered).toBe(true);
    expect(client.closed).toBe(false);
  });

  // Break caught: no bound on how many connections are being read off at once, so that connections that each cost nothing to
  // refuse together hold as many sockets as an attacker can open. Beyond the bound the refusal says Connection: close.
  it('closes at once the connections it has no room to read off, as many as may be draining at a time', async () => {
    const app = await start({
      admissionConcurrency: 2,
      bodyTimeoutMs: 5_000,
      headerTimeoutMs: 5_000,
    });
    const first = await raw(app);
    const second = await raw(app);
    const third = await raw(app);

    await first.write(refusedHead);
    await second.write(refusedHead);
    await first.until(() => first.received().includes('HTTP/1.1 415'), 1_500);
    await second.until(() => second.received().includes('HTTP/1.1 415'), 1_500);
    await third.write(refusedHead);
    const refused = await third.read(1_500);

    expect(refused.status).toBe(415);
    expect(refused.headers.connection).toBe('close');
    expect(first.closed).toBe(false);
    expect(second.closed).toBe(false);

    // A place comes free when one of them is over, and the next refusal is read off again.
    first.destroy();
    await sleep(100);
    const fourth = await raw(app);
    await fourth.write(refusedHead);
    const again = await fourth.read(1_500);
    expect(again.status).toBe(415);
    expect(again.headers.connection).not.toBe('close');
  });
});

import { connect } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { Secret } from '../config/secret.js';
import { startMetricsListener, type MetricsListener } from './metrics-listener.js';

const SECRET = 'q8Nf3vT1xL0pZr7Yk2Hw5sJd9Gc4Ue6Bm1Aa0Qo8Ii';
const quiet = { info: () => undefined, warn: () => undefined };

let listener: MetricsListener | undefined;
afterEach(async () => {
  await listener?.close();
  listener = undefined;
});

async function start(options: { secret?: string; read?: () => Promise<string> } = {}) {
  listener = await startMetricsListener({
    host: '127.0.0.1',
    port: 0,
    ...(options.secret === undefined ? {} : { secret: new Secret(options.secret) }),
    read: options.read ?? (() => Promise.resolve('up 1\n')),
    logger: quiet,
  });
  return `http://127.0.0.1:${String(listener.port)}`;
}

describe('the private metrics endpoint (S0.68)', () => {
  it('answers GET /metrics with the exposition, as Prometheus text that no one may cache', async () => {
    const base = await start();
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('up 1\n');
  });

  // Break caught: the endpoint answering anything but its one read, which would make it a second application.
  it('answers nothing else: another path is 404, another method 405', async () => {
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/auth/session`)).status).toBe(404);
    const posted = await fetch(`${base}/metrics`, { method: 'POST', body: 'x' });
    expect(posted.status).toBe(405);
    expect(posted.headers.get('allow')).toBe('GET');
  });

  // Break caught: a secret configured and not asked for, or one compared loosely (a prefix, another scheme, a missing header).
  it('with a secret, serves only a request that carries it as a bearer credential', async () => {
    let reads = 0;
    const base = await start({
      secret: SECRET,
      read: () => {
        reads += 1;
        return Promise.resolve('up 1\n');
      },
    });
    for (const authorization of [
      undefined,
      `Bearer ${SECRET.slice(0, -1)}`,
      `Basic ${SECRET}`,
      `Bearer ${SECRET}x`,
      SECRET,
    ]) {
      const response = await fetch(`${base}/metrics`, {
        headers: authorization === undefined ? {} : { authorization },
      });
      expect(response.status, authorization ?? '(none)').toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.text()).not.toContain('up');
    }
    expect(reads).toBe(0);
    const allowed = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(allowed.status).toBe(200);
    expect(reads).toBe(1);
  });

  it('answers 503 when the metrics cannot be read, with nothing of the failure', async () => {
    const base = await start({
      read: () => Promise.reject(new Error('connection to 10.0.0.5 refused')),
    });
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service Unavailable');
  });

  // Break caught: a 503 whose cause is nowhere, so that a database outage, a saturated pool and a mistyped gauge look alike to the operator.
  it('says why in its log, redacted, when the metrics cannot be read, and says nothing of it in the answer', async () => {
    const warnings: unknown[][] = [];
    listener = await startMetricsListener({
      host: '127.0.0.1',
      port: 0,
      read: () => Promise.reject(new Error('the database pool is saturated')),
      logger: { info: () => undefined, warn: (...parts: unknown[]) => void warnings.push(parts) },
    });

    const response = await fetch(`http://127.0.0.1:${String(listener.port)}/metrics`);

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Service Unavailable');
    expect(JSON.stringify(warnings)).toContain('the database pool is saturated');
  });

  it('stops listening when closed', async () => {
    const base = await start();
    await listener?.close();
    listener = undefined;
    await expect(fetch(`${base}/metrics`)).rejects.toThrow();
  });
});

/** A connection that sends what it is told to and then waits, and how long until the server ended it. */
function stalled(port: number, sent: string): { closed: Promise<number>; destroy: () => void } {
  const socket = connect(port, '127.0.0.1');
  const started = performance.now();
  socket.on('connect', () => {
    if (sent !== '') socket.write(sent);
  });
  // Reading is what lets a client see the server end the connection (an unread socket never reports the end).
  socket.resume();
  socket.on('error', () => undefined);
  const closed = new Promise<number>((resolve) => {
    socket.on('close', () => {
      resolve(performance.now() - started);
    });
  });
  return { closed, destroy: () => socket.destroy() };
}

describe('the bounds of the private metrics endpoint (S0.68)', () => {
  const DEADLINE_MS = 300;

  async function startBounded(
    maxConnections: number,
    read: () => Promise<string> = () => Promise.resolve('up 1\n'),
  ): Promise<number> {
    listener = await startMetricsListener({
      host: '127.0.0.1',
      port: 0,
      read,
      logger: quiet,
      limits: { requestTimeoutMs: DEADLINE_MS, maxConnections },
    });
    return listener.port;
  }

  // Break caught: a deadline Node does not enforce when it is told (it looks every thirty seconds unless the interval is set, measured on
  // Node 24.21.0), so that "a few seconds" is half a minute, and a connection that never says anything holds a slot for as long.
  it('ends a connection that sends nothing, and one that sends half a head, at its deadline', async () => {
    const port = await startBounded(8);
    const silent = stalled(port, '');
    const half = stalled(port, 'GET /metrics HTTP/1.1\r\nHost: x\r\n');

    const [silentAfter, halfAfter] = await Promise.all([silent.closed, half.closed]);

    expect(silentAfter).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(silentAfter).toBeLessThan(DEADLINE_MS + 3_000);
    expect(halfAfter).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(halfAfter).toBeLessThan(DEADLINE_MS + 3_000);
  });

  // Break caught: a request that declares a body and never sends it, held while the metrics are slow to read (the worker reads its queue):
  // the whole request is the deadline's, not the head alone, so that the connection does not wait for the reader of the metrics instead.
  it('ends a request that declared a body and never sent it, even while the metrics are slow to read', async () => {
    const port = await startBounded(8, () => new Promise<string>(() => undefined));
    const held = stalled(port, 'GET /metrics HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n');

    const endedAfter = await Promise.race([
      held.closed,
      new Promise<number>((resolve) =>
        setTimeout(() => {
          resolve(Number.POSITIVE_INFINITY);
        }, DEADLINE_MS + 3_000),
      ),
    ]);
    held.destroy();

    expect(endedAfter).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
    expect(endedAfter).toBeLessThan(DEADLINE_MS + 3_000);
  });

  // Break caught: a crowd of stalled connections holding every slot for ever, so that the scraper is refused and the backlog gauge never
  // reaches the alert that reads it.
  it('serves only a few connections at once, and answers again as soon as the stalled ones are ended', async () => {
    const port = await startBounded(2);
    const crowd = [stalled(port, ''), stalled(port, '')];
    await new Promise((resolve) => setTimeout(resolve, 100));

    await expect(fetch(`http://127.0.0.1:${String(port)}/metrics`)).rejects.toThrow();
    await Promise.all(crowd.map((connection) => connection.closed));

    const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('up 1\n');
  });

  // Break caught: a connection kept for a second request, which would let one client hold a slot with a keep-alive for ever.
  it('closes the connection with each answer', async () => {
    const port = await startBounded(8);
    const response = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(response.headers.get('connection')).toBe('close');
  });
});

import { createServer as createHttpServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';

import { createServer, type ViteDevServer } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Seen {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}

const APP_ROOT = resolve(import.meta.dirname, '..');

let upstream: Server | undefined;
let dev: ViteDevServer | undefined;
let seen: Seen[] = [];

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) =>
    probe.close(() => {
      done();
    }),
  );
  return port;
}

/** A real HTTP server standing in for the API, so the proxy is exercised for real. */
async function startUpstream(): Promise<string> {
  upstream = createHttpServer((request, response) => {
    seen.push({ method: request.method, url: request.url, headers: request.headers });
    response.statusCode = 404;
    response.setHeader('content-type', 'application/json');
    response.setHeader('set-cookie', 'melarc_session=opaque; Path=/; HttpOnly');
    response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'from upstream' }));
  });
  await new Promise<void>((done) => upstream?.listen(0, '127.0.0.1', done));
  const { port } = upstream.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

async function startDevServer(upstreamUrl: string): Promise<string> {
  process.env.OPS_API_PROXY_TARGET = upstreamUrl;
  const port = await freePort();
  dev = await createServer({
    root: APP_ROOT,
    configFile: resolve(APP_ROOT, 'vite.config.ts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
  });
  await dev.listen();
  return `http://127.0.0.1:${String(port)}`;
}

beforeEach(() => {
  seen = [];
});

afterEach(async () => {
  await dev?.close();
  await new Promise<void>((done) => {
    if (upstream === undefined) done();
    else
      upstream.close(() => {
        done();
      });
  });
  dev = undefined;
  upstream = undefined;
  delete process.env.OPS_API_PROXY_TARGET;
});

describe('the development proxy', () => {
  // Break caught: the base path rewritten or dropped, or the request not reaching the API at all.
  it('forwards /api/v1 requests to the API on the same path, with the browser credentials', async () => {
    const base = await startDevServer(await startUpstream());

    const response = await fetch(`${base}/api/v1/orders/42?expand=lines`, {
      method: 'POST',
      headers: {
        Cookie: 'melarc_session=abc; melarc_csrf=token123',
        'X-CSRF-Token': 'token123',
        'If-Match': '"v7"',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'NOT_FOUND', message: 'from upstream' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/v1/orders/42?expand=lines' });
    expect(seen[0]?.headers).toMatchObject({
      cookie: 'melarc_session=abc; melarc_csrf=token123',
      'x-csrf-token': 'token123',
      'if-match': '"v7"',
    });
  });

  // Break caught: the API seeing its own host instead of the browser's, which would make the dev setup
  // behave differently from production, where the edge keeps the browser host. Host-only cookies and
  // exact Origin checks depend on it.
  it('keeps the browser host on the request the API receives', async () => {
    const base = await startDevServer(await startUpstream());
    await (await fetch(`${base}/api/v1/ping`)).text();

    expect(seen[0]?.headers.host).toBe(new URL(base).host);
  });

  // Break caught: the rule that decides what is the API forwarding too little. The base itself is a path of the
  // API (the contract's one server is `/api/v1`), with a query string or without, and a trailing slash does not
  // change that. Each of these reaches the API with the path and query exactly as sent.
  it.each(['/api/v1', '/api/v1?x=1', '/api/v1/', '/api/v1/?x=1', '/api/v1/orders'])(
    'forwards %s',
    async (path) => {
      const base = await startDevServer(await startUpstream());
      await (await fetch(`${base}${path}`)).text();

      expect(seen.map((request) => request.url)).toEqual([path]);
    },
  );

  // Break caught: the API's cookies and headers not reaching the browser.
  it('returns the API response, including Set-Cookie, to the browser', async () => {
    const base = await startDevServer(await startUpstream());
    const response = await fetch(`${base}/api/v1/ping`);
    await response.text();

    expect(response.headers.get('set-cookie')).toBe('melarc_session=opaque; Path=/; HttpOnly');
  });

  // Break caught: prefix matching that treats /api/v10 or /api/v1evil as part of the API, and anything
  // outside /api/v1 (the technical probes included) being reachable from the browser origin.
  it.each([
    '/api/v10',
    '/api/v10/orders',
    '/api/v1x',
    '/api/v1x?x=1',
    '/api/v1evil',
    '/api/v2/orders',
    '/livez',
    '/readyz',
    '/api',
  ])('does not forward %s', async (path) => {
    const base = await startDevServer(await startUpstream());
    await (await fetch(`${base}${path}`)).text();

    expect(seen).toEqual([]);
  });

  // Break caught: the browser being given an absolute API address, which would break same-origin
  // cookies and CSRF (DEPLOYMENT_AND_ENVIRONMENTS.md section 12.1).
  it('never exposes the API address to the browser', async () => {
    const upstreamUrl = await startUpstream();
    const base = await startDevServer(upstreamUrl);
    const html = await (await fetch(`${base}/`)).text();

    expect(html).not.toContain(upstreamUrl);
    expect(html).not.toContain(new URL(upstreamUrl).host);
  });
});

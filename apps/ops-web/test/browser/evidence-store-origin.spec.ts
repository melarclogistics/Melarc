import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Locator, Page, Route } from '@playwright/test';
import { expect, test } from './support/guarded-test';

import { contentSecurityPolicy } from '../../config/content-security-policy';
import { freezeClock } from './support/clock';
import { watchPage } from './support/page';
import {
  answerReceivingCall,
  PICTURE,
  receivingApiState,
  RUNS,
  world,
  type ReceivingApi,
} from './support/receiving-api';
import { reportPolicyViolations } from './support/strict-policy';

/**
 * **The evidence store on another origin, in a real browser, under the production policy** (OB-S1-107, the review of 17 November 2026). The photos of the receiving screens go to an object store that is not
 * the page's origin: the bytes are sent by the browser itself (a `PUT`, `connect-src`), and a photo is drawn from the store's address (an `<img>`, `img-src`). Every other spec serves the store from the page's
 * own origin, which proves the screens and not the deployment. Here there are **two real servers on two origins**, and the browser talks to each as it would in production:
 *
 * - **the edge**: a server in front of the production build that sets the policy header on every response, as the edge of a deployment does (`e2e/harness/https-front.ts` is the same thing for the HTTPS run).
 *   The page's own requests are not intercepted by the test, so the browser knows the real address of the page, and the policy is the one `MELARC_EVIDENCE_STORE_ORIGIN` builds;
 * - **the store**: an HTTPS server on another port and under another name (`localhost`, against the edge's `127.0.0.1`) with the behaviour of a bucket: it answers the browser's own CORS preflight, checks nothing
 *   the browser does not send, and keeps every request it was sent, header by header.
 *
 * What is proved, and what each negative case is for:
 * - with the store's origin in the policy and a bucket whose CORS rule allows the portal's origin, the method and the two signed headers: a photo is **sent, completed and stored, and a stored photo is drawn**,
 *   with no violation; the store sees a preflight and a `PUT` that carry **no cookie, no authorization and no referrer**, and the bytes it received are the bytes of the file;
 * - **an origin the policy does not name stays blocked**, and nothing reaches it (a deployment with no store configured; a store other than the one configured), told as blocked and not as a lost connection;
 * - **the bucket's CORS rule is what lets the upload through**: a bucket that does not allow the portal's origin, or that does not allow one of the two headers, is told as a store that could not be reached, and
 *   the `PUT` is never sent (this is the rule that DEPLOYMENT_AND_ENVIRONMENTS.md section 12.4 asks the deployment owner to set).
 *
 * The certificate is made for the test, in the machine's temporary folder, and removed with it; the browser is told to accept it for this spec alone. **That says nothing of TLS trust** (the HTTPS run of the e2e
 * workspace is where certificates are held to a policy); it lets a real server on another origin speak `https`, which the policy asks of a store.
 */
test.use({ ignoreHTTPSErrors: true });

const PHOTO = { name: 'parcel.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('photo') };
const SIGNED_HEADERS = 'content-type, x-amz-checksum-sha256';
const STORE_UNREACHABLE =
  'The photo could not be sent to the store. Check the connection and try again.';
const STORE_BLOCKED =
  'The browser blocked sending this photo. The portal’s settings do not allow it to send photos to the photo store, so the photo itself is not at fault. Tell the person who looks after the portal.';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly bytes: Buffer;
}

interface Store {
  origin: string;
  readonly seen: Seen[];
  /** Called with every `PUT` the store received, so that the stand-in of the API can tell a completion from bytes that never came. */
  onPut: (put: Seen) => void;
  close: () => Promise<void>;
}

interface Bucket {
  /** The origin the bucket's CORS rule lets in: the portal's, or another (a rule that does not name the portal). */
  readonly allowOrigin: string;
  /** The request headers the rule allows, as a real rule lists them. */
  readonly allowHeaders: string;
}

/** A self-signed certificate for `localhost`, made by `openssl` in a folder of its own that is removed at once; nothing is kept and nothing is trusted by the machine. */
let certificate: { readonly key: string; readonly cert: string } | undefined | null = null;
function localCertificate(): { readonly key: string; readonly cert: string } | undefined {
  if (certificate !== null) return certificate;
  const directory = mkdtempSync(join(tmpdir(), 'melarc-store-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-keyout',
        join(directory, 'key.pem'),
        '-out',
        join(directory, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ],
      { stdio: 'ignore' },
    );
    certificate = {
      key: readFileSync(join(directory, 'key.pem'), 'utf8'),
      cert: readFileSync(join(directory, 'cert.pem'), 'utf8'),
    };
  } catch {
    certificate = undefined;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return certificate;
}

/** A store on its own origin: it answers as a bucket does, and keeps every request it was sent, as it was sent. */
async function startStore(bucket: Bucket): Promise<Store> {
  const tls = localCertificate();
  if (tls === undefined) throw new Error('The test certificate could not be made.');
  const seen: Seen[] = [];
  const store: Store = {
    origin: '',
    seen,
    onPut: () => undefined,
    close: () => Promise.resolve(),
  };
  const server = createServer(tls, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const record: Seen = {
        method: request.method ?? '',
        path: new URL(request.url ?? '/', 'https://store.test').pathname,
        headers: request.headers,
        bytes: Buffer.concat(chunks),
      };
      seen.push(record);
      // A real rule answers a request from the origin it names, and says nothing to any other.
      const cors =
        request.headers.origin === bucket.allowOrigin
          ? { 'access-control-allow-origin': bucket.allowOrigin, vary: 'Origin' }
          : {};
      if (request.method === 'OPTIONS') {
        response.writeHead(204, {
          ...cors,
          'access-control-allow-methods': 'PUT',
          'access-control-allow-headers': bucket.allowHeaders,
          'access-control-max-age': '60',
        });
        response.end();
        return;
      }
      if (request.method === 'PUT') {
        store.onPut(record);
        response.writeHead(200, { ...cors, 'cache-control': 'no-store' });
        response.end();
        return;
      }
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
        response.end(PICTURE);
        return;
      }
      response.writeHead(405);
      response.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  store.origin = `https://localhost:${String(port)}`;
  store.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return store;
}

interface Edge {
  origin: string;
  /** The policy it sets on every response: the one the deployment's `MELARC_EVIDENCE_STORE_ORIGIN` builds. */
  policy: string;
  /** The stand-in of the API the edge answers `/api/v1/` from, as a real server: no route is put on the page, so the browser sends the CORS preflights it really sends. */
  api: ReceivingApi | undefined;
  close: () => Promise<void>;
}

/**
 * A request of a real server in the shape the stand-in of the API answers a Playwright route in: the request it came by (`method`, `url`, `headers`, `postData`) and the two ways to answer it
 * (`fulfill`, `abort`). It lets the stand-in, which is written against a route, answer a real connection, so that nothing is intercepted in the page.
 */
function routeOf(request: IncomingMessage, response: ServerResponse, text: string, origin: string) {
  const headers = Object.fromEntries(
    Object.entries(request.headers).map(([name, value]) => [name, String(value)]),
  );
  const route = {
    request: () => ({
      method: () => request.method ?? 'GET',
      url: () => new URL(request.url ?? '/', origin).href,
      headers: () => headers,
      postData: () => (text === '' ? null : text),
      postDataBuffer: () => (text === '' ? null : Buffer.from(text)),
    }),
    fulfill: (options: {
      status?: number;
      headers?: Record<string, string>;
      json?: unknown;
      body?: string | Buffer;
    }) => {
      response.writeHead(options.status ?? 200, options.headers);
      response.end(
        options.json === undefined ? (options.body ?? '') : JSON.stringify(options.json),
      );
      return Promise.resolve();
    },
    abort: () => {
      request.socket.destroy();
      return Promise.resolve();
    },
  };
  return route as unknown as Route;
}

/**
 * The edge of a deployment, in miniature: it forwards every request to the production build and sets the policy header on what comes back, replacing any the build sent; and it answers the API's own
 * paths (`/api/v1/`) from the stand-in, as a server and not as a route of the page.
 */
async function startEdge(upstream: string): Promise<Edge> {
  const target = new URL(upstream);
  const edge: Edge = { origin: '', policy: '', api: undefined, close: () => Promise.resolve() };
  const server = createHttpServer((request, response) => {
    if (request.url?.startsWith('/api/v1/') === true && edge.api !== undefined) {
      const api = edge.api;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        void answerReceivingCall(
          routeOf(request, response, Buffer.concat(chunks).toString('utf8'), edge.origin),
          api,
        );
      });
      return;
    }
    const forwarded = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: request.url,
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (answer) => {
        const headers: OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (name !== 'content-security-policy' && value !== undefined) headers[name] = value;
        }
        response.writeHead(answer.statusCode ?? 502, {
          ...headers,
          'content-security-policy': edge.policy,
        });
        answer.pipe(response);
      },
    );
    forwarded.on('error', () => {
      response.writeHead(502);
      response.end();
    });
    request.pipe(forwarded);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  edge.origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  edge.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return edge;
}

interface Journey {
  readonly page: Page;
  readonly api: ReceivingApi;
  readonly violations: string[];
  readonly watch: ReturnType<typeof watchPage>;
}

/**
 * The receiving screens under the policy of the edge, with the store of the world on another origin. `approved` is the origin the policy names (the edge's `MELARC_EVIDENCE_STORE_ORIGIN`), or none.
 * Only the API is answered by the test's stand-in: the page, the store and the bucket's preflight are real servers.
 */
async function open(
  page: Page,
  edge: Edge,
  store: Store,
  approved: string | undefined,
): Promise<Journey> {
  edge.policy = contentSecurityPolicy(approved === undefined ? {} : { evidenceOrigin: approved });
  const violations = await reportPolicyViolations(page);
  const watch = watchPage(page);
  // The world's dates are the world's, whatever day the machine thinks it is (the clock is the page's own, no route is on the page).
  await freezeClock(page);
  const api = receivingApiState(world(), { storeOrigin: store.origin });
  edge.api = api;
  store.onPut = (put) => {
    api.uploads.push({
      path: put.path,
      headers: Object.fromEntries(
        Object.entries(put.headers).map(([name, value]) => [name, String(value)]),
      ),
      size: put.bytes.length,
      sha256: createHash('sha256').update(put.bytes).digest('hex'),
    });
  };
  await page.goto(`${edge.origin}/receiving/${RUNS.waiting}`);
  return { page, api, violations, watch };
}

const gallery = (scope: Locator) => scope.locator('input[type="file"][multiple]');

/** The first half of adding a parcel that is not on the list: the dialog, up to the photo that is chosen and sent. */
async function choosePhoto(page: Page): Promise<Locator> {
  const kente = page.getByRole('region', { name: 'Kente Crafts' });
  await kente.getByRole('button', { name: 'Add a parcel not on the list' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Add a parcel that is not on the list' });
  await dialog.getByRole('button', { name: 'Add this parcel' }).click();
  await expect(dialog.getByText('Take a photo of the parcel.', { exact: true })).toBeVisible();
  await gallery(dialog).setInputFiles(PHOTO);
  return dialog;
}

const HEADERS_THE_STORE_MUST_NEVER_SEE = [
  'cookie',
  'authorization',
  'referer',
  'x-csrf-token',
  'idempotency-key',
  'if-match',
];

/** Both servers of a case, started and stopped together: the edge in front of the production build the project serves, and the stores the case asks for. */
async function withServers(
  baseURL: string | undefined,
  buckets: readonly ((edge: Edge) => Bucket)[],
  run: (edge: Edge, stores: Store[]) => Promise<void>,
): Promise<void> {
  const edge = await startEdge(baseURL ?? '');
  const stores: Store[] = [];
  try {
    for (const bucket of buckets) stores.push(await startStore(bucket(edge)));
    await run(edge, stores);
  } finally {
    for (const store of stores) await store.close();
    await edge.close();
  }
}

/** A bucket whose rule names the portal's own origin (the edge's) and allows the headers given. */
const portals =
  (headers: string) =>
  (edge: Edge): Bucket => ({ allowOrigin: edge.origin, allowHeaders: headers });

test.describe('the evidence store on another origin, under the production policy', () => {
  test.beforeEach(() => {
    test.skip(
      localCertificate() === undefined,
      'openssl is needed to make the test certificate of a store on another origin (the hosted runs have it).',
    );
  });

  // Break caught: a policy that cannot send to, or draw from, the store of a real deployment; a bucket rule the portal's own request does not satisfy; an upload that carries the session, a credential or a
  // referrer to a store that is not the API; a stored photo that is not drawn.
  test('sends the photo to the store, completes it and stores it, and draws a stored photo from it, with no violation and nothing of the session sent', async ({
    page,
    baseURL,
  }) => {
    await withServers(baseURL, [portals(SIGNED_HEADERS)], async (edge, [store]) => {
      if (store === undefined) throw new Error('no store');
      const { api, violations, watch } = await open(page, edge, store, store.origin);

      // A stored photo is drawn from the store's address: its tile's picture is loaded from the other origin.
      await expect
        .poll(() => store.seen.filter((seen) => seen.method === 'GET').length)
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              [...document.images].filter((image) => image.complete && image.naturalWidth > 0)
                .length,
          ),
        )
        .toBeGreaterThan(0);

      const dialog = await choosePhoto(page);
      await expect(dialog.getByText('Stored', { exact: true })).toBeVisible();

      // What the browser asked the bucket first (the preflight), and what it then sent.
      const preflight = store.seen.filter((seen) => seen.method === 'OPTIONS');
      expect(preflight).toHaveLength(1);
      expect(preflight[0]?.headers.origin).toBe(edge.origin);
      expect(preflight[0]?.headers['access-control-request-method']).toBe('PUT');
      const requested = (preflight[0]?.headers['access-control-request-headers'] ?? '')
        .split(',')
        .map((name) => name.trim().toLowerCase())
        .sort();
      expect(requested).toEqual(['content-type', 'x-amz-checksum-sha256']);

      const puts = store.seen.filter((seen) => seen.method === 'PUT');
      expect(puts).toHaveLength(1);
      const put = puts[0];
      expect(put?.headers['content-type']).toBe('image/jpeg');
      expect(put?.headers['x-amz-checksum-sha256']).toBe(
        createHash('sha256').update(PHOTO.buffer).digest('base64'),
      );
      expect(put?.bytes.equals(PHOTO.buffer)).toBe(true);
      for (const name of HEADERS_THE_STORE_MUST_NEVER_SEE) {
        for (const seen of store.seen) {
          expect(seen.headers[name], `${seen.method} ${name}`).toBeUndefined();
        }
      }

      // The order the platform's steps are taken in, and the one completion.
      const steps = api.calls
        .filter(
          (call) =>
            call.method === 'POST' &&
            call.path.startsWith('/api/v1/evidence') &&
            !call.path.endsWith('/retrieval-authorization'),
        )
        .map((call) => call.path.replace(/[0-9a-f-]{36}/g, ':id'));
      expect(steps).toEqual(['/api/v1/evidence', '/api/v1/evidence/:id/complete']);

      expect(violations).toEqual([]);
      expect(api.unexpected).toEqual([]);
      expect(watch.problems).toEqual([]);
    });
  });

  // Break caught: a policy that lets the page send to an origin it was not told of, in a deployment with no store configured and in one with another store; a block told as a lost connection; a request that
  // reaches the unapproved server before the browser stops it.
  test.describe('an origin the policy does not name', () => {
    test('is blocked and nothing reaches it, when no store is configured', async ({
      page,
      baseURL,
    }) => {
      await withServers(baseURL, [portals(SIGNED_HEADERS)], async (edge, [store]) => {
        if (store === undefined) throw new Error('no store');
        const { violations } = await open(page, edge, store, undefined);

        const dialog = await choosePhoto(page);

        await expect(dialog.getByText(STORE_BLOCKED, { exact: true })).toBeVisible();
        await expect(dialog.getByText('Stored', { exact: true })).toHaveCount(0);
        expect(violations.some((violation) => violation.startsWith('connect-src'))).toBe(true);
        // No preflight and no `PUT`: the browser stopped the request before it left, and the unapproved server was never asked.
        expect(store.seen.filter((seen) => seen.method !== 'GET')).toEqual([]);
      });
    });

    test('is blocked and nothing reaches it, when the policy names another store', async ({
      page,
      baseURL,
    }) => {
      await withServers(
        baseURL,
        [portals(SIGNED_HEADERS), portals(SIGNED_HEADERS)],
        async (edge, [approved, unapproved]) => {
          if (approved === undefined || unapproved === undefined) throw new Error('no store');
          // The policy names the first store and the addresses of the world point at the second.
          const { violations } = await open(page, edge, unapproved, approved.origin);

          const dialog = await choosePhoto(page);

          await expect(dialog.getByText(STORE_BLOCKED, { exact: true })).toBeVisible();
          expect(violations.some((violation) => violation.startsWith('connect-src'))).toBe(true);
          expect(unapproved.seen.filter((seen) => seen.method !== 'GET')).toEqual([]);
          expect(approved.seen).toEqual([]);
        },
      );
    });
  });

  // Break caught: a deployment guide that omits what the bucket must allow: each case here is a bucket rule that is wrong in one way, and the browser must refuse the `PUT` for it, which the portal tells as a store
  // that could not be reached (it is the bucket's CORS and not the portal's policy) and never as stored.
  test.describe('a bucket whose CORS rule is wrong', () => {
    test('that does not name the portal’s origin refuses the PUT before it is sent', async ({
      page,
      baseURL,
    }) => {
      await withServers(
        baseURL,
        [() => ({ allowOrigin: 'https://another-portal.example', allowHeaders: SIGNED_HEADERS })],
        async (edge, [store]) => {
          if (store === undefined) throw new Error('no store');
          await open(page, edge, store, store.origin);

          const dialog = await choosePhoto(page);

          await expect(dialog.getByText(STORE_UNREACHABLE, { exact: true })).toBeVisible();
          expect(store.seen.filter((seen) => seen.method === 'OPTIONS')).toHaveLength(1);
          expect(store.seen.filter((seen) => seen.method === 'PUT')).toEqual([]);
        },
      );
    });

    test('that does not allow the checksum header refuses the PUT before it is sent', async ({
      page,
      baseURL,
    }) => {
      await withServers(baseURL, [portals('content-type')], async (edge, [store]) => {
        if (store === undefined) throw new Error('no store');
        await open(page, edge, store, store.origin);

        const dialog = await choosePhoto(page);

        await expect(dialog.getByText(STORE_UNREACHABLE, { exact: true })).toBeVisible();
        expect(store.seen.filter((seen) => seen.method === 'PUT')).toEqual([]);
      });
    });
  });
});

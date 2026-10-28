import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { Logger } from 'pino';

import type { Secret } from '../config/secret.js';
import { describeError } from '../logging/redaction.js';
import { EXPOSITION_CONTENT_TYPE } from './exposition.js';

/**
 * The private metrics endpoint (S0.68; DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "Metrics"; the Product Owner's decision of 27 October 2026).
 * **A listener of its own, never a route of the application**: the public port has no `/metrics` at all, so no edge rule, proxy
 * mistake or route inventory change can expose it, and what a scraper may reach is only this. It answers `GET /metrics` with the
 * text the process gives it (`exposition.ts`) and nothing else: any other path is `404`, any other method `405`.
 *
 * **Where it listens, and who may read it.** It is off unless a port is configured. It binds where it is told, the loopback address by
 * default; the configuration refuses a host off the loopback without a secret, and with one every request must carry it as
 * `Authorization: Bearer`, compared in constant time over a digest (the verifier's endpoint asks the same). A wrong or missing
 * credential is `401` and reads nothing. What the endpoint serves holds no identifier by construction (the catalogue's closed label
 * sets), so the secret guards the operational picture, not personal data.
 *
 * **Bounded.** It reads no body, serves eight connections at once and one request on each, and ends a connection that has not sent a
 * whole request, or has sent nothing, five seconds after it began. Node looks for such connections only at an interval it is given
 * (thirty seconds if it is not, measured on Node 24.21.0, so five seconds would be thirty-five), and the interval is set to a quarter
 * of the deadline, at most a second. A failure to read the metrics is `503` with nothing of the failure in the answer; the log says
 * what failed, redacted (`describeError`), never a credential or a header.
 */
export interface MetricsListenerOptions {
  readonly host: string;
  readonly port: number;
  readonly secret?: Secret;
  /** The exposition text, read for each request. */
  readonly read: () => Promise<string>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  /** The bounds, for a test that cannot wait five seconds; a process leaves them at their defaults. */
  readonly limits?: { readonly requestTimeoutMs?: number; readonly maxConnections?: number };
}

export interface MetricsListener {
  /** The port it listens on (the one asked for, or the one the system chose for port 0). */
  readonly port: number;
  close(): Promise<void>;
}

const PATH = '/metrics';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 8;

/**
 * How often Node looks for a connection past its deadline: a quarter of the deadline, between a tenth of a second and a second (the same
 * rule as the API's own server, `create-app.ts`, which says why the default of thirty seconds is not enough).
 */
const checkingInterval = (deadlineMs: number): number =>
  Math.min(1_000, Math.max(100, Math.floor(deadlineMs / 4)));

const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

function authorized(request: IncomingMessage, expected: Buffer | undefined): boolean {
  if (expected === undefined) return true;
  const header = request.headers.authorization;
  const presented =
    typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : '';
  return timingSafeEqual(digest(presented), expected);
}

function answer(
  response: ServerResponse,
  status: number,
  text: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(text);
}

export async function startMetricsListener(
  options: MetricsListenerOptions,
): Promise<MetricsListener> {
  const expected = options.secret === undefined ? undefined : digest(options.secret.reveal());
  const server = createServer((request, response) => {
    // Nothing of a body is wanted; it is not read, and the connection closes with the answer.
    response.shouldKeepAlive = false;
    const path = (request.url ?? '').split('?', 1)[0];
    if (path !== PATH) {
      answer(response, 404, 'Not Found');
      return;
    }
    if (request.method !== 'GET') {
      answer(response, 405, 'Method Not Allowed', { Allow: 'GET' });
      return;
    }
    if (!authorized(request, expected)) {
      answer(response, 401, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    options.read().then(
      (text) => {
        answer(response, 200, text, { 'Content-Type': EXPOSITION_CONTENT_TYPE });
      },
      (error: unknown) => {
        options.logger.warn(
          { err: describeError(error) },
          'the metrics could not be read for the metrics endpoint',
        );
        answer(response, 503, 'Service Unavailable');
      },
    );
  }) as Server & { connectionsCheckingInterval: number };
  const requestTimeoutMs = options.limits?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = requestTimeoutMs;
  // The property is read when the server starts listening and is not in the type declarations of `http.Server`.
  server.connectionsCheckingInterval = checkingInterval(requestTimeoutMs);
  server.maxConnections = options.limits?.maxConnections ?? MAX_CONNECTIONS;
  server.maxRequestsPerSocket = 1;
  server.listen(options.port, options.host);
  await once(server, 'listening');
  // An error after the start (an accept that failed) must not be an uncaught exception, which the fault handlers answer by ending the
  // process: the monitoring port may not take the application down.
  server.on('error', (error: unknown) => {
    options.logger.warn({ err: describeError(error) }, 'the metrics endpoint had a server error');
  });
  const { port } = server.address() as AddressInfo;
  options.logger.info({ host: options.host, port }, 'metrics endpoint listening');
  return {
    port,
    async close() {
      if (!server.listening) return;
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

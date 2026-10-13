import type { NextFunction, Request, Response } from 'express';

import { headerLines } from '../auth/csrf/origin-policy.js';
import { writeFailure } from './all-exceptions.filter.js';

/**
 * Credentialed CORS with exact origins (S0.25; SECURITY_DESIGN.md §13.8 "Client policy" and §14.8; `GBT-W4`, `GBT-W15`). The two
 * surfaces call their own API path on their own origin, so this is not how the product is reached; it exists so that the one thing
 * that can be said of cross-origin access is exact:
 *
 * - **An origin the deployment configured is echoed, and only that one.** The value sent back is the configured string, found by
 *   equality in a list of at most two, and never the one the request carried: nothing is reflected, and `*` is never sent with
 *   credentials (a wildcard cannot be, and is not, combined with `Access-Control-Allow-Credentials`).
 * - **An origin that is not configured gets no CORS header at all.** A browser then blocks the page from reading the answer. For a
 *   preflight from such an origin the request is refused outright (`403`, no `Error.code`: a preflight is not an operation of the
 *   contract), so no allowed method or header is advertised to it.
 * - **A preflight is answered here and goes no further** (`204`, nothing routed, no guard run, no session looked up): the
 *   permitted methods and headers are a fixed list, not the ones the request asked for, so a browser cannot be talked into a header
 *   the API never meant to accept. A preflight carries no credentials and takes no `Origin` requirement of the application's own.
 * - **A simple request is not a preflight.** One that carries an `Origin` but is not an `OPTIONS` with `Access-Control-Request-
 *   Method` meets no CORS answer beyond the headers above: the guards judge its `Origin` as they do for any other, so CORS is
 *   never what lets a browser mutation through.
 * - `Vary: Origin` is sent on every answer to a request that carries an `Origin`, so a cache cannot hand one origin's answer to
 *   another (every answer is also `no-store`).
 *
 * The Rider app is native: it sends no `Origin` and is not a CORS client. Nothing here is for it, and nothing here weakens the
 * bearer path or is relied on by it.
 */

/** What a configured origin may send. The `Cookie` is automatic and is not a header the page sets. */
const ALLOWED_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE';
const ALLOWED_HEADERS = 'Content-Type, X-CSRF-Token, Idempotency-Key, If-Match';
/** What a page may read of an answer besides the safelisted headers: the request id and the record version. */
const EXPOSED_HEADERS = 'X-Request-Id, ETag';

const isPreflight = (request: Request): boolean =>
  request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined;

export function createCors(
  allowedOrigins: readonly string[],
): (request: Request, response: Response, next: NextFunction) => void {
  const allowed = [...allowedOrigins];
  return (request, response, next) => {
    const lines = headerLines(request.rawHeaders, 'origin');
    if (lines.length === 0) {
      next();
      return;
    }
    response.vary('Origin');

    const presented = lines.length === 1 ? lines[0] : undefined;
    // The configured string, found by equality: never the request's own text.
    const matched =
      typeof presented === 'string' ? allowed.find((origin) => origin === presented) : undefined;

    if (matched === undefined) {
      if (isPreflight(request)) {
        writeFailure(response, { status: 403, body: { message: 'Forbidden' } });
        return;
      }
      next();
      return;
    }

    response.setHeader('Access-Control-Allow-Origin', matched);
    response.setHeader('Access-Control-Allow-Credentials', 'true');
    response.setHeader('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    if (isPreflight(request)) {
      response.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.status(204).end();
      return;
    }
    next();
  };
}

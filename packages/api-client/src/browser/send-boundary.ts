import { ApiError } from './api-error.ts';
import { CSRF_HEADER_NAME, readCsrfToken } from './csrf.ts';

/**
 * The API path on the page's own origin: the contract's one root server (`servers: [{ url: /api/v1 }]`).
 * Ops and Vendor authenticate with host-only cookies, so they call the API through their own origin and
 * never through the dedicated Rider host that eight operations also list.
 */
export const API_BASE_PATH = '/api/v1';

/** HTTP's safe methods. Everything else changes state and needs the CSRF token. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

/** Credentials that are not the session cookie. A Bearer credential belongs to the Rider client. */
const FOREIGN_CREDENTIALS = ['Authorization', 'Proxy-Authorization'] as const;

/** The client was asked to do something the browser transport must never do. */
export class BrowserTransportError extends Error {
  override name = 'BrowserTransportError';
}

export interface SendBoundaryOptions {
  /** The page's own origin, as `URL.origin` writes it. */
  readonly origin: string;
  /** The current `document.cookie`-style string. Read on every request, since sign-in issues a new token. */
  readonly readCookies: () => string;
  /** What actually sends a request. It is called only with a request that obeys every rule below. */
  readonly send: (request: Request) => Promise<Response>;
}

/**
 * The one place the browser rules are applied, and the last step before a request leaves: it judges the
 * `Request` that is about to be sent, not the options that built it, so nothing that came earlier (a
 * per-call option, a hook that replaced the request, a different base URL) can get around it.
 *
 * - It stays on `<origin>/api/v1`, compared as a parsed origin and a whole path segment.
 * - It carries the session cookie to its own origin only (credentials `same-origin`) and never follows a
 *   redirect, which would carry the CSRF header to whatever address the response names.
 * - It is not `no-cors`, which would drop the CSRF header without a word.
 * - It carries no `Authorization` header: a browser authenticates by its cookie.
 * - `X-CSRF-Token` is the readable `melarc_csrf` cookie's value on a state-changing method, and absent
 *   otherwise. Nothing but the cookie can set it. With no cookie (before sign-in) the request goes without it.
 *
 * What comes back is judged too (see judged): a success status must carry the contract's JSON, or nothing, and a
 * request that got no answer is an ApiError of the kind `network`, not the browser's own TypeError.
 *
 * Each refusal says what was refused and never repeats a value that could be a credential.
 */
export function createSendBoundary({
  origin,
  readCookies,
  send,
}: SendBoundaryOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const inApiPath =
      url.pathname === API_BASE_PATH || url.pathname.startsWith(`${API_BASE_PATH}/`);
    if (url.origin !== origin || !inApiPath) {
      throw new BrowserTransportError(
        `Refusing to send a request to ${url.origin}${url.pathname}: the browser may only call ` +
          `${origin}${API_BASE_PATH}.`,
      );
    }
    if (request.credentials !== 'same-origin') {
      throw new BrowserTransportError(
        `Refusing to send a request with credentials "${request.credentials}": the session cookie goes to ` +
          'this origin only ("same-origin").',
      );
    }
    if (request.redirect !== 'error') {
      throw new BrowserTransportError(
        `Refusing to send a request that would handle a redirect as "${request.redirect}": the API never ` +
          'redirects, and following one would carry the CSRF header to another address.',
      );
    }
    if (request.mode !== 'cors' && request.mode !== 'same-origin') {
      throw new BrowserTransportError(
        `Refusing to send a request in mode "${request.mode}": it would lose the CSRF header.`,
      );
    }
    for (const name of FOREIGN_CREDENTIALS) {
      if (request.headers.has(name)) {
        throw new BrowserTransportError(
          `Refusing to send an ${name} header from the browser: Bearer credentials are for the Rider ` +
            'client, and a browser authenticates with its session cookie.',
        );
      }
    }

    request.headers.delete(CSRF_HEADER_NAME);
    if (!SAFE_METHODS.has(request.method.toUpperCase())) {
      const token = readCsrfToken(readCookies());
      if (token !== undefined) request.headers.set(CSRF_HEADER_NAME, token);
    }
    return judged(await sent(send, request));
  };
}

/** An abort is the caller's own doing and keeps its identity: a query that is no longer wanted is cancelled. */
function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Sends the request. A request that gets no answer is an ApiError of the kind `network`. */
async function sent(
  send: (request: Request) => Promise<Response>,
  request: Request,
): Promise<Response> {
  try {
    return await send(request);
  } catch (error) {
    if (isAbort(error)) throw error;
    throw new ApiError({ kind: 'network' });
  }
}

/** A JSON media type, with or without parameters: `application/json; charset=utf-8`, `application/problem+json`. */
const JSON_MEDIA_TYPE = /^\s*application\/(?:[\w.+-]*\+)?json\s*(?:;|$)/i;

/**
 * An answer with a success status carries the contract's JSON, or no body. The contract has no other kind of
 * success, so anything else is not from the API: a proxy's page, a portal's login form, an error served with a
 * wrong status. It is refused here, with the status it came with, because openapi-fetch would otherwise reject with
 * a bare SyntaxError, or hand the page a string as if it were data.
 *
 * The body is read to be sure it is JSON, and the answer is rebuilt from it with the same status and headers, so
 * what the caller gets is the answer that was checked. An error answer is not judged: it is an error whatever it
 * holds, and `unwrap` says so from its status.
 */
async function judged(response: Response): Promise<Response> {
  const noContent =
    response.status === 204 ||
    response.status === 205 ||
    response.headers.get('Content-Length') === '0';
  if (!response.ok || noContent) return response;

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError({ kind: 'network' });
  }
  if (text !== '') {
    let parsesAsJson = JSON_MEDIA_TYPE.test(response.headers.get('Content-Type') ?? '');
    if (parsesAsJson) {
      try {
        JSON.parse(text);
      } catch {
        parsesAsJson = false;
      }
    }
    if (!parsesAsJson) throw new ApiError({ kind: 'unexpected-response', status: response.status });
  }
  return new Response(text, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

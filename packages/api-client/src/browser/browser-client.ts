import createClient from 'openapi-fetch';

import type { paths } from '../generated/schema.ts';
import { checkedCallOptions, checkedMethod, type RestrictedClient } from './call-options.ts';
import { API_BASE_PATH, BrowserTransportError, createSendBoundary } from './send-boundary.ts';

export { API_BASE_PATH, BrowserTransportError };

export interface BrowserApiClientOptions {
  /**
   * The page's own origin. Defaults to `location.origin`; there is no default outside a page, because
   * there is nothing to be same-origin with.
   */
  readonly origin?: string;
  /** The current `document.cookie`-style string. Read on every request, since sign-in issues a new token. */
  readonly readCookies?: () => string;
  /** The `fetch` that sends the request. Defaults to the global one, looked up when a request is made. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

/**
 * The typed client for the contract's operations on the page's origin. It has the HTTP verbs and the generic
 * `request`, and no way to add middleware, replace the send function or pass the transport's options.
 */
export type BrowserApiClient = RestrictedClient;

function resolveOrigin(origin: string | undefined): string {
  const candidate = origin ?? (typeof location === 'undefined' ? undefined : location.origin);
  if (candidate === undefined) {
    throw new BrowserTransportError(
      'The browser API client needs the page origin and there is no page here: pass `origin`.',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new BrowserTransportError(`${JSON.stringify(candidate)} is not an origin.`);
  }
  const isWeb = parsed.protocol === 'https:' || parsed.protocol === 'http:';
  if (!isWeb || parsed.origin !== candidate) {
    throw new BrowserTransportError(
      `${JSON.stringify(candidate)} is not a bare http(s) origin such as https://ops.example.`,
    );
  }
  return parsed.origin;
}

/**
 * The typed client for browser surfaces (Ops, and Vendor later): the same-origin API, cookie
 * authentication, CSRF echo. It is the only transport in this package, and it is deliberately not a
 * general one: the Rider client and anything that talks to another origin are different transports.
 *
 * The rules are applied where they cannot be skipped. The underlying openapi-fetch client is made here and
 * never handed out, so nothing can add middleware to it or swap its send function; a call is given only the
 * options in CALL_OPTIONS, the rest are refused by name; and the send function it is made with judges the
 * request that is actually about to leave (see createSendBoundary), whatever built it.
 */
export function createBrowserApiClient(options: BrowserApiClientOptions = {}): BrowserApiClient {
  const origin = resolveOrigin(options.origin);
  const readCookies =
    options.readCookies ?? (() => (typeof document === 'undefined' ? '' : document.cookie));
  const send = options.fetch ?? ((request: Request) => globalThis.fetch(request));

  const inner = createClient<paths>({
    baseUrl: `${origin}${API_BASE_PATH}`,
    fetch: createSendBoundary({ origin, readCookies, send }),
    // Host-only cookies are attached on same-origin requests and on no others.
    credentials: 'same-origin',
    // The API answers JSON and never redirects; a redirect would carry the CSRF header to another address.
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });

  // The wrappers are async so that a refusal is always a rejected promise, as every other failure is, and
  // never an exception thrown at the call site. The call is made with the checked options, a new object.
  // The inner methods are generic over the contract; here they are called as plain functions, because what
  // they are given has just been checked at run time and the callers see the precise types instead.
  type Inner = (url: never, init?: never) => Promise<unknown>;
  const verb =
    (name: 'GET' | 'PUT' | 'POST' | 'DELETE' | 'OPTIONS' | 'HEAD' | 'PATCH' | 'TRACE') =>
    async (url: never, init?: unknown) =>
      (inner[name] as Inner)(url, checkedCallOptions(init) as never);

  const client = {
    GET: verb('GET'),
    PUT: verb('PUT'),
    POST: verb('POST'),
    DELETE: verb('DELETE'),
    OPTIONS: verb('OPTIONS'),
    HEAD: verb('HEAD'),
    PATCH: verb('PATCH'),
    TRACE: verb('TRACE'),
    request: async (method: unknown, url: never, init?: unknown) =>
      inner.request(checkedMethod(method) as never, url, checkedCallOptions(init) as never),
  };
  return Object.freeze(client) as unknown as BrowserApiClient;
}

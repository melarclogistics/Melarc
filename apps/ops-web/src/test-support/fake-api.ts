import { vi } from 'vitest';

import type { SessionView } from '../platform/session/session-store';

/**
 * A stand-in for the network and nothing else. The application under test keeps its real API client, its real send
 * boundary (same origin, CSRF echo, response checks), its real query client and its real router: only the `fetch` they
 * send through is replaced, so a test sees exactly the requests the application would put on the wire.
 *
 * A request no handler answers is recorded in `unhandled` and answered with a network failure; a test asserts that
 * list is empty, so a request the test did not expect is a failure and not a quiet 404.
 */
export type Handler = (request: Request) => Response | Promise<Response>;

export interface FakeApi {
  /** Every request sent, in order. */
  readonly requests: Request[];
  /** The requests no handler answered. */
  readonly unhandled: string[];
  /** Replace or add the handler of `METHOD /path` (the path after `/api/v1`). */
  on(route: string, handler: Handler): void;
  restore(): void;
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The contract's error envelope for a code, as the API would send it. */
export function errorResponse(status: number, code: string, details?: unknown): Response {
  return json(status, {
    code,
    message: 'Diagnostic text that must never reach a screen.',
    request_id: 'req-test-1',
    ...(details === undefined ? {} : { details }),
  });
}

export function installFakeApi(handlers: Record<string, Handler> = {}): FakeApi {
  const table = new Map(Object.entries(handlers));
  const requests: Request[] = [];
  const unhandled: string[] = [];

  const fake = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname.replace(/^\/api\/v1/, '')}`;
    const handler = table.get(route);
    if (handler === undefined) {
      unhandled.push(route);
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    return Promise.resolve(handler(request));
  });
  vi.stubGlobal('fetch', fake);

  return {
    requests,
    unhandled,
    on: (route, handler) => {
      table.set(route, handler);
    },
    restore: () => {
      vi.unstubAllGlobals();
    },
  };
}

/** The API of a browser where this session is the signed-in one. */
export function signedInApi(session: SessionView): Record<string, Handler> {
  return { 'GET /auth/session': () => json(200, session) };
}

/** The API of a browser where nobody is signed in. */
export function signedOutApi(): Record<string, Handler> {
  return { 'GET /auth/session': () => errorResponse(401, 'SESSION_INVALID') };
}

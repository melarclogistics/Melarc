import type { Client } from 'openapi-fetch';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { paths } from '../generated/schema.ts';
import type { ApiErrorBody } from '../index.ts';
import {
  API_BASE_PATH,
  BrowserTransportError,
  createBrowserApiClient,
  type BrowserApiClient,
} from './browser-client.ts';

const ORIGIN = 'https://ops.melarc.test';
const ID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e8f';
const OTHER_ID = '0190d7c2-7a3e-7c1e-9d2a-3f4b5c6d7e90';
const TOKEN = 'tok_9f8e7d6c5b4a';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * A client wired to a fake `fetch` that records each request it receives, and to a cookie string the
 * test controls. Everything else is the real client: the real generated paths, the real middleware.
 */
function harness(respond: () => Response | Promise<Response> = () => json(200, {}), cookies = '') {
  const requests: Request[] = [];
  let cookieString = cookies;
  const client = createBrowserApiClient({
    origin: ORIGIN,
    readCookies: () => cookieString,
    fetch: async (request) => {
      requests.push(request);
      return respond();
    },
  });
  return {
    client,
    requests,
    setCookies: (value: string) => {
      cookieString = value;
    },
  };
}

function only(requests: readonly Request[]): Request {
  expect(requests).toHaveLength(1);
  const [request] = requests;
  if (request === undefined) throw new Error('No request was sent.');
  return request;
}

describe('where a request goes', () => {
  // Break caught: a base other than the contract's relative server, such as the dedicated Rider host.
  // The contract's only root server is /api/v1, resolved against the page's own origin.
  it('goes to /api/v1 on the page origin', async () => {
    const { client, requests } = harness();

    await client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } });

    expect(API_BASE_PATH).toBe('/api/v1');
    expect(only(requests).url).toBe(`${ORIGIN}/api/v1/pickup-requests/${ID}`);
  });

  // Break caught: credentials 'omit' (the session cookie is never sent) or 'include' (it would be sent
  // across origins). Host-only cookies are attached on same-origin requests, and only those.
  it('asks the browser for same-origin credentials, so the host-only session cookie is attached', async () => {
    const { client, requests } = harness();

    await client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } });

    expect(only(requests).credentials).toBe('same-origin');
  });

  // Break caught: following a redirect, which would carry the CSRF header to whatever address the response
  // names. The API answers JSON and never redirects, so a redirect is an error, not a route.
  it('fails on a redirect instead of following it', async () => {
    const { client, requests } = harness();

    await client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } });

    expect(only(requests).redirect).toBe('error');
  });

  // Break caught: a request that does not say it wants JSON.
  it('asks for JSON', async () => {
    const { client, requests } = harness();

    await client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } });

    expect(only(requests).headers.get('Accept')).toBe('application/json');
  });

  // Break caught: the per-call baseUrl option reaching another host, for instance the Rider native host
  // that eight operations list. That host is for a Bearer client; a browser must never call it. A call has no
  // base URL of its own at all: even the one the client already uses is refused, so that no value is ever
  // judged and the only base is the one the client was made with.
  it.each([
    ['another host', 'https://api.melarc.example/v1'],
    ['the same host on another scheme', 'http://ops.melarc.test/api/v1'],
    ['the same host on another port', 'https://ops.melarc.test:8443/api/v1'],
    ['a sibling that merely starts with the prefix', `${ORIGIN}/api/v10`],
    ['a path that climbs out of the prefix', `${ORIGIN}/api/v1/..`],
    ['the origin root', ORIGIN],
    ['another path on the same origin', `${ORIGIN}/livez`],
    ['the very base the client uses', `${ORIGIN}/api/v1`],
  ])('refuses a per-call base URL of %s, before anything is sent', async (_label, baseUrl) => {
    const { client, requests } = harness();

    await expect(
      client.GET('/pickup-requests/{id}', {
        params: { path: { id: ID } },
        baseUrl,
      } as never),
    ).rejects.toBeInstanceOf(BrowserTransportError);
    expect(requests).toHaveLength(0);
  });
});

describe('the CSRF header', () => {
  // Break caught: an unsafe request that goes without the synchronizer token, which the server refuses
  // with CSRF_VALIDATION_FAILED. One case per unsafe method the contract uses.
  it.each([
    [
      'POST',
      (client: BrowserApiClient) =>
        client.POST('/pickup-requests/{id}/confirm', {
          params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
        }),
    ],
    [
      'PATCH',
      (client: BrowserApiClient) =>
        client.PATCH('/vendor-pickup-locations/{id}', {
          params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
          body: { label: 'Main hub' },
        }),
    ],
    [
      'PUT',
      (client: BrowserApiClient) =>
        client.PUT('/pickup-manifests/{id}/stops', {
          params: { path: { id: ID }, header: { 'If-Match': '"3"', 'Idempotency-Key': 'key-1' } },
          body: { ordered_stop_ids: [ID, OTHER_ID] },
        }),
    ],
    ['DELETE', (client: BrowserApiClient) => client.DELETE('/auth/session')],
  ])('echoes the cookie in X-CSRF-Token on %s', async (_method, send) => {
    const { client, requests } = harness(() => json(200, {}), `melarc_csrf=${TOKEN}; theme=dark`);

    await send(client);

    expect(only(requests).headers.get('X-CSRF-Token')).toBe(TOKEN);
  });

  // Break caught: the token sent on reads. The contract exempts safe reads on purpose, so that clients are
  // not trained to send it everywhere; and a value the caller supplied must not slip through either.
  it('is never on a GET, even when the cookie is present and the caller supplies one', async () => {
    const { client, requests } = harness(() => json(200, {}), `melarc_csrf=${TOKEN}`);

    await client.GET('/pickup-requests/{id}', {
      params: { path: { id: ID } },
      headers: { 'X-CSRF-Token': 'caller-supplied' },
    });

    expect(only(requests).headers.has('X-CSRF-Token')).toBe(false);
  });

  // Break caught: a pre-authentication call failing or sending "undefined" because no cookie exists yet.
  // Sign-in is a POST with no session, so no token exists to echo; the server decides what that means.
  it('is left off, and the request still goes, when there is no cookie yet', async () => {
    const { client, requests } = harness();

    await client.POST('/auth/vendor/sign-in', {
      body: { account_identifier: 'VND-0001', secret: 'a secret that is not logged' },
    });

    const request = only(requests);
    expect(request.method).toBe('POST');
    expect(request.headers.has('X-CSRF-Token')).toBe(false);
  });

  // Break caught: the caller's own value being sent in place of the cookie's, or sent when there is none.
  // The cookie is the only source of the token.
  it('always comes from the cookie, never from the caller', async () => {
    const withCookie = harness(() => json(200, {}), `melarc_csrf=${TOKEN}`);
    const withoutCookie = harness();
    const forged = { 'X-CSRF-Token': 'caller-supplied' };
    const args = { params: { path: { id: ID }, header: { 'If-Match': '"3"' } }, headers: forged };

    await withCookie.client.POST('/pickup-requests/{id}/confirm', args);
    await withoutCookie.client.POST('/pickup-requests/{id}/confirm', args);

    expect(only(withCookie.requests).headers.get('X-CSRF-Token')).toBe(TOKEN);
    expect(only(withoutCookie.requests).headers.has('X-CSRF-Token')).toBe(false);
  });

  // Break caught: a token read once when the client was built. Signing in issues a new one, and the page
  // keeps the same client for as long as it is open.
  it('is read from the cookie on every request', async () => {
    const { client, requests, setCookies } = harness();
    const confirm = () =>
      client.POST('/pickup-requests/{id}/confirm', {
        params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
      });

    setCookies('melarc_csrf=first');
    await confirm();
    setCookies('melarc_csrf=second');
    await confirm();

    expect(requests.map((request) => request.headers.get('X-CSRF-Token'))).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('credentials that belong to other clients', () => {
  // Break caught: a Bearer credential from the Rider transport reaching a browser request. The contract
  // keeps the two apart: Bearer is Rider only, and a browser authenticates by cookie.
  it.each(['Authorization', 'authorization'])(
    'refuses a request that carries an %s header, before anything is sent',
    async (name) => {
      const { client, requests } = harness();

      await expect(
        client.GET('/pickup-requests/{id}', {
          params: { path: { id: ID } },
          headers: { [name]: 'Bearer rider-secret' },
        }),
      ).rejects.toBeInstanceOf(BrowserTransportError);
      expect(requests).toHaveLength(0);
    },
  );
});

/**
 * Audit F02. The options below are the transport's, not a call's. Each is a value the underlying client would
 * act on if a call passed it (usually by spreading it into the request it builds): they decide where, how and by
 * what a request is sent, and none of them is part of any operation in the contract.
 */
const OWNED_OPTIONS: readonly (readonly [string, string, unknown])[] = [
  ['credentials: omit', 'credentials', 'omit'],
  ['credentials: include', 'credentials', 'include'],
  ['redirect: follow', 'redirect', 'follow'],
  ['redirect: manual', 'redirect', 'manual'],
  ['mode: no-cors', 'mode', 'no-cors'],
  ['cache', 'cache', 'no-store'],
  ['keepalive', 'keepalive', true],
  ['referrer', 'referrer', 'https://elsewhere.example/'],
  ['referrerPolicy', 'referrerPolicy', 'unsafe-url'],
  ['integrity', 'integrity', 'sha256-AAAA'],
  ['priority', 'priority', 'high'],
  ['method', 'method', 'DELETE'],
  ['a fetch of its own', 'fetch', () => Promise.resolve(new Response(null, { status: 204 }))],
  ['a Request class of its own', 'Request', class extends Request {}],
  ['middleware of its own', 'middleware', [{ onRequest: () => undefined }]],
  ['a path serializer', 'pathSerializer', (path: string) => path],
  ['a query serializer', 'querySerializer', () => ''],
  ['a body serializer', 'bodySerializer', () => ''],
];

describe('the options of a call (audit F02)', () => {
  // The counterexample from the audit, as it was run: both defaults overridden in one call.
  it('refuses to override the credentials and the redirect policy, and sends nothing', async () => {
    const { client, requests } = harness();

    await expect(
      client.DELETE('/auth/session', { credentials: 'omit', redirect: 'follow' } as never),
    ).rejects.toThrow(/credentials, redirect/);
    expect(requests).toHaveLength(0);
  });

  // Break caught: any option that decides where, how or by what a request is sent being let through to the
  // underlying client. Each is refused by name, and nothing is sent.
  it.each(OWNED_OPTIONS)('refuses %s, and sends nothing', async (_label, name, value) => {
    const { client, requests } = harness();

    const error = await client
      .GET('/pickup-requests/{id}', { params: { path: { id: ID } }, [name]: value } as never)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserTransportError);
    expect((error as Error).message).toContain(name);
    expect(requests).toHaveLength(0);
  });

  // Break caught (audit F02): a send function given for one call replacing the client's own, which is the one
  // place the rules are applied. Neither is called.
  it('never calls a fetch given for one call, nor the client fetch', async () => {
    const { client, requests } = harness();
    const used: string[] = [];
    const ownFetch = (request: Request) => {
      used.push(request.url);
      return Promise.resolve(new Response(null, { status: 204 }));
    };

    await expect(
      client.DELETE('/auth/session', { fetch: ownFetch } as never),
    ).rejects.toBeInstanceOf(BrowserTransportError);

    expect(used).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  // Break caught (audit F02): middleware given for one call running after the checks and changing the request
  // they approved. It is never run.
  it('never runs middleware given for one call', async () => {
    const { client, requests } = harness();
    let ran = false;
    const middleware = [
      {
        onRequest: () => {
          ran = true;
          return new Request('https://external.example/collect', { method: 'DELETE' });
        },
      },
    ];

    await expect(client.DELETE('/auth/session', { middleware } as never)).rejects.toBeInstanceOf(
      BrowserTransportError,
    );

    expect(ran).toBe(false);
    expect(requests).toHaveLength(0);
  });

  // Break caught: a path parameter that is not one real segment steering the call to another route inside
  // /api/v1. With `.` the URL reads GET /pickup-requests/, the collection, instead of one request.
  it.each(['..', '.', ''])('refuses the path parameter %j, and sends nothing', async (id) => {
    const { client, requests } = harness();

    await expect(client.GET('/pickup-requests/{id}', { params: { path: { id } } })).rejects.toThrow(
      /path parameter id/,
    );
    expect(requests).toHaveLength(0);
  });

  // Break caught: a refused call leaving the client unable to make the next one.
  it('goes on working after a call was refused', async () => {
    const { client, requests } = harness();

    await expect(
      client.DELETE('/auth/session', { credentials: 'omit' } as never),
    ).rejects.toBeInstanceOf(BrowserTransportError);
    await client.DELETE('/auth/session');

    expect(requests).toHaveLength(1);
    expect(only(requests).credentials).toBe('same-origin');
    expect(only(requests).redirect).toBe('error');
  });
});

describe('the client object (audit F02)', () => {
  // Break caught (audit F02): middleware added to the client after the checks were set up, which then changes
  // the request they approved. The audit's probe replaced the checked URL with an external one and kept the
  // token. There is no way to add middleware, and no way to take the transport's own away.
  it('has no way to add or remove middleware', () => {
    const { client } = harness();

    expect('use' in client).toBe(false);
    expect('eject' in client).toBe(false);
  });

  // Break caught: a method replaced after the client was handed out, which would put code in front of the
  // checks. The client cannot be changed.
  it('cannot be changed', () => {
    const { client } = harness();

    expect(Object.isFrozen(client)).toBe(true);
    expect(() => {
      (client as unknown as { GET: unknown }).GET = () => Promise.resolve();
    }).toThrow(TypeError);
    expect(() => {
      (client as unknown as Record<string, unknown>).use = () => undefined;
    }).toThrow(TypeError);
  });

  // Break caught: a method of the underlying client leaking onto this one.
  it('has the HTTP verbs and the generic request, and nothing else', () => {
    const { client } = harness();

    expect(Object.keys(client).toSorted()).toEqual(
      ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE', 'request'].toSorted(),
    );
  });
});

describe('the options a call may use', () => {
  // Break caught: the answer being read as JSON when the caller asked for text.
  it('parseAs chooses how the answer is read', async () => {
    const { client } = harness(
      () => new Response('plain text', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );

    const result = await client.GET('/pickup-requests/{id}', {
      params: { path: { id: ID } },
      parseAs: 'text',
    });

    expect(result.data).toBe('plain text');
  });

  // Break caught: an abort signal being dropped, so that a call cannot be cancelled.
  it('signal cancels the call', async () => {
    const requests: Request[] = [];
    const client = createBrowserApiClient({
      origin: ORIGIN,
      fetch: (request) => {
        requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => {
            reject(new DOMException('aborted', 'AbortError'));
          };
          if (request.signal.aborted) abort();
          else request.signal.addEventListener('abort', abort);
        });
      },
    });
    const controller = new AbortController();

    const call = client.GET('/pickup-requests/{id}', {
      params: { path: { id: ID } },
      signal: controller.signal,
    });
    controller.abort();

    await expect(call).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(1);
  });

  // Break caught: no way to ask for another media type. Headers a call adds are sent, except the two the
  // transport decides: Authorization is refused and the CSRF token comes from the cookie.
  it('headers can ask for another media type', async () => {
    const { client, requests } = harness();

    await client.GET('/pickup-requests/{id}', {
      params: { path: { id: ID } },
      headers: { Accept: 'text/csv' },
    });

    expect(only(requests).headers.get('Accept')).toBe('text/csv');
  });

  // Break caught: the generic request skipping the gate the verbs go through.
  it('request goes through the same gate as the verbs', async () => {
    const { client, requests } = harness();

    await client.request('get', '/pickup-requests/{id}', { params: { path: { id: ID } } });
    expect(only(requests).url).toBe(`${ORIGIN}/api/v1/pickup-requests/${ID}`);

    // Options that only this gate refuses: the final boundary would let a send function of its own and a
    // base URL on this very origin through, so a missing gate cannot hide behind it.
    const ownFetchCalls: string[] = [];
    await expect(
      client.request('get', '/pickup-requests/{id}', {
        params: { path: { id: ID } },
        fetch: (request: Request) => {
          ownFetchCalls.push(request.url);
          return Promise.resolve(new Response(null, { status: 204 }));
        },
      } as never),
    ).rejects.toThrow(/call option fetch/);
    await expect(
      client.request('get', '/pickup-requests/{id}', {
        params: { path: { id: ID } },
        baseUrl: `${ORIGIN}/api/v1`,
      } as never),
    ).rejects.toThrow(/call option baseUrl/);
    await expect(
      client.request('connect' as never, '/auth/session' as never),
    ).rejects.toBeInstanceOf(BrowserTransportError);
    expect(ownFetchCalls).toEqual([]);
    expect(requests).toHaveLength(1);
  });
});

describe('the headers the contract declares', () => {
  // Break caught: If-Match or Idempotency-Key being dropped or rewritten. They are declared parameters of
  // the operation: the caller supplies them, and the transport sends them as given.
  it('sends If-Match and Idempotency-Key exactly as the caller gives them', async () => {
    const { client, requests } = harness(() => json(202, {}));

    await client.POST('/auth/vendor/device/grant', {
      params: { header: { 'Idempotency-Key': 'retry-safe-key-1' } },
    });
    await client.POST('/pickup-requests/{id}/confirm', {
      params: { path: { id: ID }, header: { 'If-Match': '"etag-from-last-read"' } },
    });

    expect(requests[0]?.headers.get('Idempotency-Key')).toBe('retry-safe-key-1');
    expect(requests[1]?.headers.get('If-Match')).toBe('"etag-from-last-read"');
  });

  // Break caught: a JSON body sent without its content type, or not as JSON at all.
  it('sends a JSON body as application/json', async () => {
    const { client, requests } = harness(() => json(200, {}));

    await client.PATCH('/vendor-pickup-locations/{id}', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
      body: { label: 'Main hub' },
    });

    const request = only(requests);
    expect(request.headers.get('Content-Type')).toBe('application/json');
    expect(await request.json()).toEqual({ label: 'Main hub' });
  });
});

describe('what comes back', () => {
  // Break caught: the response headers being lost. The ETag is what the next mutation sends as If-Match.
  it('returns the parsed body and the response, whose ETag is readable', async () => {
    const { client } = harness(() => json(200, { id: ID }, { ETag: '"v7"' }));

    const result = await client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } });

    expect(result.data).toEqual({ id: ID });
    expect(result.error).toBeUndefined();
    expect(result.response.headers.get('ETag')).toBe('"v7"');
  });

  // Break caught: an error response being treated as data. The contract's Error body is the one place a
  // client may read a machine code from.
  it('returns an error response as the error, with its code', async () => {
    const body = { code: 'STATE_CONFLICT', message: 'Version mismatch.', request_id: 'req-1' };
    const { client } = harness(() => json(409, body));

    const result = await client.POST('/pickup-requests/{id}/confirm', {
      params: { path: { id: ID }, header: { 'If-Match': '"old"' } },
    });

    expect(result.data).toBeUndefined();
    expect(result.response.status).toBe(409);
    const error: ApiErrorBody | undefined = result.error;
    expect(error?.code).toBe('STATE_CONFLICT');
  });

  // Break caught: a 204 parsed as JSON, which throws on an empty body.
  it('treats 204 as success with no body', async () => {
    const { client } = harness(() => new Response(null, { status: 204 }));

    const result = await client.DELETE('/auth/session');

    expect(result.response.status).toBe(204);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  // Break caught: a network failure swallowed into an empty result, so the caller believes nothing was wrong.
  it('lets a network failure reject', async () => {
    const { client } = harness(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(
      client.GET('/pickup-requests/{id}', { params: { path: { id: ID } } }),
    ).rejects.toThrow('Failed to fetch');
  });
});

describe('creating the client', () => {
  // Break caught: a client that guesses an origin. There is nothing to be same-origin with outside a page.
  it('needs the page origin, and says so when there is none', () => {
    expect(() => createBrowserApiClient()).toThrow(BrowserTransportError);
    expect(() => createBrowserApiClient()).toThrow(/needs the page origin/);
  });

  // Break caught: an "origin" that is a URL with a path, which would move the whole API somewhere else.
  it.each(['not a url', 'https://ops.melarc.test/api', 'https://ops.melarc.test/', 'null', ''])(
    'rejects %j as an origin',
    (origin) => {
      expect(() => createBrowserApiClient({ origin })).toThrow(BrowserTransportError);
    },
  );
});

/**
 * Compile-time proofs, checked by `tsc` through `pnpm typecheck` and never run: each line below must be a
 * type error, so if the generated types stop constraining callers, the unused directive fails the build.
 */
export async function typeLevelProofs(client: BrowserApiClient): Promise<void> {
  // A header the contract requires cannot be left out.
  // @ts-expect-error confirmPickupRequest declares a required If-Match header.
  await client.POST('/pickup-requests/{id}/confirm', { params: { path: { id: ID } } });

  // A path that is not in the contract does not exist.
  // @ts-expect-error '/not-in-the-contract' is not a path.
  await client.GET('/not-in-the-contract');

  // A method the path does not have is refused.
  // @ts-expect-error getPickupRequest has no DELETE.
  await client.DELETE('/pickup-requests/{id}', { params: { path: { id: ID } } });

  // Nor is it a path for that method at all, whatever is or is not passed with it.
  // @ts-expect-error '/pickup-requests/{id}' is not a path that has a DELETE.
  await client.DELETE('/pickup-requests/{id}');

  // The options may be left out only when the operation needs none: this one needs its path parameter.
  // @ts-expect-error getPickupRequest requires `params`, so the options cannot be omitted.
  await client.GET('/pickup-requests/{id}');

  // A body that does not match the contract's schema is refused.
  await client.PATCH('/vendor-pickup-locations/{id}', {
    params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
    // @ts-expect-error VendorPickupLocationUpdate.label is a string.
    body: { label: 42 },
  });

  // The options the transport owns are not options of a call (audit F02).
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    // @ts-expect-error credentials belongs to the transport.
    credentials: 'omit',
  });
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    // @ts-expect-error redirect belongs to the transport.
    redirect: 'follow',
  });
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    // @ts-expect-error a call has no base URL of its own.
    baseUrl: 'https://api.melarc.example/v1',
  });
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    // @ts-expect-error a call has no send function of its own.
    fetch: () => Promise.resolve(new Response()),
  });
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    // @ts-expect-error a call has no middleware of its own.
    middleware: [],
  });

  // There is no way to add or remove middleware.
  // The calls below are the compile errors being proved, so the unsafe-call rule is right and is not the point.
  // @ts-expect-error the client has no `use`.
  client.use({ onRequest: () => undefined }); // eslint-disable-line @typescript-eslint/no-unsafe-call
  // @ts-expect-error the client has no `eject`.
  client.eject(); // eslint-disable-line @typescript-eslint/no-unsafe-call

  // What a call may use is still typed: the headers and body of the contract, and the signal.
  await client.GET('/pickup-requests/{id}', {
    params: { path: { id: ID } },
    signal: new AbortController().signal,
    parseAs: 'text',
    headers: { Accept: 'text/csv' },
  });
}

/**
 * The generated typing is not weakened (audit F02). For operations of every shape, the answer of the
 * restricted client has the very type the unrestricted client gives. Checked by `tsc` and never run.
 */
export function typeEqualityProofs(restricted: BrowserApiClient, original: Client<paths>): void {
  // No parameters at all.
  expectTypeOf(restricted.DELETE('/auth/session')).toEqualTypeOf(original.DELETE('/auth/session'));

  // A path parameter.
  expectTypeOf(
    restricted.GET('/pickup-requests/{id}', { params: { path: { id: ID } } }),
  ).toEqualTypeOf(original.GET('/pickup-requests/{id}', { params: { path: { id: ID } } }));

  // A required header.
  expectTypeOf(
    restricted.POST('/pickup-requests/{id}/confirm', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
    }),
  ).toEqualTypeOf(
    original.POST('/pickup-requests/{id}/confirm', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
    }),
  );

  // A body.
  expectTypeOf(
    restricted.PATCH('/vendor-pickup-locations/{id}', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
      body: { label: 'Main hub' },
    }),
  ).toEqualTypeOf(
    original.PATCH('/vendor-pickup-locations/{id}', {
      params: { path: { id: ID }, header: { 'If-Match': '"3"' } },
      body: { label: 'Main hub' },
    }),
  );

  // A required body and an optional header, on an operation that is not a read.
  expectTypeOf(
    restricted.POST('/auth/vendor/sign-in', {
      body: { account_identifier: 'VND-0001', secret: 'x' },
    }),
  ).toEqualTypeOf(
    original.POST('/auth/vendor/sign-in', {
      body: { account_identifier: 'VND-0001', secret: 'x' },
    }),
  );

  // Reading the answer another way changes the type of the data, as it does for the original.
  expectTypeOf(
    restricted.GET('/pickup-requests/{id}', { params: { path: { id: ID } }, parseAs: 'text' }),
  ).toEqualTypeOf(
    original.GET('/pickup-requests/{id}', { params: { path: { id: ID } }, parseAs: 'text' }),
  );
}

describe('the compile-time proofs', () => {
  it('exist, and are enforced by the typecheck rather than at run time', () => {
    expect(typeof typeLevelProofs).toBe('function');
  });
});

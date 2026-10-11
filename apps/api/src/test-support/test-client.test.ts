import { describe, expect, it } from 'vitest';

import { ManualClock } from './manual-clock.js';
import { CSRF_COOKIE, CSRF_HEADER, TestClient, type FetchLike } from './test-client.js';

/**
 * The kit's HTTP client (S0.10): a cookie jar that behaves as a browser's does where the specifications depend on it
 * (SECURITY_DESIGN.md sections 12 and 13.8: `HttpOnly`, `Secure`, `Path`, expiry, the readable `melarc_csrf` echoed in `X-CSRF-Token`),
 * and a bearer mode that has none of it. The server is a double: a `fetch` that records what it is sent.
 */

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | undefined;
}

function server(...replies: { status?: number; setCookie?: string[]; body?: unknown }[]) {
  const seen: Seen[] = [];
  let at = 0;
  const fetchLike: FetchLike = (input, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies[Math.min(at, replies.length - 1)] ?? {};
    at += 1;
    const response = new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
    for (const cookie of reply.setCookie ?? []) response.headers.append('set-cookie', cookie);
    return Promise.resolve(response);
  };
  return { fetchLike, seen };
}

const BASE = 'http://127.0.0.1:3000';
const clientFor = (fetchLike: FetchLike, clock = new ManualClock()) =>
  new TestClient({ baseUrl: BASE, fetch: fetchLike, now: () => clock.now() });

describe('the cookie jar', () => {
  // Break caught: a jar that keeps nothing (a session would never be carried), or sends every cookie's attributes back.
  it('keeps what the server sets and sends back only name=value, in one header', async () => {
    const { fetchLike, seen } = server({
      setCookie: [
        'melarc_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
        'melarc_csrf=tok; Path=/; Secure; SameSite=Lax',
      ],
    });
    const client = clientFor(fetchLike);
    await client.get('/api/v1/one');
    await client.get('/api/v1/two');
    expect(seen[0]?.headers.get('cookie')).toBeNull();
    expect(seen[1]?.headers.get('cookie')).toBe('melarc_session=abc; melarc_csrf=tok');
  });

  // Break caught: a cookie the server deleted staying in the jar (a signed-out session still presented).
  it.each([
    ['Max-Age=0', 'melarc_session=; Path=/; Max-Age=0'],
    ['an Expires in the past', 'melarc_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT'],
  ])('drops a cookie the server deletes with %s', async (_label, deletion) => {
    const { fetchLike, seen } = server(
      { setCookie: ['melarc_session=abc; Path=/'] },
      { setCookie: [deletion] },
      {},
    );
    const client = clientFor(fetchLike);
    await client.get('/a');
    await client.get('/b');
    await client.get('/c');
    expect(seen[1]?.headers.get('cookie')).toBe('melarc_session=abc');
    expect(seen[2]?.headers.get('cookie')).toBeNull();
  });

  // Break caught: expiry judged by the wall clock of the machine and not by the clock the test controls, so that "the session
  // expired" could only be tested by waiting.
  it('expires a cookie by the clock it is given', async () => {
    const clock = new ManualClock();
    const { fetchLike, seen } = server(
      { setCookie: ['melarc_session=abc; Path=/; Max-Age=60'] },
      {},
    );
    const client = clientFor(fetchLike, clock);
    await client.get('/a');
    clock.advance(59_000);
    await client.get('/b');
    clock.advance(2_000);
    await client.get('/c');
    expect(seen[1]?.headers.get('cookie')).toBe('melarc_session=abc');
    expect(seen[2]?.headers.get('cookie')).toBeNull();
  });

  // Break caught: a cookie of one path sent to every path.
  it('sends a cookie only to the paths its Path covers', async () => {
    const { fetchLike, seen } = server(
      { setCookie: ['scoped=1; Path=/api/v1', 'everywhere=1; Path=/'] },
      {},
    );
    const client = clientFor(fetchLike);
    await client.get('/readyz');
    await client.get('/readyz');
    await client.get('/api/v1/staff');
    await client.get('/api/v1x/staff');
    expect(seen[1]?.headers.get('cookie')).toBe('everywhere=1');
    expect(seen[2]?.headers.get('cookie')).toBe('scoped=1; everywhere=1');
    expect(seen[3]?.headers.get('cookie')).toBe('everywhere=1');
  });

  // Break caught: a Secure cookie sent over plaintext to a host that is not the machine itself (a browser withholds it; the
  // loopback exception is the one a local run depends on).
  it('withholds a Secure cookie from a plain http host that is not loopback, and sends it to loopback', async () => {
    const remote = server({ setCookie: ['melarc_session=abc; Path=/; Secure'] }, {});
    const remoteClient = new TestClient({ baseUrl: 'http://api.example', fetch: remote.fetchLike });
    await remoteClient.get('/a');
    await remoteClient.get('/b');
    expect(remote.seen[1]?.headers.get('cookie')).toBeNull();

    const secure = server({ setCookie: ['melarc_session=abc; Path=/; Secure'] }, {});
    const httpsClient = new TestClient({ baseUrl: 'https://api.example', fetch: secure.fetchLike });
    await httpsClient.get('/a');
    await httpsClient.get('/b');
    expect(secure.seen[1]?.headers.get('cookie')).toBe('melarc_session=abc');

    const local = server({ setCookie: ['melarc_session=abc; Path=/; Secure'] }, {});
    const localClient = clientFor(local.fetchLike);
    await localClient.get('/a');
    await localClient.get('/b');
    expect(local.seen[1]?.headers.get('cookie')).toBe('melarc_session=abc');
  });

  it('replaces a cookie of the same name and path, and keeps one of another path', async () => {
    const { fetchLike, seen } = server(
      { setCookie: ['k=1; Path=/', 'k=other; Path=/api'] },
      { setCookie: ['k=2; Path=/'] },
      {},
    );
    const client = clientFor(fetchLike);
    await client.get('/x');
    await client.get('/x');
    await client.get('/api/y');
    expect(seen[2]?.headers.get('cookie')).toBe('k=other; k=2');
  });

  // The jar of one client is not the jar of another: two users in one test are two clients.
  it('gives each client a jar of its own, and a fork starts empty', async () => {
    const { fetchLike, seen } = server({ setCookie: ['melarc_session=abc; Path=/'] }, {});
    const first = clientFor(fetchLike);
    await first.get('/a');
    await first.fork().get('/b');
    expect(seen[1]?.headers.get('cookie')).toBeNull();
  });
});

describe('the CSRF echo (SECURITY_DESIGN.md section 13.8)', () => {
  const SESSION = [
    'melarc_session=abc; Path=/; HttpOnly; Secure',
    `${CSRF_COOKIE}=tok-1; Path=/; Secure`,
  ];

  // Break caught: an unsafe request that goes out without the token the server demands, which would make every protected test
  // pass for the wrong reason, or a safe request that carries one.
  it('echoes the readable token in X-CSRF-Token on an unsafe request and on no safe one', async () => {
    const { fetchLike, seen } = server({ setCookie: SESSION }, {}, {}, {}, {}, {});
    const client = clientFor(fetchLike);
    await client.get('/login');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await client.request(method, '/api/v1/x', { body: {} });
    }
    await client.get('/api/v1/x');
    expect(seen.slice(1, 5).map((each) => each.headers.get(CSRF_HEADER))).toEqual([
      'tok-1',
      'tok-1',
      'tok-1',
      'tok-1',
    ]);
    expect(seen[5]?.headers.get(CSRF_HEADER)).toBeNull();
  });

  // The cookie is readable by design; an HttpOnly one is not, and the page could not echo it. The client reads what a page could.
  it('does not echo a token the server marked HttpOnly: a page could not read it', async () => {
    const { fetchLike, seen } = server(
      { setCookie: [`${CSRF_COOKIE}=tok-1; Path=/; HttpOnly`] },
      {},
    );
    const client = clientFor(fetchLike);
    await client.get('/login');
    await client.post('/api/v1/x', {});
    expect(seen[1]?.headers.get(CSRF_HEADER)).toBeNull();
    expect(seen[1]?.headers.get('cookie')).toBe(`${CSRF_COOKIE}=tok-1`);
  });

  it('sends the origin on an unsafe request, the configured one when it is given', async () => {
    const { fetchLike, seen } = server({});
    const client = new TestClient({
      baseUrl: BASE,
      origin: 'https://ops.example',
      fetch: fetchLike,
    });
    await client.post('/api/v1/x', {});
    await client.get('/api/v1/x');
    expect(seen[0]?.headers.get('origin')).toBe('https://ops.example');
    expect(seen[1]?.headers.get('origin')).toBeNull();
  });

  // Break caught: no way to send the wrong token, none, or the wrong origin, which are the refusals a server must be shown.
  it('can send a wrong token, no token, and no or another origin', async () => {
    const { fetchLike, seen } = server({ setCookie: SESSION }, {}, {}, {}, {});
    const client = clientFor(fetchLike);
    await client.get('/login');
    await client.post('/a', {}, { csrf: 'wrong' });
    await client.post('/b', {}, { csrf: 'omit' });
    await client.post('/c', {}, { origin: null });
    await client.post('/d', {}, { origin: 'https://evil.example' });
    expect(seen[1]?.headers.get(CSRF_HEADER)).toBe('wrong');
    expect(seen[2]?.headers.get(CSRF_HEADER)).toBeNull();
    expect(seen[3]?.headers.get('origin')).toBeNull();
    expect(seen[4]?.headers.get('origin')).toBe('https://evil.example');
  });

  it('sends a JSON body with its content type, and reads one back', async () => {
    const { fetchLike, seen } = server({ status: 201, body: { id: 'x' } });
    const client = clientFor(fetchLike);
    const response = await client.post('/api/v1/x', { a: 1 });
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(seen[0]?.headers.get('content-type')).toBe('application/json');
    expect(response.status).toBe(201);
    expect(response.json()).toEqual({ id: 'x' });
  });
});

describe('the bearer client', () => {
  // Break caught: a native client that carries a cookie or a CSRF token it never has (a Rider request is not a browser's).
  it('sends the bearer credential and nothing a browser would: no cookie, no token, no origin', async () => {
    const { fetchLike, seen } = server(
      { setCookie: ['melarc_session=abc; Path=/', `${CSRF_COOKIE}=t; Path=/`] },
      {},
    );
    const browser = clientFor(fetchLike);
    await browser.get('/login');
    const rider = browser.bearer('rider-token');
    await rider.post('/api/v1/x', {});
    expect(seen[1]?.headers.get('authorization')).toBe('Bearer rider-token');
    expect(seen[1]?.headers.get('cookie')).toBeNull();
    expect(seen[1]?.headers.get(CSRF_HEADER)).toBeNull();
    expect(seen[1]?.headers.get('origin')).toBeNull();
  });

  it('does not keep a cookie the server sets to a bearer client', async () => {
    const { fetchLike, seen } = server({ setCookie: ['melarc_session=abc; Path=/'] }, {});
    const rider = new TestClient({ baseUrl: BASE, fetch: fetchLike, bearer: 'rider-token' });
    await rider.get('/a');
    await rider.get('/b');
    expect(seen[1]?.headers.get('cookie')).toBeNull();
    expect(rider.cookie('melarc_session')).toBeUndefined();
  });
});

describe('the response', () => {
  it('reports the status, the headers, the text, the parsed JSON and the cookies the server set', async () => {
    const { fetchLike } = server({
      status: 403,
      setCookie: ['a=1; Path=/', 'b=2; Path=/; HttpOnly'],
      body: { code: 'X' },
    });
    const response = await clientFor(fetchLike).get('/a');
    expect(response.status).toBe(403);
    expect(response.header('content-type')).toBe('application/json');
    expect(response.text).toBe('{"code":"X"}');
    expect(response.json()).toEqual({ code: 'X' });
    expect(response.setCookies.map((cookie) => [cookie.name, cookie.httpOnly])).toEqual([
      ['a', false],
      ['b', true],
    ]);
  });

  it('does not follow a redirect: the test sees the answer the server gave', async () => {
    let redirected = false;
    const fetchLike: FetchLike = (_input, init) => {
      redirected = init?.redirect === 'manual';
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: '/elsewhere' } }),
      );
    };
    const response = await clientFor(fetchLike).get('/a');
    expect(redirected).toBe(true);
    expect(response.status).toBe(302);
  });
});

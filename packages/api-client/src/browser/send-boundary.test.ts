import { describe, expect, it } from 'vitest';

import { ApiError } from './api-error.ts';
import { BrowserTransportError, createSendBoundary } from './send-boundary.ts';

const ORIGIN = 'https://ops.melarc.test';
const TOKEN = 'tok_9f8e7d6c5b4a';

/** The boundary wired to a sender that records what reaches it, and to a cookie string the test controls. */
function boundary(cookies = '') {
  const sent: Request[] = [];
  let cookieString = cookies;
  const send = createSendBoundary({
    origin: ORIGIN,
    readCookies: () => cookieString,
    send: (request) => {
      sent.push(request);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  return {
    send,
    sent,
    setCookies: (value: string) => {
      cookieString = value;
    },
  };
}

/** A request that obeys every rule. Each test below breaks exactly one. */
function request(init: RequestInit = {}, url = `${ORIGIN}/api/v1/auth/session`): Request {
  return new Request(url, {
    method: 'GET',
    credentials: 'same-origin',
    redirect: 'error',
    ...init,
  });
}

describe('the final send boundary: a request that obeys the rules', () => {
  // Break caught: the boundary swallowing or rewriting a good request. It hands the sender the request it was
  // given and returns the sender's response.
  it('reaches the sender once and its response comes back', async () => {
    const { send, sent } = boundary();
    const good = request({ method: 'DELETE' });

    const response = await send(good);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(`${ORIGIN}/api/v1/auth/session`);
    expect(sent[0]?.method).toBe('DELETE');
    expect(response.status).toBe(204);
  });

  // Break caught: a failure of the sender being turned into a result. It is still a rejection, and it is an
  // ApiError of the kind `network`: the browser's own "Failed to fetch" says nothing a program can act on.
  it('lets the sender fail, as an ApiError of the kind network', async () => {
    const send = createSendBoundary({
      origin: ORIGIN,
      readCookies: () => '',
      send: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    const failure = await send(request()).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: 'network' });
  });
});

describe('the final send boundary: where a request goes', () => {
  // Break caught: a check done on the text of the URL, or on a prefix of it. Each of these is a request the
  // browser may not make, whatever hook produced it, and none reaches the sender.
  it.each([
    ['another host', 'https://api.melarc.example/api/v1/auth/session'],
    ['the same host on another scheme', 'http://ops.melarc.test/api/v1/auth/session'],
    ['the same host on another port', 'https://ops.melarc.test:8443/api/v1/auth/session'],
    ['a sibling that merely starts with the prefix', `${ORIGIN}/api/v10`],
    ['a path that climbs out of the prefix', `${ORIGIN}/api/v1/../admin`],
    ['the origin root', `${ORIGIN}/`],
    ['another path on the same origin', `${ORIGIN}/livez`],
  ])('refuses %s, before anything is sent', async (_label, url) => {
    const { send, sent } = boundary();

    await expect(send(request({}, url))).rejects.toBeInstanceOf(BrowserTransportError);
    expect(sent).toHaveLength(0);
  });

  // Break caught: the API root itself, which is inside the prefix, being refused.
  it('allows the API root and anything below it', async () => {
    const { send, sent } = boundary();

    await send(request({}, `${ORIGIN}/api/v1`));
    await send(request({}, `${ORIGIN}/api/v1/pickup-requests?limit=5`));

    expect(sent.map((r) => new URL(r.url).pathname)).toEqual([
      '/api/v1',
      '/api/v1/pickup-requests',
    ]);
  });

  // Break caught: the refusal repeating where the request was going, which can carry a token in its query.
  it('does not repeat the query string in what it says', async () => {
    const { send } = boundary();
    const error = await send(
      request({}, 'https://api.melarc.example/api/v1/x?token=QUERY-SECRET'),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BrowserTransportError);
    expect(String(error)).not.toContain('QUERY-SECRET');
  });
});

describe('the final send boundary: how a request is made', () => {
  // Break caught (audit F02): credentials other than same-origin. 'omit' drops the session cookie silently
  // and 'include' would send it to another origin. The default is not enough: a call can override it.
  it.each(['omit', 'include'] as const)(
    'refuses credentials %s, before anything is sent',
    async (credentials) => {
      const { send, sent } = boundary();

      await expect(send(request({ credentials }))).rejects.toBeInstanceOf(BrowserTransportError);
      expect(sent).toHaveLength(0);
    },
  );

  // Break caught (audit F02): a redirect being followed. It would carry the CSRF header to whatever address
  // the response names. The API never redirects, so a request that would follow one is not made.
  it.each(['follow', 'manual'] as const)(
    'refuses redirect %s, before anything is sent',
    async (redirect) => {
      const { send, sent } = boundary();

      await expect(send(request({ redirect }))).rejects.toBeInstanceOf(BrowserTransportError);
      expect(sent).toHaveLength(0);
    },
  );

  // Break caught: a no-cors request. The browser drops custom headers from it, so the CSRF token would vanish
  // without a word, and the response would be opaque.
  it('refuses mode no-cors, before anything is sent', async () => {
    const { send, sent } = boundary();

    await expect(send(request({ mode: 'no-cors' }))).rejects.toBeInstanceOf(BrowserTransportError);
    expect(sent).toHaveLength(0);
  });

  // Break caught: a mode that keeps the CSRF header being refused. A same-origin request is one the page may
  // make (its own origin is the only one this boundary lets through), and it carries custom headers; `cors` is
  // what a request has by default. Only a mode that loses the header is refused.
  it.each(['cors', 'same-origin'] as const)(
    'allows mode %s, and the request carries its CSRF header',
    async (mode) => {
      const { send, sent } = boundary(`melarc_csrf=${TOKEN}`);

      await send(request({ method: 'POST', mode }));

      expect(sent).toHaveLength(1);
      expect(sent[0]?.mode).toBe(mode);
      expect(sent[0]?.headers.get('X-CSRF-Token')).toBe(TOKEN);
    },
  );

  // Break caught: a Bearer credential from the Rider transport reaching a browser request.
  it.each(['Authorization', 'authorization', 'Proxy-Authorization'])(
    'refuses a request that carries %s, before anything is sent',
    async (name) => {
      const { send, sent } = boundary();

      await expect(
        send(request({ headers: { [name]: 'Bearer rider-secret' } })),
      ).rejects.toBeInstanceOf(BrowserTransportError);
      expect(sent).toHaveLength(0);
    },
  );

  // Break caught: the refusal repeating the credential it refused.
  it('does not repeat the credential it refused', async () => {
    const { send } = boundary();
    const error = await send(request({ headers: { Authorization: 'Bearer RIDER-SECRET' } })).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(BrowserTransportError);
    expect(String(error)).not.toContain('RIDER-SECRET');
  });
});

describe('the final send boundary: the CSRF header', () => {
  // Break caught: an unsafe request that goes without the synchronizer token.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('puts the cookie token on %s', async (method) => {
    const { send, sent } = boundary(`melarc_csrf=${TOKEN}; theme=dark`);

    await send(request({ method }));

    expect(sent[0]?.headers.get('X-CSRF-Token')).toBe(TOKEN);
  });

  // Break caught: the token on reads, or a value the caller put there surviving.
  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'keeps it off %s, even when one was put there',
    async (method) => {
      const { send, sent } = boundary(`melarc_csrf=${TOKEN}`);

      await send(request({ method, headers: { 'X-CSRF-Token': 'caller-supplied' } }));

      expect(sent[0]?.headers.has('X-CSRF-Token')).toBe(false);
    },
  );

  // Break caught (audit F02): a value set after the headers were first checked surviving to the wire. The
  // boundary decides the header at the last moment, from the cookie, and from nowhere else.
  it('replaces a value put there with the one from the cookie', async () => {
    const { send, sent } = boundary(`melarc_csrf=${TOKEN}`);

    await send(request({ method: 'POST', headers: { 'x-csrf-token': 'ATTACKER-CHOSEN' } }));

    expect(sent[0]?.headers.get('X-CSRF-Token')).toBe(TOKEN);
  });

  // Break caught: a made-up token sent before sign-in, when there is no cookie to echo.
  it('removes a value put there when there is no cookie', async () => {
    const { send, sent } = boundary();

    await send(request({ method: 'POST', headers: { 'X-CSRF-Token': 'ATTACKER-CHOSEN' } }));

    expect(sent[0]?.headers.has('X-CSRF-Token')).toBe(false);
  });

  // Break caught: a token read once. Signing in issues a new one and the page keeps the same client.
  it('reads the cookie again for every request', async () => {
    const { send, sent, setCookies } = boundary();

    setCookies('melarc_csrf=first');
    await send(request({ method: 'POST' }));
    setCookies('melarc_csrf=second');
    await send(request({ method: 'POST' }));

    expect(sent.map((r) => r.headers.get('X-CSRF-Token'))).toEqual(['first', 'second']);
  });
});

import { describe, expect, it } from 'vitest';

import { ApiError, apiErrorFromResponse, unwrap } from './api-error.ts';
import { createBrowserApiClient } from './browser-client.ts';

const ORIGIN = 'https://ops.melarc.test';

const respond = (make: () => Response) =>
  createBrowserApiClient({
    origin: ORIGIN,
    readCookies: () => '',
    fetch: () => Promise.resolve(make()),
  });

const headers = { 'Content-Type': 'application/json' };

describe('unwrap', () => {
  // Break caught (the defect the reviewer found): `if (error)` as the test of failure. Each of these is a refusal
  // that has a falsy `error`: an empty body, the JSON text `null`, the JSON text `0`, and a 304. All were taken for
  // successes, and a failed command was shown as done.
  it.each([
    [
      '403 with an empty body',
      () => new Response(null, { status: 403, headers: { 'Content-Length': '0' } }),
      403,
    ],
    ['502 with an empty body and no length', () => new Response('', { status: 502 }), 502],
    [
      '403 whose body is the JSON text null',
      () => new Response('null', { status: 403, headers }),
      403,
    ],
    ['401 whose body is the JSON text 0', () => new Response('0', { status: 401, headers }), 401],
    ['304 Not Modified', () => new Response(null, { status: 304 }), 304],
    [
      '500 with an HTML body',
      () =>
        new Response('<html>Bad gateway</html>', {
          status: 500,
          headers: { 'Content-Type': 'text/html' },
        }),
      500,
    ],
  ])('throws an ApiError for a %s', async (_label, make, status) => {
    const result = await respond(make).GET('/pickup-manifests');

    expect(() => unwrap(result)).toThrow(ApiError);
    try {
      unwrap(result);
    } catch (error) {
      expect(error).toMatchObject({ name: 'ApiError', kind: 'http', status, code: undefined });
    }
  });

  it('throws an ApiError that carries the contract code and the request id of an error answer', async () => {
    const result = await respond(
      () =>
        new Response(
          JSON.stringify({ code: 'STATE_CONFLICT', message: 'x', request_id: 'abc-123' }),
          {
            status: 409,
            headers: { ...headers, 'X-Request-Id': 'req-777' },
          },
        ),
    ).GET('/pickup-manifests');

    let thrown: unknown;
    try {
      unwrap(result);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ status: 409, code: 'STATE_CONFLICT', requestId: 'req-777' });
    expect((thrown as ApiError).message).toBe('The API answered 409 STATE_CONFLICT');
  });

  // Break caught: the server's own words reaching a log or a screen through the error. The message is made from the
  // status and the code, and a code or an id that does not have the shape of one is dropped, not kept.
  it('never puts the body of the answer in the error', async () => {
    const result = await respond(
      () =>
        new Response(
          JSON.stringify({
            code: 'token=abc123 and more text',
            message: 'SECRET-MESSAGE',
            request_id: '<script>',
          }),
          { status: 400, headers },
        ),
    ).GET('/pickup-manifests');

    let thrown: unknown;
    try {
      unwrap(result);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ status: 400, code: undefined, requestId: undefined });
    expect(JSON.stringify(thrown) + (thrown as Error).message).not.toMatch(/abc123|SECRET|script/);
  });

  // Break caught: unwrap refusing a success, or changing what it carries.
  it('returns the data of a success, and undefined for one with no content', async () => {
    const data = await respond(
      () => new Response(JSON.stringify({ items: [] }), { status: 200, headers }),
    ).GET('/pickup-manifests');
    expect(unwrap(data)).toEqual({ items: [] });

    const none = await respond(() => new Response(null, { status: 204 })).GET('/pickup-manifests');
    expect(unwrap(none)).toBeUndefined();

    const falsy = await respond(() => new Response('0', { status: 200, headers })).GET(
      '/pickup-manifests',
    );
    expect(unwrap(falsy)).toBe(0);
  });

  it.each(['SESSION_INVALID', 'SESSION_SUPERSEDED'])('says that %s ends the session', (code) => {
    expect(apiErrorFromResponse(new Response(null, { status: 401 }), { code }).endsSession).toBe(
      true,
    );
  });

  it.each(['PERMISSION_DENIED', 'STATE_CONFLICT', undefined])(
    'does not say that %s ends the session',
    (code) => {
      expect(apiErrorFromResponse(new Response(null, { status: 403 }), { code }).endsSession).toBe(
        false,
      );
    },
  );
});

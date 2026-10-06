import { describe, expect, it } from 'vitest';

import { ApiError } from './api-error.ts';
import { createBrowserApiClient } from './browser-client.ts';

const ORIGIN = 'https://ops.melarc.test';
const json = { 'Content-Type': 'application/json' };

function clientAnswering(answer: () => Response | Promise<Response>) {
  return createBrowserApiClient({
    origin: ORIGIN,
    readCookies: () => '',
    fetch: () => Promise.resolve().then(answer),
  });
}

/** The error a call rejects with, or a failure if it did not reject. */
async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('an answer that is not the contract', () => {
  // Break caught: a success status with something that is not JSON in it. A proxy's login page, a captive portal
  // and an error page served with the wrong status all arrive as 200, and openapi-fetch rejected with a bare
  // SyntaxError that carried no status, so nothing could tell it from a bug in the page's own code.
  it.each([
    [
      'an HTML page',
      () =>
        new Response('<html>please sign in</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    ],
    [
      'plain text',
      () => new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    ],
    ['text with no content type', () => new Response('OK', { status: 200 })],
    ['JSON that is cut short', () => new Response('{"items": [', { status: 200, headers: json })],
    ['JSON with something after it', () => new Response('{} {}', { status: 200, headers: json })],
  ])('is an ApiError with the status, for %s', async (_label, answer) => {
    const error = await rejection(clientAnswering(answer).GET('/pickup-manifests'));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'unexpected-response', status: 200 });
    expect((error as ApiError).message).not.toMatch(/please sign in|OK/);
  });

  it('is an ApiError with the status that it came with', async () => {
    const error = await rejection(
      clientAnswering(
        () =>
          new Response('<html></html>', { status: 201, headers: { 'Content-Type': 'text/html' } }),
      ).GET('/pickup-manifests'),
    );

    expect(error).toMatchObject({ kind: 'unexpected-response', status: 201 });
  });

  // Break caught: the check refusing what the API really sends, which is no body for an answer with no content, and
  // JSON with a charset.
  it.each([
    [
      'JSON with a charset',
      () =>
        new Response('{"items":[]}', {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      { items: [] },
    ],
    ['a 204', () => new Response(null, { status: 204 }), undefined],
    [
      'an empty 202 with a length',
      () => new Response('', { status: 202, headers: { 'Content-Length': '0' } }),
      undefined,
    ],
    ['an empty 202 with no length', () => new Response('', { status: 202 }), undefined],
  ])('lets through %s', async (_label, answer, expected) => {
    const result = await clientAnswering(answer).GET('/pickup-manifests');

    expect(result.response.ok).toBe(true);
    expect(result.data).toEqual(expected);
  });

  // The answer that was read to be checked is still the answer the caller gets.
  it('keeps the status, the headers and the data of what it checked', async () => {
    const result = await clientAnswering(
      () =>
        new Response('{"items":[]}', {
          status: 201,
          statusText: 'Created',
          headers: { ...json, 'X-Request-Id': 'req-1', ETag: '"v3"' },
        }),
    ).GET('/pickup-manifests');

    expect(result.response.status).toBe(201);
    expect(result.response.headers.get('ETag')).toBe('"v3"');
    expect(result.response.headers.get('X-Request-Id')).toBe('req-1');
    expect(result.data).toEqual({ items: [] });
  });

  // Break caught: a failure answer being judged as a success answer would be: it is read by openapi-fetch as an
  // error, whatever it holds, and only unwrap decides what it means.
  it('leaves an error answer to be read as an error, whatever it holds', async () => {
    const result = await clientAnswering(
      () =>
        new Response('<html>Bad gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    ).GET('/pickup-manifests');

    expect(result.response.status).toBe(502);
    expect(result.error).toBe('<html>Bad gateway</html>');
  });
});

describe('no answer', () => {
  // Break caught: a dropped connection arriving as the browser's own TypeError ("Failed to fetch"), which says
  // nothing a program can act on. The call rejects with an ApiError of the kind that says no answer came.
  it('is an ApiError of the kind network when the request cannot be sent', async () => {
    const error = await rejection(
      clientAnswering(() => Promise.reject(new TypeError('Failed to fetch'))).GET(
        '/pickup-manifests',
      ),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'network', status: undefined });
    expect((error as ApiError).message).toBe('The API did not answer');
  });

  // Break caught: the connection failing in the middle of the answer: the status was 200, the body never came.
  it('is an ApiError of the kind network when the answer breaks off', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('network error'));
      },
    });
    const error = await rejection(
      clientAnswering(() => new Response(stream, { status: 200, headers: json })).GET(
        '/pickup-manifests',
      ),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: 'network' });
  });

  // Break caught: a cancelled request reported as a failure. A query that is no longer wanted is aborted, and an
  // abort is not an error of the API; it has to reach the caller as the abort it is.
  it('keeps an abort as an abort', async () => {
    const aborted = new DOMException('This operation was aborted', 'AbortError');
    const error = await rejection(
      clientAnswering(() => Promise.reject(aborted)).GET('/pickup-manifests'),
    );

    expect(error).toBe(aborted);
    expect(error).not.toBeInstanceOf(ApiError);
  });
});

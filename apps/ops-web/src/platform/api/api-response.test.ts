import { ApiError } from '@melarc/api-client/browser';
import { describe, expect, it } from 'vitest';

import { answerOf, isNotFound, isNotSignedIn, OperationFailure } from './api-response';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function respond(status: number, body?: unknown, headers: Record<string, string> = {}) {
  const response = new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
  return status >= 200 && status < 300 ? { data: body, response } : { error: body, response };
}

function failureOf(result: Parameters<typeof answerOf>[0]): OperationFailure {
  try {
    answerOf(result);
  } catch (error) {
    if (error instanceof OperationFailure) return error;
    throw error;
  }
  throw new Error('The answer was expected to be a failure.');
}

describe('answerOf: a success', () => {
  // Break caught: a read that returns the data and drops the status, so a 200 and a 201 or a 204 are one thing to the
  // page, or one that drops the version the next command needs.
  it('keeps the data, the status, the ETag and the request id', () => {
    const answer = answerOf(respond(200, { id: 'a' }, { ETag: '"v7"', 'X-Request-Id': 'req-123' }));

    expect(answer).toEqual({ data: { id: 'a' }, status: 200, etag: '"v7"', requestId: 'req-123' });
  });

  it('keeps a weak ETag as the server sent it, without reading into it', () => {
    expect(answerOf(respond(200, {}, { ETag: 'W/"abc"' })).etag).toBe('W/"abc"');
  });

  // Break caught: a header taken for a version because it was present. Anything that is not an entity tag is not a
  // version, and a command must not send it back in `If-Match`.
  it.each(['', 'v7', '"unterminated', '"a" "b"', `"${'x'.repeat(300)}"`, '"line\nbreak"'])(
    'drops an ETag that is not an entity tag: %j',
    (etag) => {
      const result = respond(200, {});
      // The Headers class refuses some of these values, which is the second line of defence; the check stands alone.
      const headers = new Headers(result.response.headers);
      try {
        headers.set('ETag', etag);
      } catch {
        return;
      }
      const answer = answerOf({
        data: {},
        response: new Response('{}', { status: 200, headers }),
      });
      expect(answer.etag).toBeUndefined();
    },
  );

  it('has no ETag and no request id when the response sent none', () => {
    const answer = answerOf(respond(200, { ok: true }));

    expect(answer.etag).toBeUndefined();
    expect(answer.requestId).toBeUndefined();
  });

  // A command that answers 204 has no data; the status is what says it succeeded.
  it('is a success with no data for a 204', () => {
    const answer = answerOf({ response: new Response(null, { status: 204 }) });

    expect(answer.status).toBe(204);
    expect(answer.data).toBeUndefined();
  });
});

describe('answerOf: the rule a conflict declares (S1.25)', () => {
  const STOP = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e';

  // Break caught: the rule of a STATE_CONFLICT thrown away, so a refused dispatch can only say that "something changed".
  it('keeps the rule and the stops a STATE_CONFLICT names', () => {
    const failure = failureOf(
      respond(409, {
        code: 'STATE_CONFLICT',
        message: 'x',
        request_id: 'req-2',
        details: { rule: 'request_not_confirmed', stops: [STOP], service_date: '2026-11-03' },
      }),
    );

    expect(failure.rule).toBe('request_not_confirmed');
    expect(failure.stops).toEqual([STOP]);
  });

  it('has no rule and no stops when the answer declares none', () => {
    const failure = failureOf(respond(409, { code: 'STATE_CONFLICT', message: 'x' }));

    expect(failure.rule).toBeUndefined();
    expect(failure.stops).toEqual([]);
  });

  // Break caught: a rule that is not a machine name (markup, text of a person's) kept to be drawn, or a stop that is not an identifier.
  it.each([
    ['markup', { rule: '<script>alert(1)</script>' }],
    ['a sentence', { rule: 'The day has passed for this run' }],
    ['a number', { rule: 7 }],
    ['an empty text', { rule: '' }],
  ])('drops a rule that is %s', (_name, details) => {
    const failure = failureOf(respond(409, { code: 'STATE_CONFLICT', message: 'x', details }));

    expect(failure.rule).toBeUndefined();
  });

  it('keeps only the stops that are identifiers, and at most 64', () => {
    const failure = failureOf(
      respond(409, {
        code: 'STATE_CONFLICT',
        message: 'x',
        details: { rule: 'request_not_confirmed', stops: [STOP, 'not an id', 4, null] },
      }),
    );
    expect(failure.stops).toEqual([STOP]);

    const many = failureOf(
      respond(409, {
        code: 'STATE_CONFLICT',
        message: 'x',
        details: { rule: 'request_not_confirmed', stops: Array.from({ length: 200 }, () => STOP) },
      }),
    );
    expect(many.stops).toHaveLength(64);
  });
});

describe('answerOf: a failure', () => {
  // Break caught: a failure read as `if (error)`, which takes a 403 with an empty body for a success.
  it('is a failure for an error status with no body at all', () => {
    const failure = failureOf({ response: new Response(null, { status: 403 }) });

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(403);
    expect(failure.code).toBeUndefined();
    expect(failure.violations).toEqual([]);
  });

  it('keeps the status, the code and the request id of the contract envelope', () => {
    const failure = failureOf(
      respond(409, { code: 'STATE_CONFLICT', message: 'x', request_id: 'req-9' }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.kind).toBe('http');
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('STATE_CONFLICT');
    expect(failure.requestId).toBe('req-9');
  });

  // Break caught: the field errors of a validation failure being thrown away, so a form can only say "something is
  // wrong". `ApiError` keeps no details; this is what keeps the ones the contract declares.
  it('keeps the violations a VALIDATION_FAILED declares, as pointers and rules', () => {
    const failure = failureOf(
      respond(400, {
        code: 'VALIDATION_FAILED',
        message: 'The request is not valid',
        request_id: 'req-1',
        details: {
          violations: [
            { in: 'body', pointer: '/password', rule: 'minLength' },
            { in: 'query', pointer: 'limit', rule: 'maximum' },
          ],
        },
      }),
    );

    expect(failure.violations).toEqual([
      { in: 'body', pointer: '/password', rule: 'minLength' },
      { in: 'query', pointer: 'limit', rule: 'maximum' },
    ]);
  });

  // Break caught: the server's text, or the value that was refused, reaching a screen through the details. A violation
  // is a place and a rule and nothing else; the message and every other detail are dropped.
  it('keeps nothing of the details but the place and the rule', () => {
    const failure = failureOf(
      respond(400, {
        code: 'VALIDATION_FAILED',
        message: 'password hunter2 is too short',
        request_id: 'req-1',
        details: {
          secret: 'hunter2',
          violations: [
            {
              in: 'body',
              pointer: '/password',
              rule: 'minLength',
              value: 'hunter2',
              message: 'hunter2',
            },
          ],
        },
      }),
    );

    expect(failure.violations).toEqual([{ in: 'body', pointer: '/password', rule: 'minLength' }]);
    expect(JSON.stringify(failure.violations)).not.toContain('hunter2');
    expect(failure.message).not.toContain('hunter2');
  });

  // Break caught: a hostile or broken body (a proxy's page, a very long list, an entry of the wrong type) being kept
  // as it is. What does not have the declared shape is dropped, and the list is bounded.
  it.each([
    ['details is not an object', { details: 'oops' }],
    ['violations is not a list', { details: { violations: { pointer: '/a' } } }],
    ['an entry is not an object', { details: { violations: ['/a', 7, null] } }],
    [
      'an entry has the wrong types',
      { details: { violations: [{ in: 1, pointer: {}, rule: [] }] } },
    ],
    [
      'an entry is oversized',
      { details: { violations: [{ in: 'body', pointer: `/${'a'.repeat(300)}`, rule: 'x' }] } },
    ],
    [
      'a rule is not a rule name',
      {
        details: { violations: [{ in: 'body', pointer: '/a', rule: '<script>alert(1)</script>' }] },
      },
    ],
    [
      'a pointer holds a control character',
      { details: { violations: [{ in: 'body', pointer: '/a\u0000b', rule: 'format' }] } },
    ],
  ])('drops what is not the declared shape: %s', (_label, extra) => {
    const failure = failureOf(
      respond(400, { code: 'VALIDATION_FAILED', message: 'm', request_id: 'r', ...extra }),
    );

    expect(failure.violations).toEqual([]);
  });

  it('keeps at most 32 violations', () => {
    const violations = Array.from({ length: 100 }, (_, index) => ({
      in: 'body',
      pointer: `/field${String(index)}`,
      rule: 'required',
    }));
    const failure = failureOf(
      respond(400, {
        code: 'VALIDATION_FAILED',
        message: 'm',
        request_id: 'r',
        details: { violations },
      }),
    );

    expect(failure.violations).toHaveLength(32);
    expect(failure.violations[0]?.pointer).toBe('/field0');
  });

  it('keeps the valid entries and drops the others', () => {
    const failure = failureOf(
      respond(400, {
        code: 'VALIDATION_FAILED',
        message: 'm',
        request_id: 'r',
        details: {
          violations: [
            { in: 'body', pointer: '/a', rule: 'required' },
            { nonsense: true },
            { in: 'body', pointer: '/b', rule: 'format' },
          ],
        },
      }),
    );

    expect(failure.violations.map((violation) => violation.pointer)).toEqual(['/a', '/b']);
  });

  // Break caught: a code that is not the contract's shape (lower case, long, with markup) being kept as `code`, which
  // copy is keyed by.
  it('keeps no code that is not shaped like the contract is', () => {
    const failure = failureOf(respond(400, { code: 'not a code', message: 'm', request_id: 'r' }));

    expect(failure.code).toBeUndefined();
  });

  // Break caught: the failure losing its place in the error handling that already exists. A session that ended is
  // noticed by `instanceof ApiError` and `endsSession`; a failure that is not one would never end it.
  it('is an ApiError, so a session that ended is still noticed as one', () => {
    const failure = failureOf(
      respond(401, { code: 'SESSION_INVALID', message: 'm', request_id: 'r' }),
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.endsSession).toBe(true);
  });
});

describe('isNotSignedIn', () => {
  // Break caught: a page taking any failure for "signed out", which signs a person out because the network dropped, or
  // taking a refused permission for it.
  it.each([
    [respond(401, { code: 'SESSION_INVALID', message: 'm', request_id: 'r' }), true],
    [respond(401, { code: 'SESSION_SUPERSEDED', message: 'm', request_id: 'r' }), true],
    [{ response: new Response(null, { status: 401 }) }, true],
    [respond(403, { code: 'PERMISSION_DENIED', message: 'm', request_id: 'r' }), false],
    [respond(500, { code: 'VALIDATION_FAILED', message: 'm', request_id: 'r' }), false],
    [respond(503), false],
  ])('judges an answer of %#', (result, expected) => {
    expect(isNotSignedIn(failureOf(result as Parameters<typeof answerOf>[0]))).toBe(expected);
  });

  it('is false for an error that is not the API’s', () => {
    expect(isNotSignedIn(new Error('401'))).toBe(false);
    expect(isNotSignedIn(new ApiError({ kind: 'network' }))).toBe(false);
    expect(isNotSignedIn(undefined)).toBe(false);
  });
});

describe('isNotFound', () => {
  // Break caught: a page taking any refusal for "it is not there", which would read a refused permission or a hub outside the session's as done.
  it.each([
    [respond(404, { code: 'NOT_FOUND', message: 'm', request_id: 'r' }), true],
    [{ response: new Response(null, { status: 404 }) }, true],
    [respond(403, { code: 'HUB_SCOPE_VIOLATION', message: 'm', request_id: 'r' }), false],
    [respond(403, { code: 'PERMISSION_DENIED', message: 'm', request_id: 'r' }), false],
    [respond(401, { code: 'SESSION_INVALID', message: 'm', request_id: 'r' }), false],
    [respond(409, { code: 'STATE_CONFLICT', message: 'm', request_id: 'r' }), false],
    [respond(500, { code: 'INTERNAL_ERROR', message: 'm', request_id: 'r' }), false],
  ])('judges an answer of %#', (result, expected) => {
    expect(isNotFound(failureOf(result as Parameters<typeof answerOf>[0]))).toBe(expected);
  });

  it('is false for an error that is not the API’s, and for a request that got no answer', () => {
    expect(isNotFound(new Error('404'))).toBe(false);
    expect(isNotFound(new ApiError({ kind: 'network' }))).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });
});

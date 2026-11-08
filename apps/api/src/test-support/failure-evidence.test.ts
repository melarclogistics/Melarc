import { describe, expect, it } from 'vitest';

import { runWithRequestContext } from '../platform/logging/request-context.js';
import { CapturedLogs } from './captured-logs.js';
import {
  clearEveryWatch,
  describeFailures,
  everyWatchedFailure,
  failureEvidence,
  registerWatch,
  watchServerFailures,
} from './failure-evidence.js';
import { TestClient, TestResponse } from './test-client.js';

/**
 * The evidence a test keeps of a server error: the request id, the status and the code, and the application's own sanitized lines for
 * that request, and nothing else. What matters here is what it leaves out as much as what it keeps.
 */
const responseFor = (requestId: string, status: number, body: unknown = {}): TestResponse =>
  new TestResponse(
    status,
    new Headers({ 'x-request-id': requestId, 'content-type': 'application/json' }),
    JSON.stringify(body),
  );

/** An error as drizzle-orm raises one: its message ends with the bound values, and a pg error is its cause. */
function failedQuery(): Error {
  const cause = Object.assign(new Error('permission denied for table mfa_factor'), {
    name: 'error',
    code: '42501',
    detail: 'Key (secret)=(hunter2) is not allowed',
  });
  return new Error('Failed query: insert into mfa_factor values ($1)\nparams: hunter2-the-seed', {
    cause,
  });
}

describe('the evidence of a server error', () => {
  // Break caught: a failed test that says only "expected 500 to be 200": the request id, the status and the lines of the log that tell
  // what the request ended in are what a person reads next.
  it('names the request, its status and its code, and the lines the application logged for it', () => {
    const logs = new CapturedLogs();
    runWithRequestContext({ requestId: 'req-a' }, () => {
      logs.logger.error({ err: failedQuery(), reason: 'deadline' }, 'unhandled error');
      logs.logger.info({ method: 'POST', status: 500, duration_ms: 12.5 }, 'request completed');
      logs.logger.info('a line about something else');
    });

    const evidence = failureEvidence(logs, responseFor('req-a', 500, { message: 'Internal' }));

    expect(evidence).toMatchObject({ request_id: 'req-a', status: 500, code: null });
    expect(evidence.records.map((record) => [record.level, record.msg])).toEqual([
      ['error', 'unhandled error'],
      ['info', 'request completed'],
    ]);
    expect(Object.keys(evidence.records[0] ?? {}).toSorted()).toEqual([
      'errors',
      'fields',
      'level',
      'msg',
    ]);
    expect(evidence.records[0]?.fields).toEqual({ reason: 'deadline' });
    expect(evidence.records[1]?.fields).toEqual({ method: 'POST', status: 500, duration_ms: 12.5 });
    expect(evidence.records[0]?.errors.map((error) => error.type)).toEqual(['Error', 'error']);
    expect(evidence.records[0]?.errors[1]?.message).toBe('permission denied for table mfa_factor');
  });

  // Break caught: the lines of another request, or an unrelated one, taken for this request's: a failure explained by someone else's.
  it('keeps nothing of another request', () => {
    const logs = new CapturedLogs();
    runWithRequestContext({ requestId: 'req-other' }, () => {
      logs.logger.error({ err: new Error('someone else') }, 'unhandled error');
    });
    runWithRequestContext({ requestId: 'req-b' }, () => {
      logs.logger.warn('request failed: the service could not do the work');
    });

    const evidence = failureEvidence(logs, responseFor('req-b', 503));

    expect(evidence.records.map((record) => record.msg)).toEqual([
      'request failed: the service could not do the work',
    ]);
  });

  // Break caught (the point of the helper): the bound values of a failed statement, a key that names a secret, a stack, or any property
  // of an error reaching the output of a test, which is a log that people paste.
  it('carries no bound value, no secret-named field, no stack and no property of the error', () => {
    const logs = new CapturedLogs();
    runWithRequestContext({ requestId: 'req-c' }, () => {
      logs.logger.error(
        {
          err: failedQuery(),
          totp_seed: 'JBSWY3DPEHPK3PXP',
          cookie: 'melarc_session=abc',
          label: 'transaction',
        },
        'unhandled error',
      );
    });

    const text = describeFailures([failureEvidence(logs, responseFor('req-c', 500))]);

    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('JBSWY3DPEHPK3PXP');
    expect(text).not.toContain('melarc_session=abc');
    expect(text).not.toContain('stack');
    expect(text).not.toContain('42501');
    expect(text).toContain('transaction');
    expect(text).toContain('permission denied for table mfa_factor');
  });

  // Break caught: an unbounded dump: a text, the lines of a request and the failures of a test are each capped.
  it('cuts long texts and caps the lines of a request', () => {
    const logs = new CapturedLogs();
    runWithRequestContext({ requestId: 'req-d' }, () => {
      for (let each = 0; each < 30; each += 1) logs.logger.warn({ note: 'x'.repeat(5_000) }, 'w');
    });

    const evidence = failureEvidence(logs, responseFor('req-d', 500));

    expect(evidence.records).toHaveLength(12);
    expect(String(evidence.records[0]?.fields.note).length).toBeLessThanOrEqual(401);
  });

  it('reads the code of the body when it has one, and tolerates a body that is not JSON', () => {
    const logs = new CapturedLogs();

    expect(failureEvidence(logs, responseFor('req-e', 500, { code: 'SOMETHING' })).code).toBe(
      'SOMETHING',
    );
    expect(
      failureEvidence(
        logs,
        new TestResponse(502, new Headers({ 'x-request-id': 'req-f' }), '<html>bad gateway</html>'),
      ),
    ).toMatchObject({ request_id: 'req-f', status: 502, code: null });
  });
});

describe('watching a client for server errors', () => {
  const clientAnswering = (answers: Record<string, number>): TestClient =>
    new TestClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: (input) => {
        const path = new URL(String(input)).pathname;
        const status = answers[path] ?? 200;
        return Promise.resolve(
          new Response(JSON.stringify({ request_id: `id-${path}` }), {
            status,
            headers: { 'x-request-id': `id-${path}`, 'content-type': 'application/json' },
          }),
        );
      },
    });

  // Break caught: the watch changing what the client answers, recording a response that is not a server error, or never being cleared.
  it('keeps the evidence of the server errors only, answers as before, and clears', async () => {
    const logs = new CapturedLogs();
    const client = clientAnswering({ '/bad': 500, '/gone': 404 });
    const watch = watchServerFailures(client, logs);

    const ok = await client.get('/fine');
    const gone = await client.get('/gone');
    const bad = await client.post('/bad', { any: 'body' });

    expect([ok.status, gone.status, bad.status]).toEqual([200, 404, 500]);
    expect(watch.seen().map((failure) => [failure.request_id, failure.status])).toEqual([
      ['id-/bad', 500],
    ]);
    watch.clear();
    expect(watch.seen()).toEqual([]);
  });

  it('keeps at most twenty failures', async () => {
    const client = clientAnswering({ '/bad': 500 });
    const watch = watchServerFailures(client, new CapturedLogs());

    for (let each = 0; each < 25; each += 1) await client.get('/bad');

    expect(watch.seen()).toHaveLength(20);
  });

  // Break caught: a session presented by value (a fork of the kit's client) or a Rider's bearer client answering with a server error that
  // the watch never sees, so that the one failing request of a test is the one request nobody recorded.
  it('watches the clients made from the client too: forks and bearer clients', async () => {
    const client = clientAnswering({ '/bad': 500 });
    const watch = watchServerFailures(client, new CapturedLogs());

    await client.fork().get('/bad');
    await client.bearer('a-token').get('/bad');
    await client.fork().fork().get('/bad');

    expect(watch.seen()).toHaveLength(3);
  });
});

describe('the watches of a test file', () => {
  const clientAnswering = (): TestClient =>
    new TestClient({
      baseUrl: 'http://127.0.0.1:1',
      fetch: () =>
        Promise.resolve(
          new Response('{}', { status: 500, headers: { 'x-request-id': 'id-registry' } }),
        ),
    });

  // Break caught: the setup of the database project printing nothing because the registry lost a watch, printing what a stopped kit
  // saw, or carrying one test's failures into the next.
  it('collects what every registered watch saw, clears them all, and forgets one that was unregistered', async () => {
    const first = clientAnswering();
    const second = clientAnswering();
    const forgetFirst = registerWatch(watchServerFailures(first, new CapturedLogs()));
    const forgetSecond = registerWatch(watchServerFailures(second, new CapturedLogs()));
    try {
      await first.get('/one');
      await second.get('/two');
      expect(everyWatchedFailure()).toHaveLength(2);

      clearEveryWatch();
      expect(everyWatchedFailure()).toEqual([]);

      await first.get('/one');
      await second.get('/two');
      forgetFirst();
      expect(everyWatchedFailure()).toHaveLength(1);
    } finally {
      forgetFirst();
      forgetSecond();
    }
    expect(everyWatchedFailure()).toEqual([]);
  });
});

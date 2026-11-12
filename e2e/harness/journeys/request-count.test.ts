import { EventEmitter } from 'node:events';

import type { BrowserContext } from '@playwright/test';
import { describe, expect, it } from 'vitest';

import {
  SESSION_REQUEST_BUDGET,
  SessionRequestLog,
  WINDOW_MS,
  budgetFailure,
  countingRequests,
  operationOf,
  watchRequests,
} from './request-count.ts';

/**
 * The count of a journey's requests by session (run 7, Stage 3.5). The point is the failure: a session that passes 100 requests in a rolling minute fails the journey, with the
 * counts by operation, before the API's own limit of 120 turns a run red with a 429 that names no page.
 */
describe('operationOf', () => {
  // Break caught: an identifier, a code or a number in the name of an operation, so that the same read of ten runs is ten operations and the count by operation says nothing.
  it('names an operation by its method and its path, with placeholders for what varies and no query', () => {
    expect(
      operationOf('get', '/api/v1/pickup-manifests/3f2c9d3a-1b0e-4e5f-9a6b-0123456789ab'),
    ).toBe('GET /pickup-manifests/{id}');
    expect(operationOf('POST', '/api/v1/pickup-requests/ACC-PR-HXB3MN/cancel')).toBe(
      'POST /pickup-requests/{code}/cancel',
    );
    expect(operationOf('GET', '/api/v1/ops/queue-summary')).toBe('GET /ops/queue-summary');
    expect(operationOf('GET', '/api/v1/things/12/parts/7')).toBe('GET /things/{n}/parts/{n}');
  });
});

describe('the busiest minute of a session', () => {
  const sessionOf = (times: readonly number[], operation = 'GET /ops/queue-summary') => {
    const log = new SessionRequestLog();
    log.startSession('session 1');
    for (const at of times) log.record(operation, at);
    return { log, session: log.sessions()[1] ?? { label: '', requests: [] } };
  };
  const evenly = (count: number, spacing: number): number[] =>
    Array.from({ length: count }, (_, index) => index * spacing);

  // Break caught: a count of the whole session, which says nothing of a rate (a long journey is not a fast one), or a minute that is not rolling (a fixed minute splits a burst).
  it('counts the most requests inside any rolling minute, not the total', () => {
    const { log, session } = sessionOf(evenly(200, 1000));

    expect(session.requests).toHaveLength(200);
    expect(log.busiestMinute(session).count).toBe(60);
  });

  it('finds a burst that straddles two fixed minutes', () => {
    const { log, session } = sessionOf([
      ...evenly(60, 100).map((at) => at + 50_000),
      ...evenly(60, 100).map((at) => at + 56_000),
    ]);

    expect(log.busiestMinute(session).count).toBeGreaterThan(60);
  });

  // Break caught: a request exactly a minute after another counted in its window (the limit counts the last 60 seconds, so the one at 60.000 is out).
  it('does not put two requests exactly a minute apart in one window', () => {
    const { log, session } = sessionOf([0, WINDOW_MS]);

    expect(log.busiestMinute(session).count).toBe(1);
    const inside = sessionOf([0, WINDOW_MS - 1]);
    expect(inside.log.busiestMinute(inside.session).count).toBe(2);
  });

  it('names the operations of the busiest minute, the most frequent first', () => {
    const log = new SessionRequestLog();
    log.startSession('session 1');
    for (let index = 0; index < 5; index += 1) log.record('GET /ops/queue-summary', index);
    for (let index = 0; index < 3; index += 1) log.record('GET /pickup-manifests/{id}', 10 + index);
    log.record('POST /auth/session/sign-out', 20);
    log.record('GET /late', 200_000);

    expect(log.busiestMinute(log.sessions()[1] ?? { label: '', requests: [] })).toEqual({
      count: 9,
      byOperation: [
        ['GET /ops/queue-summary', 5],
        ['GET /pickup-manifests/{id}', 3],
        ['POST /auth/session/sign-out', 1],
      ],
    });
  });
});

describe('the budget of a session', () => {
  const logWith = (...counts: number[]) => {
    const log = new SessionRequestLog();
    for (const [index, count] of counts.entries()) {
      log.startSession(`session ${String(index + 1)}`);
      for (let request = 0; request < count; request += 1) {
        log.record(
          request % 2 === 0 ? 'GET /ops/queue-summary' : 'GET /pickup-manifests/{id}',
          request * 100,
        );
      }
    }
    return log;
  };

  // Break caught: the failure at 101 requests missed (a budget of 120 is the API's own, and the first the journey would hear of it is a 429), or at 100 (a limit that is the budget).
  it('allows 100 requests in a minute and refuses 101, with the counts by operation', () => {
    expect(SESSION_REQUEST_BUDGET).toBe(100);
    expect(budgetFailure(logWith(100))).toBeUndefined();

    const failure = budgetFailure(logWith(101)) ?? '';
    expect(failure).toContain('session 1 passed 100 requests in a rolling minute');
    expect(failure).toContain('101 at the busiest');
    expect(failure).toContain('GET /ops/queue-summary x51');
    expect(failure).toContain('GET /pickup-manifests/{id} x50');
  });

  // Break caught: the requests of two sessions added together (a journey that signs in again has a new session and a new count), or only the first session judged.
  it('judges each session by its own requests, and names the one that is over', () => {
    expect(budgetFailure(logWith(60, 60))).toBeUndefined();

    const failure = budgetFailure(logWith(60, 101, 40)) ?? '';
    expect(failure).toContain('session 2 passed');
    expect(failure).not.toContain('session 1 passed');
    expect(failure).toContain('session 1: 60 requests');
    expect(failure).toContain('session 3: 40 requests');
  });

  it('puts the requests made before any sign-in in a session of their own that has no label of a person', () => {
    const log = new SessionRequestLog();
    log.record('GET /auth/session', 0);
    log.startSession('session 1');
    log.record('GET /ops/queue-summary', 1);

    expect(log.report()).toBe(
      'before a sign-in: 1 requests, 1 in the busiest minute (GET /auth/session x1)\nsession 1: 1 requests, 1 in the busiest minute (GET /ops/queue-summary x1)',
    );
  });
});

describe('watching a browser context', () => {
  const API = 'http://127.0.0.1:5172/api/v1';
  const fakeContext = () => {
    const emitter = new EventEmitter();
    return { emitter, context: emitter as unknown as BrowserContext };
  };
  const request = (method: string, path: string) => ({
    method: () => method,
    url: () => `${API}${path}`,
  });
  const response = (method: string, path: string, status: number) => ({
    status: () => status,
    request: () => request(method, path),
  });

  // Break caught: requests of another origin or another path counted (the Vite assets, the page itself), which would make a journey that loads many files look busy.
  it('counts the API requests of the Ops origin and nothing else', () => {
    const { emitter, context } = fakeContext();
    const watched = watchRequests(context, () => 0);

    emitter.emit('request', {
      method: () => 'GET',
      url: () => 'http://127.0.0.1:5172/assets/app.js',
    });
    emitter.emit('request', request('GET', '/ops/queue-summary?hub_id=x'));

    expect(
      watched.log.sessions().flatMap((session) => session.requests.map((r) => r.operation)),
    ).toEqual(['GET /ops/queue-summary']);
  });

  // Break caught: a sign-in that does not begin a session (every session of the journey merged into one, which fails a journey that is well within its limit), or a refused sign-in that does.
  it('begins a session at a sign-in that answered 200, at the password step or at the second step, and at nothing else', () => {
    const { emitter, context } = fakeContext();
    const watched = watchRequests(context, () => 0);

    emitter.emit('response', response('POST', '/auth/staff/sign-in', 202));
    emitter.emit('response', response('POST', '/auth/staff/sign-in', 401));
    emitter.emit('response', response('GET', '/auth/session', 200));
    expect(watched.log.sessions()).toHaveLength(1);

    emitter.emit('request', request('GET', '/ops/queue-summary'));
    emitter.emit('response', response('POST', '/auth/staff/sign-in/mfa', 200));
    emitter.emit('request', request('GET', '/ops/queue-summary'));
    emitter.emit('response', response('POST', '/auth/staff/sign-in', 200));
    emitter.emit('request', request('GET', '/ops/queue-summary'));
    emitter.emit('request', request('GET', '/ops/queue-summary'));

    expect(
      watched.log.sessions().map((session) => [session.label, session.requests.length]),
    ).toEqual([
      ['before a sign-in', 1],
      ['session 1', 1],
      ['session 2', 2],
    ]);
  });

  // Break caught: a watcher that cannot be stopped (it counts the requests of the next journey's context, or leaks a listener for each journey of the run).
  it('stops watching when it is told to, and keeps what it has', () => {
    const { emitter, context } = fakeContext();
    const watched = watchRequests(context, () => 0);
    emitter.emit('request', request('GET', '/ops/queue-summary'));

    watched.stop();
    emitter.emit('request', request('GET', '/ops/queue-summary'));

    expect(emitter.listenerCount('request')).toBe(0);
    expect(emitter.listenerCount('response')).toBe(0);
    expect(watched.log.sessions().flatMap((session) => session.requests)).toHaveLength(1);
  });

  it('measures time on the clock it is given', () => {
    const { emitter, context } = fakeContext();
    let time = 0;
    const watched = watchRequests(context, () => time);
    for (time = 0; time < 101 * 100; time += 100) {
      emitter.emit('request', request('GET', '/ops/queue-summary'));
    }

    expect(budgetFailure(watched.log)).toContain('before a sign-in passed 100 requests');
  });
});

describe('a counted journey', () => {
  const API = 'http://127.0.0.1:5172/api/v1';
  const emitRequests = (emitter: EventEmitter, count: number, path = '/ops/queue-summary') => {
    for (let index = 0; index < count; index += 1) {
      emitter.emit('request', { method: () => 'GET', url: () => `${API}${path}` });
    }
  };
  const journeyOf = (run: (emitter: EventEmitter) => Promise<void>) => {
    const emitter = new EventEmitter();
    const said: string[] = [];
    const counted = countingRequests(
      { title: 'a journey of the harness', run: () => run(emitter) },
      (text) => said.push(text),
      () => 0,
    );
    return { emitter, said, counted, context: { context: emitter as unknown as BrowserContext } };
  };

  // Break caught: counts nobody sees (a journey that ends green and says nothing of how close it came), so that the margin is found out by a 429 in CI.
  it('prints the counts of a journey that stays within the budget, and passes', async () => {
    const { emitter, said, counted, context } = journeyOf(async (e) => {
      emitRequests(e, 30);
      await Promise.resolve();
    });

    await counted.run(context);

    expect(said.join('')).toContain(
      'before a sign-in: 30 requests, 30 in the busiest minute (GET /ops/queue-summary x30)',
    );
    expect(emitter.listenerCount('request')).toBe(0);
  });

  // Break caught: a journey that makes 101 requests in a minute and passes, so that the margin under the API's limit of 120 is spent without anyone being told.
  it('fails a journey that passes 100 requests in a rolling minute, with the counts by operation', async () => {
    const { said, counted, context } = journeyOf(async (e) => {
      emitRequests(e, 70);
      emitRequests(e, 31, '/pickup-manifests/3f2c9d3a-1b0e-4e5f-9a6b-0123456789ab');
      await Promise.resolve();
    });

    const failure = await counted.run(context).then(
      () => new Error('expected the journey to fail'),
      (error: unknown) => error as Error,
    );

    expect(failure.message).toContain(
      'passed 100 requests in a rolling minute (101 at the busiest',
    );
    expect(failure.message).toContain('GET /ops/queue-summary x70');
    expect(failure.message).toContain('GET /pickup-manifests/{id} x31');
    expect(said.join('')).toContain('101 in the busiest minute');
  });

  // Break caught: a journey's own failure replaced by the count, or the count left out of it: the reader needs both, the journey's words first.
  it('rethrows the failure of the journey itself, its words first and the counts after, and keeps its cause', async () => {
    const cause = new Error('the step that failed');
    const { emitter, counted, context } = journeyOf(async (e) => {
      emitRequests(e, 5);
      await Promise.resolve();
      throw cause;
    });

    const failure = await counted.run(context).then(
      () => new Error('expected the journey to fail'),
      (error: unknown) => error as Error,
    );

    expect(failure.message.startsWith('the step that failed')).toBe(true);
    expect(failure.message).toContain('GET /ops/queue-summary x5');
    expect(failure.cause).toBe(cause);
    expect(emitter.listenerCount('request')).toBe(0);
  });
});

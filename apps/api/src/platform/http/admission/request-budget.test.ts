import { Module } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../../../app.module.js';
import { FixtureModule, observedBudgets } from '../../../test-support/fixtures.js';
import { ManualClock } from '../../../test-support/manual-clock.js';
import { chunk, head, RawClient } from '../../../test-support/raw-http.js';
import { startTestApp, TEST_CONFIG, type TestApp } from '../../../test-support/test-app.js';
import type { AppConfig, HttpConfig } from '../../config/load-config.js';
import { currentBudget } from '../../execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../execution/execution-parameters.js';
import { createRequestBudget } from './request-budget.js';

/**
 * The request's execution budget over real HTTP (S0.20; plan OB-37 and OB-55). The mechanism is S0.6's and is proved against a
 * real database there; this is the pipeline half: a budget is made once a request has been admitted and received, the work runs
 * under it, it is finished when the request is over, and a request whose work outlasts it is answered. The budgets here are a
 * few hundred milliseconds; the figures are the test's.
 */
const BUDGET_MS = 600;

function runtime(
  budgetMs = BUDGET_MS,
  http: Partial<HttpConfig> = {},
  composition: AppConfig['composition'] = 'runtime',
): AppConfig {
  return {
    ...TEST_CONFIG,
    composition,
    execution: Object.freeze({ requestBudgetMs: budgetMs }),
    http: Object.freeze({
      ...TEST_CONFIG.http,
      headerTimeoutMs: 1_000,
      bodyTimeoutMs: 1_000,
      admissionTimeoutMs: 2_000,
      admissionConcurrency: 4,
      ...http,
    }),
  };
}

let running: TestApp | undefined;
const clients: RawClient[] = [];

async function start(config: AppConfig = runtime()): Promise<TestApp> {
  running = await startTestApp({
    config,
    rootModule: (options) => {
      @Module({ imports: [AppModule.register(options), FixtureModule] })
      class TestRoot {}
      return TestRoot;
    },
  });
  return running;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy();
  observedBudgets.length = 0;
  await running?.stop();
  running = undefined;
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Seen {
  present: boolean;
  label?: string;
  remainingMs?: number;
  closed?: boolean;
}

const budgetSeen = async (app: TestApp): Promise<Seen> =>
  (await (await fetch(`${app.baseUrl}/api/v1/fixture/budget`)).json()) as Seen;

describe('a request has an execution budget from admission to answer', () => {
  // Break caught: no budget at all, so a request is bounded only by the database's own time bounds and the budget setting is
  // validated and read by nothing.
  it('runs its handler under a budget of the configured length', async () => {
    const app = await start(runtime(BUDGET_MS));

    const seen = await budgetSeen(app);

    expect(seen.present).toBe(true);
    expect(seen.label).toBe('request');
    expect(seen.closed).toBe(false);
    expect(seen.remainingMs).toBeGreaterThan(0);
    expect(seen.remainingMs).toBeLessThanOrEqual(BUDGET_MS);
    // Almost all of it is left: the handler is the first thing to run once the request is admitted.
    expect(seen.remainingMs).toBeGreaterThan(BUDGET_MS - 300);
  });

  // Break caught: the budget kept alive after the answer. An unfinished budget is a leaked timer, and a continuation that kept it
  // could start work on behalf of a request that has been answered.
  it('finishes the budget when the response is over, so nothing more may start under it', async () => {
    const app = await start();

    await budgetSeen(app);
    // The response has been read by the client; the server's close of it follows a moment later.
    await sleep(100);

    expect(observedBudgets).toHaveLength(1);
    expect(observedBudgets[0]?.closed).toBe(true);
    expect(() => observedBudgets[0]?.assertOpen()).toThrow();
    expect(observedBudgets[0]?.expired).toBe(false);
  });

  // Break caught: a budget left open when the client goes away before the answer, while the handler goes on working: the
  // request is over, and nothing more may start under its budget.
  it('finishes the budget when the client goes away, even while the handler is still working', async () => {
    const app = await start(runtime(5_000));
    const controller = new AbortController();

    const gone = fetch(`${app.baseUrl}/api/v1/fixture/budget-then-wait?ms=1500`, {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await sleep(150);
    expect(observedBudgets).toHaveLength(1);
    expect(observedBudgets[0]?.closed).toBe(false);
    controller.abort();
    await gone;
    await sleep(150);

    expect(observedBudgets[0]?.closed).toBe(true);
  });

  // Break caught: the budget running while the body is still on its way, which lets a slow sender spend a request's time. The
  // receipt deadlines end a slow sender; the budget bounds what the application does once it has the request.
  it('does not start until the body has been received', async () => {
    const app = await start(runtime(1_000));
    const client = await RawClient.connect(app.baseUrl);
    clients.push(client);
    const body = '{"a":1}';

    await client.write(
      head('POST /api/v1/fixture/budget HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      }),
    );
    await sleep(500);
    await client.write(body);
    const response = await client.read(3_000);

    expect(response.status).toBe(201);
    const seen = response.json as unknown as Seen;
    // Half a second passed between the head and the body, and none of it was spent.
    expect(seen.remainingMs).toBeGreaterThan(850);
  });

  it('does not start until the request has a slot, so a wait at the gate costs it nothing', async () => {
    const app = await start(runtime(1_000, { admissionConcurrency: 1, admissionTimeoutMs: 3_000 }));

    const holder = fetch(`${app.baseUrl}/api/v1/fixture/slow/holder?ms=500`);
    await sleep(60);
    const waited = await budgetSeen(app);
    await holder;

    expect(waited.remainingMs).toBeGreaterThan(850);
  });

  // Break caught: elapsed time read from the wall clock or from a clock the pipeline made for itself, so that a test which moves the
  // bound clock moves nothing, and the mechanism the database layer reads (which uses the bound clock) disagrees with the pipeline.
  it('measures its budget on the clock the application was given', async () => {
    const clock = new ManualClock();
    const app = await startTestApp({
      config: runtime(600),
      rootModule: (options) => {
        @Module({
          imports: [
            AppModule.register({ ...options, ports: { clock: { useValue: clock } } }),
            FixtureModule,
          ],
        })
        class TestRoot {}
        return TestRoot;
      },
    });
    running = app;

    const pending = fetch(`${app.baseUrl}/api/v1/fixture/budget-after-pause?ms=250`);
    await sleep(80);
    // A quarter of a second of real time has not passed, but ten seconds of the bound clock have.
    clock.advance(10_000);
    const seen = (await (await pending).json()) as { expired: boolean };

    expect(seen.expired).toBe(true);
  });

  // Break caught: a budget on the describe composition, whose clock refuses to be read. The describe composition serves nothing
  // real (the tools and the default test application); it has no request budget, and its requests are not failed for the want of
  // one.
  it('is not made in the describe composition, whose adapters are inert', async () => {
    const app = await start(runtime(BUDGET_MS, {}, 'describe'));

    expect((await budgetSeen(app)).present).toBe(false);
    expect((await fetch(`${app.baseUrl}/api/v1/fixture/orders/1`)).status).toBe(200);
  });
});

describe('a request whose work outlasts its budget is answered', () => {
  // Break caught: a handler that heeds its budget being answered as a defect, or waiting for something other than the work.
  it('answers 503 when the work fails with the budget’s own error, as soon as it does', async () => {
    const app = await start(runtime(400));
    const started = Date.now();

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/cooperative`);

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    // Answered by the failure, not by the pipeline's own fallback, which waits out the disposal bound as well.
    expect(Date.now() - started).toBeLessThan(400 + DISPOSAL_BOUND_MS - 500);
  });

  // Break caught: a request that is never answered because its work never looks at the budget. The budget is enforced, not raced,
  // so the work is told (a statement is cancelled, the transaction rolled back); but work that waits on nothing the mechanism
  // reaches must not hold a client for as long as it likes. The pipeline waits the bound the database layer needs to settle a
  // transaction it is cleaning up, so that a commit whose outcome is unknown is answered as that and not first as a failure,
  // and then answers 503 itself.
  it('answers 503 itself, after the disposal bound, when the work heeds nothing', async () => {
    const app = await start(runtime(400));
    const started = Date.now();

    const response = await fetch(
      `${app.baseUrl}/api/v1/fixture/slow/deaf?ms=${String(400 + DISPOSAL_BOUND_MS + 1_500)}`,
    );
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    expect(elapsed).toBeGreaterThanOrEqual(400 + DISPOSAL_BOUND_MS - 100);
    expect(elapsed).toBeLessThan(400 + DISPOSAL_BOUND_MS + 1_000);
    // The work was still running when the client was answered; it is not claimed to have been stopped.
    expect(app.logs.records().some((record) => record.msg === 'fixture handler finished')).toBe(
      false,
    );
  });

  // Break caught: the late finish of the work writing a second answer over the first, or failing loudly after it.
  it('leaves the answer standing when the work finishes late, and does not report that as a fault', async () => {
    const app = await start(runtime(300));

    const response = await fetch(
      `${app.baseUrl}/api/v1/fixture/slow/late?ms=${String(300 + DISPOSAL_BOUND_MS + 400)}`,
    );
    expect(response.status).toBe(503);
    await sleep(700);

    const records = app.logs.records();
    expect(records.some((record) => record.msg === 'fixture handler finished')).toBe(true);
    const completions = records.filter((record) => record.msg === 'request completed');
    expect(completions.filter((record) => record.status === 503)).toHaveLength(1);
    // The one thing logged at error level is the completion line of a 5xx; no "unhandled error" came of the late finish.
    expect(records.filter((record) => record.msg === 'unhandled error')).toEqual([]);
  });

  // Break caught: the fallback answering a request that was answered in time, or firing after the response.
  it('does not answer a request that was answered in time', async () => {
    const app = await start(runtime(300));

    const response = await fetch(`${app.baseUrl}/api/v1/fixture/slow/prompt?ms=50`);
    await sleep(300 + DISPOSAL_BOUND_MS + 200);

    expect(response.status).toBe(200);
    expect(app.logs.records().filter((record) => String(record.msg).includes('outlasted'))).toEqual(
      [],
    );
  });

  it('logs that the pipeline answered, with the budget and not the request', async () => {
    const app = await start(runtime(300));

    await fetch(
      `${app.baseUrl}/api/v1/fixture/slow/log?ms=${String(300 + DISPOSAL_BOUND_MS + 600)}`,
    );

    const logged = app.logs
      .records()
      .find(
        (record) =>
          record.msg === 'request answered by the pipeline: its work outlasted the budget',
      );
    expect(logged).toMatchObject({ level: 'warn', label: 'request', budgetMilliseconds: 300 });
  });
});

describe('the probes have no budget', () => {
  const noRequest = {} as Request;

  const call = (path: string): { budget: unknown; calls: number } => {
    const observed: { budget: unknown; calls: number } = { budget: 'untouched', calls: 0 };
    const middleware = createRequestBudget({
      clock: new ManualClock(),
      budgetMs: 1_000,
      graceMs: 1_000,
      isExempt: (request) => request.path === '/livez' || request.path === '/readyz',
    });
    const response = { once: () => response } as unknown as Response;
    middleware({ ...noRequest, path } as Request, response, (() => {
      observed.calls += 1;
      observed.budget = currentBudget();
    }) as NextFunction);
    return observed;
  };

  // Break caught: a probe made to live inside a budget it does not need and that would fail a health check of a busy instance.
  it('does not give a probe a budget, and still runs it', () => {
    expect(call('/livez')).toEqual({ budget: undefined, calls: 1 });
    expect(call('/readyz')).toEqual({ budget: undefined, calls: 1 });
  });

  it('gives any other path one', () => {
    const { budget, calls } = call('/api/v1/anything');

    expect(calls).toBe(1);
    expect(budget).toBeDefined();
  });
});

describe('a chunked body does not spend the budget either', () => {
  it('is received first and budgeted after', async () => {
    const app = await start(runtime(1_000));
    const client = await RawClient.connect(app.baseUrl);
    clients.push(client);

    await client.write(
      head('POST /api/v1/fixture/budget HTTP/1.1', {
        Host: 'melarc.test',
        'Content-Type': 'application/json',
        'Transfer-Encoding': 'chunked',
      }),
    );
    await client.write(chunk('{"a":'));
    await sleep(400);
    await client.write(Buffer.concat([chunk('1}'), Buffer.from('0\r\n\r\n')]));
    const response = await client.read(3_000);

    expect(response.status).toBe(201);
    expect((response.json as unknown as Seen).remainingMs).toBeGreaterThan(850);
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PgDialect } from 'drizzle-orm/pg-core';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { ManualClock } from '../../../test-support/manual-clock.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { DELIVERY_WORKER_PRINCIPAL_ID } from '../delivery-parameters.js';
import {
  BACKSTOP_BATCH_SIZE,
  BACKSTOP_RUN_BUDGET_MS,
  FailureBackstop,
  MAX_BACKSTOP_ROUNDS,
  failureBackstopTask,
  type BackstopReport,
} from './failure-backstop.js';

/**
 * The failure backstop lane (S1.28; D-A1) without a database: the context it opens, the one function it calls and with what, the report it reads from the answer, and the task that
 * runs it on the worker's schedule (the rounds, the counters, what it says and what it keeps as the worker's health). What the function does to the rows is the database test's
 * (`failure-backstop.db.test.ts`).
 */
describe('the failure backstop’s call (the one function of migration 0084)', () => {
  const fakeDatabase = (answer: unknown) => {
    const seen: { context?: SecurityContext; statement?: { sql: string; params: unknown[] } } = {};
    return {
      seen,
      database: {
        transactionWithContext: <T>(
          context: SecurityContext,
          work: (tx: { execute: (statement: never) => Promise<{ rows: unknown[] }> }) => Promise<T>,
        ): Promise<T> => {
          seen.context = context;
          return work({
            execute: (statement) => {
              seen.statement = new PgDialect().sqlToQuery(statement);
              return Promise.resolve({ rows: answer === undefined ? [] : [answer] });
            },
          });
        },
      },
    };
  };

  // Break caught: the lane opened under another capability or principal, or asking for a batch that is not the one it was given, or calling another function.
  it('opens the backstop’s context, calls the function with the batch, and reads the report from its answer', async () => {
    const { seen, database } = fakeDatabase({
      out_escalated: 3,
      out_more: true,
      out_unusable_hubs: ['5eed0100-0000-4000-8000-000000000001'],
    });
    const backstop = new FailureBackstop({
      database: database as never,
      clock: new ManualClock(),
      batchSize: 40,
    });

    const report = await backstop.runOnce();

    expect(report).toEqual({
      escalated: 3,
      more: true,
      unusableHubs: ['5eed0100-0000-4000-8000-000000000001'],
    });
    expect(seen.context).toMatchObject({
      principalType: 'SYSTEM',
      principalId: DELIVERY_WORKER_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'pickup_backstop',
    });
    expect(seen.context?.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(seen.statement?.sql).toContain('melarc.failure_backstop_escalate(');
    expect(seen.statement?.params).toEqual([40]);
  });

  // Break caught: a null list of hubs (the function answers an empty array, but a driver may give null) taken for a failure, or an empty answer for a report.
  it('reads a null list of hubs as none, and an answer that is not there as a failure', async () => {
    const none = fakeDatabase({ out_escalated: 0, out_more: false, out_unusable_hubs: null });
    expect(
      await new FailureBackstop({
        database: none.database as never,
        clock: new ManualClock(),
      }).runOnce(),
    ).toEqual({ escalated: 0, more: false, unusableHubs: [] });
    const absent = fakeDatabase(undefined);
    await expect(
      new FailureBackstop({
        database: absent.database as never,
        clock: new ManualClock(),
      }).runOnce(),
    ).rejects.toThrow('gave no answer');
  });

  // Break caught: a batch no one meant (zero, fractional, above the function's own bound), which the function would refuse at run time.
  it.each([0, -1, 1.5, 1001])('refuses a batch of %s requests when it is made', (batchSize) => {
    expect(
      () => new FailureBackstop({ database: {} as never, clock: new ManualClock(), batchSize }),
    ).toThrow(RangeError);
  });

  // Break caught: a lane that reports a figure of hubs before it has looked (zero, which reads as "all judged"), or never again after a failed check.
  it('has no figure of unusable hubs until a check has run to its end', () => {
    const backstop = new FailureBackstop({ database: {} as never, clock: new ManualClock() });
    expect(backstop.unusableHubs).toBeUndefined();
    backstop.recordUnusable(2);
    expect(backstop.unusableHubs).toBe(2);
    backstop.recordUnusable(0);
    expect(backstop.unusableHubs).toBe(0);
  });
});

describe('the cadence is the worker’s configuration, never a constant in code (D-A1)', () => {
  // Break caught: the 15 minutes of the Product Owner written into the lane or into the worker's composition, where a configuration that says another value would be ignored.
  it('writes no cadence in the lane or in the composition of the worker', () => {
    for (const file of ['failure-backstop.ts', '../../../delivery-worker-runtime.ts']) {
      const text = readFileSync(resolve(import.meta.dirname, file), 'utf8');
      expect(text, file).not.toMatch(/\b15\s*\*\s*60/);
      expect(text, file).not.toMatch(/\b900_?000\b/);
    }
  });
});

describe('the failure backstop as a task of the worker', () => {
  const report = (over: Partial<BackstopReport> = {}): BackstopReport => ({
    escalated: 0,
    more: false,
    unusableHubs: [],
    ...over,
  });
  const arrange = (reports: (BackstopReport | Error)[], options: { maxRounds?: number } = {}) => {
    const answers = [...reports];
    const counted: string[] = [];
    const recorded: number[] = [];
    const info = vi.fn();
    const error = vi.fn();
    const backstop = {
      runOnce: vi.fn(() => {
        const next = answers.shift();
        if (next === undefined)
          throw new Error('the lane looked more often than the test expected');
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }),
      recordUnusable: (count: number) => void recorded.push(count),
    };
    const task = failureBackstopTask({
      backstop,
      logger: { info, error } as unknown as Logger,
      metrics: {
        increment: (name: string, labels?: Readonly<Record<string, string>>) =>
          void counted.push(labels === undefined ? name : `${name}:${labels.outcome ?? ''}`),
        observe: () => undefined,
      },
      intervalMs: 15 * 60_000,
      ...options,
    });
    return { task, backstop, counted, recorded, info, error };
  };

  // Break caught: a task that runs on another cadence than the one it was given (the 15 minutes are the worker's configuration), or with no budget of its own.
  it('runs on the cadence it is given, under a budget of its own', () => {
    const { task } = arrange([]);
    expect(task.name).toBe('failure-backstop');
    expect(task.intervalMs).toBe(15 * 60_000);
    expect(task.budgetMs).toBe(BACKSTOP_RUN_BUDGET_MS);
    expect(BACKSTOP_BATCH_SIZE).toBeLessThanOrEqual(1000);
  });

  // Break caught: a check that finds nothing and says something (noise every fifteen minutes for ever), or one that counts nothing.
  it('says nothing about a check that found nothing, and counts it as checked', async () => {
    const { task, counted, recorded, info, error } = arrange([report()]);
    await task.run(new AbortController().signal);
    expect(counted).toEqual(['pickup_backstop_runs_total:CHECKED']);
    expect(recorded).toEqual([0]);
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  // Break caught: a count of escalations that is not the lane's (counted once for a batch, not for each request), or a log that names a request.
  it('counts each request it escalated, goes on while the batch was full, and says how many, never which', async () => {
    const { task, counted, info, backstop } = arrange([
      report({ escalated: 100, more: true }),
      report({ escalated: 2 }),
    ]);
    await task.run(new AbortController().signal);

    expect(backstop.runOnce).toHaveBeenCalledTimes(2);
    expect(counted.filter((each) => each === 'pickup_backstop_escalations_total')).toHaveLength(
      102,
    );
    expect(counted.at(-1)).toBe('pickup_backstop_runs_total:CHECKED');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      { requests_escalated: 102 },
      'failure backstop escalated failures left undecided',
    );
  });

  // Break caught: a backlog that holds the lane for ever, or one that goes on after the worker was told to stop.
  it('takes no more rounds than the bound, and none after it was told to stop', async () => {
    const full = Array.from({ length: MAX_BACKSTOP_ROUNDS + 5 }, () =>
      report({ escalated: 1, more: true }),
    );
    const bounded = arrange(full);
    await bounded.task.run(new AbortController().signal);
    expect(bounded.backstop.runOnce).toHaveBeenCalledTimes(MAX_BACKSTOP_ROUNDS);

    const few = arrange(full, { maxRounds: 2 });
    await few.task.run(new AbortController().signal);
    expect(few.backstop.runOnce).toHaveBeenCalledTimes(2);

    const stopped = new AbortController();
    stopped.abort();
    const never = arrange([]);
    await never.task.run(stopped.signal);
    expect(never.backstop.runOnce).not.toHaveBeenCalled();
  });

  // Break caught: a hub the lane cannot judge that goes unsaid, or is said in words with no hub to look at, or kept as the figure of an earlier check.
  it('names the hubs it could not judge at error level, keeps their number as its health, and still counts the check', async () => {
    const { task, recorded, error, counted } = arrange([
      report({
        unusableHubs: [
          '5eed0100-0000-4000-8000-000000000001',
          'b0b0b0b0-0000-4000-8000-00000000000b',
        ],
      }),
    ]);
    await task.run(new AbortController().signal);

    expect(recorded).toEqual([2]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toEqual({
      hubs: ['5eed0100-0000-4000-8000-000000000001', 'b0b0b0b0-0000-4000-8000-00000000000b'],
    });
    expect(String(error.mock.calls[0]?.[1])).toContain('stale_failure_backstop_hours');
    expect(counted).toEqual(['pickup_backstop_runs_total:CHECKED']);
  });

  // Break caught: a check that raised counted as a good one, the failure swallowed (the worker's loop logs it only if it is raised), or a figure of health recorded by a check
  // that did not run to its end.
  it('counts a check that raised as failed, raises it again, and records no health', async () => {
    const { task, recorded, counted } = arrange([new Error('the database was away')]);
    await expect(task.run(new AbortController().signal)).rejects.toThrow('the database was away');
    expect(counted).toEqual(['pickup_backstop_runs_total:FAILED']);
    expect(recorded).toEqual([]);
  });
});

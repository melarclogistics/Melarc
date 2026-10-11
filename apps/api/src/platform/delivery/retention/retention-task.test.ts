import { describe, expect, it } from 'vitest';

import { SystemClock } from '../../auth/clock/system.clock.adapter.js';
import { createServiceLogger } from '../../logging/create-logger.js';
import { BoundedMetrics } from '../../metrics/bounded.metrics.adapter.js';
import { RETENTION_RUN_BUDGET_MS } from '../delivery-parameters.js';
import type { RetentionReport } from './retention-cleanup.js';
import { MAX_RETENTION_ROUNDS, retentionTask } from './retention-task.js';

const NONE = { jobsExpired: 0, replayErased: 0, leasesExpired: 0, more: false };
const noStop = (): AbortSignal => new AbortController().signal;

function rig(reports: (RetentionReport | Error)[], onRound?: (round: number) => void) {
  const calls: number[] = [];
  const raw: string[] = [];
  const queue = [...reports];
  const metrics = new BoundedMetrics({ policy: 'throw', clock: new SystemClock() });
  const task = retentionTask({
    cleanup: {
      runOnce: () => {
        onRound?.(calls.length);
        calls.push(calls.length);
        const next = queue.shift() ?? NONE;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
    metrics,
    logger: createServiceLogger({
      service: 'melarc-delivery-worker',
      level: 'debug',
      appEnv: 'local',
      destination: { write: (line: string) => void raw.push(line) },
    }),
    intervalMs: 1_234,
  });
  return {
    task,
    calls,
    leasesExpired: () =>
      metrics
        .snapshot()
        .counters.find((entry) => entry.name === 'credential_delivery_leases_expired_total')
        ?.value ?? 0,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('the retention task the delivery worker runs on a schedule (S0.19)', () => {
  // Break caught: a task that is not named or does not say how often it runs, which the worker's loop needs.
  it('is named, and carries the interval it was given', () => {
    const { task } = rig([]);

    expect(task.name).toBe('retention');
    expect(task.intervalMs).toBe(1_234);
  });

  // Break caught: a run with no budget of its own, so that nothing but the server's limits bounds its transactions and nothing cancels
  // them at a stop.
  it('carries the longest a run may take, which is the budget its transactions run under', () => {
    const { task } = rig([]);

    expect(task.budgetMs).toBe(RETENTION_RUN_BUDGET_MS);
    expect(RETENTION_RUN_BUDGET_MS).toBe(30_000);
  });

  // Break caught: a run that goes on with its rounds after the worker has been told to stop, holding the shutdown for the rest of them.
  it('leaves off between rounds when the worker is told to stop', async () => {
    const stop = new AbortController();
    const full = { jobsExpired: 200, replayErased: 0, leasesExpired: 0, more: true };
    const { task, calls } = rig([full, full, full], (round) => {
      if (round === 1) stop.abort();
    });

    await task.run(stop.signal);

    expect(calls).toHaveLength(2);
  });

  // Break caught: the leases that ended with no outcome on jobs the cleanup then expired never being counted, though no takeover will
  // ever come for them.
  it('counts the leases that ended on the jobs it expired', async () => {
    const { task, leasesExpired } = rig([
      { jobsExpired: 200, replayErased: 0, leasesExpired: 3, more: true },
      { jobsExpired: 4, replayErased: 0, leasesExpired: 1, more: false },
    ]);

    await task.run(noStop());

    expect(leasesExpired()).toBe(4);
  });

  // Break caught: a backlog cleared one batch a minute (an hour for ten thousand rows), or a run that stops at the first batch.
  it('runs again at once while a batch was full, and stops when one was not', async () => {
    const full = { jobsExpired: 200, replayErased: 0, leasesExpired: 0, more: true };
    const last = { jobsExpired: 7, replayErased: 3, leasesExpired: 0, more: false };
    const { task, calls } = rig([full, full, last, full]);

    await task.run(noStop());

    expect(calls).toHaveLength(3);
  });

  // Break caught: a cleanup that never gets to the end (rows arriving as fast as they go) holding the task for ever.
  it('stops after the most rounds one run may take, however much there is', async () => {
    const full = { jobsExpired: 200, replayErased: 200, leasesExpired: 0, more: true };
    const { task, calls } = rig(Array.from({ length: MAX_RETENTION_ROUNDS + 10 }, () => full));

    await task.run(noStop());

    expect(calls).toHaveLength(MAX_RETENTION_ROUNDS);
  });

  // Break caught: a quiet worker that logs every minute, or one that erases material and says nothing: the line is the operator's
  // account that expired credential material was removed, with counts and nothing else.
  it('says what it erased, with counts and nothing else, and says nothing when there was nothing', async () => {
    const quiet = rig([NONE]);
    await quiet.task.run(noStop());
    const busy = rig([
      { jobsExpired: 200, replayErased: 0, leasesExpired: 0, more: true },
      { jobsExpired: 5, replayErased: 2, leasesExpired: 0, more: false },
    ]);
    await busy.task.run(noStop());

    expect(quiet.lines()).toEqual([]);
    expect(busy.lines()).toHaveLength(1);
    expect(busy.lines()[0]).toMatchObject({
      level: 'info',
      msg: 'delivery retention erased expired material',
      jobs_expired: 205,
      replay_erased: 2,
    });
  });

  // Break caught: a failure swallowed (the loop must see it to log it and try again), or the round count continuing after one.
  it('raises the failure of a round, and does not go on', async () => {
    const { task, calls } = rig([
      { jobsExpired: 200, replayErased: 0, leasesExpired: 0, more: true },
      new Error('the database is gone'),
      { jobsExpired: 1, replayErased: 0, leasesExpired: 0, more: false },
    ]);

    await expect(task.run(noStop())).rejects.toThrow('the database is gone');

    expect(calls).toHaveLength(2);
  });
});

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ManualClock } from '../../test-support/manual-clock.js';
import { createServiceLogger } from '../logging/create-logger.js';
import {
  EVIDENCE_SWEEP_BATCH_SIZE,
  EVIDENCE_SWEEP_INTERVAL_MS,
  EVIDENCE_SWEEP_RUN_BUDGET_MS,
  EvidenceSweep,
  MAX_EVIDENCE_SWEEP_ROUNDS,
  evidenceSweepTask,
  expireAbandonedEvidenceStatement,
  type EvidenceSweepReport,
} from './evidence-sweep.js';

const NONE: EvidenceSweepReport = { expired: 0, more: false };

function logger() {
  const raw: string[] = [];
  return {
    logger: createServiceLogger({
      service: 'melarc-delivery-worker',
      level: 'debug',
      appEnv: 'local',
      destination: { write: (line: string) => void raw.push(line) },
    }),
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function rig(reports: (EvidenceSweepReport | Error)[], maxRounds?: number) {
  const queue = [...reports];
  let calls = 0;
  const { logger: log, lines } = logger();
  const task = evidenceSweepTask({
    sweep: {
      runOnce: () => {
        calls += 1;
        const next = queue.shift() ?? NONE;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
    logger: log,
    intervalMs: 4_321,
    ...(maxRounds === undefined ? {} : { maxRounds }),
  });
  return { task, calls: () => calls, lines };
}

const running = (): AbortSignal => new AbortController().signal;

describe('the evidence sweep task the delivery worker runs on a schedule (S1.11)', () => {
  // Break caught: a task the worker cannot name, or one that ignores the interval it was given.
  it('is named, and carries the interval it was given and the budget a run may take', () => {
    const { task } = rig([]);
    expect(task.name).toBe('evidence');
    expect(task.intervalMs).toBe(4_321);
    expect(task.budgetMs).toBe(EVIDENCE_SWEEP_RUN_BUDGET_MS);
    expect(
      evidenceSweepTask({
        sweep: { runOnce: () => Promise.resolve(NONE) },
        logger: logger().logger,
      }).intervalMs,
    ).toBe(EVIDENCE_SWEEP_INTERVAL_MS);
  });

  // Break caught: a run that stops after the first full batch and leaves a backlog for the next minute, or one that never stops.
  it('goes on while a batch was full and stops at the first that was not', async () => {
    const { task, calls, lines } = rig([
      { expired: 200, more: true },
      { expired: 200, more: true },
      { expired: 7, more: false },
      { expired: 99, more: false },
    ]);
    await task.run(running());
    expect(calls()).toBe(3);
    expect(
      lines().filter((line) => line.msg === 'evidence sweep expired abandoned captures'),
    ).toEqual([expect.objectContaining({ evidence_expired: 407 })]);
  });

  it('takes at most the rounds it is allowed, however much it finds', async () => {
    const { task, calls } = rig(Array.from({ length: 50 }, () => ({ expired: 200, more: true })));
    await task.run(running());
    expect(calls()).toBe(MAX_EVIDENCE_SWEEP_ROUNDS);
    const few = rig(
      Array.from({ length: 50 }, () => ({ expired: 200, more: true })),
      3,
    );
    await few.task.run(running());
    expect(few.calls()).toBe(3);
  });

  // Break caught: a worker told to stop that goes on sweeping.
  it('leaves off when the worker is told to stop, before a round and between rounds', async () => {
    const before = rig([{ expired: 1, more: true }]);
    const stopped = new AbortController();
    stopped.abort();
    await before.task.run(stopped.signal);
    expect(before.calls()).toBe(0);

    const between = new AbortController();
    let rounds = 0;
    const { logger: log } = logger();
    const task = evidenceSweepTask({
      sweep: {
        runOnce: () => {
          rounds += 1;
          between.abort();
          return Promise.resolve({ expired: 200, more: true });
        },
      },
      logger: log,
    });
    await task.run(between.signal);
    expect(rounds).toBe(1);
  });

  // Break caught: a run that logs every minute whether or not it found anything, or one that logs what it found as text.
  it('says nothing when it found nothing, and a count when it did', async () => {
    const quiet = rig([NONE]);
    await quiet.task.run(running());
    expect(quiet.lines()).toEqual([]);
    const busy = rig([{ expired: 2, more: false }]);
    await busy.task.run(running());
    expect(busy.lines()).toEqual([expect.objectContaining({ level: 'info', evidence_expired: 2 })]);
  });

  // Break caught: a failure swallowed, so that the worker's loop never logs it nor tries again at the next interval.
  it('raises the failure of a round for the worker’s loop', async () => {
    const { task } = rig([new Error('the database went away')]);
    await expect(task.run(running())).rejects.toThrow('the database went away');
  });
});

describe('EvidenceSweep: one short transaction as the system under the evidence_validation capability', () => {
  function database(rowCount: number | null | undefined) {
    const seen: { context: unknown; text: string; params: unknown[] }[] = [];
    return {
      seen,
      service: {
        transactionWithContext: <T>(
          context: unknown,
          work: (tx: {
            execute: (query: unknown) => Promise<{ rowCount?: number | null }>;
          }) => Promise<T>,
        ): Promise<T> =>
          work({
            execute: (query) => {
              const built = new PgDialect().sqlToQuery(
                query as Parameters<PgDialect['sqlToQuery']>[0],
              );
              seen.push({ context, text: built.sql, params: built.params });
              return Promise.resolve({ rowCount });
            },
          }),
      },
    };
  }

  // Break caught: a sweep that opens another capability, or any principal but the system.
  it('opens the system context under the capability and nothing else', async () => {
    const { seen, service } = database(3);
    const report = await new EvidenceSweep({
      database: service as never,
      clock: new ManualClock(),
    }).runOnce();
    expect(report).toEqual({ expired: 3, more: false });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.context).toMatchObject({
      principalType: 'SYSTEM',
      surface: 'SYSTEM',
      taskCapability: 'evidence_validation',
    });
  });

  // Break caught: a batch that is not the one asked for, so a full batch is not reported and the task never goes on.
  it('reports a full batch as more to do, and a missing count as none', async () => {
    const full = database(2);
    expect(
      await new EvidenceSweep({
        database: full.service as never,
        clock: new ManualClock(),
        batchSize: 2,
      }).runOnce(),
    ).toEqual({ expired: 2, more: true });
    expect(full.seen[0]?.params).toContain(2);
    const missing = database(undefined);
    expect(
      await new EvidenceSweep({
        database: missing.service as never,
        clock: new ManualClock(),
      }).runOnce(),
    ).toEqual({ expired: 0, more: false });
  });

  it('refuses a batch that is not a whole number of rows', () => {
    for (const batchSize of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new EvidenceSweep({ database: {} as never, clock: new ManualClock(), batchSize }),
      ).toThrow(RangeError);
    }
    expect(EVIDENCE_SWEEP_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe('expireAbandonedEvidenceStatement', () => {
  const text = new PgDialect().sqlToQuery(expireAbandonedEvidenceStatement(5)).sql;

  // Break caught: a statement that touches a stored record, one that expires a window still open, one that waits for a row another sweep holds, or one that writes more
  // than the state.
  it('marks pending records whose window has closed, skipping locked rows, and writes the state alone', () => {
    expect(text).toContain(`state = 'PENDING_UPLOAD'`);
    expect(text).toContain('upload_expires_at <= statement_timestamp()');
    expect(text).toContain('for update skip locked');
    expect(text).toMatch(/set state = 'EXPIRED'\s+from due/);
    expect(text).not.toMatch(/delete|truncate/i);
    expect(text.match(/\bset\b/g)).toHaveLength(1);
  });
});

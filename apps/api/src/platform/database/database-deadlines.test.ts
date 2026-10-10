import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import {
  fakeCanceller,
  FakeConnection,
  FakePool,
  serverError,
  testRuntime,
  type FakeCanceller,
} from '../../test-support/fake-pg.js';
import { ManualClock } from '../../test-support/manual-clock.js';
import type { DatabaseDeadlines } from '../config/load-config.js';
import {
  BudgetClosedError,
  BudgetExpiredError,
  ExecutionBudget,
  currentBudget,
  runWithBudget,
} from '../execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../execution/execution-parameters.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { AcquireTimeoutError, PoolClosedError, PoolSaturatedError } from './connection-queue.js';
import { DatabaseService } from './database.service.js';
import {
  CommitOutcomeUnknownError,
  DatabaseDeadlineError,
  TransactionRolledBackError,
  serverErrorIn,
} from './database-failures.js';
import { POSTURE_FLAGS } from './role-posture.js';
import type { SecurityContext } from './transaction-context.js';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'unit-test',
};

let clock: ManualClock;

beforeEach(() => {
  vi.useFakeTimers();
  clock = new ManualClock();
});

afterEach(() => {
  vi.useRealTimers();
});

function build(
  options: {
    deadlines?: Partial<DatabaseDeadlines>;
    poolMax?: number;
    canceller?: FakeCanceller;
  } = {},
) {
  const pool = new FakePool();
  const logs = new CapturedLogs();
  const canceller = options.canceller ?? fakeCanceller();
  const service = new DatabaseService(
    pool as unknown as Pool,
    logs.logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    testRuntime({
      clock,
      canceller,
      ...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
      ...(options.poolMax === undefined ? {} : { poolMax: options.poolMax }),
    }),
  );
  return { pool, logs, canceller, service };
}

/** Real time passing for the manual clock and the fake timers together, with the promise callbacks it triggers. */
async function pass(milliseconds: number): Promise<void> {
  // What was started has taken its connection and made its budget before time moves.
  await vi.advanceTimersByTimeAsync(0);
  clock.advance(milliseconds);
  await vi.advanceTimersByTimeAsync(milliseconds);
}

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** A unit of work that issues one statement the connection leaves unanswered, as a statement that is still running. */
const runningStatement = (tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }) =>
  tx.execute(sql`select 1 as work`);

describe('DatabaseService: what the server is told (SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: the server's own transaction bound dropped, or set to the budget itself so that it kills the session before the
  // process-side cancellation and rollback have run. It is the budget plus the disposal bound: a bound for when this process
  // cannot clean up.
  it('bounds the transaction on the server by the transaction time plus the disposal bound', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection({ role: 'melarc_api_runtime' });
    pool.hand(connection);

    await service.transactionWithContext(STAFF, () => Promise.resolve());

    expect(connection.statements[0]).toBe(
      `begin; select set_config('transaction_timeout', '${String(10_000 + DISPOSAL_BOUND_MS)}ms', true)`,
    );
  });

  // Break caught: a transaction inside a request that is allowed longer than the request has left.
  it('bounds it by what the request has left when that is less', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection();
    pool.hand(connection);
    const request = new ExecutionBudget(clock, 'request', 3_000);
    await pass(500);

    await runWithBudget(request, () =>
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    );

    expect(connection.statements[0]).toBe(
      `begin; select set_config('transaction_timeout', '${String(2_500 + DISPOSAL_BOUND_MS)}ms', true)`,
    );
    request.finish();
  });
});

describe('DatabaseService: a budget that expires mid-work (OB-37)', () => {
  // Break caught: a timeout that stops awaiting while the statement goes on in the database, the transaction stays open and the
  // connection goes back to the pool.
  it('cancels the running statement, rolls the transaction back, destroys the connection, and tells the caller', async () => {
    const { pool, service, canceller, logs } = build();
    const connection = new FakeConnection().hang(/select 1 as work/);
    canceller.cancel.mockImplementation(() => {
      connection.rejectPending(serverError('57014', 'canceling statement due to user request'));
      return Promise.resolve('signalled');
    });
    pool.hand(connection);

    const outcome = settled(service.transactionWithContext(STAFF, runningStatement));
    await pass(9_999);
    expect(connection.pending).toHaveLength(1);
    expect(canceller.cancel).not.toHaveBeenCalled();
    await pass(1);

    const result = await outcome;
    expect(result).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect((result as { error: BudgetExpiredError }).error.label).toBe('transaction');
    expect(canceller.cancel).toHaveBeenCalledExactlyOnceWith(4242);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.statements).not.toContain('commit');
    expect(connection.destroyed).toBe(true);
    expect(
      logs.records().find((record) => String(record.msg).includes('budget ran out')),
    ).toMatchObject({
      level: 'warn',
      phase: 'working',
      cancel: 'signalled',
      rolledBack: true,
    });
  });

  // Break caught: a budget that expires while the work waits on something that is not the database (an outbound call, a hash),
  // where there is no statement to cancel but the transaction is still open and holds its locks.
  it('rolls back and destroys when the work is outside the database, cancels nothing, and never commits what finishes late', async () => {
    const { pool, service, canceller, logs } = build();
    const connection = new FakeConnection();
    pool.hand(connection);
    let finish: () => void = () => undefined;
    const outsideWork = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const outcome = settled(
      service.transactionWithContext(STAFF, async () => {
        await outsideWork;
        return 'finished late';
      }),
    );
    await pass(10_000);

    expect(Object.hasOwn(await outcome, 'error')).toBe(true);
    expect(canceller.cancel).not.toHaveBeenCalled();
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.destroyed).toBe(true);

    // The work finishes after the caller was told it failed: nothing is committed, and the lateness is logged.
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.statements).not.toContain('commit');
    expect(
      logs
        .records()
        .some((record) => String(record.msg).includes('finished after its budget ran out')),
    ).toBe(true);
  });

  // Break caught: work that goes on issuing statements after the caller was told the request failed, on a connection that is gone
  // or, worse, one the pool has handed to another request.
  it('refuses a statement the work issues after the budget expired: it never reaches a connection', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection();
    pool.hand(connection);
    let proceed: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    let lateStatement: Promise<unknown> | undefined;

    const outcome = settled(
      service.transactionWithContext(STAFF, async (tx) => {
        await gate;
        lateStatement = tx.execute(sql`select 2 as late`).catch((error: unknown) => error);
      }),
    );
    await pass(10_000);
    await outcome;
    const statementsAtExpiry = [...connection.statements];
    proceed();
    await vi.advanceTimersByTimeAsync(0);

    const late = (await lateStatement) as { cause?: unknown };
    expect(late.cause).toBeInstanceOf(BudgetExpiredError);
    expect(connection.statements).toEqual(statementsAtExpiry);
  });

  // Break caught: the work finishing in the instant after the budget ran out, before the timer was seen, and being committed.
  it('does not commit when the budget has run out by the time the work finishes', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection();
    pool.hand(connection);

    const outcome = settled(
      service.transactionWithContext(STAFF, () => {
        // The clock has passed the deadline; no timer has run.
        clock.advance(10_000);
        return Promise.resolve('done');
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(await outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect(connection.statements).not.toContain('commit');
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: a transaction bounded only by the database's own timeouts, outliving the request that opened it.
  it('is bounded by the request budget when that is shorter, and names it', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().hang(/select 1 as work/);
    pool.hand(connection);
    const request = new ExecutionBudget(clock, 'request', 3_000);

    const outcome = settled(
      runWithBudget(request, () => service.transactionWithContext(STAFF, runningStatement)),
    );
    await pass(3_000);

    const result = (await outcome) as { error: BudgetExpiredError };
    expect(result.error).toBeInstanceOf(BudgetExpiredError);
    expect(result.error.label).toBe('request');
    expect(connection.destroyed).toBe(true);
    request.finish();
  });

  // Break caught: a request whose budget has already run out starting a transaction at all.
  it('takes no connection for a request whose budget has already run out', async () => {
    const { pool, service } = build();
    const request = new ExecutionBudget(clock, 'request', 1_000);
    await pass(1_000);

    await expect(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    ).rejects.toBeInstanceOf(BudgetExpiredError);

    expect(pool.connect).not.toHaveBeenCalled();
    request.finish();
  });

  // Break caught (F05): a continuation that kept the scope of a request that was answered beginning a transaction, with a fresh
  // budget of its own and no request behind it.
  it('takes no connection for a request whose budget has finished, and says it is closed', async () => {
    const { pool, service } = build();
    const request = new ExecutionBudget(clock, 'request', 10_000);
    request.finish();

    const failure = await runWithBudget(request, () =>
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BudgetClosedError);
    expect(failure).not.toBeInstanceOf(BudgetExpiredError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  // Break caught (F05): the connection a transaction was waiting for, taken after its request was finished, and never given back
  // because the refusal came after it was held. It goes back as it came, with nothing sent on it, and the permit with it.
  it('gives the connection back when the request is finished while the transaction waits for one', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const first = new FakeConnection();
    const second = new FakeConnection();
    const third = new FakeConnection();
    pool.hand(first, second, third);
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    await vi.advanceTimersByTimeAsync(0);
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const waiter = settled(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    );
    await vi.advanceTimersByTimeAsync(0);

    request.finish();
    finish();
    await one;

    expect(((await waiter) as { error: unknown }).error).toBeInstanceOf(BudgetClosedError);
    expect(second.statements).toEqual([]);
    expect(second.release).toHaveBeenCalledOnce();
    expect(second.destroyed).toBe(false);
    // The permit went back too: the next transaction is served.
    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('next')),
    ).resolves.toBe('next');
  });

  // Break caught (F05, review): the transaction's budget is a child of the request's, and closure stopped at the request: work that
  // outlived its request kept a child that still authorized an outbound call or an enqueue after the request was answered.
  it('refuses an effect of work that outlives its request: the transaction budget is closed with the request', async () => {
    const { pool, service } = build();
    pool.hand(new FakeConnection());
    const request = new ExecutionBudget(clock, 'request', 10_000);
    const action = vi.fn(() => Promise.resolve('sent'));
    let proceed: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });

    const outcome = settled(
      runWithBudget(request, () =>
        service.transactionWithContext(STAFF, async () => {
          await gate;
          return currentBudget()?.effect('send the message', action);
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    request.finish();
    proceed();

    const result = (await outcome) as { error: unknown };
    expect(result.error).toBeInstanceOf(BudgetClosedError);
    expect(result.error).not.toBeInstanceOf(BudgetExpiredError);
    expect(action).not.toHaveBeenCalled();
  });

  // Break caught: a cleanup that waits for ever on a database that does not answer, so the caller is never told.
  it('bounds its own cleanup: a cancel that fails and a rollback that hangs still end in the connection destroyed', async () => {
    const { pool, service, canceller } = build({ canceller: fakeCanceller('failed') });
    const connection = new FakeConnection().hang(/select 1 as work/).hang(/^rollback/);
    pool.hand(connection);

    const outcome = settled(service.transactionWithContext(STAFF, runningStatement));
    await pass(10_000);
    let done = false;
    void outcome.then(() => {
      done = true;
    });
    await pass(DISPOSAL_BOUND_MS - 1);
    expect(done).toBe(false);
    await pass(1);

    expect(await outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect(canceller.cancel).toHaveBeenCalledOnce();
    expect(connection.destroyed).toBe(true);
  });

  // Break caught (F04B): a rollback sent after the clean-up's bound had passed, on a connection that is being destroyed at that
  // moment. The clean-up has one budget for the cancel and the rollback together; the rollback is not given a fresh one.
  it('sends no rollback once the clean-up bound has passed while the cancel was being made', async () => {
    const canceller = fakeCanceller();
    canceller.cancel.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve('failed');
          }, DISPOSAL_BOUND_MS);
        }),
    );
    const { pool, service } = build({ canceller });
    const connection = new FakeConnection().hang(/select 1 as work/);
    pool.hand(connection);

    const outcome = settled(service.transactionWithContext(STAFF, runningStatement));
    await pass(10_000);
    await pass(DISPOSAL_BOUND_MS);
    await pass(0);

    expect(await outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect(canceller.cancel).toHaveBeenCalledOnce();
    expect(connection.destroyed).toBe(true);
    expect(connection.statements).not.toContain('rollback');
  });

  // Break caught: a connection without a process id cannot be asked to cancel; the statement is bounded by the server's timeouts
  // and the connection is destroyed, and nothing throws.
  it('destroys a connection it cannot name to the server, without trying to cancel it', async () => {
    const { pool, service, canceller } = build();
    const connection = new FakeConnection({ processID: null })
      .hang(/select 1 as work/)
      .hang(/^rollback/);
    pool.hand(connection);

    const outcome = settled(service.transactionWithContext(STAFF, runningStatement));
    await pass(10_000);
    await pass(DISPOSAL_BOUND_MS);

    expect(await outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect(canceller.cancel).not.toHaveBeenCalled();
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: connection reuse after an expiry, where the next request lands on the connection that was abandoned.
  it('gives the next transaction a different connection, and returns that one to the pool when it succeeds', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const first = new FakeConnection().hang(/select 1 as work/);
    const second = new FakeConnection({ processID: 5252 });
    pool.hand(first, second);

    const expired = settled(service.transactionWithContext(STAFF, runningStatement));
    await pass(10_000);
    await expired;
    expect(first.destroyed).toBe(true);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('fine')),
    ).resolves.toBe('fine');

    expect(second.statements).toContain('commit');
    expect(second.release).toHaveBeenCalledOnce();
    expect(second.destroyed).toBe(false);
    expect(first.release).toHaveBeenCalledOnce();
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });
});

describe('DatabaseService: the clean-up of an ordinary failure is bounded too', () => {
  // Break caught: a work failure whose rollback never answers (a hung connection), leaving the caller waiting for ever and the
  // connection held.
  it('tells the caller the original failure after the disposal bound when the rollback hangs, and destroys the connection', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().hang(/^rollback/);
    pool.hand(connection);
    const failure = new Error('work failed');

    const outcome = settled(service.transactionWithContext(STAFF, () => Promise.reject(failure)));
    await pass(DISPOSAL_BOUND_MS - 1);
    let done = false;
    void outcome.then(() => {
      done = true;
    });
    await pass(0);
    expect(done).toBe(false);
    await pass(1);

    expect(await outcome).toEqual({ error: failure });
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: a request that expires in the instant between getting a connection and beginning, and a BEGIN sent anyway on
  // a connection that is about to be thrown away. The connection that arrived after the deadline is not handed over (F04A);
  // nothing was sent on it, so it goes back to the pool as it came, and with it the permit.
  it('sends nothing at all to a connection for a request that expired while it was getting one', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const connection = new FakeConnection();
    const request = new ExecutionBudget(clock, 'request', 1_000);
    pool.connect.mockImplementationOnce(() => {
      // The request runs out while the connection is being made.
      clock.advance(1_000);
      return Promise.resolve(connection);
    });

    const outcome = await settled(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    );

    expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
    expect(connection.statements).toEqual([]);
    expect(connection.release).toHaveBeenCalledExactlyOnceWith();
    pool.hand(new FakeConnection());
    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('next')),
    ).resolves.toBe('next');
    request.finish();
  });
});

describe('DatabaseService: an uncertain commit outcome (OB-37)', () => {
  // Break caught: a budget that expires with COMMIT in flight reported as a failure that rolled back, which invites a retry
  // of work that may have committed.
  it('reports the outcome as unknown when the budget expires with the commit in flight, and says nothing about rollback', async () => {
    const { pool, service, canceller } = build();
    const connection = new FakeConnection().hang(/^commit/);
    pool.hand(connection);

    const outcome = settled(service.transactionWithContext(STAFF, () => Promise.resolve('work')));
    await pass(10_000);

    const result = (await outcome) as { error: CommitOutcomeUnknownError };
    expect(result.error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(result.error.reason).toBe('budget-expired');
    expect(result.error.cause).toBeInstanceOf(BudgetExpiredError);
    expect(result.error.message).toMatch(/may or may not have committed/);
    expect(result.error.message).not.toMatch(/rolled back/i);
    // A rollback after a commit that may have happened would claim something nobody knows; a cancel cannot undo a commit.
    expect(connection.statements.at(-1)).toMatch(/^commit/);
    expect(canceller.cancel).not.toHaveBeenCalled();
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: a connection lost during COMMIT reported as an ordinary failure.
  it('reports the outcome as unknown when the connection is lost during the commit', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().fail(
      /^commit/,
      new Error('Connection terminated unexpectedly'),
    );
    pool.hand(connection);

    const result = (await settled(
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    )) as { error: CommitOutcomeUnknownError };

    expect(result.error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(result.error.reason).toBe('connection-lost');
    expect(result.error.cause).toMatchObject({ message: 'Connection terminated unexpectedly' });
    expect(connection.statements).not.toContain('rollback');
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: a FATAL error from the server during COMMIT (the backend is going away) treated as a definite refusal.
  it('reports the outcome as unknown when the server ends the session during the commit', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().fail(
      /^commit/,
      serverError('57P01', 'terminating connection due to administrator command', 'FATAL'),
    );
    pool.hand(connection);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
  });

  // Break caught: a commit the server refused (a serialization failure) reported as unknown, so a safe retry is withheld, or
  // as anything but the server's own error.
  it('reports a commit the server refused as that refusal: the transaction did not commit', async () => {
    const { pool, service } = build();
    const refusal = serverError('40001', 'could not serialize access');
    const connection = new FakeConnection().fail(/^commit/, refusal);
    pool.hand(connection);

    const result = (await settled(
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    )) as { error: unknown };

    expect(result.error).toBe(refusal);
    expect(connection.destroyed).toBe(true);
  });
});

describe('DatabaseService: the answer to COMMIT is read (correction F01)', () => {
  /** Work that runs a statement the server refuses, catches the refusal, and goes on to return a success-shaped value. */
  const carriesOn = async (tx: {
    execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
  }) => {
    try {
      await tx.execute(sql`select 1/0 as division`);
    } catch {
      // the work goes on, as if nothing had happened
    }
    return { saved: true };
  };

  // Break caught: a COMMIT of a failed transaction completed by the server as ROLLBACK (with no error), reported as success. The
  // work caught the statement error and went on, so the caller was told its rows were saved when nothing was.
  it('rejects, as a definite failure, when the server completes COMMIT as ROLLBACK, and keeps the statement error that caused it', async () => {
    const { pool, service } = build();
    const failure = serverError('22012', 'division by zero');
    const connection = new FakeConnection()
      .fail(/division/, failure)
      .completeWith(/^commit/, 'ROLLBACK');
    pool.hand(connection);

    const result = (await settled(service.transactionWithContext(STAFF, carriesOn))) as {
      value?: unknown;
      error?: unknown;
    };

    expect(result.value).toBeUndefined();
    expect(result.error).toBeInstanceOf(TransactionRolledBackError);
    // A definite failure: it is not the unknown outcome, which would withhold a safe retry and invite an unsafe one.
    expect(result.error).not.toBeInstanceOf(CommitOutcomeUnknownError);
    expect((result.error as Error).message).toMatch(/rolled back/);
    // The original error is the cause, so a log line says why.
    expect(serverErrorIn(result.error)?.code).toBe('22012');
    // The server confirmed the rollback: nothing more is sent, and a transaction that failed at its commit is not trusted again.
    expect(connection.statements.at(-1)).toBe('commit');
    expect(connection.statements).not.toContain('rollback');
    expect(connection.destroyed).toBe(true);
  });

  // The same answer with no statement failure for the service to have seen: it is still no commit.
  it('rejects the same way when no statement failure was seen', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().completeWith(/^commit/, 'ROLLBACK');
    pool.hand(connection);

    const error = (await settled(
      service.transactionWithContext(STAFF, () => Promise.resolve('x')),
    )) as {
      error: TransactionRolledBackError;
    };

    expect(error.error).toBeInstanceOf(TransactionRolledBackError);
    expect(error.error.cause).toBeUndefined();
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: the new error caught by the handler of a failed COMMIT and made into an unknown outcome, so a transaction the
  // server rolled back is described as one that may have committed.
  it('does not report the rollback as an uncertain commit, and does not report an ordinary commit as a rollback', async () => {
    const { pool, service } = build();
    const rolledBack = new FakeConnection().completeWith(/^commit/, 'ROLLBACK');
    const committed = new FakeConnection();
    pool.hand(rolledBack, committed);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve(1)),
    ).rejects.toMatchObject({
      name: 'TransactionRolledBackError',
    });
    await expect(service.transactionWithContext(STAFF, () => Promise.resolve(2))).resolves.toBe(2);
    expect(committed.destroyed).toBe(false);
  });

  // Break caught: an answer that is not a COMMIT's taken for one. A missing result and a command tag of something else say
  // nothing about the commit, so the outcome is unknown, and the connection is not trusted.
  it.each([
    ['no result at all', (connection: FakeConnection) => connection.answerNothing(/^commit/)],
    [
      'no command tag',
      (connection: FakeConnection) => connection.completeWith(/^commit/, undefined),
    ],
    [
      'a command tag of another statement',
      (connection: FakeConnection) => connection.completeWith(/^commit/, 'SELECT'),
    ],
    [
      'an empty command tag',
      (connection: FakeConnection) => connection.completeWith(/^commit/, ''),
    ],
  ])('treats %s as an unknown outcome, never as success', async (_label, arrange) => {
    const { pool, service } = build();
    const connection = arrange(new FakeConnection());
    pool.hand(connection);

    const result = (await settled(
      service.transactionWithContext(STAFF, () => Promise.resolve('work')),
    )) as { value?: unknown; error?: CommitOutcomeUnknownError };

    expect(result.value).toBeUndefined();
    expect(result.error).toBeInstanceOf(CommitOutcomeUnknownError);
    expect(result.error?.reason).toBe('unrecognized-completion');
    expect(result.error?.message).toMatch(/may or may not have committed/);
    expect(connection.destroyed).toBe(true);
  });

  // The ordinary commit, which these checks must not disturb.
  it('still returns the work’s value, and the connection to the pool, when the server completes COMMIT as COMMIT', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection();
    pool.hand(connection);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('work')),
    ).resolves.toBe('work');
    expect(connection.destroyed).toBe(false);
  });
});

describe('DatabaseService: the database’s own timeouts (SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: a lock, statement, idle-in-transaction or transaction timeout surfacing as a bare driver error that each
  // caller must recognise by SQLSTATE; or the connection that raised it going back to the pool.
  it.each([
    ['55P03', 'lock'],
    ['57014', 'statement'],
    ['25P03', 'idle-in-transaction'],
    ['25P04', 'transaction'],
  ] as const)(
    'raises a DatabaseDeadlineError for SQLSTATE %s (%s), rolls back, and destroys the connection',
    async (code, kind) => {
      const { pool, service } = build();
      const raised = serverError(code);
      const connection = new FakeConnection().fail(/select 1 as work/, raised);
      pool.hand(connection);

      const result = (await settled(service.transactionWithContext(STAFF, runningStatement))) as {
        error: DatabaseDeadlineError;
      };

      expect(result.error).toBeInstanceOf(DatabaseDeadlineError);
      expect(result.error.kind).toBe(kind);
      expect(result.error.code).toBe(code);
      // drizzle wraps what a connection throws; the server's error is still the root cause.
      let root: unknown = result.error;
      while (root instanceof Error && root.cause !== undefined) root = root.cause;
      expect(root).toBe(raised);
      expect(connection.statements.at(-1)).toBe('rollback');
      // The rollback worked, and the connection is still not trusted: a timeout is a sign of a connection in trouble.
      expect(connection.destroyed).toBe(true);
    },
  );

  // Break caught: every failure treated as a timeout, destroying healthy connections, or a unique violation reported as one.
  it('leaves an ordinary database error alone: rolled back, the connection kept', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().fail(/select 1 as work/, serverError('23505'));
    pool.hand(connection);

    const result = (await settled(service.transactionWithContext(STAFF, runningStatement))) as {
      error: unknown;
    };

    expect(result.error).not.toBeInstanceOf(DatabaseDeadlineError);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.destroyed).toBe(false);
  });

  // Break caught: a session ended by the server for idling in a transaction reported only as "connection terminated".
  it('names the idle-in-transaction timeout when the server ended the session before the next statement', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection().fail(
      /select 1 as work/,
      new Error('Connection terminated unexpectedly'),
    );
    pool.hand(connection);

    const outcome = settled(
      service.transactionWithContext(STAFF, async (tx) => {
        // The server ends the session; the driver emits the FATAL error on the connection, and the next statement fails.
        connection.emit(
          'error',
          serverError(
            '25P03',
            'terminating connection due to idle-in-transaction timeout',
            'FATAL',
          ),
        );
        await runningStatement(tx);
      }),
    );

    const result = (await outcome) as { error: DatabaseDeadlineError };
    expect(result.error).toBeInstanceOf(DatabaseDeadlineError);
    expect(result.error.kind).toBe('idle-in-transaction');
    expect(connection.destroyed).toBe(true);
  });

  // Break caught: the driver's "connection terminated" arriving before (or after) the server's own explanation and hiding it.
  it('keeps the server’s explanation of why it ended the session over the driver’s generic error, in either order', async () => {
    for (const order of ['driver first', 'server first'] as const) {
      const { pool, service } = build();
      const connection = new FakeConnection().fail(
        /select 1 as work/,
        new Error('Client has encountered a connection error and is not queryable'),
      );
      pool.hand(connection);
      const driver = new Error('Connection terminated unexpectedly');
      const server = serverError(
        '25P03',
        'terminating connection due to idle-in-transaction timeout',
        'FATAL',
      );

      const result = (await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          for (const error of order === 'driver first' ? [driver, server] : [server, driver]) {
            connection.emit('error', error);
          }
          await runningStatement(tx);
        }),
      )) as { error: DatabaseDeadlineError };

      expect(result.error, order).toBeInstanceOf(DatabaseDeadlineError);
      expect(result.error.kind, order).toBe('idle-in-transaction');
    }
  });

  // Break caught: a connection that raised an error event while held, then released back into the pool as healthy.
  it('destroys a connection that raised an error while it was held, even when the transaction finished', async () => {
    const { pool, service } = build();
    const connection = new FakeConnection();
    pool.hand(connection);

    await service.transactionWithContext(STAFF, () => {
      connection.emit('error', new Error('socket hang up'));
      return Promise.resolve();
    });

    expect(connection.destroyed).toBe(true);
  });
});

describe('DatabaseService: waiting for a connection (S0.6)', () => {
  // Break caught: more transactions open than connections, so the surplus waits in the driver where it cannot be bounded.
  it('lets no more transactions hold a connection than the pool has, and serves the next when one ends', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const first = new FakeConnection();
    const second = new FakeConnection();
    pool.hand(first, second);
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const one = service.transactionWithContext(STAFF, () => hold);
    const two = service.transactionWithContext(STAFF, () => Promise.resolve('two'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    finish();
    await one;
    await expect(two).resolves.toBe('two');
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  // Break caught: an unbounded line of waiters.
  it('refuses at once, without taking a connection, when as many callers wait as are allowed', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { maxWaiters: 1 } });
    pool.hand(new FakeConnection(), new FakeConnection(), new FakeConnection());
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    const two = service.transactionWithContext(STAFF, () => Promise.resolve());
    await vi.advanceTimersByTimeAsync(0);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(PoolSaturatedError);

    expect(pool.connect).toHaveBeenCalledTimes(1);
    finish();
    await one;
    await two;
  });

  // Break caught: a wait for a connection that lasts as long as the database is stuck.
  it('stops waiting after the acquire timeout, and the waiter takes no connection later', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 500 } });
    pool.hand(new FakeConnection(), new FakeConnection());
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    const waiter = settled(service.transactionWithContext(STAFF, () => Promise.resolve()));
    await vi.advanceTimersByTimeAsync(0);

    await pass(500);

    expect(await waiter).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
    finish();
    await one;
    // The connection that came free went to nobody: the next transaction takes it and the pool was asked only twice in all.
    await service.transactionWithContext(STAFF, () => Promise.resolve());
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  // Break caught: a request that expires while it waits for a connection, still in line, then handed one it cannot use.
  it('removes a waiter whose request budget expires, and names the budget', async () => {
    const { pool, service } = build({ poolMax: 1 });
    pool.hand(new FakeConnection(), new FakeConnection());
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    await vi.advanceTimersByTimeAsync(0);
    const request = new ExecutionBudget(clock, 'request', 800);
    const waiter = settled(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    );
    await vi.advanceTimersByTimeAsync(0);

    await pass(800);

    const result = (await waiter) as { error: BudgetExpiredError };
    expect(result.error).toBeInstanceOf(BudgetExpiredError);
    expect(result.error.label).toBe('request');
    finish();
    await one;
    expect(pool.connect).toHaveBeenCalledTimes(1);
    request.finish();
  });

  // Break caught: a connection being opened when the budget expires, abandoned and leaked, or its permit freed while it is still
  // being made so that the pool is over-committed.
  it('keeps the permit until an abandoned connection attempt ends, then returns that connection unused', async () => {
    const { pool, service } = build({ poolMax: 1 });
    let arrive: (connection: FakeConnection) => void = () => undefined;
    pool.connect.mockReturnValueOnce(
      new Promise<FakeConnection>((resolve) => {
        arrive = resolve;
      }),
    );
    const next = new FakeConnection();
    pool.hand(next);
    const request = new ExecutionBudget(clock, 'request', 1_000);

    const abandoned = settled(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    );
    await vi.advanceTimersByTimeAsync(0);
    await pass(1_000);
    expect(await abandoned).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });

    // The attempt is still running: another caller must wait for it, not open a second connection beside it.
    const waiting = service.transactionWithContext(STAFF, () => Promise.resolve('next'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const late = new FakeConnection({ processID: 7 });
    arrive(late);
    await expect(waiting).resolves.toBe('next');
    expect(late.release).toHaveBeenCalledExactlyOnceWith();
    expect(late.statements).toEqual([]);
    expect(next.statements).toContain('commit');
    request.finish();
  });

  // Break caught: a connection that cannot be made leaving its permit held for ever.
  it('frees the permit when the connection cannot be made', async () => {
    const { pool, service } = build({ poolMax: 1 });
    pool.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const good = new FakeConnection();
    pool.hand(good);

    await expect(service.transactionWithContext(STAFF, () => Promise.resolve())).rejects.toThrow(
      'ECONNREFUSED',
    );
    await expect(service.transactionWithContext(STAFF, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  // Break caught: shutdown leaving callers parked in the line.
  it('rejects the callers waiting when it is closed, and ends the pool', async () => {
    const { pool, service } = build({ poolMax: 1 });
    pool.hand(new FakeConnection());
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    const waiter = settled(service.transactionWithContext(STAFF, () => Promise.resolve()));
    await vi.advanceTimersByTimeAsync(0);

    const closing = service.close();
    expect(await waiter).toMatchObject({ error: expect.any(PoolClosedError) as unknown });
    finish();
    await one;
    await closing;
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

/** A promise that stays pending until `finish` is called: the work of a transaction that holds its connection. */
const holding = () => {
  let release: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hold,
    finish: () => {
      release();
    },
  };
};

/** An outcome and whether it has been reached yet, so a test can say that something is not settled at a given moment. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; outcome?: { value: T } | { error: unknown } } = { done: false };
  void settled(promise).then((outcome) => {
    state.done = true;
    state.outcome = outcome;
  });
  return state;
}

/**
 * One deadline for getting a connection (correction F04A). The wait for a permit and the connection itself draw on the one
 * acquire timeout (or on what the request has left, if that is less); neither is given a fresh one when the other ends, a
 * connection that arrives after the deadline is not handed to a caller that was owed a failure, and no more connections are being
 * made than there are permits.
 */
describe('DatabaseService: one deadline for getting a connection (F04A)', () => {
  // Break caught: the reproduction of F04A. The acquire timeout counted for the wait in line and then again, from nothing, for the
  // connection, and a request-less caller's connection was bounded by nothing of the service's, so the wait could last as long as the
  // database stayed silent.
  it('bounds the wait for a permit and the connection together by the acquire timeout', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 1_000 } });
    pool.hand(new FakeConnection());
    // The second connection is never made.
    pool.connect.mockReturnValueOnce(new Promise(() => undefined));
    const { hold, finish } = holding();
    const one = service.transactionWithContext(STAFF, () => hold);
    const waiter = track(service.transactionWithContext(STAFF, () => Promise.resolve()));
    await vi.advanceTimersByTimeAsync(0);

    // 900 ms in line; then the permit goes to the waiter, which begins to connect with 100 ms left of its one deadline.
    await pass(900);
    finish();
    await one;
    await pass(99);
    expect(waiter.done).toBe(false);
    await pass(1);

    expect(waiter.done).toBe(true);
    expect(waiter.outcome).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
    const { error } = waiter.outcome as { error: AcquireTimeoutError };
    expect(error.waitedMilliseconds).toBe(1_000);
    expect(pool.connect).toHaveBeenCalledTimes(2);
  });

  // Break caught: a connection attempt that is given up on and its permit freed at once, so that as many attempts are being made as
  // there are callers; or the connection that arrives late kept by nobody and not given back.
  it('holds the permit while an abandoned connection is being made, and returns that connection unused when it arrives', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 500 } });
    let arrive: (connection: FakeConnection) => void = () => undefined;
    pool.connect.mockReturnValueOnce(
      new Promise<FakeConnection>((resolve) => {
        arrive = resolve;
      }),
    );
    const next = new FakeConnection();
    pool.hand(next);

    const abandoned = track(service.transactionWithContext(STAFF, () => Promise.resolve()));
    await vi.advanceTimersByTimeAsync(0);
    await pass(500);
    expect(abandoned.done).toBe(true);
    expect(abandoned.outcome).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });

    // Another caller waits for the attempt that is still running; it does not open a second connection beside it.
    const waiting = service.transactionWithContext(STAFF, () => Promise.resolve('next'));
    await vi.advanceTimersByTimeAsync(0);
    expect(pool.connect).toHaveBeenCalledTimes(1);

    const late = new FakeConnection({ processID: 7 });
    arrive(late);
    await expect(waiting).resolves.toBe('next');
    expect(late.release).toHaveBeenCalledExactlyOnceWith();
    expect(late.statements).toEqual([]);
    expect(next.statements).toContain('commit');
  });

  // Break caught: a connection that arrives after the deadline, before the timer that enforces it has run (a busy event loop),
  // handed to a caller that was owed a failure. The deadline is the clock's, checked when the connection arrives.
  it('does not hand over a connection that arrives after the deadline, even before the timer has run', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 500 } });
    let arrive: (connection: FakeConnection) => void = () => undefined;
    pool.connect.mockReturnValueOnce(
      new Promise<FakeConnection>((resolve) => {
        arrive = resolve;
      }),
    );
    const caller = track(service.transactionWithContext(STAFF, () => Promise.resolve('done')));
    await vi.advanceTimersByTimeAsync(0);

    clock.advance(600);
    const late = new FakeConnection();
    arrive(late);
    await vi.advanceTimersByTimeAsync(0);

    expect(caller.outcome).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
    expect(late.statements).toEqual([]);
    expect(late.release).toHaveBeenCalledExactlyOnceWith();
    // The permit went back with it: the next caller is served.
    pool.hand(new FakeConnection());
    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('next')),
    ).resolves.toBe('next');
  });

  // Break caught: a permit handed over at the instant the deadline passes, used to start a connection nobody is waiting for.
  it('starts no connection with a permit that is handed over after the deadline', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 500 } });
    pool.hand(new FakeConnection(), new FakeConnection());
    const { hold, finish } = holding();
    const one = service.transactionWithContext(STAFF, () => hold);
    const waiter = track(service.transactionWithContext(STAFF, () => Promise.resolve()));
    await vi.advanceTimersByTimeAsync(0);

    // The deadline passes by the clock, the permit comes free before the timer that enforces it has run.
    clock.advance(600);
    finish();
    await one;
    await vi.advanceTimersByTimeAsync(0);

    expect(waiter.outcome).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
    expect(pool.connect).toHaveBeenCalledTimes(1);
  });

  // The request caps the one deadline, and its own error is what the caller gets, as before.
  it('is capped by the request: a wait that used most of it leaves the connection only the rest, and the request is named', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 5_000 } });
    pool.hand(new FakeConnection());
    pool.connect.mockReturnValueOnce(new Promise(() => undefined));
    const { hold, finish } = holding();
    const one = service.transactionWithContext(STAFF, () => hold);
    await vi.advanceTimersByTimeAsync(0);
    const request = new ExecutionBudget(clock, 'request', 800);
    const waiter = track(
      runWithBudget(request, () => service.transactionWithContext(STAFF, () => Promise.resolve())),
    );
    await vi.advanceTimersByTimeAsync(0);

    await pass(700);
    finish();
    await one;
    await pass(99);
    expect(waiter.done).toBe(false);
    await pass(1);

    expect(waiter.done).toBe(true);
    const { error } = waiter.outcome as { error: BudgetExpiredError };
    expect(error).toBeInstanceOf(BudgetExpiredError);
    expect(error.label).toBe('request');
    request.finish();
  });

  // Break caught: the timer that enforces the deadline, or the budget that carries it, left running after a connection is had.
  it('leaves no timer running once the connection is had or the wait has failed', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 500 } });
    pool.hand(new FakeConnection());
    await service.transactionWithContext(STAFF, () => Promise.resolve());
    expect(vi.getTimerCount()).toBe(0);

    pool.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await expect(service.transactionWithContext(STAFF, () => Promise.resolve())).rejects.toThrow(
      'ECONNREFUSED',
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('DatabaseService.check: the readiness probe goes through the same door', () => {
  const SAFE_ROLE = {
    role: 'melarc_api_runtime',
    ...Object.fromEntries(POSTURE_FLAGS.map((flag) => [flag, false])),
  };

  // Break caught: a probe that takes a connection beside the permits, so readiness can over-commit a saturated pool.
  it('takes a permit and a leased connection, and gives both back', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const connection = new FakeConnection();
    connection.query.mockResolvedValueOnce({ rows: [SAFE_ROLE] });
    pool.hand(connection);

    await expect(service.check()).resolves.toBeUndefined();

    expect(pool.query).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  // Break caught: a probe that fails and returns its connection to the pool as healthy.
  it('destroys the connection when the probe fails', async () => {
    const { pool, service } = build({ poolMax: 1 });
    const connection = new FakeConnection();
    connection.query.mockRejectedValueOnce(new Error('connection refused'));
    pool.hand(connection);

    await expect(service.check()).rejects.toThrow('connection refused');

    expect(connection.destroyed).toBe(true);
  });

  // Break caught: readiness waiting for a connection beyond the acquire timeout while the pool is busy.
  it('is refused when the pool stays busy for the acquire timeout', async () => {
    const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 400 } });
    pool.hand(new FakeConnection());
    let finish: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const one = service.transactionWithContext(STAFF, () => hold);
    await vi.advanceTimersByTimeAsync(0);

    const probe = settled(service.check());
    await pass(400);

    expect(await probe).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
    finish();
    await one;
  });

  /**
   * The probe is bounded on this side (correction F04C). The registry stops waiting for a slow check after its own deadline, but
   * a check it stopped waiting for would otherwise go on holding a connection and a permit for as long as the database stays
   * silent, and the server's statement timeout is not what a caller should have to rely on: a few probes would take the pool that
   * serves the business.
   */
  describe('is bounded by its own deadline (F04C)', () => {
    // Break caught: the reproduction of F04C. A posture query that is never answered held the probe, the connection and the permit
    // for ever.
    it('stops waiting for a query that is never answered, destroys its connection and gives the permit back', async () => {
      const { pool, service } = build({ poolMax: 1 });
      const stuck = new FakeConnection();
      stuck.query.mockReturnValueOnce(new Promise(() => undefined));
      const healthy = new FakeConnection();
      healthy.query.mockResolvedValueOnce({ rows: [SAFE_ROLE] });
      pool.hand(stuck, healthy);

      const probe = track(service.check({ timeoutMs: 700 }));
      await pass(699);
      expect(probe.done).toBe(false);
      await pass(1);

      expect(probe.done).toBe(true);
      const { error } = probe.outcome as { error: BudgetExpiredError };
      expect(error).toBeInstanceOf(BudgetExpiredError);
      expect(error.label).toBe('readiness');
      // The connection is not returned to the pool as if it were sound, and its permit is free for the next caller.
      expect(stuck.destroyed).toBe(true);
      await expect(service.check()).resolves.toBeUndefined();
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    // Break caught: failed probes that each keep a connection, so a few of them take the pool that serves the business.
    it('does not consume the pool when the probe fails again and again, and a later healthy probe is served', async () => {
      const { pool, service } = build({ poolMax: 2 });
      const stuck = [new FakeConnection(), new FakeConnection(), new FakeConnection()];
      for (const connection of stuck)
        connection.query.mockReturnValueOnce(new Promise(() => undefined));
      const healthy = new FakeConnection();
      healthy.query.mockResolvedValueOnce({ rows: [SAFE_ROLE] });
      pool.hand(...stuck, healthy);

      let round = 0;
      while (round < stuck.length) {
        const probe = track(service.check({ timeoutMs: 300 }));
        await pass(300);
        expect(probe.done).toBe(true);
        expect(probe.outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
        round += 1;
      }

      for (const connection of stuck) expect(connection.destroyed).toBe(true);
      await expect(service.check()).resolves.toBeUndefined();
    });

    // Break caught: the probe's wait in line bounded only by the acquire timeout, which is longer than the probe is allowed.
    it('stops waiting in line at its own deadline when that is shorter than the acquire timeout', async () => {
      const { pool, service } = build({ poolMax: 1, deadlines: { acquireTimeoutMs: 5_000 } });
      pool.hand(new FakeConnection(), new FakeConnection());
      const { hold, finish } = holding();
      const one = service.transactionWithContext(STAFF, () => hold);
      await vi.advanceTimersByTimeAsync(0);

      const probe = track(service.check({ timeoutMs: 400 }));
      await pass(399);
      expect(probe.done).toBe(false);
      await pass(1);

      expect(probe.done).toBe(true);
      const { error } = probe.outcome as { error: BudgetExpiredError };
      expect(error).toBeInstanceOf(BudgetExpiredError);
      expect(error.label).toBe('readiness');
      finish();
      await one;
      // The probe took no connection when it gave up: only the transaction's was made.
      expect(pool.connect).toHaveBeenCalledTimes(1);
    });

    // Break caught: a probe with no deadline of its own, when called without one: the registry's default is the bound.
    it('is bounded by the readiness default when it is called without a deadline', async () => {
      const { pool, service } = build({ poolMax: 1 });
      const stuck = new FakeConnection();
      stuck.query.mockReturnValueOnce(new Promise(() => undefined));
      pool.hand(stuck);

      const probe = track(service.check());
      await pass(1_999);
      expect(probe.done).toBe(false);
      await pass(1);

      expect(probe.done).toBe(true);
      expect(stuck.destroyed).toBe(true);
    });

    // Break caught: a late answer to the abandoned query surfacing as an unhandled rejection that ends the process.
    it('lets the abandoned query fail later without a trace', async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const { pool, service } = build({ poolMax: 1 });
        const stuck = new FakeConnection();
        let fail: (error: Error) => void = () => undefined;
        stuck.query.mockReturnValueOnce(
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
        );
        pool.hand(stuck);

        const probe = track(service.check({ timeoutMs: 200 }));
        await pass(200);
        expect(probe.done).toBe(true);
        fail(new Error('terminating connection'));
        await pass(100);

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    // The ordinary failures keep their meaning: a probe that is answered with an error is that error, not the deadline.
    it('still reports the error of a query that fails inside its deadline', async () => {
      const { pool, service } = build({ poolMax: 1 });
      const connection = new FakeConnection();
      connection.query.mockRejectedValueOnce(new Error('connection refused'));
      pool.hand(connection);

      await expect(service.check({ timeoutMs: 700 })).rejects.toThrow('connection refused');

      expect(connection.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

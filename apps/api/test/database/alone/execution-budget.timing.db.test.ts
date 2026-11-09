// Runs alone: its bounds (1.5 seconds, the budget plus the disposal bound) are wall-clock time.
// Functional half, which runs on a pull request: execution-budget.db.test.ts (the same scenarios with the clock in the test's hands and no duration asserted; run 5, Stage 1.2).
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import {
  API_RUNTIME_ROLE,
  type DatabaseDeadlines,
} from '../../../src/platform/config/load-config.js';
import { AcquireTimeoutError } from '../../../src/platform/database/connection-queue.js';
import { DatabaseDeadlineError } from '../../../src/platform/database/database-failures.js';
import { createPool } from '../../../src/platform/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../../src/platform/database/database.service.js';
import { postgresConnectionSettings } from '../../../src/platform/database/postgres-url.js';
import {
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../../src/platform/execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../../src/platform/execution/execution-parameters.js';
import { ReadinessRegistry } from '../../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../../src/test-support/captured-logs.js';
import { applyFixture, HUB_A, staffContext } from '../support/rls-fixture.js';
import { databaseRuntime } from '../support/runtime.js';
import { createTestDatabase, withClient, type TestDatabase } from '../support/test-database.js';

/**
 * S0.6 against a real PostgreSQL, connecting as `melarc_api_runtime` (the runtime login, not an administrator): how soon the pool bound, the server's time bounds, and an
 * execution budget end a wait for a connection, a wait for a lock and work in the middle of a statement (OB-37).
 *
 * **Only the bounds are here** (run 5, Stage 1.2). What each scenario does, besides how soon (the waiter takes nothing, the statement is cancelled, the backend is gone,
 * nothing is committed, the log says so), is asserted without any time by `execution-budget.db.test.ts`, which a pull request runs; each test here keeps the one thing it
 * needs to be about that scenario (the failure that ended the wait) and asserts the time.
 *
 * Times are real. They are small so the file stays quick, and they are the development-qualified figures recorded in
 * DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.6 applied and where it was exercised".
 */

/** The deadlines these tests give the service. The relations hold (lock < statement < transaction); the figures are small. */
const FAST: DatabaseDeadlines = {
  acquireTimeoutMs: 1_500,
  lockTimeoutMs: 400,
  statementTimeoutMs: 1_200,
  idleInTransactionTimeoutMs: 1_500,
  transactionTimeoutMs: 1_600,
  maxWaiters: 3,
};

/** Longer bounds, so that a budget (not the database) is what ends the work. */
const SLOW: DatabaseDeadlines = {
  acquireTimeoutMs: 5_000,
  lockTimeoutMs: 8_000,
  statementTimeoutMs: 20_000,
  idleInTransactionTimeoutMs: 20_000,
  transactionTimeoutMs: 30_000,
  maxWaiters: 3,
};

const APPLICATION = 'melarc-api';
const clock = new SystemClock();
const STAFF = staffContext([HUB_A]);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
});

afterAll(async () => {
  await database.drop();
});

interface Built {
  readonly service: DatabaseService;
  readonly shutdown: ShutdownRegistry;
}

const built: Built[] = [];

function build(deadlines: DatabaseDeadlines, poolMax = 1): Built {
  const url = database.urlFor(API_RUNTIME_ROLE);
  const pool = createPool({ url, poolMax, deadlines });
  const logs = new CapturedLogs();
  const shutdown = new ShutdownRegistry();
  const service = new DatabaseService(
    pool,
    logs.logger,
    shutdown,
    new ReadinessRegistry(),
    databaseRuntime(url, poolMax, { deadlines, clock }),
  );
  const each = { service, shutdown };
  built.push(each);
  return each;
}

/** The pool of every service is ended between tests: nothing one test opened can be seen by the next. */
async function closeAll(): Promise<void> {
  for (const each of built.splice(0)) await each.shutdown.closeAll();
}

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** The sessions of the service, as the administrator sees them. */
async function backends(): Promise<{ pid: number; state: string | null; query: string }[]> {
  return withClient(database.urlFor('postgres'), async (admin) => {
    const { rows } = await admin.query(
      `select pid, state, query from pg_stat_activity where datname = $1 and application_name = $2`,
      [database.name, APPLICATION],
    );
    return rows as { pid: number; state: string | null; query: string }[];
  });
}

const insertNote = (tx: DatabaseTransaction, body: string) =>
  tx.execute(sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`);

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe('waiting for a connection (the pool bound and the cleanup of waiters)', () => {
  // Break caught: a wait for a connection that lasts as long as the holder.
  it('stops waiting at the acquire timeout, not before it and not long after', async () => {
    const { service } = build({ ...FAST, acquireTimeoutMs: 300 }, 1);
    try {
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.transactionWithContext(STAFF, () => hold);
      await eventually(async () => (await backends()).length === 1, 'the first session');

      const started = Date.now();
      const timedOut = await settled(
        service.transactionWithContext(STAFF, () => Promise.resolve()),
      );

      expect(timedOut).toMatchObject({ error: expect.any(AcquireTimeoutError) as unknown });
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(1_500);
      release();
      await first;
    } finally {
      await closeAll();
    }
  });

  // Break caught (OB-37): a request whose budget ran out while it waited for a connection, told only when the holder is done.
  it('ends the wait of a waiter whose request budget expires at the budget, not long after', async () => {
    const { service } = build(SLOW, 1);
    const request = new ExecutionBudget(clock, 'request', 300);
    try {
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.transactionWithContext(STAFF, async (tx) => {
        await insertNote(tx, 'held by the first');
        await hold;
        return 'first done';
      });
      await eventually(async () => (await backends()).length === 1, 'the first session');

      const started = Date.now();
      const waiter = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, () => Promise.resolve()),
        ),
      );

      expect(waiter).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect((waiter as { error: BudgetExpiredError }).error.label).toBe('request');
      expect(Date.now() - started).toBeLessThan(1_500);
      release();
      await first;
    } finally {
      request.finish();
      await closeAll();
    }
  });
});

describe('a budget that expires waiting for a lock (OB-37)', () => {
  /** Holds an exclusive lock on the table from another connection until `release` is called. */
  async function holdTableLock() {
    const { Client } = await import('pg');
    const admin = new Client({ ...postgresConnectionSettings(database.urlFor('postgres')) });
    admin.on('error', () => undefined);
    await admin.connect();
    await admin.query('begin');
    await admin.query('lock table rls_fixture.notes in access exclusive mode');
    return {
      release: async () => {
        await admin.query('rollback').catch(() => undefined);
        await admin.end().catch(() => undefined);
      },
    };
  }

  // Break caught: a lock wait with no end. The database's own lock timeout ends it, and the caller is told it was the lock.
  it('ends at the lock timeout when the budget is longer, and not long after', async () => {
    const { service } = build(FAST);
    const lock = await holdTableLock();
    try {
      const started = Date.now();
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          await tx.execute(sql`select count(*) from rls_fixture.notes`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(DatabaseDeadlineError) as unknown });
      expect((outcome as { error: DatabaseDeadlineError }).error.kind).toBe('lock');
      expect(Date.now() - started).toBeLessThan(1_500);
    } finally {
      await lock.release();
      await closeAll();
    }
  });

  // Break caught: a budget that stops awaiting late, or only when the lock is freed or the database's own bound ends the wait: the budget, plus a cancel and a rollback.
  it('ends a wait for a lock at the request budget plus the disposal bound at most, and not at the lock timeout', async () => {
    const { service } = build(SLOW);
    const lock = await holdTableLock();
    const request = new ExecutionBudget(clock, 'request', 500);
    try {
      const started = Date.now();
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            await insertNote(tx, 'never committed (lock)');
            await tx.execute(sql`select count(*) from rls_fixture.notes`);
          }),
        ),
      );
      const elapsed = Date.now() - started;

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect((outcome as { error: BudgetExpiredError }).error.label).toBe('request');
      // Not the lock timeout (8 s) and not the statement timeout (20 s): the budget, plus a cancel and a rollback.
      expect(elapsed).toBeGreaterThanOrEqual(450);
      expect(elapsed).toBeLessThan(500 + DISPOSAL_BOUND_MS + 500);
    } finally {
      request.finish();
      await lock.release();
      await closeAll();
    }
  });
});

describe('a budget that expires in the middle of work (OB-37)', () => {
  // Break caught (the central one): a timeout that stops awaiting late, or only when the statement ends of itself.
  it('ends a running statement at the request budget plus the disposal bound at most', async () => {
    const { service } = build(SLOW);
    const request = new ExecutionBudget(clock, 'request', 500);
    try {
      const started = Date.now();
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            await insertNote(tx, 'never committed (running)');
            await tx.execute(sql`select pg_sleep(30)`);
          }),
        ),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect(Date.now() - started).toBeLessThan(500 + DISPOSAL_BOUND_MS + 500);
    } finally {
      request.finish();
      await closeAll();
    }
  });

  // Break caught: a transaction with no request budget outliving the transaction time, or ending only when the database's own bound does.
  it('bounds a transaction by its own time when there is no request budget, and names it', async () => {
    const { service } = build({ ...SLOW, transactionTimeoutMs: 400 });
    try {
      const started = Date.now();
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          await tx.execute(sql`select pg_sleep(30)`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect((outcome as { error: BudgetExpiredError }).error.label).toBe('transaction');
      expect(Date.now() - started).toBeLessThan(400 + DISPOSAL_BOUND_MS + 500);
    } finally {
      await closeAll();
    }
  });
});

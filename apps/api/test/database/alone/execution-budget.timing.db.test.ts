// Runs alone: its bounds (1.5 seconds, the budget plus the disposal bound) are wall-clock time.
// The time bounds of execution-budget.db.test.ts; its other tests run on a pull request (task CI.2, run 4 Stage 1 item 5).
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
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from '../support/test-database.js';

/**
 * S0.6 against a real PostgreSQL, connecting as `melarc_api_runtime` (the runtime login, not an administrator): the pool
 * bound, the server's time bounds, and an execution budget that expires waiting for a connection, waiting for a lock and
 * in the middle of work (OB-37). The effects are observed from a second connection (the administrator, who bypasses
 * row-level security and sees every session), never from the connection that did the work.
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
  await withClient(database.urlFor('postgres'), async (admin) => {
    // A commit that takes a while: a deferred constraint trigger that sleeps when the transaction commits.
    await admin.query(`
      create function rls_fixture.slow_commit() returns trigger language plpgsql as
        $$ begin perform pg_sleep(1.5); return null; end $$;
      create constraint trigger slow_commit after insert on rls_fixture.notes
        deferrable initially deferred for each row when (new.body = 'slow commit')
        execute function rls_fixture.slow_commit();
    `);
  });
});

afterAll(async () => {
  await database.drop();
});

interface Built {
  readonly service: DatabaseService;
  readonly logs: CapturedLogs;
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
  const each = { service, logs, shutdown };
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

async function isGone(pid: number): Promise<boolean> {
  return withClient(
    database.urlFor('postgres'),
    async (admin) =>
      (await scalar<number>(admin, 'select count(*)::int from pg_stat_activity where pid = $1', [
        pid,
      ])) === 0,
  );
}

async function notesWith(body: string): Promise<number> {
  return withClient(database.urlFor('postgres'), (admin) =>
    scalar<number>(admin, 'select count(*)::int from rls_fixture.notes where body = $1', [body]),
  );
}

const insertNote = (tx: DatabaseTransaction, body: string) =>
  tx.execute(sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`);

const backendPid = async (tx: DatabaseTransaction): Promise<number> => {
  const result = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number((result.rows[0] as { pid: number | string }).pid);
};

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

describe('waiting for a connection (the pool bound and the cleanup of waiters)', () => {
  // Break caught: a wait for a connection that lasts as long as the holder, and a waiter that stays in line after giving up.
  it('stops waiting at the acquire timeout, and the waiter takes nothing when a connection comes free', async () => {
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
      // Nobody was waiting any more: the connection is idle, and a later caller is served at once.
      await expect(
        service.transactionWithContext(STAFF, () => Promise.resolve('ok')),
      ).resolves.toBe('ok');
    } finally {
      await closeAll();
    }
  });

  // Break caught (OB-37): a request whose budget ran out while it waited for a connection, still queued and later handed one.
  it('removes a waiter whose request budget expires, names the budget, and leaves the holder alone', async () => {
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
      await expect(first).resolves.toBe('first done');
      expect(await notesWith('held by the first')).toBe(1);
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

  // Break caught: a lock wait with no end. The database's own lock timeout ends it, the caller is told it was the lock, and the
  // connection is not kept.
  it('ends at the lock timeout when the budget is longer: a DatabaseDeadlineError of the lock, the connection destroyed', async () => {
    const { service } = build(FAST);
    const lock = await holdTableLock();
    try {
      let pid = 0;
      const started = Date.now();
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          pid = await backendPid(tx);
          await tx.execute(sql`select count(*) from rls_fixture.notes`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(DatabaseDeadlineError) as unknown });
      expect((outcome as { error: DatabaseDeadlineError }).error.kind).toBe('lock');
      expect(Date.now() - started).toBeLessThan(1_500);
      await eventually(() => isGone(pid), 'the connection to be destroyed');
    } finally {
      await lock.release();
      await closeAll();
    }
  });

  // Break caught: a budget that stops awaiting while the statement goes on waiting for the lock in the database. The waiter is
  // gone from the server, the caller is told, the connection destroyed, and the lock is still held by its owner untouched.
  it('cancels the waiting statement when the request budget expires, rolls back, and destroys the connection', async () => {
    const { service, logs } = build(SLOW);
    const lock = await holdTableLock();
    const request = new ExecutionBudget(clock, 'request', 500);
    try {
      let pid = 0;
      const started = Date.now();
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            pid = await backendPid(tx);
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
      await eventually(() => isGone(pid), 'the waiting backend to be gone');
      expect(
        logs.records().find((record) => String(record.msg).includes('budget ran out')),
      ).toMatchObject({ level: 'warn', phase: 'working', cancel: 'signalled' });
    } finally {
      request.finish();
      await lock.release();
      await closeAll();
    }
    expect(await notesWith('never committed (lock)')).toBe(0);
  });
});

describe('a budget that expires in the middle of work (OB-37)', () => {
  // Break caught (the central one): a timeout that stops awaiting while the statement, and the transaction around it, go on in
  // the database. Seen from a second connection: the session is gone, nothing was written, and nothing appears later.
  it('cancels the running statement, rolls back, destroys the connection, and leaves nothing committed, then or later', async () => {
    const { service, logs } = build(SLOW);
    const request = new ExecutionBudget(clock, 'request', 500);
    try {
      let pid = 0;
      const started = Date.now();
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            pid = await backendPid(tx);
            await insertNote(tx, 'never committed (running)');
            await tx.execute(sql`select pg_sleep(30)`);
          }),
        ),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect(Date.now() - started).toBeLessThan(500 + DISPOSAL_BOUND_MS + 500);
      // Observed from outside: the backend that ran the statement is gone, not merely abandoned.
      await eventually(() => isGone(pid), 'the backend running the statement to be gone');
      expect(await notesWith('never committed (running)')).toBe(0);
      await sleep(400);
      expect(await notesWith('never committed (running)')).toBe(0);
      expect(
        logs.records().find((record) => String(record.msg).includes('budget ran out')),
      ).toMatchObject({ phase: 'working', cancel: 'signalled' });
    } finally {
      request.finish();
      await closeAll();
    }
  });

  // Break caught: a transaction with no request budget outliving the transaction time, or ending only when the database's own
  // bound does.
  it('bounds a transaction by its own time when there is no request budget, and names it', async () => {
    const { service } = build({ ...SLOW, transactionTimeoutMs: 400 });
    try {
      let pid = 0;
      const started = Date.now();
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          pid = await backendPid(tx);
          await tx.execute(sql`select pg_sleep(30)`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      expect((outcome as { error: BudgetExpiredError }).error.label).toBe('transaction');
      expect(Date.now() - started).toBeLessThan(400 + DISPOSAL_BOUND_MS + 500);
      await eventually(() => isGone(pid), 'the backend to be gone');
    } finally {
      await closeAll();
    }
  });
});

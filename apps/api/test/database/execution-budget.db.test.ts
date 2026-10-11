import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { API_RUNTIME_ROLE, type DatabaseDeadlines } from '../../src/platform/config/load-config.js';
import {
  AcquireTimeoutError,
  PoolSaturatedError,
} from '../../src/platform/database/connection-queue.js';
import {
  CommitOutcomeUnknownError,
  DatabaseDeadlineError,
} from '../../src/platform/database/database-failures.js';
import { createPool } from '../../src/platform/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../src/platform/database/database.service.js';
import { postgresConnectionSettings } from '../../src/platform/database/postgres-url.js';
import { PgStatementCanceller } from '../../src/platform/database/statement-canceller.js';
import {
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../src/platform/execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../src/platform/execution/execution-parameters.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import { applyFixture, HUB_A, staffContext } from './support/rls-fixture.js';
import { databaseRuntime } from './support/runtime.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

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

describe('the connection carries the server’s time bounds, as the runtime login (SECURITY_DESIGN.md §14.6)', () => {
  // Break caught: a pool that sets none of the server's timeouts on its connections, or sets them on some. The values are read
  // back from the server, on a connection the pool made, inside a transaction.
  it('has the statement, lock and idle-in-transaction timeouts from the start, and the transaction bound per transaction', async () => {
    const { service } = build(FAST);
    try {
      const seen = await service.transactionWithContext(STAFF, async (tx) => {
        const result = await tx.execute(
          sql`select current_user as role,
                     current_setting('statement_timeout') as statement,
                     current_setting('lock_timeout') as lock,
                     current_setting('idle_in_transaction_session_timeout') as idle,
                     current_setting('transaction_timeout') as transaction`,
        );
        return result.rows[0] as Record<string, string>;
      });

      expect(seen.role).toBe(API_RUNTIME_ROLE);
      expect(seen.statement).toBe('1200ms');
      expect(seen.lock).toBe('400ms');
      expect(seen.idle).toBe('1500ms');
      // The budget (1.6 s, a little of it gone) plus the disposal bound.
      const bound = Number(/^(\d+)ms$/.exec(seen.transaction ?? '')?.[1]);
      expect(bound).toBeGreaterThan(1_600 + DISPOSAL_BOUND_MS - 400);
      expect(bound).toBeLessThanOrEqual(1_600 + DISPOSAL_BOUND_MS);
    } finally {
      await closeAll();
    }
  });

  // Break caught: a statement that runs for as long as it likes. The server ends it, the caller is told which bound it was, and
  // the connection that was running it is not kept.
  it('ends a statement at the statement timeout: a DatabaseDeadlineError, the connection destroyed', async () => {
    const { service } = build({ ...FAST, statementTimeoutMs: 300, transactionTimeoutMs: 1_600 });
    try {
      let pid = 0;
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          pid = await backendPid(tx);
          await tx.execute(sql`select pg_sleep(3)`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(DatabaseDeadlineError) as unknown });
      expect((outcome as { error: DatabaseDeadlineError }).error.kind).toBe('statement');
      await eventually(() => isGone(pid), 'the connection to be destroyed');
    } finally {
      await closeAll();
    }
  });

  // Break caught: a transaction that sits idle holding its locks. The server ends the session; the next statement finds it
  // gone, and the caller is told it was the idle-in-transaction timeout, not "connection terminated".
  it('ends a transaction that idles at the idle-in-transaction timeout, and names it', async () => {
    const { service } = build({ ...FAST, idleInTransactionTimeoutMs: 300 });
    try {
      let pid = 0;
      const outcome = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          pid = await backendPid(tx);
          await sleep(900);
          await tx.execute(sql`select 1`);
        }),
      );

      expect(outcome).toMatchObject({ error: expect.any(DatabaseDeadlineError) as unknown });
      expect((outcome as { error: DatabaseDeadlineError }).error.kind).toBe('idle-in-transaction');
      await eventually(() => isGone(pid), 'the session to be gone');
    } finally {
      await closeAll();
    }
  });
});

describe('waiting for a connection (the pool bound and the cleanup of waiters)', () => {
  // Break caught: an unbounded pool, or more sessions than the pool allows. A pool of one is held; the sessions of the service
  // are counted from outside.
  it('never opens more sessions than the pool has, however many callers wait', async () => {
    const { service } = build(FAST, 1);
    try {
      let release: () => void = () => undefined;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = service.transactionWithContext(STAFF, () => hold);
      await eventually(async () => (await backends()).length === 1, 'the first session');
      const waiters = [
        settled(service.transactionWithContext(STAFF, () => Promise.resolve('a'))),
        settled(service.transactionWithContext(STAFF, () => Promise.resolve('b'))),
        settled(service.transactionWithContext(STAFF, () => Promise.resolve('c'))),
      ];
      await sleep(150);

      expect(await backends()).toHaveLength(1);
      // The fourth caller finds three already waiting: refused at once, no session opened for it.
      await expect(
        service.transactionWithContext(STAFF, () => Promise.resolve('d')),
      ).rejects.toBeInstanceOf(PoolSaturatedError);
      expect(await backends()).toHaveLength(1);

      release();
      await first;
      expect(await Promise.all(waiters)).toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }]);
      expect((await backends()).length).toBeLessThanOrEqual(1);
    } finally {
      await closeAll();
    }
  });

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

  // Break caught: work that is not in the database when the budget runs out (an outbound call, a hash) and finishes later,
  // being committed, or issuing statements, after the caller was told the request failed.
  it('drops work outside the database that finishes late: nothing committed, no further statement reaches a connection', async () => {
    const { service, logs } = build(SLOW);
    const request = new ExecutionBudget(clock, 'request', 400);
    try {
      let pid = 0;
      let lateStatement: unknown = 'not attempted';
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            pid = await backendPid(tx);
            await insertNote(tx, 'never committed (outside)');
            await sleep(1_200);
            lateStatement = await insertNote(tx, 'never committed (late)').then(
              () => 'ran',
              (error: unknown) => (error as { cause?: unknown }).cause,
            );
            return 'finished late';
          }),
        ),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      await eventually(() => isGone(pid), 'the session to be gone');
      // The work resumes at 1.2 s: its statement is refused before it reaches any connection.
      await eventually(
        () => Promise.resolve(lateStatement !== 'not attempted'),
        'the late statement',
      );
      expect(lateStatement).toBeInstanceOf(BudgetExpiredError);
      expect(await notesWith('never committed (outside)')).toBe(0);
      expect(await notesWith('never committed (late)')).toBe(0);
      expect(logs.records().some((record) => String(record.msg).includes('budget ran out'))).toBe(
        true,
      );
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

  // Break caught: connection reuse after an expiry. The pool has one connection; the next transaction must run on a new
  // session, outside any transaction of the old one, with none of the old context.
  it('gives the next transaction a clean session: a different backend, no leftover context, no open transaction', async () => {
    const { service } = build(SLOW, 1);
    const request = new ExecutionBudget(clock, 'request', 400);
    try {
      let firstPid = 0;
      await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            firstPid = await backendPid(tx);
            await insertNote(tx, 'never committed (reuse)');
            await tx.execute(sql`select pg_sleep(30)`);
          }),
        ),
      );
      await eventually(() => isGone(firstPid), 'the old backend to be gone');

      const next = await service.transactionWithContext(
        staffContext([HUB_A], 'SET'),
        async (tx) => {
          const result = await tx.execute(
            sql`select pg_backend_pid() as pid,
                       current_setting('melarc.principal_type', true) as principal_type,
                       (select count(*)::int from rls_fixture.notes where body = 'never committed (reuse)') as leaked,
                       pg_current_xact_id_if_assigned() is null as no_write_yet`,
          );
          const row = result.rows[0];
          if (row === undefined) throw new Error('the statement returned no row');
          return row;
        },
      );

      expect(Number(next.pid)).not.toBe(firstPid);
      expect(next.principal_type).toBe('STAFF');
      expect(next.leaked).toBe(0);
      expect(next.no_write_yet).toBe(true);
      expect(await notesWith('never committed (reuse)')).toBe(0);
    } finally {
      request.finish();
      await closeAll();
    }
  });

  // Break caught: a request whose budget has already run out taking a connection and starting work.
  it('starts nothing for a request whose budget has already run out', async () => {
    const { service } = build(SLOW, 1);
    const request = new ExecutionBudget(clock, 'request', 50);
    await sleep(120);
    try {
      await expect(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            await insertNote(tx, 'never committed (expired before)');
          }),
        ),
      ).rejects.toBeInstanceOf(BudgetExpiredError);

      expect(await backends()).toHaveLength(0);
      expect(await notesWith('never committed (expired before)')).toBe(0);
    } finally {
      request.finish();
      await closeAll();
    }
  });
});

describe('an uncertain commit outcome (OB-37)', () => {
  // Break caught: a budget that expires with COMMIT in flight reported as a failure that was rolled back. The commit here takes
  // 1.5 s (a deferred trigger); the caller is told after 0.4 s. Observed from outside, the transaction DID commit after the
  // caller was told: the outcome really was unknown, and "rolled back" would have been false.
  it('reports the outcome as unknown when the budget expires during the commit, and the commit does happen', async () => {
    const { service, logs } = build(SLOW);
    const request = new ExecutionBudget(clock, 'request', 400);
    try {
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            await insertNote(tx, 'slow commit');
          }),
        ),
      );

      expect(outcome).toMatchObject({ error: expect.any(CommitOutcomeUnknownError) as unknown });
      const error = (outcome as { error: CommitOutcomeUnknownError }).error;
      expect(error.reason).toBe('budget-expired');
      expect(error.message).not.toMatch(/rolled back/i);
      // The transaction had not committed when the caller was told …
      expect(await notesWith('slow commit')).toBe(0);
      // … and did, afterwards, though the connection had been destroyed.
      await eventually(
        async () => (await notesWith('slow commit')) === 1,
        'the commit to complete',
      );
      expect(
        logs.records().find((record) => String(record.msg).includes('commit outcome unknown')),
      ).toMatchObject({ level: 'error' });
    } finally {
      request.finish();
      await closeAll();
    }
  });
});

describe('the cancel itself, as the runtime login', () => {
  // Break caught: a cancel that needs a privilege the runtime login does not hold, or one that reaches sessions it should not.
  it('cancels a statement of its own role, and cannot reach another role’s session', async () => {
    const settings = postgresConnectionSettings(database.urlFor(API_RUNTIME_ROLE));
    const canceller = new PgStatementCanceller(settings, {
      timeoutMilliseconds: DISPOSAL_BOUND_MS,
      clock,
    });
    const { Client } = await import('pg');

    const own = new Client({ ...settings });
    own.on('error', () => undefined);
    await own.connect();
    const ownPid = (own as unknown as { processID: number }).processID;
    const admin = new Client({ ...postgresConnectionSettings(database.urlFor('postgres')) });
    admin.on('error', () => undefined);
    await admin.connect();
    const adminPid = (admin as unknown as { processID: number }).processID;
    try {
      const ownSleep = own.query('select pg_sleep(30)').then(
        () => 'completed',
        (error: unknown) => (error as { code?: string }).code,
      );
      const adminSleep = admin.query('select pg_sleep(1.2)').then(
        () => 'completed',
        (error: unknown) => (error as { code?: string }).code,
      );
      await sleep(200);

      expect(await canceller.cancel(ownPid)).toBe('signalled');
      expect(await ownSleep).toBe('57014');
      // Another role’s session is not found by a login that is not it: nothing is cancelled.
      expect(await canceller.cancel(adminPid)).toBe('not-found');
      expect(await adminSleep).toBe('completed');
      // A process id nobody has.
      expect(await canceller.cancel(2_000_000_000)).toBe('not-found');
    } finally {
      await own.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
  });
});

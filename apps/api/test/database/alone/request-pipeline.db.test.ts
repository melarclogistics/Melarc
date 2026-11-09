// Runs alone: it ends a request's statements and transactions at the budget of the request, which files beside it would delay.
import { Controller, Inject, Module, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../../src/app.module.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../../src/platform/config/load-config.js';
import { DatabaseService } from '../../../src/platform/database/database.service.js';
import { currentBudget } from '../../../src/platform/execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../../src/platform/execution/execution-parameters.js';
import { LOGGER } from '../../../src/platform/platform.tokens.js';
import { TechnicalEndpoint } from '../../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../../src/test-support/config-env.js';
import { ManualClock } from '../../../src/test-support/manual-clock.js';
import { startTestApp, type TestApp } from '../../../src/test-support/test-app.js';
import { observe, type Observer } from '../support/observe.js';
import { applyFixture, HUB_A, staffContext } from '../support/rls-fixture.js';
import { createTestDatabase, withClient, type TestDatabase } from '../support/test-database.js';

/**
 * S0.20, the pipeline half of the execution budget (plan OB-37 and OB-55), over real HTTP and a real PostgreSQL: a request whose
 * work outlasts its budget is answered, its transaction is rolled back, and nothing it goes on to do after the answer takes
 * effect. Every effect is read from a second connection (the observer), never from the connection that did the work.
 *
 * The budget is the smallest the configuration accepts (one second), so each case takes about that long. The mechanism and
 * the database half are S0.6's, proved in `execution-budget.db.test.ts`; this file shows the request pipeline puts them to use.
 */
const BUDGET_MS = 1_000;

let database: TestDatabase;
let reader: Observer;
let app: TestApp | undefined;

/** The work that waits at a named gate (the routes `gated-*`) is let go by the test calling the function kept here: a wait that is the test's, and not a timer's. */
const gates = new Map<string, () => void>();

@Controller('pipeline')
@TechnicalEndpoint()
class PipelineFixtureController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Says that the work is at the gate, and waits until the test lets it go. */
  private atGate(gate: string): Promise<void> {
    return new Promise<void>((resolve) => {
      gates.set(gate, resolve);
      this.logger.info({ gate }, 'pipeline fixture: waiting at a gate');
    });
  }

  /** Like `open-transaction`, but the wait inside the open transaction is the test's gate and not a timer. */
  @Post('gated-open-transaction')
  async gatedOpenTransaction(
    @Query('body') body: string,
    @Query('late') late: string,
    @Query('gate') gate: string,
  ): Promise<{ done: boolean }> {
    await this.db.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`,
      );
      await this.atGate(gate);
      try {
        await tx.execute(
          sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${late})`,
        );
        this.logger.info({ late }, 'pipeline fixture: the late write was accepted');
      } catch {
        this.logger.info({ late }, 'pipeline fixture: the late write was refused');
      }
    });
    return { done: true };
  }

  /** Like `deaf`, but what it waits for is the test's gate and not a timer. */
  @Post('gated-deaf')
  async gatedDeaf(
    @Query('late') late: string,
    @Query('gate') gate: string,
  ): Promise<{ done: boolean }> {
    await this.atGate(gate);
    try {
      await this.insert(late);
      this.logger.info({ late }, 'pipeline fixture: the late transaction was accepted');
    } catch {
      this.logger.info({ late }, 'pipeline fixture: the late transaction was refused');
    }
    return { done: true };
  }

  private insert(body: string) {
    return this.db.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`,
      );
    });
  }

  /** A write that commits: the control. */
  @Post('commit')
  async commit(@Query('body') body: string): Promise<{ done: boolean }> {
    await this.insert(body);
    return { done: true };
  }

  /** Writes, and then holds the transaction in a statement far longer than the budget. */
  @Post('statement')
  async statement(@Query('body') body: string): Promise<{ done: boolean }> {
    await this.db.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`,
      );
      await tx.execute(sql`select pg_sleep(30)`);
    });
    return { done: true };
  }

  /**
   * Writes, then waits outside the database, inside the open transaction, longer than the budget, and then tries to go on. The
   * transaction is rolled back at the expiry; the work, which heeds nothing, wakes up and tries a second write, which is
   * refused. `late` records how the late attempt ended.
   */
  @Post('open-transaction')
  async openTransaction(
    @Query('body') body: string,
    @Query('late') late: string,
  ): Promise<{ done: boolean }> {
    await this.db.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`,
      );
      await new Promise((resolve) => setTimeout(resolve, BUDGET_MS + 1_200));
      try {
        await tx.execute(
          sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${late})`,
        );
        this.logger.info({ late }, 'pipeline fixture: the late write was accepted');
      } catch {
        this.logger.info({ late }, 'pipeline fixture: the late write was refused');
      }
    });
    return { done: true };
  }

  /**
   * Writes, and then waits, inside the open transaction, until the request is over (the client has left), and only then tries a
   * second write and returns. The budget has not run out: the request was finished by its response closing.
   */
  @Post('client-leaves')
  async clientLeaves(
    @Query('body') body: string,
    @Query('second') second: string,
  ): Promise<{ done: boolean }> {
    await this.db.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(
        sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`,
      );
      this.logger.info({ body }, 'pipeline fixture: waiting for the client to leave');
      const giveUpAt = Date.now() + 5_000;
      while (currentBudget()?.closed !== true && Date.now() < giveUpAt) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      try {
        await tx.execute(
          sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${second})`,
        );
        this.logger.info({ second }, 'pipeline fixture: the second write was accepted');
      } catch {
        this.logger.info({ second }, 'pipeline fixture: the second write was refused');
      }
    });
    return { done: true };
  }

  /** Does nothing with the database until long after the budget, and then writes in a transaction of its own. */
  @Post('deaf')
  async deaf(@Query('late') late: string): Promise<{ done: boolean }> {
    await new Promise((resolve) => setTimeout(resolve, BUDGET_MS + DISPOSAL_BOUND_MS + 600));
    try {
      await this.insert(late);
      this.logger.info({ late }, 'pipeline fixture: the late transaction was accepted');
    } catch {
      this.logger.info({ late }, 'pipeline fixture: the late transaction was refused');
    }
    return { done: true };
  }
}

@Module({ controllers: [PipelineFixtureController] })
class PipelineFixtureModule {}

@Module({})
class Root {}

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await withClient(database.urlFor('postgres'), async (admin) => {
    // A commit that takes a while: a deferred constraint trigger that sleeps when the transaction commits.
    await admin.query(`
      create function rls_fixture.slow_commit() returns trigger language plpgsql as
        $$ begin perform pg_sleep(2.5); return null; end $$;
      create constraint trigger slow_commit after insert on rls_fixture.notes
        deferrable initially deferred for each row when (new.body = 'slow commit')
        execute function rls_fixture.slow_commit();
    `);
  });
  reader = await observe(database);

  const loaded = loadConfig(
    validEnv({
      DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
      DATABASE_POOL_MAX: '3',
      REQUEST_EXECUTION_BUDGET_MS: String(BUDGET_MS),
    }),
  );
  if (!loaded.ok) throw new Error('the configuration was refused');
  app = await startTestApp({
    config: loaded.config,
    rootModule: (options) => {
      Module({ imports: [AppModule.register(options), PipelineFixtureModule] })(Root);
      return Root;
    },
  });
});

afterAll(async () => {
  await app?.stop();
  await reader.close();
  await database.drop();
});

afterEach(() => {
  // Each case names its own rows, so nothing needs to be cleared between them.
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const notes = (body: string): Promise<{ n: number }[]> =>
  reader.rows<{ n: number }>('select count(*)::int as n from rls_fixture.notes where body = $1', [
    body,
  ]);

async function eventually(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const post = (path: string): Promise<Response> => {
  if (app === undefined) throw new Error('the application is not running');
  return fetch(`${app.baseUrl}/api/v1/pipeline/${path}`, { method: 'POST' });
};

const records = () => app?.logs.records() ?? [];

describe('a request that finishes inside its budget', () => {
  // Break caught: the budget getting in the way of work that finishes in time.
  it('commits, and answers as it always did', async () => {
    const response = await post('commit?body=in-time');

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ done: true });
    expect(await notes('in-time')).toEqual([{ n: 1 }]);
  });
});

describe('a client that leaves while its transaction is open (found by the audit of 11 October 2026)', () => {
  // Break caught: closure of the request checked only when a transaction begins. The client disconnects; the transaction, already
  // open and well inside its budget, went on to write and to commit for a request nobody was waiting for.
  it('commits nothing: the late write is refused, and the rows written before the client left are rolled back', async () => {
    if (app === undefined) throw new Error('the application is not running');
    const controller = new AbortController();
    const request = fetch(
      `${app.baseUrl}/api/v1/pipeline/client-leaves?body=left-first&second=left-second`,
      {
        method: 'POST',
        signal: controller.signal,
      },
    ).then(
      () => 'answered',
      () => 'abandoned',
    );
    await eventually(
      () =>
        Promise.resolve(
          records().some(
            (record) => record.msg === 'pipeline fixture: waiting for the client to leave',
          ),
        ),
      'the work to be waiting inside its transaction',
    );

    controller.abort();
    expect(await request).toBe('abandoned');

    await eventually(
      () =>
        Promise.resolve(
          records().some(
            (record) => record.msg === 'pipeline fixture: the second write was refused',
          ),
        ),
      'the second write to be attempted',
    );
    expect(
      records().some((record) => record.msg === 'pipeline fixture: the second write was accepted'),
    ).toBe(false);
    // Neither row is there, and none appears later: the work returned after the refusal and its COMMIT was not sent.
    await sleep(300);
    expect(await notes('left-first')).toEqual([{ n: 0 }]);
    expect(await notes('left-second')).toEqual([{ n: 0 }]);
  });
});

describe('a request whose commit is in flight when the budget runs out', () => {
  // Break caught: the client told "unavailable, try again" about a commit that may have happened. This is the case that decided
  // the unknown-commit answer (OB-55): 500, no code, no Retry-After and a text of its own. Whether the row is there is not
  // asserted: the server finishes a commit it was sent, and nothing here can tell, which is the point.
  it('is answered 500 with the unknown-outcome text, never 503', async () => {
    const response = await post('commit?body=slow%20commit');
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({
      message: 'The outcome of the request could not be confirmed',
      request_id: response.headers.get('x-request-id'),
    });
    expect(response.headers.has('retry-after')).toBe(false);
    const logged = records().find(
      (record) => record.msg === 'request failed: the outcome of its commit is unknown',
    );
    expect(logged?.reason).toBe('budget-expired');
    // Let the server finish what it was sent before the database is dropped.
    await sleep(2_800);
  });
});

@Module({})
class ManualRoot {}

/**
 * The claims of `request-pipeline.timing.db.test.ts` without a wall-clock assertion (run 5, Stage 1.2), so that a pull request runs them. This application is given a
 * `ManualClock` through the `clock` port, as the integration kit gives one: the request's budget, and the database layer under it, expire when the test says so (`advance`),
 * after the test has seen that the work is where it means it to be (a statement running in the database, or the work at a gate). The budget's timer and the pipeline's
 * grace timer are still real, so the expiry is noticed within a budget's period after the advance and the pipeline's own answer comes its grace after that; nothing here
 * asserts how long anything took. How soon the answer comes, and that the database layer's own failure beats the pipeline's, is the timing file.
 */
describe('a request that outlasts its budget, with the clock in the test’s hands (run 5, Stage 1.2; how soon is request-pipeline.timing.db.test.ts)', () => {
  let manual: { readonly clock: ManualClock; readonly running: TestApp } | undefined;

  beforeAll(async () => {
    const clock = new ManualClock();
    const loaded = loadConfig(
      validEnv({
        DATABASE_URL: database.urlFor(API_RUNTIME_ROLE),
        DATABASE_POOL_MAX: '3',
        REQUEST_EXECUTION_BUDGET_MS: String(BUDGET_MS),
      }),
    );
    if (!loaded.ok) throw new Error('the configuration was refused');
    const running = await startTestApp({
      config: loaded.config,
      rootModule: (options) => {
        Module({
          imports: [
            AppModule.register({ ...options, ports: { clock: { useValue: clock } } }),
            PipelineFixtureModule,
          ],
        })(ManualRoot);
        return ManualRoot;
      },
    });
    manual = { clock, running };
  }, 120_000);

  afterAll(async () => {
    await manual?.running.stop();
  });

  const started = () => {
    if (manual === undefined) throw new Error('the application is not running');
    return manual;
  };

  const postManual = (path: string): Promise<Response> =>
    fetch(`${started().running.baseUrl}/api/v1/pipeline/${path}`, { method: 'POST' });

  const recordsManual = () => started().running.logs.records();

  /** Resolves when the work has said that it is at the gate: it is where the test means it to be. */
  const atGate = (gate: string) =>
    eventually(
      () =>
        Promise.resolve(
          recordsManual().some(
            (record) =>
              record.msg === 'pipeline fixture: waiting at a gate' && record.gate === gate,
          ),
        ),
      `the work to wait at the gate ${gate}`,
    );

  const sleepingStatements = async (): Promise<number> =>
    (
      await reader.rows<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and query like '%pg_sleep(30)%' and pid <> pg_backend_pid() and state = 'active'`,
      )
    )[0]?.n ?? 0;

  /** The sessions that sit in a transaction their work has left open: a row written in one is invisible to the observer, so this is how a rollback is seen from outside. */
  const transactionsLeftOpen = async (): Promise<number> =>
    (
      await reader.rows<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database() and state like 'idle in transaction%' and pid <> pg_backend_pid()`,
      )
    )[0]?.n ?? 0;

  // Break caught: the budget raced and not enforced: the client told 503 while the statement runs to its end and the transaction commits. The statement is cancelled from
  // another connection, the transaction rolled back and the connection destroyed.
  it('is answered 503 when the budget runs out, its write is rolled back, and the statement is no longer running', async () => {
    const answered = postManual('statement?body=cancelled-manual');
    await eventually(async () => (await sleepingStatements()) === 1, 'the statement to be running');

    started().clock.advance(BUDGET_MS);
    const response = await answered;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    expect(await notes('cancelled-manual')).toEqual([{ n: 0 }]);
    // The sleep was cancelled, not left to run its thirty seconds: no session of the API is still running it.
    await eventually(
      async () => (await sleepingStatements()) === 0,
      'the cancelled statement to leave pg_stat_activity',
    );
  });

  // Break caught: a transaction left open until the work decides to end it, or a write made after the answer. The work heeds nothing, but everything it asks of the database
  // after the expiry is refused. The work is still at its gate when the answer is given, so the rollback at the expiry is seen before the work wakes.
  it('is answered 503, the transaction is rolled back at the expiry before the work goes on, and the late write is refused and absent', async () => {
    const answered = postManual(
      'gated-open-transaction?body=held-manual&late=late-in-tx-manual&gate=open-transaction',
    );
    await atGate('open-transaction');

    // Open, and well inside its budget: the work's session sits in its transaction with the row written.
    await eventually(
      async () => (await transactionsLeftOpen()) === 1,
      'the transaction to be open',
    );

    started().clock.advance(BUDGET_MS);
    const response = await answered;

    expect(response.status).toBe(503);
    // At the answer, and not later, the transaction is rolled back: it was done at the expiry by the database layer, which says so before it fails the work, and not when
    // the work ended (it has not ended: it is at its gate). The server's own transaction bound would end it a few seconds later whatever the application did, so this is not
    // waited for. A row an open transaction wrote is invisible to the observer, so the row's absence alone would not tell a rollback from a transaction left open.
    expect(
      recordsManual().find(
        (record) => record.msg === 'database transaction abandoned: its budget ran out',
      ),
    ).toMatchObject({ level: 'warn', label: 'request', phase: 'working' });
    expect(await transactionsLeftOpen()).toBe(0);
    expect(await notes('held-manual')).toEqual([{ n: 0 }]);
    gates.get('open-transaction')?.();
    await eventually(
      () =>
        Promise.resolve(
          recordsManual().some(
            (record) => record.msg === 'pipeline fixture: the late write was refused',
          ),
        ),
      'the late write to be attempted',
    );
    expect(await notes('late-in-tx-manual')).toEqual([{ n: 0 }]);
    expect(await notes('held-manual')).toEqual([{ n: 0 }]);
    expect(
      recordsManual().some(
        (record) => record.msg === 'pipeline fixture: the late write was accepted',
      ),
    ).toBe(false);
  });

  // Break caught: a client left waiting for work that never looks at its budget, or work that begins a transaction on behalf of a request that has been answered.
  it('is answered 503 by the pipeline when the work heeds nothing, and what the work tries afterwards is refused and absent', async () => {
    const answered = postManual('gated-deaf?late=late-after-answer-manual&gate=deaf');
    await atGate('deaf');

    started().clock.advance(BUDGET_MS);
    const response = await answered;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    gates.get('deaf')?.();
    await eventually(
      () =>
        Promise.resolve(
          recordsManual().some(
            (record) => record.msg === 'pipeline fixture: the late transaction was refused',
          ),
        ),
      'the late transaction to be attempted',
    );
    expect(await notes('late-after-answer-manual')).toEqual([{ n: 0 }]);
    expect(
      recordsManual().some(
        (record) => record.msg === 'pipeline fixture: the late transaction was accepted',
      ),
    ).toBe(false);
    // Said once, as a warning: the pipeline answered; and not as a defect.
    const said = recordsManual().filter(
      (record) => record.msg === 'request answered by the pipeline: its work outlasted the budget',
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ level: 'warn' });
  });
});

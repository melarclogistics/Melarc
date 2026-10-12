import { Controller, Inject, Module, Post, Query } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../src/app.module.js';
import { API_RUNTIME_ROLE, loadConfig } from '../../src/platform/config/load-config.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import { currentBudget } from '../../src/platform/execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../src/platform/execution/execution-parameters.js';
import { LOGGER } from '../../src/platform/platform.tokens.js';
import { TechnicalEndpoint } from '../../src/platform/routes/access-declaration.js';
import { validEnv } from '../../src/test-support/config-env.js';
import { startTestApp, type TestApp } from '../../src/test-support/test-app.js';
import { observe, type Observer } from './support/observe.js';
import { applyFixture, HUB_A, staffContext } from './support/rls-fixture.js';
import { createTestDatabase, withClient, type TestDatabase } from './support/test-database.js';

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

@Controller('pipeline')
@TechnicalEndpoint()
class PipelineFixtureController {
  constructor(
    private readonly db: DatabaseService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

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

describe('a request whose statement outlasts the budget', () => {
  // Break caught: the budget raced and not enforced: the client told 503 while the statement runs to its end and the transaction
  // commits. The statement is cancelled from another connection, the transaction rolled back and the connection destroyed.
  it('is answered 503 at the budget, its write is rolled back, and the statement is no longer running', async () => {
    const started = Date.now();

    const response = await post('statement?body=cancelled');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    // Answered by the work's own failure, which the database layer raised within its disposal bound, not by the fallback.
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS);
    expect(await notes('cancelled')).toEqual([{ n: 0 }]);
    // The sleep was cancelled, not left to run its thirty seconds: no session of the API is still running it.
    await eventually(
      async () =>
        (
          await reader.rows<{ n: number }>(
            `select count(*)::int as n from pg_stat_activity where datname = current_database() and query like '%pg_sleep(30)%' and pid <> pg_backend_pid() and state <> 'idle'`,
          )
        )[0]?.n === 0,
      'the cancelled statement to leave pg_stat_activity',
    );
  });
});

describe('a request whose work waits outside the database, inside its transaction, past the budget', () => {
  // Break caught: a transaction left open until the work decides to end it, or a write made after the answer. The work heeds
  // nothing, but everything it asks of the database after the expiry is refused.
  it('is answered 503, the transaction is rolled back at the expiry, and the late write is refused and absent', async () => {
    const started = Date.now();

    const response = await post('open-transaction?body=held&late=late-in-tx');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS);
    // At the answer the row the transaction wrote is already gone: it was rolled back at the expiry, not when the work ended.
    expect(await notes('held')).toEqual([{ n: 0 }]);
    await eventually(
      () =>
        Promise.resolve(
          records().some((record) => record.msg === 'pipeline fixture: the late write was refused'),
        ),
      'the late write to be attempted',
    );
    expect(await notes('late-in-tx')).toEqual([{ n: 0 }]);
    expect(await notes('held')).toEqual([{ n: 0 }]);
    expect(
      records().some((record) => record.msg === 'pipeline fixture: the late write was accepted'),
    ).toBe(false);
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

describe('a request whose work heeds nothing', () => {
  // Break caught: a client left waiting for work that never looks at its budget, or work that begins a transaction on behalf of a
  // request that has been answered.
  it('is answered 503 by the pipeline, and what the work tries afterwards is refused and absent', async () => {
    const started = Date.now();

    const response = await post('deaf?late=late-after-answer');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service unavailable',
      request_id: response.headers.get('x-request-id'),
    });
    // Not before the database layer's own bound had passed, and not long after it.
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS + DISPOSAL_BOUND_MS - 100);
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS + 1_000);
    await eventually(
      () =>
        Promise.resolve(
          records().some(
            (record) => record.msg === 'pipeline fixture: the late transaction was refused',
          ),
        ),
      'the late transaction to be attempted',
    );
    expect(await notes('late-after-answer')).toEqual([{ n: 0 }]);
    expect(
      records().some(
        (record) => record.msg === 'pipeline fixture: the late transaction was accepted',
      ),
    ).toBe(false);
    // Said once, as a warning: the pipeline answered; and not as a defect.
    expect(
      records().filter(
        (record) =>
          record.msg === 'request answered by the pipeline: its work outlasted the budget',
      ),
    ).toHaveLength(1);
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

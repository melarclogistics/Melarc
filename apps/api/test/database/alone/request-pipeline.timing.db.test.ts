// Runs alone: its bounds (the budget plus the disposal bound) are wall-clock time.
// Functional half, which runs on a pull request: request-pipeline.db.test.ts (the same requests with the clock in the test's hands and no duration asserted; run 5, Stage 1.2).
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
import { startTestApp, type TestApp } from '../../../src/test-support/test-app.js';
import { applyFixture, HUB_A, staffContext } from '../support/rls-fixture.js';
import { createTestDatabase, withClient, type TestDatabase } from '../support/test-database.js';

/**
 * S0.20, the pipeline half of the execution budget (plan OB-37 and OB-55), over real HTTP and a real PostgreSQL: a request whose
 * work outlasts its budget is answered at the budget, and not when the work ends.
 *
 * The budget is the smallest the configuration accepts (one second), so each case takes about that long. The mechanism and
 * the database half are S0.6's, proved in `execution-budget.db.test.ts`; this file shows the request pipeline puts them to use.
 *
 * **Only the bounds are here** (run 5, Stage 1.2): how soon the answer comes, and that the database layer's own failure beats the pipeline's. That the write is rolled back, the
 * statement cancelled, the late write refused and absent and the pipeline's answer said once is asserted without any time by `request-pipeline.db.test.ts`, which a pull
 * request runs. Each test here waits for the work to go on to its end (the line it logs), so that nothing it does is left running into the next test or the end of the file.
 */
const BUDGET_MS = 1_000;

let database: TestDatabase;
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
  await database.drop();
});

afterEach(() => {
  // Each case names its own rows, so nothing needs to be cleared between them.
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

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

describe('a request whose statement outlasts the budget', () => {
  // Break caught: the budget raced and not enforced, or enforced late: the client told 503 only when the statement ends, or by the pipeline's fallback and not by the work's own
  // failure, which the database layer raises within its disposal bound.
  it('is answered 503 at the budget, by the work’s own failure and within the disposal bound', async () => {
    const started = Date.now();

    const response = await post('statement?body=cancelled');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS - 100);
    // Answered by the work's own failure, which the database layer raised within its disposal bound, not by the fallback.
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS);
  });
});

describe('a request whose work waits outside the database, inside its transaction, past the budget', () => {
  // Break caught: a transaction left open, and the client left waiting, until the work decides to end it (the work here waits for 2.2 seconds beyond the budget).
  it('is answered 503 at the expiry, not when the work ends', async () => {
    const started = Date.now();

    const response = await post('open-transaction?body=held&late=late-in-tx');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS);
    // The work goes on to its end, and is let finish before the next test.
    await eventually(
      () =>
        Promise.resolve(
          records().some((record) => record.msg === 'pipeline fixture: the late write was refused'),
        ),
      'the late write to be attempted',
    );
  });
});

describe('a request whose work heeds nothing', () => {
  // Break caught: a client left waiting for work that never looks at its budget, or answered before the database layer's own bound had passed.
  it('is answered 503 by the pipeline, once the budget and the disposal bound have passed and not long after', async () => {
    const started = Date.now();

    const response = await post('deaf?late=late-after-answer');
    const elapsed = Date.now() - started;

    expect(response.status).toBe(503);
    // Not before the database layer's own bound had passed, and not long after it.
    expect(elapsed).toBeGreaterThanOrEqual(BUDGET_MS + DISPOSAL_BOUND_MS - 100);
    expect(elapsed).toBeLessThan(BUDGET_MS + DISPOSAL_BOUND_MS + 1_000);
    // The work goes on to its end, and is let finish before the end of the file.
    await eventually(
      () =>
        Promise.resolve(
          records().some(
            (record) => record.msg === 'pipeline fixture: the late transaction was refused',
          ),
        ),
      'the late transaction to be attempted',
    );
  });
});

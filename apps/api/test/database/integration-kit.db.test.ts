import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CLOCK, type Clock } from '../../src/platform/auth/ports/clock.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { DatabaseService } from '../../src/platform/database/database.service.js';
import { runSeed } from '../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { DATABASE_POOL } from '../../src/platform/platform.tokens.js';
import { sameShape } from '../../src/test-support/work-shape.js';
import { referenceSeedPlan } from '../../src/tools/seed/reference-seed.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { staffContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.10, the integration kit's own tests (Gate 1): the real application over a real database of this file's own, with the hands
 * a test needs, shown to do what the later tasks will rely on. Each piece is shown in use against the real thing, not a double.
 */

let database: TestDatabase;
let kit: IntegrationKit;

beforeAll(async () => {
  database = await createTestDatabase();
  kit = await startIntegrationKit(database);
});

afterAll(async () => {
  await kit.stop();
  await database.drop();
});

const HUB = '5eed0100-0000-4000-8000-0000000000e1';

describe('the application, real, over a real database of its own', () => {
  // The application is wired as it ships: the runtime composition, connected as the API's login, over a pool of one.
  it('answers readiness through the test client, connected as melarc_api_runtime over a pool of one', async () => {
    const response = await kit.client.get('/readyz');
    expect(response.status).toBe(200);
    const pool = kit.app.app.get<{ options: { max: number; user?: string } }>(DATABASE_POOL);
    expect(pool.options.max).toBe(1);
    expect(
      await kit.observe.one<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = $1 and usename = 'melarc_api_runtime'`,
        [database.name],
      ),
    ).toEqual({ n: 1 });
  });

  it('answers a path that nothing serves with the contract’s envelope, through the same client', async () => {
    const response = await kit.client.get('/api/v1/no-such-operation');
    expect(response.status).toBe(404);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.json()).toMatchObject({ code: expect.any(String) as unknown });
  });

  // Break caught: a pool larger than the test asked for, which would hide a connection held across an await (a deadlock a pool of
  // one makes certain).
  it('does not leave a connection held after a request: two requests in a row on a pool of one', async () => {
    expect((await kit.client.get('/readyz')).status).toBe(200);
    expect((await kit.client.get('/readyz')).status).toBe(200);
  });
});

describe('the injected clock', () => {
  // Break caught: the application reading the machine's clock instead of the one it was given (a test could not reach an expiry),
  // or a kit whose clock is not the one the client and the jar read.
  it('is the clock the application resolves, and the client reads it too', () => {
    expect(kit.app.app.get<Clock>(CLOCK)).toBe(kit.clock);
    const before = kit.clock.now().getTime();
    kit.clock.advance(60_000);
    expect(kit.app.app.get<Clock>(CLOCK).now().getTime()).toBe(before + 60_000);
  });
});

describe('admin(): arranging what no operation arranges', () => {
  // The evidence of S0.10: aging a row by SQL. The row is made old by the database's own clock, which is the clock a persisted
  // expiry is judged by, and a second connection reads that it is old.
  it('ages a row by SQL, and a second connection reads that it is old', async () => {
    await kit.admin.query(`insert into hub (id, name) values ($1, 'Aged hub')`, [HUB]);
    const young = await kit.observe.one<{ old: boolean }>(
      `select (now() - created_at) >= interval '2 days' as old from hub where id = $1`,
      [HUB],
    );
    expect(young?.old).toBe(false);

    expect(await kit.admin.ageRows('hub', 'created_at', '2 days', { id: HUB })).toBe(1);

    const aged = await kit.observe.one<{ old: boolean }>(
      `select (now() - created_at) >= interval '2 days' as old from hub where id = $1`,
      [HUB],
    );
    expect(aged?.old).toBe(true);
  });

  // Break caught: an arrangement that reaches rows it was not told to (every row aged for one), or one that reaches none.
  it('reaches only the rows it is told to, and none when none match', async () => {
    const other = '5eed0100-0000-4000-8000-0000000000e2';
    await kit.admin.query(`insert into hub (id, name) values ($1, 'Other hub')`, [other]);
    const before = await kit.observe.one<{ created_at: Date }>(
      'select created_at from hub where id = $1',
      [other],
    );
    expect(await kit.admin.ageRows('hub', 'created_at', '1 day', { name: 'No such hub' })).toBe(0);
    expect(await kit.admin.ageRows('hub', 'created_at', '1 day', { id: HUB })).toBe(1);
    const after = await kit.observe.one<{ created_at: Date }>(
      'select created_at from hub where id = $1',
      [other],
    );
    expect(after?.created_at).toEqual(before?.created_at);
    await kit.admin.query('delete from hub where id = $1', [other]);
  });

  it('changes a status or a column on the rows it names', async () => {
    expect(await kit.admin.setColumn('hub', 'name', 'Renamed hub', { id: HUB })).toBe(1);
    expect(await kit.observe.count('hub', { name: 'Renamed hub' })).toBe(1);
  });

  // Break caught: a name that is not a name, which would let a test string be SQL. The helpers take plain identifiers only.
  it('refuses a table or column name that is not a plain name', async () => {
    await expect(kit.admin.ageRows('hub; drop table hub', 'created_at', '1 day')).rejects.toThrow(
      /plain table or column name/,
    );
    await expect(kit.admin.setColumn('hub', 'name = name --', 'x')).rejects.toThrow(
      /plain table or column name/,
    );
    await expect(kit.observe.count('hub"')).rejects.toThrow(/plain table or column name/);
  });

  // Break caught: a broken write that does not fail the write, one that is not mended, and one that fails writes of a table it was
  // not told about. The seed (a real write path of the provisioning login) is shown failing and leaving nothing, and then working.
  it('breaks writes to a table, so an operation fails in the middle and leaves nothing, and mends them', async () => {
    const empty = await createTestDatabase();
    const emptyKit = await startIntegrationKit(empty);
    const { service, close } = buildService(empty, { login: PROVISIONING_ROLE });
    try {
      const broken = await emptyKit.admin.breakWrites('reason_code');
      const failure = await runSeed(service, referenceSeedPlan()).catch((error: unknown) => error);
      expect(serverErrorIn(failure)?.code).toBe('P0001');
      expect(serverErrorIn(failure)?.message).toMatch(/write refused by the test kit/);
      // Every table written before the last is rolled back with it, seen from the second connection.
      for (const table of ['hub', 'permission', 'role_bundle', 'role_bundle_grant', 'setting']) {
        expect(await emptyKit.observe.count(table), table).toBe(0);
      }
      await broken.mend();
      await runSeed(service, referenceSeedPlan());
      expect(await emptyKit.observe.count('hub')).toBe(1);
    } finally {
      await close();
      await emptyKit.stop();
      await empty.drop();
    }
  });
});

describe('observe(): a second connection that only reads', () => {
  // Break caught: an observer that could write, which would let a test arrange data through the very handle it asserts with.
  it('is refused a write, at the server', async () => {
    const failure = await kit.observe
      .rows(`insert into hub (id, name) values ('5eed0100-0000-4000-8000-0000000000e3', 'x')`)
      .catch((error: unknown) => error);
    expect(serverErrorIn(failure)?.code).toBe('25006');
    expect(await kit.observe.count('hub', { id: '5eed0100-0000-4000-8000-0000000000e3' })).toBe(0);
  });

  // The evidence of S0.10: a refusal read from a second connection. The application's own login is refused a write by the
  // database (it holds SELECT and nothing more on the reference tables); the second connection shows the row was never written.
  it('shows a refusal by the rows that did not change', async () => {
    const service = kit.app.app.get(DatabaseService);
    const before = await kit.observe.count('hub');
    const failure = await service
      .transactionWithContext(staffContext([], 'ALL'), async (tx) => {
        await tx.execute(
          sql`insert into hub (id, name) values ('5eed0100-0000-4000-8000-0000000000e4', 'Refused hub')`,
        );
      })
      .catch((error: unknown) => error);
    expect(serverErrorIn(failure)?.code).toBe('42501');
    expect(await kit.observe.count('hub')).toBe(before);
    expect(await kit.observe.count('hub', { name: 'Refused hub' })).toBe(0);
  });

  // Break caught: an observer that sees an open transaction's uncommitted rows (it cannot: it is another connection), or a count
  // taken on the application's pool, which a pool of one would block.
  it('does not wait for the application’s connection', async () => {
    const service = kit.app.app.get(DatabaseService);
    let counted = -1;
    await service.transactionWithContext(staffContext([], 'ALL'), async (tx) => {
      await tx.execute(sql`select 1`);
      counted = await kit.observe.count('hub');
    });
    expect(counted).toBeGreaterThanOrEqual(1);
  });
});

describe('the capture reader', () => {
  // The evidence of S0.10: empty by default. Nothing writes to it until a delivery adapter in capture mode is bound (S0.17).
  it('is empty by default, and reads what a sink is given', () => {
    expect(kit.capture.all()).toEqual([]);
    expect(kit.capture.size).toBe(0);
    kit.captureSink.push({ to: 'someone' });
    expect(kit.capture.last()).toEqual({ to: 'someone' });
    kit.captureSink.clear();
    expect(kit.capture.all()).toEqual([]);
  });
});

describe('the work-shape tracer', () => {
  // Break caught: a tracer that records the application only in theory. It sees what the real service sent over the real
  // connection, bracketed by the transaction, and nothing of the administrator's or the observer's own statements.
  it('records what the application’s login sent, as shapes, and not the administrator’s or the observer’s statements', async () => {
    const service = kit.app.app.get(DatabaseService);
    const traced = await kit.trace(async () => {
      await kit.observe.count('hub');
      await kit.admin.query('select 1');
      await service.transactionWithContext(staffContext([], 'ALL'), async (tx) => {
        await tx.execute(sql`select name from hub where id = ${HUB}`);
      });
    });
    expect(traced.statements[0]).toMatch(/^begin/);
    expect(traced.statements.at(-1)).toBe('commit');
    expect(traced.statements).toContain('select name from hub where id = ?');
    expect(traced.statements.some((statement) => statement.includes('count(*)'))).toBe(false);
    expect(traced.statements).not.toContain('select ?');
  });

  // The use it is built for: two runs that differ only in a value have one shape, and a run that does more has another.
  it('gives two runs that differ in a value one shape, and a run that does more another', async () => {
    const service = kit.app.app.get(DatabaseService);
    const run = (name: string, extra = false) =>
      kit.trace(() =>
        service.transactionWithContext(staffContext([], 'ALL'), async (tx) => {
          await tx.execute(sql`select name from hub where name = ${name}`);
          if (extra) await tx.execute(sql`select count(*) from permission`);
        }),
      );
    const first = await run('Renamed hub');
    const second = await run('A hub that is not there');
    const third = await run('Renamed hub', true);
    expect(sameShape(first.statements, second.statements)).toBe(true);
    expect(sameShape(first.statements, third.statements)).toBe(false);
  });
});

describe('a database of its own for each file, and several at once (Stop if: parallel files cannot each have one)', () => {
  // The stop condition of S0.10. Two databases made at the same time are two databases, each migrated, each with its own data and
  // its own application, and neither sees the other's rows.
  it('makes two disposable databases concurrently, and two applications over them do not see each other’s rows', async () => {
    const [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
    try {
      expect(first.name).not.toBe(second.name);
      const [one, two] = await Promise.all([
        startIntegrationKit(first),
        startIntegrationKit(second),
      ]);
      try {
        expect(one.app.baseUrl).not.toBe(two.app.baseUrl);
        await one.admin.query(`insert into hub (id, name) values ($1, 'Only in one')`, [HUB]);
        expect(await one.observe.count('hub')).toBe(1);
        expect(await two.observe.count('hub')).toBe(0);
        expect((await one.client.get('/readyz')).status).toBe(200);
        expect((await two.client.get('/readyz')).status).toBe(200);
      } finally {
        await Promise.all([one.stop(), two.stop()]);
      }
    } finally {
      await Promise.all([first.drop(), second.drop()]);
    }
  });
});

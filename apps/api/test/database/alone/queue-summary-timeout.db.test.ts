// Runs alone: its tests set the server's statement timeout of a pooled connection and read it back, which a server busy with other files would disturb.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../../src/platform/config/inert-config.js';
import type { DatabaseTransaction } from '../../../src/platform/database/database.service.js';
import { limitStatements } from '../../../src/platform/queue-summary/statement-limit.js';
import { withHandle } from '../support/handle.js';
import { staffContext } from '../support/rls-fixture.js';
import { buildService } from '../support/service.js';
import { API, HUB_A, startStaffRoutes, type StaffRoutes } from '../support/staff-routes.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * The bound on a count (`AC-QSUM-13`; the Product Owner's decision of 6 November 2026): every statement of `getQueueSummary` is bounded at
 * three seconds by a `SET LOCAL statement_timeout` in the transaction of its counts. Two proofs against a real PostgreSQL: the limiter
 * itself (it only lowers the bound, ends with the transaction, and replaces "none"), and the operation (a count that cannot finish ends the
 * read as the platform's failed read, after three seconds and not after the pool's wait, and the next read is not affected).
 *
 * This file asserts no time, so a pull request runs it: the limiter's setting is read back, and the failed read is made by cancelling the waiting statement from another
 * connection, which the server reports as the statement timeout does (SQLSTATE 57014), so it takes the same path through the platform. That the bound ends the read after
 * three seconds and not after the four of the lock wait is `queue-summary-timeout.timing.db.test.ts` (run 5, Stage 1.2).
 */
describe('the limiter', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await database.drop();
  });

  /** The statement timeout the transaction sees after the limiter (and `before`, if given), and the one the next transaction of the same pooled connection sees. */
  const timeoutIn = async (
    statementTimeoutMs: number,
    before: (tx: DatabaseTransaction) => Promise<unknown> = () => Promise.resolve(),
  ): Promise<{
    readonly inside: string;
    readonly after: string;
    readonly sameConnection: boolean;
  }> => {
    const built = buildService(database, {
      poolMax: 1,
      deadlines: { ...INERT_DEADLINES, statementTimeoutMs, lockTimeoutMs: 1000 },
    });
    const read = async (tx: DatabaseTransaction): Promise<string> => {
      const result = await tx.execute(
        sql`select current_setting('statement_timeout') as value, pg_backend_pid() as pid`,
      );
      const row = result.rows[0] as { value: string; pid: number } | undefined;
      return `${row?.value ?? ''}@${String(row?.pid ?? 0)}`;
    };
    try {
      const inside = await withHandle(built.service, staffContext([HUB_A]), async (handle, tx) => {
        await before(tx);
        await limitStatements(handle, 3000);
        return read(tx);
      });
      // The pool has one connection: the next transaction is on the same one, and meets the setting it was left with.
      const after = await withHandle(built.service, staffContext([HUB_A]), (_handle, tx) =>
        read(tx),
      );
      const split = (seen: string): [string, string] => {
        const at = seen.lastIndexOf('@');
        return [seen.slice(0, at), seen.slice(at + 1)];
      };
      const [insideValue, insidePid] = split(inside);
      const [afterValue, afterPid] = split(after);
      return { inside: insideValue, after: afterValue, sameConnection: insidePid === afterPid };
    } finally {
      await built.close();
    }
  };

  // Break caught: no bound at all, one in milliseconds read as seconds, or one that outlives the transaction on a pooled connection.
  it('bounds the statements of its transaction at three seconds and leaves the connection as it was', async () => {
    const { inside, after, sameConnection } = await timeoutIn(8000);

    expect(inside).toBe('3s');
    // On the one connection of the pool, and back at the setting the pool gave it.
    expect(sameConnection).toBe(true);
    expect(after).toBe('8s');
  });

  // Break caught: a limiter that raises a lower bound the configuration chose, which would let a deployment's own safety be undone.
  it('only lowers the bound: a statement timeout the configuration set lower is kept', async () => {
    const { inside, after, sameConnection } = await timeoutIn(1500);

    expect(inside).toBe('1500ms');
    expect(sameConnection).toBe(true);
    expect(after).toBe('1500ms');
  });

  // Break caught: "no statement timeout" (0) read as the lowest of all, which would make the bound zero.
  it('replaces "none" by the bound', async () => {
    const { inside } = await timeoutIn(8000, async (tx) => {
      await tx.execute(sql`set local statement_timeout = 0`);
    });

    expect(inside).toBe('3s');
  });
});

const SUMMARY = `${API}/ops/queue-summary`;

describe('the operation, with the failure made by a cancel and not by the clock (run 5, Stage 1.2; how soon it ends is queue-summary-timeout.timing.db.test.ts)', () => {
  let routes: StaffRoutes;
  beforeAll(async () => {
    // The bounds nest as the configuration requires, and the lock wait (4 s) and the pool's statement timeout (6 s) are longer than the summary's own bound (3 s): whatever
    // ends the wait here is the cancel the test makes, long before any of them, and no assertion reads the time.
    routes = await startStaffRoutes({
      env: { DATABASE_STATEMENT_TIMEOUT_MS: '6000', DATABASE_LOCK_TIMEOUT_MS: '4000' },
    });
  }, 240_000);
  afterAll(async () => {
    await routes.stop();
  });

  const sleep = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });

  /** Waits until some statement of the test database is waiting on a lock: the count that the test holds has reached the table it holds. */
  async function waitForALockWait(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [waiting] = await routes.rows<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      );
      if ((waiting?.waiting ?? 0) > 0) return;
      await sleep(50);
    }
    throw new Error('no statement waited on the lock the test holds');
  }

  // Break caught: a summary whose failed count is told as something other than the platform's failed read (a 500 with a code, or a body that tells why), or that leaves the
  // next read broken. The cancel is reported by the server as the statement timeout is (SQLSTATE 57014, which the platform reads as the database's time bound).
  it('ends a count that cannot finish as the failed read of the platform, and the next read is whole', async () => {
    const officer = await routes.opsStaff(HUB_A);
    const first = await officer.client.get(SUMMARY);
    expect(first.status).toBe(200);

    // A lock on the table the counts read, held by another connection: the count waits for it, and is cancelled while it waits.
    await routes.admin.query('begin');
    let blocked: Awaited<ReturnType<typeof officer.client.get>>;
    try {
      await routes.admin.query('lock table pickup_request in access exclusive mode');
      const pending = officer.client.get(SUMMARY);
      await waitForALockWait();
      await routes.admin.query(
        `select pg_cancel_backend(pid) from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`,
      );
      blocked = await pending;
    } finally {
      await routes.admin.query('rollback');
    }

    expect(blocked.status).toBe(503);
    expect((blocked.json() as { code?: string }).code).toBeUndefined();
    // The platform's own words and a request id, and nothing of the statement, the table or the SQLSTATE (the request id is random, so it is left
    // out of what is searched: its characters can spell anything).
    const body = blocked.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['message', 'request_id']);
    expect(String(body.message)).not.toMatch(/statement|timeout|pickup_request|57014/i);

    const again = await officer.client.get(SUMMARY);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
  }, 60_000);
});

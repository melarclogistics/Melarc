// Runs alone: its tests set the server's statement timeout of a pooled connection and read it back, which a server busy with other files would disturb.
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../../src/platform/config/inert-config.js';
import type { DatabaseTransaction } from '../../../src/platform/database/database.service.js';
import { limitStatements } from '../../../src/platform/queue-summary/statement-limit.js';
import { withHandle } from '../support/handle.js';
import { staffContext } from '../support/rls-fixture.js';
import { buildService } from '../support/service.js';
import { HUB_A } from '../support/staff-routes.js';
import { createTestDatabase, type TestDatabase } from '../support/test-database.js';

/**
 * The bound on a count (`AC-QSUM-13`; the Product Owner's decision of 6 November 2026): every statement of `getQueueSummary` is bounded at
 * three seconds by a `SET LOCAL statement_timeout` in the transaction of its counts. Two proofs against a real PostgreSQL: the limiter
 * itself (it only lowers the bound, ends with the transaction, and replaces "none"), and the operation (a count that cannot finish ends the
 * read as the platform's failed read, after three seconds and not after the pool's wait, and the next read is not affected).
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

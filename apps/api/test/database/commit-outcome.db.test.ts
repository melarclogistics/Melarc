import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CommitOutcomeUnknownError,
  TransactionRolledBackError,
  serverErrorIn,
} from '../../src/platform/database/database-failures.js';
import { applyFixture, HUB_A, staffContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * The answer to COMMIT, against a real PostgreSQL, as `melarc_api_runtime` (correction F01 of Stage 1). A transaction in which a
 * statement was refused and the work carried on is aborted; PostgreSQL answers its COMMIT with the command tag `ROLLBACK` and no
 * error, so a caller that only waits for COMMIT to resolve is told its rows were saved when none were. What was or was not
 * committed is read from a second connection (the administrator), never from the one that did the work.
 */

const STAFF = staffContext([HUB_A]);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await withClient(database.urlFor('postgres'), async (admin) => {
    // A commit the server refuses: a deferred constraint trigger that raises when the transaction commits.
    await admin.query(`
      create function rls_fixture.refuse_at_commit() returns trigger language plpgsql as
        $$ begin raise exception 'refused at commit' using errcode = '23514'; end $$;
      create constraint trigger refuse_at_commit after insert on rls_fixture.notes
        deferrable initially deferred for each row when (new.body = 'refuse at commit')
        execute function rls_fixture.refuse_at_commit();
    `);
  });
});

afterAll(async () => {
  await database.drop();
});

const committed = (body: string): Promise<number> =>
  withClient(database.urlFor('postgres'), async (admin) =>
    Number(
      await scalar(admin, 'select count(*)::int from rls_fixture.notes where body = $1', [body]),
    ),
  );

const insert = (body: string) =>
  sql`insert into rls_fixture.notes (hub_id, body) values (${HUB_A}, ${body})`;

describe('the answer to COMMIT is read (F01)', () => {
  // Control: the ordinary commit, which the checks below must not disturb.
  it('returns the work’s value and keeps the row when the server completes COMMIT as COMMIT', async () => {
    const { service, close } = buildService(database);
    try {
      const value = await service.transactionWithContext(STAFF, async (tx) => {
        await tx.execute(insert('kept'));
        return { saved: true };
      });
      expect(value).toEqual({ saved: true });
      expect(await committed('kept')).toBe(1);
    } finally {
      await close();
    }
  });

  // Reproduction and regression of F01. The row is written, a statement is then refused inside the same transaction, the work
  // catches the refusal and returns a success-shaped value. Before the correction the service returned that value and the row
  // was gone; now it rejects, with the refusal as its cause, and the second connection sees no row.
  it('rejects when the work carried on after a refused statement, and nothing was committed', async () => {
    const { service, close } = buildService(database);
    try {
      const outcome = await service
        .transactionWithContext(STAFF, async (tx) => {
          await tx.execute(insert('must not persist'));
          try {
            await tx.execute(sql`select 1/0 as division`);
          } catch {
            // the work catches the error and goes on, as if the transaction were still sound
          }
          return { saved: true };
        })
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );

      expect(outcome).toHaveProperty('error');
      const { error } = outcome as { error: unknown };
      expect(error).toBeInstanceOf(TransactionRolledBackError);
      // A definite failure, not the unknown outcome: nothing was committed and a retry is safe.
      expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
      // The cause is the statement the server refused.
      expect(serverErrorIn(error)?.code).toBe('22012');
      expect(await committed('must not persist')).toBe(0);

      // The connection that failed to commit was replaced, and the next transaction commits.
      await service.transactionWithContext(STAFF, (tx) => tx.execute(insert('after the failure')));
      expect(await committed('after the failure')).toBe(1);
    } finally {
      await close();
    }
  });

  // Control: a refusal the work does not catch is the refusal, as before, and nothing is committed.
  it('passes on a refusal the work did not catch, and commits nothing', async () => {
    const { service, close } = buildService(database);
    try {
      const error = await service
        .transactionWithContext(STAFF, async (tx) => {
          await tx.execute(insert('uncaught refusal'));
          await tx.execute(sql`select 1/0 as division`);
        })
        .catch((failure: unknown) => failure);
      expect(serverErrorIn(error)?.code).toBe('22012');
      expect(error).not.toBeInstanceOf(TransactionRolledBackError);
      expect(await committed('uncaught refusal')).toBe(0);
    } finally {
      await close();
    }
  });

  // Retained coverage: a commit the server refuses with an error is that error, a definite failure that committed nothing.
  it('reports a commit the server refuses with an error as that error', async () => {
    const { service, close } = buildService(database);
    try {
      const error = await service
        .transactionWithContext(STAFF, (tx) => tx.execute(insert('refuse at commit')))
        .catch((failure: unknown) => failure);
      expect(serverErrorIn(error)?.code).toBe('23514');
      expect(error).not.toBeInstanceOf(CommitOutcomeUnknownError);
      expect(error).not.toBeInstanceOf(TransactionRolledBackError);
      expect(await committed('refuse at commit')).toBe(0);
    } finally {
      await close();
    }
  });

  // A savepoint is the legitimate way to carry on after a refused statement: the transaction is sound, and the commit is a commit.
  it('commits a transaction that recovered from a refused statement with a savepoint', async () => {
    const { service, close } = buildService(database);
    try {
      await service.transactionWithContext(STAFF, async (tx) => {
        await tx.execute(insert('recovered'));
        await tx.execute(sql`savepoint attempt`);
        try {
          await tx.execute(sql`select 1/0 as division`);
        } catch {
          await tx.execute(sql`rollback to savepoint attempt`);
        }
      });
      expect(await committed('recovered')).toBe(1);
    } finally {
      await close();
    }
  });
});

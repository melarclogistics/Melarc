import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { CapturedLogs } from '../../../test-support/captured-logs.js';
import {
  FakeConnection,
  FakePool,
  serverError,
  testRuntime,
} from '../../../test-support/fake-pg.js';
import { ReadinessRegistry } from '../../health/readiness.registry.js';
import { ShutdownRegistry } from '../../lifecycle/shutdown.registry.js';
import { DatabaseDeadlineError } from '../database-failures.js';
import { DatabaseService, type DatabaseTransaction } from '../database.service.js';
import type { SecurityContext } from '../transaction-context.js';
import { PolicyIsolationError, acquirePolicyLocks, heldPolicyLocks } from './acquire.js';
import { AUTH_POLICY_BUNDLE, AUTH_POLICY_FIXED, PolicyLockError } from './lock-keys.js';
import { planPolicyLocks } from './plan.js';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'unit-test',
};

const READ_COMMITTED = [{ level: 'read committed' }];

function build(level: unknown[] = READ_COMMITTED) {
  const pool = new FakePool();
  const connection = new FakeConnection().answer(/transaction_isolation/, level);
  pool.hand(connection);
  const service = new DatabaseService(
    pool as unknown as Pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    testRuntime(),
  );
  return { service, connection };
}

const PLAN = planPolicyLocks([
  { class: AUTH_POLICY_FIXED, key: 1, mode: 'shared' },
  { class: AUTH_POLICY_BUNDLE, key: -7, mode: 'exclusive' },
  { class: AUTH_POLICY_BUNDLE, key: 9, mode: 'shared' },
]);

/** The statements after the transaction began and its context was set. */
const afterContext = (connection: FakeConnection): string[] => connection.workStatements.slice(1);

describe('acquirePolicyLocks: the locks come first, in the plan’s order (SECURITY_DESIGN.md §13.10a)', () => {
  // Break caught: locks taken out of the plan’s order (two operations with overlapping sets then wait for each other), or by a
  // function that outlives the transaction.
  it('takes each lock, one statement each, in the plan’s order, with the transaction-scoped function of its mode', async () => {
    const { service, connection } = build();

    await service.transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN));

    const locks = afterContext(connection).filter((text) => text.includes('pg_advisory'));
    expect(locks).toEqual([
      'select pg_advisory_xact_lock($1::int4, $2::int4)',
      'select pg_advisory_xact_lock_shared($1::int4, $2::int4)',
      'select pg_advisory_xact_lock_shared($1::int4, $2::int4)',
    ]);
    const indexes = connection.statements
      .map((text, at) => (text.includes('pg_advisory') ? at : -1))
      .filter((at) => at >= 0);
    expect(indexes.map((at) => connection.values[at])).toEqual([
      [AUTH_POLICY_BUNDLE, -7],
      [AUTH_POLICY_BUNDLE, 9],
      [AUTH_POLICY_FIXED, 1],
    ]);
  });

  // Break caught: a function that is not transaction-scoped, a `pg_try_` that returns false instead of waiting, or a lock built
  // into the statement text instead of bound.
  it('uses only the transaction-scoped functions, and binds the class and the key', async () => {
    const { service, connection } = build();

    await service.transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN));

    const text = connection.statements.join('\n');
    expect(text).toMatch(/pg_advisory_xact_lock/);
    expect(text).not.toMatch(/pg_advisory_lock|pg_advisory_unlock|pg_try_advisory/);
    for (const statement of connection.statements.filter((each) => each.includes('pg_advisory'))) {
      expect(statement).not.toMatch(/\d{4,}/);
    }
  });

  // Break caught: the isolation level read after the locks (a snapshot older than the locks may already exist), or not read.
  it('checks the isolation level before the first lock', async () => {
    const { service, connection } = build();

    await service.transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN));

    const texts = afterContext(connection);
    expect(texts[0]).toMatch(/current_setting\('transaction_isolation'\)/);
    expect(texts.slice(1).every((text) => text.includes('pg_advisory'))).toBe(true);
  });

  it.each([['repeatable read'], ['serializable']])(
    'refuses a transaction at %s and takes no lock',
    async (level) => {
      const { service, connection } = build([{ level }]);

      const failure = await service
        .transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PolicyIsolationError);
      expect(failure).toBeInstanceOf(PolicyLockError);
      expect((failure as PolicyIsolationError).level).toBe(level);
      expect(connection.statements.some((text) => text.includes('pg_advisory'))).toBe(false);
    },
  );

  it('refuses a transaction whose isolation level cannot be read', async () => {
    const { service, connection } = build([]);

    await expect(
      service.transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN)),
    ).rejects.toBeInstanceOf(PolicyIsolationError);
    expect(connection.statements.some((text) => text.includes('pg_advisory'))).toBe(false);
  });

  // Break caught: a lock taken after the transaction already read or wrote data, so the data was read before the content was
  // protected: the whole point of "locks first".
  it('refuses to take a lock after any other statement, and takes none', async () => {
    const { service, connection } = build();

    const failure = await service
      .transactionWithContext(STAFF, async (tx) => {
        await tx.execute(sql`select 1 as work`);
        await acquirePolicyLocks(tx, PLAN);
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolicyLockError);
    expect((failure as Error).message).toMatch(/before any other statement/);
    expect(connection.statements.some((text) => text.includes('pg_advisory'))).toBe(false);
  });

  // Break caught: the security-context statement counted as a data statement, so no operation could ever take its locks.
  it('does allow the context statement before the locks: it is configuration, not data', async () => {
    const { service } = build();
    await expect(
      service.transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN)),
    ).resolves.toBeUndefined();
  });

  // Break caught: a statement issued beside the acquisition (Promise.all), which may run before the locks and read what they were
  // meant to protect. It cannot be stopped from being sent; it is caught, and the transaction rolls back.
  it('fails the transaction when another statement is issued while the locks are being taken', async () => {
    const { service, connection } = build();

    const failure = await service
      .transactionWithContext(STAFF, async (tx) => {
        await Promise.all([acquirePolicyLocks(tx, PLAN), tx.execute(sql`select 1 as sneaked`)]);
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolicyLockError);
    expect((failure as Error).message).toMatch(/while the policy locks were being taken/);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.statements).not.toContain('commit');
  });

  // Break caught: a second acquisition in one transaction, which is how a key held shared is asked for exclusive.
  it('takes the locks once per transaction: a second call is refused', async () => {
    const { service, connection } = build();

    const failure = await service
      .transactionWithContext(STAFF, async (tx) => {
        await acquirePolicyLocks(
          tx,
          planPolicyLocks([{ class: AUTH_POLICY_BUNDLE, key: 1, mode: 'shared' }]),
        );
        await acquirePolicyLocks(
          tx,
          planPolicyLocks([{ class: AUTH_POLICY_BUNDLE, key: 1, mode: 'exclusive' }]),
        );
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolicyLockError);
    expect((failure as Error).message).toMatch(/once/);
    expect(
      connection.statements.filter((text) => text.startsWith('select pg_advisory_xact_lock(')),
    ).toHaveLength(0);
  });

  it('records what the transaction holds, for the code that must not ask for more', async () => {
    const { service } = build();

    const held = await service.transactionWithContext(STAFF, async (tx) => {
      const before = heldPolicyLocks(tx);
      await acquirePolicyLocks(tx, PLAN);
      return { before, after: heldPolicyLocks(tx) };
    });

    expect(held.before).toBeUndefined();
    expect(held.after).toEqual(PLAN);
  });

  // Break caught: the toolkit used on a transaction it did not open, where nothing knows what was sent before.
  it('refuses a handle that is not a transaction of the database service', async () => {
    const stray = drizzle({ query: () => Promise.reject(new Error('never used')) } as never);

    await expect(acquirePolicyLocks(stray as DatabaseTransaction, PLAN)).rejects.toBeInstanceOf(
      PolicyLockError,
    );
  });

  // Break caught: a lock-wait timeout reported as a bare driver error, or treated as success.
  it('lets a lock timeout through as the database’s deadline error, rolled back', async () => {
    const { service, connection } = build();
    connection.fail(/pg_advisory_xact_lock_shared/, serverError('55P03', 'could not obtain lock'));

    const failure = await service
      .transactionWithContext(STAFF, (tx) => acquirePolicyLocks(tx, PLAN))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatabaseDeadlineError);
    expect((failure as DatabaseDeadlineError).kind).toBe('lock');
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.statements).not.toContain('commit');
  });

  it('takes nothing, and still checks the level, for an empty plan', async () => {
    const { service, connection } = build();

    await service.transactionWithContext(STAFF, (tx) =>
      acquirePolicyLocks(tx, planPolicyLocks([])),
    );

    expect(afterContext(connection)).toHaveLength(1);
  });
});

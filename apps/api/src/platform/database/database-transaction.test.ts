import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DatabaseService, type DatabaseTransaction } from './database.service.js';
import type { SecurityContext } from './transaction-context.js';

/** The part of a node-postgres Pool the service uses. */
class FakePool extends EventEmitter {
  query = vi.fn();
  connect = vi.fn();
  end = vi.fn(() => Promise.resolve());
}

function build() {
  const pool = new FakePool();
  const service = new DatabaseService(
    pool as unknown as Pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
  );
  return { pool, service };
}

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'unit-test',
};

/** A connection that answers every statement, except the ones whose text matches `fail`. */
function connection(fail?: { match: RegExp; error: Error }) {
  const statements: string[] = [];
  return {
    statements,
    query: vi.fn((query: string | { text: string }) => {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (fail?.match.test(text) === true) return Promise.reject(fail.error);
      return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
    }),
    release: vi.fn(),
  };
}

/** drizzle wraps what a connection throws in its own error, with the connection's error as the cause. */
async function expectEnded(statement: Promise<unknown> | undefined): Promise<void> {
  await expect(statement).rejects.toMatchObject({
    cause: expect.objectContaining({
      message: expect.stringMatching(/transaction has ended/) as unknown,
    }) as unknown,
  });
}

describe('DatabaseService: the transaction owns its connection', () => {
  // Break caught: a transaction that cannot begin keeping its connection for ever. drizzle's own transaction
  // sends BEGIN before the block that releases the connection, so each failure leaked a slot of the pool, and a
  // database that refused BEGIN for a minute left the pool empty for good.
  it('gives the connection back, destroyed, when BEGIN fails', async () => {
    const { pool, service } = build();
    const client = connection({ match: /^begin/i, error: new Error('terminating connection') });
    pool.connect.mockResolvedValue(client);

    await expect(service.transactionWithContext(STAFF, () => Promise.resolve())).rejects.toThrow(
      'terminating connection',
    );

    expect(client.release).toHaveBeenCalledOnce();
    // A connection that failed to begin is not put back in the pool for the next request to use.
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  // Break caught: a connection whose ROLLBACK failed going back to the pool as if it were healthy. It may still be
  // inside the failed transaction, with this request's security context set on it.
  it('destroys the connection when the rollback fails too, and reports the original failure', async () => {
    const { pool, service } = build();
    const client = connection({ match: /^rollback/i, error: new Error('rollback refused') });
    pool.connect.mockResolvedValue(client);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');

    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  // Break caught: a failed COMMIT being reported as success, or leaving the transaction open on a connection that
  // goes back to the pool.
  it('rolls back and reports the failure when the commit fails', async () => {
    const { pool, service } = build();
    const client = connection({ match: /^commit/i, error: new Error('could not serialize') });
    pool.connect.mockResolvedValue(client);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.resolve('done')),
    ).rejects.toThrow('could not serialize');

    expect(client.statements.at(-1)).toMatch(/^rollback/i);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('gives the connection back, healthy, when everything went well', async () => {
    const { pool, service } = build();
    const client = connection();
    pool.connect.mockResolvedValue(client);

    await service.transactionWithContext(STAFF, () => Promise.resolve());

    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  // Break caught: a transaction object that is still usable after the transaction ended. Whoever kept it (a
  // callback, a timer, a promise nobody awaited) would send statements down a connection that has gone back to the
  // pool and may belong to another request, with that request's security context set on it.
  it('refuses a statement sent through the transaction after it has ended', async () => {
    const { pool, service } = build();
    const client = connection();
    pool.connect.mockResolvedValue(client);
    let kept: DatabaseTransaction | undefined;

    await service.transactionWithContext(STAFF, (tx) => {
      kept = tx;
      return Promise.resolve();
    });
    const statementsAtTheEnd = client.statements.length;

    await expectEnded(kept?.execute(sql`select 'after the end'`));

    expect(client.statements).toHaveLength(statementsAtTheEnd);
  });

  it('refuses a statement sent through the transaction after it failed', async () => {
    const { pool, service } = build();
    const client = connection();
    pool.connect.mockResolvedValue(client);
    let kept: DatabaseTransaction | undefined;

    await service
      .transactionWithContext(STAFF, (tx) => {
        kept = tx;
        return Promise.reject(new Error('work failed'));
      })
      .catch(() => undefined);

    await expectEnded(kept?.execute(sql`select 1`));
  });

  // Break caught: a transaction opened inside another, which takes a second connection while the first is still
  // held. With as many requests as the pool has connections, every one of them waits for a connection that only
  // another of them can give back, and the API stops answering without a single error.
  it.each([
    ['a context transaction in a context transaction', 'context', 'context'],
    ['a plain transaction in a context transaction', 'context', 'plain'],
    ['a context transaction in a plain transaction', 'plain', 'context'],
  ])('refuses %s, before it takes a second connection', async (_label, outer, inner) => {
    const { pool, service } = build();
    pool.connect.mockResolvedValue(connection());
    const run = (kind: string, work: () => Promise<unknown>) =>
      kind === 'context' ? service.transactionWithContext(STAFF, work) : service.transaction(work);

    await expect(run(outer, () => run(inner, () => Promise.resolve()))).rejects.toThrow(
      /already open/,
    );

    expect(pool.connect).toHaveBeenCalledOnce();
  });

  // Break caught: the nesting rule reaching sideways. Two requests at once are not nested, and a transaction that
  // starts after another has finished is not either.
  it('does not take transactions side by side, or one after another, for nested ones', async () => {
    const { pool, service } = build();
    pool.connect.mockImplementation(() => Promise.resolve(connection()));

    await Promise.all([
      service.transactionWithContext(STAFF, () => Promise.resolve()),
      service.transactionWithContext(STAFF, () => Promise.resolve()),
    ]);
    await service.transactionWithContext(STAFF, () => Promise.resolve());

    expect(pool.connect).toHaveBeenCalledTimes(3);
  });
});

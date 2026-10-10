import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DatabaseService, type DatabaseTransaction } from './database.service.js';
import { SecurityContextError, type SecurityContext } from './transaction-context.js';

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

/**
 * A connection that answers every statement, except the ones whose text matches `fail`. The statement that sets the
 * context also reports the role the connection runs as, which is `role` (none, when it is left out).
 */
function connection(fail?: { match: RegExp; error: Error }, role?: string) {
  const statements: string[] = [];
  return {
    statements,
    query: vi.fn((query: string | { text: string }) => {
      const text = typeof query === 'string' ? query : query.text;
      statements.push(text);
      if (fail?.match.test(text) === true) return Promise.reject(fail.error);
      const rows =
        role !== undefined && text.includes('set_config') ? [{ database_role: role }] : [];
      return Promise.resolve({ rows, rowCount: rows.length, fields: [] });
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

const SYSTEM_AUTHENTICATION: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'unit-test',
};

describe('DatabaseService: no door without a context (S0.4c)', () => {
  // Break caught: the context-free `db` handle or `transaction()` coming back. Either runs a statement under no
  // validated context, and a protected table answers nothing to it only because its policy happens to say so. The
  // pool's driver handle and a transaction that takes no context are not part of what the service offers.
  it('offers no db handle and no context-free transaction', () => {
    const { service } = build();

    expect('db' in service).toBe(false);
    expect('transaction' in service).toBe(false);
    expect(typeof (service as unknown as Record<string, unknown>).transactionWithContext).toBe(
      'function',
    );
  });

  // The same, for the compiler: a use of either does not type-check. The function is never called.
  it('does not type-check a use of either', () => {
    const { service } = build();
    /* eslint-disable @typescript-eslint/no-unsafe-call -- a call that does not type-check is the point */
    const uses = () => {
      // @ts-expect-error the context-free handle is closed
      const handle: unknown = service.db;
      // @ts-expect-error a transaction with no context is closed
      const transaction: unknown = service.transaction(() => Promise.resolve());
      return [handle, transaction];
    };
    /* eslint-enable @typescript-eslint/no-unsafe-call */
    expect(uses).toBeTypeOf('function');
  });
});

describe('DatabaseService: a SYSTEM capability is opened over its own identity only (SECURITY_DESIGN.md §14.1b)', () => {
  // Break caught: the capability check being skipped, so that a connection running as the API opens the seed
  // capability, or any capability opens over any connection. The refusal comes before the work runs.
  it('runs the work when the capability belongs to the connection’s identity', async () => {
    const { pool, service } = build();
    pool.connect.mockResolvedValue(connection(undefined, 'melarc_api_runtime'));
    const work = vi.fn(() => Promise.resolve('done'));

    await expect(service.transactionWithContext(SYSTEM_AUTHENTICATION, work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledOnce();
  });

  it('refuses a capability held by another identity, before the work, and rolls the transaction back', async () => {
    const { pool, service } = build();
    const client = connection(undefined, 'melarc_api_runtime');
    pool.connect.mockResolvedValue(client);
    const work = vi.fn(() => Promise.resolve('done'));

    const failure = await service
      .transactionWithContext({ ...SYSTEM_AUTHENTICATION, taskCapability: 'seed' }, work)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SecurityContextError);
    expect((failure as SecurityContextError).fields).toEqual(['taskCapability']);
    expect(work).not.toHaveBeenCalled();
    expect(client.statements.at(-1)).toMatch(/^rollback/i);
    // Refusing a context is not a fault of the connection: it goes back to the pool as it was.
    expect(client.release.mock.calls[0]?.[0]).toBeUndefined();
  });

  // Break caught: a connection that cannot say which role it runs as being trusted. Unknown is refused.
  it.each([
    ['reports no role', undefined],
    ['reports an unrelated role', 'postgres'],
    ['reports the owner', 'melarc_owner'],
    ['reports the migration identity', 'melarc_migration_elevated'],
  ])('refuses a SYSTEM context when the connection %s', async (_label, role) => {
    const { pool, service } = build();
    pool.connect.mockResolvedValue(connection(undefined, role));
    const work = vi.fn(() => Promise.resolve('done'));

    await expect(
      service.transactionWithContext(SYSTEM_AUTHENTICATION, work),
    ).rejects.toBeInstanceOf(SecurityContextError);
    expect(work).not.toHaveBeenCalled();
  });

  // Break caught: the identity check applying to business principals, who hold no capability and need no identity.
  it('does not look at the role for a staff context', async () => {
    const { pool, service } = build();
    pool.connect.mockResolvedValue(connection(undefined, 'postgres'));

    await expect(service.transactionWithContext(STAFF, () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  // Break caught: the role being read from a second statement, so that a change between the two is possible. It is
  // reported by the statement that sets the context.
  it('reads the role in the statement that sets the context', async () => {
    const { pool, service } = build();
    const client = connection(undefined, 'melarc_api_runtime');
    pool.connect.mockResolvedValue(client);

    await service.transactionWithContext(SYSTEM_AUTHENTICATION, () => Promise.resolve());

    const setting = client.statements.filter((text) => text.includes('set_config'));
    expect(setting).toHaveLength(1);
    expect(setting[0]).toMatch(/current_user/);
  });
});

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
  it('refuses a context transaction in a context transaction, before it takes a second connection', async () => {
    const { pool, service } = build();
    pool.connect.mockResolvedValue(connection());
    const run = (work: () => Promise<unknown>) => service.transactionWithContext(STAFF, work);

    await expect(run(() => run(() => Promise.resolve()))).rejects.toThrow(/already open/);

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

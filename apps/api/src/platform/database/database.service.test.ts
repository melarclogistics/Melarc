import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DatabaseService } from './database.service.js';
import {
  SecurityContextError,
  toContextSettings,
  type SecurityContext,
} from './transaction-context.js';

/** The part of a node-postgres Pool the service uses, recording what it is asked to do. */
class FakePool extends EventEmitter {
  query = vi.fn();
  connect = vi.fn();
  end = vi.fn(() => Promise.resolve());
}

const SAFE_ROLE = {
  role: 'melarc_api_runtime',
  rolsuper: false,
  rolbypassrls: false,
  rolcreatedb: false,
  rolcreaterole: false,
  owns_database: false,
  owns_objects: false,
};

function build() {
  const pool = new FakePool();
  const logs = new CapturedLogs();
  const shutdown = new ShutdownRegistry();
  const readiness = new ReadinessRegistry();
  const service = new DatabaseService(pool as unknown as Pool, logs.logger, shutdown, readiness);
  return { pool, logs, shutdown, readiness, service };
}

describe('DatabaseService: lifecycle', () => {
  // Break caught: a pool that is never ended, so shutdown cannot finish and the process lingers.
  it('registers its pool for shutdown, and closing ends it exactly once', async () => {
    const { pool, shutdown } = build();

    const first = await shutdown.closeAll();
    const second = await shutdown.closeAll();

    expect(first.closed).toEqual(['database-pool']);
    expect(second.closed).toEqual([]);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  // Break caught: closing the service directly after shutdown ended it, which would throw "called end on
  // pool more than once".
  it('ends the pool only once even if closed twice by hand', async () => {
    const { pool, service } = build();

    await service.close();
    await service.close();

    expect(pool.end).toHaveBeenCalledOnce();
  });

  // Break caught: an error on an idle connection (the database restarting) becoming an uncaught exception
  // that kills the process, or its text, which can carry connection details, reaching the log unredacted.
  it('logs an idle client error without throwing and without its secrets', () => {
    const { pool, logs } = build();

    expect(() =>
      pool.emit(
        'error',
        new Error('connection lost: postgres://melarc_api_runtime:hunter2@db/melarc'),
      ),
    ).not.toThrow();

    expect(
      logs.records().find((record) => record.msg === 'idle database client error'),
    ).toMatchObject({
      level: 'error',
    });
    expect(logs.text()).not.toContain('hunter2');
  });

  // Break caught: a connection lost while a transaction holds it. The pool takes its own listener off a client at
  // checkout, so an error on a client in use has no listener unless the service adds one: an `error` event with
  // nobody listening is an uncaught exception, and the fault handler then ends the whole process, every other
  // request in flight included. The idle test above cannot see it.
  it('logs an error on a client in use without throwing and without its secrets', () => {
    const { pool, logs } = build();
    const client = new EventEmitter();
    pool.emit('connect', client);

    expect(() =>
      client.emit(
        'error',
        new Error('Connection terminated: postgres://melarc_api_runtime:hunter2@db/melarc'),
      ),
    ).not.toThrow();

    expect(logs.records().find((record) => record.msg === 'database client error')).toMatchObject({
      level: 'error',
    });
    expect(logs.text()).not.toContain('hunter2');
  });
});

describe('DatabaseService: readiness', () => {
  // Break caught: a database that is not checked at all, so the instance is "ready" while it cannot serve.
  it('registers a readiness check named database', async () => {
    const { pool, readiness } = build();
    pool.query.mockResolvedValue({ rows: [SAFE_ROLE] });

    expect(await readiness.failing()).toEqual([]);
    expect(pool.query).toHaveBeenCalledOnce();
  });

  // Break caught: an unreachable database reported ready, or the failure escaping as an exception.
  it('is not ready when the database cannot be reached', async () => {
    const { pool, readiness } = build();
    pool.query.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));

    expect(await readiness.failing()).toEqual(['database']);
  });

  // Break caught: an instance configured with a role that can bypass what protects the data (the owner,
  // a superuser, BYPASSRLS) being served traffic. Row-level security would be on and enforce nothing.
  it.each([
    ['a superuser', { rolsuper: true }],
    ['a role with BYPASSRLS', { rolbypassrls: true }],
    ['a role that can create databases', { rolcreatedb: true }],
    ['a role that can create roles', { rolcreaterole: true }],
    ['the owner of the database', { owns_database: true }],
    ['the owner of objects', { owns_objects: true }],
  ])('is never ready when connected as %s', async (_label, flags) => {
    const { pool, readiness, logs } = build();
    pool.query.mockResolvedValue({ rows: [{ ...SAFE_ROLE, ...flags }] });

    expect(await readiness.failing()).toEqual(['database']);
    expect(await readiness.failing()).toEqual(['database']);
    // Said once, with the role and the flags, however often the probe asks.
    const said = logs
      .records()
      .filter((record) => record.msg === 'database role is not a safe runtime identity');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ level: 'error', role: 'melarc_api_runtime' });
  });

  // Break caught: a query that finds no row for the connected role (it was dropped) counted as healthy.
  it('is not ready when the connected role cannot be inspected', async () => {
    const { pool, readiness } = build();
    pool.query.mockResolvedValue({ rows: [] });

    expect(await readiness.failing()).toEqual(['database']);
  });
});

describe('DatabaseService: transactions with a security context', () => {
  // Break caught: an invalid context opening a transaction. It must be refused before any connection is
  // taken, so nothing reaches a pooled connection (SECURITY_DESIGN.md §14.1b).
  it('refuses an invalid context before it takes a connection', async () => {
    const { pool, service } = build();
    const work = vi.fn();

    await expect(
      service.transactionWithContext({ principalType: 'ADMIN' } as never, work),
    ).rejects.toBeInstanceOf(SecurityContextError);

    expect(pool.connect).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  const PRINCIPAL = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
  const HUB = '11111111-1111-4111-8111-111111111111';
  const STAFF: SecurityContext = {
    principalType: 'STAFF',
    principalId: PRINCIPAL,
    surface: 'OPS_PORTAL',
    hubScopeMode: 'SET',
    authorizedHubIds: [HUB],
    correlationId: 'unit-test',
  };

  /** A connection that records every statement it is sent, in order. */
  function recordingClient() {
    const statements: string[] = [];
    const client = {
      query: vi.fn((query: string | { text: string }) => {
        statements.push(typeof query === 'string' ? query : query.text);
        return Promise.resolve({ rows: [], rowCount: 0, fields: [] });
      }),
      release: vi.fn(),
    };
    return { client, statements };
  }

  // Break caught: the context being set for the connection and not for the transaction (the third argument
  // of set_config), which is the defect GBT-A1..A5 exist to catch. Those tests need a server; this one
  // asserts the statement itself, so the guarantee does not depend on one being available. It also fixes
  // the order: the transaction begins, the context is set, and only then does the work run.
  it('sets the context for the transaction only, after it begins and before the work runs', async () => {
    const { pool, service } = build();
    const { client, statements } = recordingClient();
    pool.connect.mockResolvedValue(client);

    await service.transactionWithContext(STAFF, async (tx) => {
      await tx.execute(sql`select 1 as work`);
    });

    const began = statements.findIndex((text) => /^begin/i.test(text));
    const context = statements.findIndex((text) => text.includes('set_config'));
    const work = statements.findIndex((text) => text.includes('as work'));
    expect(began).toBeGreaterThanOrEqual(0);
    expect(context).toBeGreaterThan(began);
    expect(work).toBeGreaterThan(context);
    expect(statements[context]).toMatch(/set_config\(\$\d+, \$\d+, true\)/);
    expect(statements[context]).not.toMatch(/set_config\([^)]*false\)/);
    expect(statements.at(-1)).toMatch(/^commit/i);
    expect(client.release).toHaveBeenCalledOnce();
  });

  // Break caught: a context value written into the statement text, where a crafted value could end the
  // statement. Values travel as parameters; the text holds only placeholders.
  it('sends the context values as parameters, never in the statement text', async () => {
    const { pool, service } = build();
    const { client, statements } = recordingClient();
    pool.connect.mockResolvedValue(client);

    await service.transactionWithContext(STAFF, () => Promise.resolve());

    const context = statements.find((text) => text.includes('set_config')) ?? '';
    for (const value of [PRINCIPAL, HUB, 'STAFF', 'OPS_PORTAL', 'unit-test']) {
      expect(context).not.toContain(value);
    }
    // One set_config per setting the context yields: none dropped, none repeated.
    expect(context.match(/set_config\(/g)).toHaveLength(toContextSettings(STAFF).length);
  });

  // Break caught: a failed transaction that is committed, or a connection that is not given back, which
  // starves the pool until the API stops answering.
  it('rolls back, releases the connection and rethrows when the work fails', async () => {
    const { pool, service } = build();
    const { client, statements } = recordingClient();
    pool.connect.mockResolvedValue(client);

    await expect(
      service.transactionWithContext(STAFF, () => Promise.reject(new Error('work failed'))),
    ).rejects.toThrow('work failed');

    expect(statements.at(-1)).toMatch(/^rollback/i);
    expect(statements.some((text) => /^commit/i.test(text))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });
});

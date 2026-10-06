import { Injectable, Module } from '@nestjs/common';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appWith, startTestApp, TEST_CONFIG, type TestApp } from '../../test-support/test-app.js';
import type { AppConfig, DatabaseConfig } from '../config/load-config.js';
import { gracefulShutdown } from '../lifecycle/graceful-shutdown.js';
import { DATABASE_POOL } from '../platform.tokens.js';
import { createPool } from './database.module.js';
import { DatabaseService } from './database.service.js';
import { PostgresUrlError } from './postgres-url.js';

/** A database that is not there: nothing listens on port 1. */
const UNREACHABLE_DATABASE: DatabaseConfig = {
  url: 'postgres://melarc_api_runtime:URL-PASSWORD-VALUE@127.0.0.1:1/melarc_unreachable',
  poolMax: 2,
};

const UNREACHABLE: AppConfig = { ...TEST_CONFIG, database: UNREACHABLE_DATABASE };

/** A stand-in for a future domain module: it imports nothing and only asks the platform for the database. */
@Injectable()
class Repository {
  constructor(readonly database: DatabaseService) {}
}

@Module({ providers: [Repository], exports: [Repository] })
class RepositoryModule {}

let running: TestApp | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function readyz(baseUrl: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/readyz`);
  return { status: response.status, body: await response.json() };
}

describe('the database module', () => {
  // Break caught: the database being wired in for configurations that name none, which would make the
  // OpenAPI generator and every database-free test need a live dependency.
  it('is not part of an application whose configuration names no database', async () => {
    running = await startTestApp();

    expect(() => running?.app.get(DatabaseService, { strict: false })).toThrow();
    expect(await readyz(running.baseUrl)).toEqual({ status: 200, body: { status: 'ready' } });
  });

  // Break caught: a module being unable to receive the database service without importing platform
  // internals, which would let each module build its own pool and connect around the controls.
  it('gives any module the database service through the platform', async () => {
    running = await startTestApp({ config: UNREACHABLE, rootModule: appWith(RepositoryModule) });

    const repository = running.app.get(Repository);

    expect(repository.database).toBeInstanceOf(DatabaseService);
  });

  // Break caught: an unreachable database crashing the API at startup, serving traffic as if it were
  // ready, or putting the connection URL (with its password) in the response or the log.
  it('keeps an API with an unreachable database alive and not ready, and says nothing about it', async () => {
    running = await startTestApp({ config: UNREACHABLE });

    const livez = await fetch(`${running.baseUrl}/livez`);
    const ready = await readyz(running.baseUrl);

    expect(livez.status).toBe(200);
    expect(ready).toEqual({
      status: 503,
      body: { status: 'not_ready', reason: 'dependency_unavailable' },
    });
    expect(
      running.logs.records().find((record) => record.msg === 'readiness check failing'),
    ).toMatchObject({ level: 'warn', checks: ['database'] });
    const everything = `${running.logs.text()}${JSON.stringify(ready)}`;
    for (const secret of ['URL-PASSWORD-VALUE', 'melarc_unreachable']) {
      expect(everything).not.toContain(secret);
    }
  });

  // Break caught (audit F01): the pool being handed the URL string, which the driver reads again, query
  // string included. The pool is made from the facts that were checked, and from nothing else.
  it('builds its pool from the checked facts and not from the URL string', async () => {
    const pool = createPool(UNREACHABLE_DATABASE);
    try {
      expect(pool.options).toMatchObject({
        host: '127.0.0.1',
        port: 1,
        user: 'melarc_api_runtime',
        database: 'melarc_unreachable',
        password: 'URL-PASSWORD-VALUE',
        max: 2,
      });
      expect(pool.options).not.toHaveProperty('connectionString');
    } finally {
      await pool.end();
    }
  });

  // Break caught (audit F01): a pool made from a URL whose query string would have the driver connect as
  // another user, to another host or with other options. The refusal comes before any pool exists.
  it.each(['?user=postgres', '?host=db.example', '?port=6543', '?sslmode=require', '#fragment'])(
    'refuses to build a pool from a URL that ends %s',
    (suffix) => {
      expect(() =>
        createPool({ ...UNREACHABLE_DATABASE, url: `${UNREACHABLE_DATABASE.url}${suffix}` }),
      ).toThrow(PostgresUrlError);
    },
  );

  // Break caught: the pool left open at shutdown, so the process cannot exit by itself.
  it('ends its pool as part of a clean shutdown', async () => {
    running = await startTestApp({ config: UNREACHABLE });
    await readyz(running.baseUrl);

    const outcome = await gracefulShutdown(running.app, {
      timeoutMs: 5000,
      drainDelayMs: 0,
      logger: running.logs.logger,
    });

    expect(outcome).toBe('clean');
    expect(running.logs.records().map((record) => record.msg)).toContain('shutdown complete');
  });

  // Break caught: a close that reports success and ends nothing. The test above sees only a clean outcome and
  // a log line, which a no-op close produces as well. This one watches the real pool the application built: it
  // is ended once, by the shutdown and not by the test, holds no connection afterwards and refuses new work.
  it('ends the pool the application built exactly once, leaving no connection open', async () => {
    running = await startTestApp({ config: UNREACHABLE });
    await readyz(running.baseUrl);
    const pool = running.app.get<pg.Pool>(DATABASE_POOL, { strict: false });
    const end = vi.spyOn(pool, 'end');
    expect(pool.ended).toBe(false);

    const outcome = await gracefulShutdown(running.app, {
      timeoutMs: 5000,
      drainDelayMs: 0,
      logger: running.logs.logger,
    });

    expect(outcome).toBe('clean');
    expect(end).toHaveBeenCalledTimes(1);
    expect(pool.ended).toBe(true);
    expect([pool.totalCount, pool.idleCount, pool.waitingCount]).toEqual([0, 0, 0]);
    await expect(pool.query('select 1')).rejects.toThrow(/after calling end/);
  });
});

import { Module, type DynamicModule } from '@nestjs/common';
import pg from 'pg';

import { CLOCK, type Clock } from '../auth/ports/clock.port.js';
import type { DatabaseConfig } from '../config/load-config.js';
import { DISPOSAL_BOUND_MS } from '../execution/execution-parameters.js';
import { HealthModule } from '../health/health.module.js';
import { DATABASE_POOL, DATABASE_RUNTIME } from '../platform.tokens.js';
import { DatabaseService, type DatabaseRuntime } from './database.service.js';
import { postgresConnectionSettings } from './postgres-url.js';
import { PgStatementCanceller } from './statement-canceller.js';

/**
 * Builds the pool. It connects lazily, on first use, so constructing it needs no database.
 *
 * Every connection is made with the server's statement, lock and idle-in-transaction timeouts as start-up parameters
 * (SECURITY_DESIGN.md §14.6), so no statement runs on a connection without them, and a connection takes at most the acquire
 * timeout to be made. The transaction timeout is set per transaction (`DatabaseService`), because it is the transaction's
 * budget. The idle timeout and application name remain engineering defaults no retained specification sets.
 *
 * The pool is given the facts read from the URL and never the URL, which the driver would read again,
 * query string included (see postgresConnectionSettings). A URL that is not accepted throws here.
 */
export function createPool({ url, poolMax, deadlines }: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    ...postgresConnectionSettings(url),
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: deadlines.acquireTimeoutMs,
    statement_timeout: deadlines.statementTimeoutMs,
    lock_timeout: deadlines.lockTimeoutMs,
    idle_in_transaction_session_timeout: deadlines.idleInTransactionTimeoutMs,
    application_name: 'melarc-api',
  });
}

/** Registered by the platform module only when the configuration names a database. */
@Module({})
export class DatabaseModule {
  static register(database: DatabaseConfig): DynamicModule {
    return {
      module: DatabaseModule,
      global: true,
      imports: [HealthModule],
      providers: [
        { provide: DATABASE_POOL, useFactory: () => createPool(database) },
        {
          // The clock is the port the application root binds; the canceller connects from the same checked facts as the pool.
          provide: DATABASE_RUNTIME,
          useFactory: (clock: Clock): DatabaseRuntime => ({
            clock,
            poolMax: database.poolMax,
            deadlines: database.deadlines,
            canceller: new PgStatementCanceller(postgresConnectionSettings(database.url), {
              timeoutMilliseconds: DISPOSAL_BOUND_MS,
              clock,
            }),
          }),
          inject: [CLOCK],
        },
        DatabaseService,
      ],
      exports: [DatabaseService],
    };
  }
}

import { Module, type DynamicModule } from '@nestjs/common';
import pg from 'pg';

import type { DatabaseConfig } from '../config/load-config.js';
import { HealthModule } from '../health/health.module.js';
import { DATABASE_POOL } from '../platform.tokens.js';
import { DatabaseService } from './database.service.js';
import { postgresConnectionSettings } from './postgres-url.js';

/**
 * Builds the pool. It connects lazily, on first use, so constructing it needs no database. The timeouts
 * and application name are provisional engineering defaults: no retained specification sets them.
 *
 * The pool is given the facts read from the URL and never the URL, which the driver would read again,
 * query string included (see postgresConnectionSettings). A URL that is not accepted throws here.
 */
export function createPool({ url, poolMax }: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    ...postgresConnectionSettings(url),
    max: poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
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
        DatabaseService,
      ],
      exports: [DatabaseService],
    };
  }
}

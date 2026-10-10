import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { INERT_DEADLINES } from '../../../src/platform/config/inert-config.js';
import {
  API_RUNTIME_ROLE,
  type DatabaseDeadlines,
} from '../../../src/platform/config/load-config.js';
import { createPool } from '../../../src/platform/database/database.module.js';
import { DatabaseService } from '../../../src/platform/database/database.service.js';
import { ReadinessRegistry } from '../../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../../src/test-support/captured-logs.js';
import { databaseRuntime } from './runtime.js';
import type { Login, TestDatabase } from './test-database.js';

/** A `DatabaseService` over a real pool, built the way production builds one, and what a test needs to end it. */
export interface BuiltService {
  readonly service: DatabaseService;
  readonly logs: CapturedLogs;
  /** Ends the pool. Call it in a `finally`. */
  readonly close: () => Promise<void>;
}

/**
 * The service as `melarc_api_runtime` (the login the API connects as) unless the test names another `login`, on a pool of
 * `poolMax`, with `deadlines` in force on every connection. A test passes its own deadlines to make a bound small enough to reach.
 */
export function buildService(
  database: TestDatabase,
  options: {
    readonly poolMax?: number;
    readonly deadlines?: DatabaseDeadlines;
    readonly login?: Login;
  } = {},
): BuiltService {
  const url = database.urlFor(options.login ?? API_RUNTIME_ROLE);
  const poolMax = options.poolMax ?? 1;
  const deadlines = options.deadlines ?? INERT_DEADLINES;
  const pool = createPool({ url, poolMax, deadlines });
  const logs = new CapturedLogs();
  const shutdown = new ShutdownRegistry();
  const service = new DatabaseService(
    pool,
    logs.logger,
    shutdown,
    new ReadinessRegistry(),
    databaseRuntime(url, poolMax, { deadlines, clock: new SystemClock() }),
  );
  return {
    service,
    logs,
    close: async () => {
      await shutdown.closeAll();
    },
  };
}

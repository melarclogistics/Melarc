import { SystemClock } from '../../../src/platform/auth/clock/system.clock.adapter.js';
import { INERT_DEADLINES } from '../../../src/platform/config/inert-config.js';
import type { DatabaseDeadlines } from '../../../src/platform/config/load-config.js';
import type { Clock } from '../../../src/platform/auth/ports/clock.port.js';
import type { DatabaseRuntime } from '../../../src/platform/database/database.service.js';
import { postgresConnectionSettings } from '../../../src/platform/database/postgres-url.js';
import { PgStatementCanceller } from '../../../src/platform/database/statement-canceller.js';
import { DISPOSAL_BOUND_MS } from '../../../src/platform/execution/execution-parameters.js';

/**
 * What `DatabaseService` is given besides its pool, made the way `DatabaseModule` makes it: the production clock, the
 * deadlines, and a canceller that connects from the same checked facts as the pool. A test passes its own `deadlines` or
 * `clock` to change them.
 */
export function databaseRuntime(
  url: string,
  poolMax: number,
  options: { readonly deadlines?: DatabaseDeadlines; readonly clock?: Clock } = {},
): DatabaseRuntime {
  const clock = options.clock ?? new SystemClock();
  return {
    clock,
    poolMax,
    deadlines: options.deadlines ?? INERT_DEADLINES,
    canceller: new PgStatementCanceller(postgresConnectionSettings(url), {
      timeoutMilliseconds: DISPOSAL_BOUND_MS,
      clock,
    }),
  };
}

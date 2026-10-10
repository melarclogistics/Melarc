import pino from 'pino';

import { SystemClock } from '../../platform/auth/clock/system.clock.adapter.js';
import { INERT_DEADLINES } from '../../platform/config/inert-config.js';
import { createPool } from '../../platform/database/database.module.js';
import { DatabaseService } from '../../platform/database/database.service.js';
import { postgresConnectionSettings } from '../../platform/database/postgres-url.js';
import type { runSeed } from '../../platform/database/seed/seed-helper.js';
import { PgStatementCanceller } from '../../platform/database/statement-canceller.js';
import { DISPOSAL_BOUND_MS } from '../../platform/execution/execution-parameters.js';
import { ReadinessRegistry } from '../../platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../platform/lifecycle/shutdown.registry.js';

/**
 * The composition root of the `db:seed` process (S0.9): the one file that binds the production clock and the database service for
 * the command, as `app.module.ts` does for the API. It is on the architecture test's list of composition-root files, so the
 * command's own logic (`seed-command.ts`) imports no adapter.
 */

/** The database a run seeds and how to let go of it. */
export interface SeedTarget {
  readonly database: Parameters<typeof runSeed>[0];
  close(): Promise<void>;
}

/**
 * One connection, made the way the API makes its pool, as whoever the URL names: a pool of one, the engineering default deadlines
 * (the transaction inserts a few hundred rows), no log output, and a pool that is ended when the run ends.
 */
export function openSeedTarget(url: string): SeedTarget {
  const shutdown = new ShutdownRegistry();
  const clock = new SystemClock();
  const database = new DatabaseService(
    createPool({ url, poolMax: 1, deadlines: INERT_DEADLINES }),
    pino({ level: 'silent' }),
    shutdown,
    new ReadinessRegistry(),
    {
      clock,
      poolMax: 1,
      deadlines: INERT_DEADLINES,
      canceller: new PgStatementCanceller(postgresConnectionSettings(url), {
        timeoutMilliseconds: DISPOSAL_BOUND_MS,
        clock,
      }),
    },
  );
  return {
    database,
    close: async () => {
      await shutdown.closeAll();
    },
  };
}

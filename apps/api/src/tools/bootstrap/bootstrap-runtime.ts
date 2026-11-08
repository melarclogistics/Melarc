import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SystemClock } from '../../platform/auth/clock/system.clock.adapter.js';
import { INERT_DEADLINES } from '../../platform/config/inert-config.js';
import type { DatabaseDeadlines } from '../../platform/config/load-config.js';
import { Sha256TokenService } from '../../platform/auth/crypto/sha256.token-service.adapter.js';
import { localProvisioningUrl } from '../seed/seed-command.js';
import { openSeedTarget } from '../seed/seed-runtime.js';
import type { BootstrapDependencies } from './bootstrap-command.js';
import { PostgresBootstrapDatabase } from './bootstrap-database.js';
import {
  assertCustodyDirectory,
  NodeCustodyDisk,
  privateAccessFor,
  randomBundleName,
} from './custody-node.js';
import { CustodyStore } from './custody-store.js';

/**
 * The database deadlines of the bootstrap commands: the engineering defaults, with the two that bound a transaction made longer. A
 * bundle is written **inside** the transaction, after the function that makes the pair and before the commit, so that a bundle that
 * cannot be written rolls the pair back; and on Windows each bundle costs runs of `whoami` and `icacls`, each allowed 15 seconds
 * (`custody-node.ts`). With the defaults (5 seconds idle in a transaction, 10 for the whole) a loaded machine would have the server
 * end the session between the function and the commit, which fails the run and, before the review of 21 October 2026, could leave a
 * bundle for a pair that was never made. These are development-qualified like the other deadlines: the longest a run can wait is two
 * bundles of about 45 seconds each, and the idle limit is what must cover the longest silence between two statements.
 */
export const BOOTSTRAP_DEADLINES: DatabaseDeadlines = Object.freeze({
  ...INERT_DEADLINES,
  idleInTransactionTimeoutMs: 120_000,
  transactionTimeoutMs: 180_000,
});

/**
 * The composition root of the `bootstrap:seed` and `bootstrap:resume` processes (S0.30): the one file that binds the production
 * clock, the token service, the database service over the provisioning login, and the custody adapters over `node:fs` and (on
 * Windows) `icacls`, for the commands, as `seed-runtime.ts` does for `db:seed` and `app.module.ts` does for the API. It is on the
 * architecture test's list of composition-root files, so the commands' own logic (`bootstrap-command.ts`) imports no adapter.
 */
export function bootstrapDependencies(): BootstrapDependencies {
  return {
    localUrl: () => localProvisioningUrl(),
    open: (url) => {
      // The same pool of one as `db:seed`, as the login the URL names (the command refuses any but the provisioning login).
      const target = openSeedTarget(url, BOOTSTRAP_DEADLINES);
      return {
        database: new PostgresBootstrapDatabase(target.database),
        close: () => target.close(),
      };
    },
    store: new CustodyStore(new NodeCustodyDisk(), privateAccessFor(), randomBundleName),
    tokens: new Sha256TokenService(),
    clock: new SystemClock(),
    // The checkouts the process can be said to run from: where it was started, and where this file is.
    custodyDirectory: (value) =>
      assertCustodyDirectory(value, [process.cwd(), dirname(fileURLToPath(import.meta.url))]),
    correlationId: () => `bootstrap-${randomUUID()}`,
  };
}

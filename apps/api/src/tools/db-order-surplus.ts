import pg from 'pg';

import { postgresConnectionSettings } from '../platform/database/postgres-url.js';
import { runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import {
  checkOrderSurplus,
  formatOrderSurplusReport,
  isClear,
  parseOrderSurplusArguments,
} from './database/order-surplus-check.js';
import { buildDatabaseUrl } from './database/provisioning.js';
import {
  assertDisposableName,
  assertLocalHost,
  assertNotDeployedEnvironment,
} from './database/safety.js';

/**
 * The inventory of a surplus that already stands (Stage 7, OB-S1-161): does an intake counted blind, open or closed, hold more orders than the parcels it received? It reads and writes nothing, and it has no
 * flag that would. See `database/order-surplus-check.ts` for what it finds and why the cluster administrator's login is the one that can see it.
 *
 * It connects to a database on this machine and refuses any database but `melarc_dev` and the test databases, and any environment but a local one. A deployed database is checked by its administrator with the
 * statement of `database/order-surplus-check.ts`. The exit code is 0 when it is clear, 2 when it found a surplus, and 1 on a failure.
 *
 * usage: node dist/tools/db-order-surplus.js [database]
 */
await runCli(async () => {
  const request = parseOrderSurplusArguments(process.argv.slice(2));
  // Before any connection: a name that is not a development or test database never reaches the server.
  assertDisposableName(request.database);
  assertNotDeployedEnvironment(process.env);
  const settings = readLocalPostgres();
  assertLocalHost(settings.host);

  const client = new pg.Client({
    ...postgresConnectionSettings(
      buildDatabaseUrl({
        host: settings.host,
        port: settings.port,
        user: 'postgres',
        password: settings.adminPassword,
        database: request.database,
      }),
    ),
    application_name: 'melarc-order-surplus',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    // A read-only transaction: whatever the statement is, nothing can be written through this connection.
    await client.query('begin read only');
    const report = await checkOrderSurplus(client);
    await client.query('rollback');
    process.stdout.write(formatOrderSurplusReport(request.database, report));
    process.exitCode = isClear(report) ? 0 : 2;
  } finally {
    await client.end();
  }
});

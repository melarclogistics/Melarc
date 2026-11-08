import pg from 'pg';

import { postgresConnectionSettings } from '../platform/database/postgres-url.js';
import { runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import {
  checkOpenStops,
  formatOpenStopReport,
  isClear,
  parseOpenStopArguments,
} from './database/open-stop-check.js';
import { buildDatabaseUrl } from './database/provisioning.js';
import {
  assertDisposableName,
  assertLocalHost,
  assertNotDeployedEnvironment,
} from './database/safety.js';

/**
 * The upgrade check of migration 0065 (S1.22; MIGRATION_AND_SEEDING.md section 5.5): does a cancelled pickup request still hold a stop that is to be
 * worked? It reads and writes nothing, and it has no flag that would. The Product Owner's decision of 2 November 2026 is the procedure: run it
 * before the migration is applied, record the result, and **stop the migration if it finds a violation**.
 *
 * It connects as the cluster administrator to a database on this machine (the migration login and the runtime login cannot see these rows through
 * row-level security, and a check made there would pass because it could not see), and refuses any database but `melarc_dev` and the test
 * databases, and any environment but a local one. A deployed database is checked by its administrator with the statement of
 * database/open-stop-check.ts. The exit code is 0 when it is clear, 2 when it found a pair, and 1 on a failure.
 *
 * usage: node dist/tools/db-open-stops.js [database]
 */
await runCli(async () => {
  const request = parseOpenStopArguments(process.argv.slice(2));
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
    application_name: 'melarc-open-stops',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    // A read-only transaction: whatever the statement is, nothing can be written through this connection.
    await client.query('begin read only');
    const report = await checkOpenStops(client);
    await client.query('rollback');
    process.stdout.write(formatOpenStopReport(request.database, report));
    process.exitCode = isClear(report) ? 0 : 2;
  } finally {
    await client.end();
  }
});

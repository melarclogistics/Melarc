import pg from 'pg';

import { postgresConnectionSettings } from '../platform/database/postgres-url.js';
import { runCli } from './database/cli.js';
import {
  formatCommitmentReport,
  parseCommitmentMarkArguments,
  runCommitmentMarks,
} from './database/commitment-marks.js';
import { readLocalPostgres } from './database/local-env.js';
import { buildDatabaseUrl } from './database/provisioning.js';
import {
  assertDisposableName,
  assertLocalHost,
  assertNotDeployedEnvironment,
} from './database/safety.js';

/**
 * The upgrade check of migration 0064 (S1.21; OB-S1-35): does the mark of a rider commitment on each pickup request agree with the request's
 * current claim? With no flag it only looks and changes nothing; with `--reconcile` it puts right the confirmed requests that disagree, in one
 * locked transaction, and checks the result before it commits. A cancelled request and its charge decision are never touched.
 *
 * It connects as the cluster administrator to a database on this machine (the migration login cannot see these rows through row-level security,
 * and a check made there would pass because it could not see), and refuses any database but `melarc_dev` and the test databases, and any
 * environment but a local one. A deployed database is checked by its administrator with the statements of database/commitment-marks.ts (MIGRATION_AND_SEEDING.md section 5.5).
 * Stop the application and the worker first. The exit code is 0 when the database agrees with its claims, 2 when it does not, and 1 on a failure.
 *
 * usage: node dist/tools/db-commitment-marks.js [database] [--reconcile]
 */
await runCli(async () => {
  const request = parseCommitmentMarkArguments(process.argv.slice(2));
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
    application_name: 'melarc-commitment-marks',
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    const run = await runCommitmentMarks(client, { reconcile: request.reconcile });
    process.stdout.write(formatCommitmentReport(request.database, run.before, run.reconciled));
    process.exitCode = run.consistent ? 0 : 2;
  } finally {
    await client.end();
  }
});

import { runCli } from './database/cli.js';
import { readLocalPostgres } from './database/local-env.js';
import {
  formatListing,
  ORPHANS_USAGE,
  parseOrphanArguments,
  removeNamed,
} from './database/orphans.js';
import { connectLocalAdmin, listTestDatabases } from './database/provisioning.js';
import { assertTestDatabaseName } from './database/safety.js';

/**
 * Finds, and removes on request, the test databases a run left behind. A run that is killed cannot clean up
 * after itself, and nothing else does it for it: no test run removes another run's database, because from the
 * outside a database that is idle may belong to a run that is between two steps.
 *
 * With no argument it lists the test databases and changes nothing. A database is removed only when it is
 * named after `--drop`, and only if it is a test database on this machine's server that carries the marker
 * this tooling writes. A database with a session connected is refused unless `--disconnect` is also given.
 *
 * usage: node dist/tools/db-orphans.js [--drop <database> [<database> ...] [--disconnect]]
 */
await runCli(async () => {
  const request = parseOrphanArguments(process.argv.slice(2));
  // Before any connection: a name that is not a test database never reaches the server.
  for (const name of request.drop) assertTestDatabaseName(name);

  const admin = await connectLocalAdmin(readLocalPostgres());
  try {
    if (request.drop.length === 0) {
      process.stdout.write(formatListing(await listTestDatabases(admin)));
      return;
    }

    const { dropped, refused } = await removeNamed(admin, request.drop, {
      disconnect: request.disconnect,
    });
    for (const name of dropped) process.stdout.write(`dropped ${name}\n`);
    for (const { reason } of refused) process.stderr.write(`${reason}\n`);
    if (refused.length > 0) {
      process.exitCode = 1;
      process.stderr.write(
        `${String(refused.length)} of ${String(request.drop.length)} not dropped. ${ORPHANS_USAGE}\n`,
      );
    }
  } finally {
    await admin.close();
  }
});

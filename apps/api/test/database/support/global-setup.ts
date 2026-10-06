import { describeFailure } from '../../../src/tools/database/cli.js';
import { readLocalPostgres } from '../../../src/tools/database/local-env.js';
import { connectLocalAdmin } from '../../../src/tools/database/provisioning.js';

/**
 * Runs once before the database tests. It fails the whole run, saying why, when PostgreSQL is not
 * configured or not reachable, so a missing service is never mistaken for passing tests.
 *
 * It removes nothing. A database with no connection may belong to another run that is between two steps (a
 * second `test:db`, the e2e harness), so no run removes a database it did not make. Each test file drops its
 * own in `afterAll`; what a killed run leaves behind is listed and removed by name with `db:orphans`.
 */
export default async function setup(): Promise<void> {
  try {
    const admin = await connectLocalAdmin(readLocalPostgres());
    await admin.close();
  } catch (error) {
    throw new Error(`the database tests cannot run: ${describeFailure(error)}`, { cause: error });
  }
}

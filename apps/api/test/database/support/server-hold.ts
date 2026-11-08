import { readLocalPostgres } from '../../../src/tools/database/local-env.js';
import { connectLocalAdmin } from '../../../src/tools/database/provisioning.js';

/**
 * Who may use the database server while a database test file runs (vitest.config.ts). A file of the `database` project holds
 * it shared, with the files beside it; a file of `database-alone` holds it alone. The order of the two projects already keeps
 * them apart within one run. This keeps them apart whatever the scheduler does, and across two runs at once (two people or two
 * agents running database tests together): what cannot take the server within the wait says so and fails, instead of changing
 * roles or settings under the other run's tests.
 *
 * The hold is a session advisory lock in the server's `postgres` database, where every run takes the same key, on a connection
 * of its own that lives as long as the file: closing it, or the file's process ending, gives it back.
 */
const KEY = "hashtextextended('melarc:test-database-server', 0)";
const WAIT = '10s';

export type Hold = 'shared' | 'alone';

export async function holdServer(hold: Hold): Promise<() => Promise<void>> {
  const admin = await connectLocalAdmin(readLocalPostgres());
  try {
    await admin.client.query(`set lock_timeout = '${WAIT}'`);
    await admin.client.query(
      hold === 'shared'
        ? `select pg_advisory_lock_shared(${KEY})`
        : `select pg_advisory_lock(${KEY})`,
    );
  } catch (error) {
    await admin.close();
    if (error instanceof Error && 'code' in error && error.code === '55P03') {
      throw new Error(
        `The database server is in use by another database test run (${hold === 'shared' ? 'a file that must run alone' : 'files that run beside each other'}): run one database test run at a time.`,
        { cause: error },
      );
    }
    throw error;
  }
  return () => admin.close();
}

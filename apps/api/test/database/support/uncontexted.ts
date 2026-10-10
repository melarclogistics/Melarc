import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import type { DatabaseTransaction } from '../../../src/platform/database/database.service.js';

/**
 * Runs `work` in a transaction on a connection of `pool` that carries no security context at all: what a request that
 * failed to establish its principal would be, or code that reached the pool some other way. `DatabaseService` has no
 * such door any more (S0.4c), and the tests of what a protected table answers to "no context" still need one, so it
 * lives here, in the tests, where production code cannot import it.
 */
export async function inUncontextedTransaction<T>(
  pool: pg.Pool,
  work: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    try {
      const result = await work(drizzle(client));
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  } finally {
    client.release();
  }
}

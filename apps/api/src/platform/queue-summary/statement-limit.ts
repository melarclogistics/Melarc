import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';

/**
 * Bounds every statement that follows it in the transaction (the counts of the summary, the searches of `lookupRecords` (`AC-LOOKUP-15`), and the commit) to at most `milliseconds` (`SET LOCAL statement_timeout`: `set_config(..., true)` is local to the
 * transaction and is gone when it ends, so the connection goes back to the pool with the setting it had). **It only ever lowers the bound**:
 * the pool is given a statement timeout by the configuration (`DATABASE_STATEMENT_TIMEOUT_MS`), and a deployment that set it lower than the
 * summary's keeps its lower value; `0` means none, and is replaced by the bound. The database ends a statement that runs longer with a
 * `57014`, which the platform answers as a failed read (`DatabaseDeadlineError`, a `503` with no code).
 */
export async function limitStatements(
  handle: TransactionHandle,
  milliseconds: number,
): Promise<void> {
  // `least` ignores a NULL: a configured `0` (`nullif`) and a setting that could not be read (a scalar subquery with no row) both leave the
  // bound itself, so the statement can never run unbounded for want of a row to compute from.
  await transactionOf(handle).execute(
    sql`select set_config(
          'statement_timeout',
          least(
            nullif((select setting::int from pg_settings where name = 'statement_timeout'), 0),
            ${String(milliseconds)}::int
          )::text,
          true)`,
  );
}

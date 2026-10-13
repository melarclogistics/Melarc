import { sql } from 'drizzle-orm';

import type { TransactionHandle, UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import type { DatabaseService } from './database.service.js';
import { timestampOf } from './timestamps.js';
import type { SecurityContext } from './transaction-context.js';
import { bindTransactionHandle, transactionOf } from './transaction-handle.js';

/**
 * The unit of work over PostgreSQL (S0.24; SOLUTION_ARCHITECTURE.md §5; plan obligation OB-99, the first consumer of the port): the
 * one place that turns the transaction of `DatabaseService` into the opaque handle that port operations receive. The use case
 * owns the transaction (this opens it under the context it is given, commits when the work returns and rolls back when it throws),
 * and every port adapter that works inside it is handed the handle and cannot open, nest or commit one of its own.
 *
 * **The context is the service's, not this class's.** `DatabaseService` validates it (an invalid one never opens a transaction),
 * applies it to the transaction, and registers it with the transaction's facts; the handle reads it back from there
 * (`bindTransactionHandle`), so a handle cannot stand over a transaction under a context other than the one applied.
 * Opening a transaction inside the work of another is refused by the service, and so is a connection kept past the work.
 *
 * `databaseNow` is the database's wall clock **read afresh** (`clock_timestamp()`, not the transaction's start `now()`): a request
 * can wait on a lock past an expiry, and a persisted expiry is decided on one fresh value read after the locks are held, with
 * equality expired (SECURITY_DESIGN.md §13.3a). It has the precision of a JavaScript date, a millisecond.
 */
export class PostgresUnitOfWork implements UnitOfWork {
  readonly #database: Pick<DatabaseService, 'transactionWithContext'>;

  constructor(database: Pick<DatabaseService, 'transactionWithContext'>) {
    this.#database = database;
  }

  run<T>(
    context: SecurityContext,
    work: (transaction: TransactionHandle) => Promise<T>,
  ): Promise<T> {
    return this.#database.transactionWithContext(context, (tx) => work(bindTransactionHandle(tx)));
  }

  async databaseNow(transaction: TransactionHandle): Promise<Date> {
    const result = await transactionOf(transaction).execute(sql`select clock_timestamp() as now`);
    const now = (result.rows[0] as { now?: Date | string } | undefined)?.now;
    if (now === undefined) throw new Error('The database did not answer with a time');
    return timestampOf(now);
  }
}

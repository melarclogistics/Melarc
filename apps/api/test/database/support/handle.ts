import { sql } from 'drizzle-orm';

import type {
  TransactionHandle,
  UnitOfWork,
} from '../../../src/platform/auth/ports/unit-of-work.port.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../../src/platform/database/transaction-context.js';
import {
  bindTransactionHandle,
  transactionOf,
} from '../../../src/platform/database/transaction-handle.js';

/**
 * A transaction under `context` on the real service, with both the handle that port operations take and the transaction the
 * test itself may use to arrange or read rows. The handle is the way a use case passes its transaction to a port; the real
 * `UnitOfWork` adapter belongs to the first task that consumes the port, and this is its shape for a test.
 */
export function withHandle<T>(
  service: DatabaseService,
  context: SecurityContext,
  work: (handle: TransactionHandle, tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return service.transactionWithContext(context, (tx) => work(bindTransactionHandle(tx), tx));
}

/** A `UnitOfWork` over the real service, for tests of code that opens its own transaction through the port. */
export function unitOfWorkOver(service: DatabaseService): UnitOfWork {
  return {
    run: (context, work) =>
      service.transactionWithContext(context, (tx) => work(bindTransactionHandle(tx))),
    databaseNow: async (handle) => {
      const result = await transactionOf(handle).execute(sql`select clock_timestamp() as now`);
      return new Date((result.rows[0] as { now: Date | string }).now);
    },
  };
}

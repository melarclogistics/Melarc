import type { SecurityContext } from '../../database/transaction-context.js';
import type { PortDescriptor } from './port-descriptor.js';

declare const transactionBrand: unique symbol;

/**
 * The caller's open transaction, opaque to every port. An adapter that runs inside it receives it as an argument and passes
 * it on to its queries; it never opens a nested transaction or hides a commit. Only the unit-of-work adapter can make one.
 */
export interface TransactionHandle {
  readonly [transactionBrand]: true;
}

/**
 * The use case owns the transaction (SOLUTION_ARCHITECTURE.md §5). It opens one here under a security context, does its work
 * against the handle, and the transaction commits when the work returns and rolls back when it throws. External I/O stays
 * outside; security state is read again after any wait.
 */
export interface UnitOfWork {
  run<T>(
    context: SecurityContext,
    work: (transaction: TransactionHandle) => Promise<T>,
  ): Promise<T>;
  /**
   * The database's wall-clock time for this transaction. A persisted expiry decision takes one fresh value of it **after the
   * required locks are held** and treats a time as valid when `now < expires_at` (plan §3).
   */
  databaseNow(transaction: TransactionHandle): Promise<Date>;
}

export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

export const UNIT_OF_WORK_DESCRIPTOR: PortDescriptor<UnitOfWork> = {
  port: 'UnitOfWork',
  owner: { kind: 'platform', area: 'database' },
  operations: {
    run: {
      inputs:
        'the security context of the transaction (principal, surface, scope) and the work to do against the transaction handle',
      outputs:
        "the work's result, after the commit; on a throw the transaction is rolled back and the error continues",
      outcomes: 'none',
      raises: ['CONTEXT_REFUSED', 'NESTED_TRANSACTION_REFUSED'],
      transaction: 'outside-any-transaction',
    },
    databaseNow: {
      inputs: 'the transaction handle',
      outputs: 'the database wall-clock time, fresh at the call',
      outcomes: 'none',
      raises: 'none',
      transaction: 'inside-callers-transaction',
    },
  },
};

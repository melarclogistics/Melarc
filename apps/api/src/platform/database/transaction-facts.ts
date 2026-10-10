/**
 * What `DatabaseService` knows about a transaction it opened, for the code that must act first in it (S0.7). The policy locks of
 * SECURITY_DESIGN.md §13.10a come before any statement that reads or writes data; only the transaction's own configuration (here:
 * the security context) may precede them. The service counts the statements the work issues, and marks the point where its own
 * context statement has been applied, so the toolkit can tell "nothing else has run" from "something has".
 *
 * Like the exclusive gate (`transaction-gate.ts`) the facts are keyed by the transaction handle itself, so they are not part of
 * the handle's type: only the service registers them, and a handle it did not make has none.
 */
export interface TransactionFacts {
  /** The statements the work has issued since the security context was applied. */
  readonly statementsSinceContext: () => number;
  /** Called by the service once its context statement has run: statements before this are configuration, not data. */
  readonly markContextApplied: () => void;
}

const facts = new WeakMap<object, TransactionFacts>();

/** Called by the database service for each transaction it opens. */
export function registerTransactionFacts(transaction: object, given: TransactionFacts): void {
  facts.set(transaction, given);
}

/** The facts of a transaction of the database service, or `undefined` for any other handle. */
export function transactionFacts(transaction: object): TransactionFacts | undefined {
  return facts.get(transaction);
}

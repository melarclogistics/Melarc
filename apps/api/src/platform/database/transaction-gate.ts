import type { DatabaseTransaction } from './database.service.js';

/**
 * The transaction's gate: how a piece of code holds a transaction exclusively for a few statements. The scope probe
 * (scope-probe.ts) makes one record of another hub readable by setting a transaction-local value, reads it, and clears the
 * value (SECURITY_DESIGN.md §14.4b). While the value is set, any other statement of the same transaction would see that
 * record too, and a transaction handle can be used from several places at once (`Promise.all`), so the probe holds the
 * transaction: for as long as it runs, the transaction's own handle refuses every statement and the probe uses a handle
 * of its own that works only until it ends.
 *
 * Only `DatabaseService` makes the gate for a transaction (`registerExclusiveGate`); a handle it did not make has none.
 * The gate is keyed by the handle itself, so it is not part of the handle's type and cannot be reached from the work the
 * transaction runs, except through `runExclusively`.
 */

export type ExclusiveWork<T> = (exclusive: DatabaseTransaction) => Promise<T>;
export type ExclusiveGate = <T>(work: ExclusiveWork<T>) => Promise<T>;

const gates = new WeakMap<object, ExclusiveGate>();

/** Called by the database service for each transaction it opens. */
export function registerExclusiveGate(transaction: object, gate: ExclusiveGate): void {
  gates.set(transaction, gate);
}

/**
 * Runs `work` with the transaction held: no other statement of `transaction` runs until it ends, and a second hold is
 * refused. `exclusive` is the handle `work` uses, and it stops working when `work` ends. A transaction that is not the
 * database service's is refused.
 */
export function runExclusively<T>(
  transaction: DatabaseTransaction,
  work: ExclusiveWork<T>,
): Promise<T> {
  const gate = gates.get(transaction);
  if (gate === undefined) {
    return Promise.reject(new Error('That is not a transaction of the database service'));
  }
  return gate(work);
}

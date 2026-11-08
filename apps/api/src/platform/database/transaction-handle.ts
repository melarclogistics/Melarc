import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import type { DatabaseTransaction } from './database.service.js';
import type { SecurityContext } from './transaction-context.js';
import { transactionFacts } from './transaction-facts.js';

/**
 * The bridge between the opaque `TransactionHandle` that port operations receive (unit-of-work.port.ts) and the transaction of
 * `DatabaseService` they run their statements on. A port adapter that works inside the caller's transaction (the audit writer,
 * the idempotency store) is given a handle and asks for the transaction here; it never opens one, so it cannot nest or commit.
 *
 * **Who makes a handle.** The code that opens a transaction with `DatabaseService.transactionWithContext` and then hands the
 * work to ports: the unit-of-work adapter of the first task that consumes `UnitOfWork`, and the tests of the adapters. It gives
 * the transaction and nothing else: **the context is the one the database service applied to that transaction** (registered with
 * the transaction's facts, `transaction-facts.ts`), never one the binder names, so a handle cannot stand over a transaction
 * under a context other than its own. That is what lets an adapter take facts from the context (the audit's actor, surface and
 * correlation id) rather than trusting them from a caller: the actor of an event is `auditActorOf(context)` and nothing a caller
 * passes (obligation OB-47). A transaction the service has not put under a context is refused.
 *
 * A handle is an empty frozen object: the transaction and the context are kept beside it, not on it, and a forged object is
 * refused. The context is the service's frozen copy, taken when it was validated, so nothing the caller does to its own object
 * afterwards changes who the audit says acted.
 */
const bound = new WeakMap<object, { tx: DatabaseTransaction; context: SecurityContext }>();
const handleOfTransaction = new WeakMap<object, TransactionHandle>();

/**
 * The handle for a transaction that the database service has put under a security context; its context is the one the service
 * applied. The same transaction always gives the same handle.
 */
export function bindTransactionHandle(tx: DatabaseTransaction): TransactionHandle {
  const existing = handleOfTransaction.get(tx);
  if (existing !== undefined) return existing;
  const context = transactionFacts(tx)?.appliedContext();
  if (context === undefined) {
    throw new Error(
      'That transaction has no security context applied by the database service: it cannot be bound to a handle',
    );
  }
  const handle = Object.freeze(Object.create(null) as object) as TransactionHandle;
  bound.set(handle, { tx, context });
  handleOfTransaction.set(tx, handle);
  return handle;
}

function entryOf(handle: TransactionHandle): { tx: DatabaseTransaction; context: SecurityContext } {
  // A WeakMap answers nothing for a key that is not an object, so a forged value of any kind finds no entry.
  const entry = bound.get(handle);
  if (entry === undefined) throw new Error('That is not a transaction handle');
  return entry;
}

/** The transaction a handle stands for. Refuses anything that was not made by `bindTransactionHandle`. */
export function transactionOf(handle: TransactionHandle): DatabaseTransaction {
  return entryOf(handle).tx;
}

/** The security context the handle's transaction was opened under. */
export function securityContextOf(handle: TransactionHandle): SecurityContext {
  return entryOf(handle).context;
}

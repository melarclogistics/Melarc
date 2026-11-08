import { sql } from 'drizzle-orm';

import type { DatabaseTransaction } from '../database.service.js';
import { transactionFacts } from '../transaction-facts.js';
import { PolicyLockError } from './lock-keys.js';
import type { PolicyLockPlan } from './plan.js';

/**
 * Taking the planned locks (S0.7; SECURITY_DESIGN.md §13.10a). Three rules are enforced here and not left to the caller:
 *
 * - **The locks come first.** Only the security context may precede them; a transaction that has already issued another
 *   statement is refused, and so is one in which another statement is issued while the locks are being taken. A read before the
 *   locks could be the basis of a decision the locks were meant to protect.
 * - **The isolation level is READ COMMITTED**, read before the first lock. A transaction at REPEATABLE READ or SERIALIZABLE could
 *   hold a snapshot older than its locks, and is refused for these operations.
 * - **Once per transaction, so never an upgrade.** (An acquisition that fails leaves the transaction with some locks held and
 *   others not: it is not tried again, and the transaction rolls back.) The plan already holds each key once, in its strongest mode; a second
 *   acquisition would be how a key held shared is asked for exclusive. A path that finds it needs more rolls back and
 *   restarts with the stronger plan from the start (`PolicyRestartRequired`).
 *
 * Only the transaction-scoped functions are used (`pg_advisory_xact_lock`, `pg_advisory_xact_lock_shared`): they release at
 * `COMMIT` or `ROLLBACK`, so a pooled connection never carries a lock into the next request. The runtime holds no table
 * privilege for any of this, which is the point of using advisory locks. Each lock is its own statement, because the order of
 * evaluation within one `SELECT` list is not a promise of SQL.
 */

/** The isolation level was not READ COMMITTED. */
export class PolicyIsolationError extends PolicyLockError {
  constructor(readonly level: string | undefined) {
    super(
      `Policy locks need a READ COMMITTED transaction, not ${level ?? 'one whose level cannot be read'}`,
    );
    this.name = 'PolicyIsolationError';
  }
}

const held = new WeakMap<object, PolicyLockPlan>();

/** The locks this transaction holds through the toolkit, or `undefined` before they were taken. */
export function heldPolicyLocks(transaction: DatabaseTransaction): PolicyLockPlan | undefined {
  return held.get(transaction);
}

/**
 * Refuses a transaction that is not at READ COMMITTED (SECURITY_DESIGN.md §13.10a, "Reads follow acquisition"). It reads the
 * level of the transaction it is given: a default isolation level set on the role or the database shows up here.
 */
export async function assertReadCommitted(transaction: DatabaseTransaction): Promise<void> {
  const result = await transaction.execute(
    sql`select current_setting('transaction_isolation') as level`,
  );
  const level = (result.rows[0] as { level?: unknown } | undefined)?.level;
  if (level !== 'read committed') {
    throw new PolicyIsolationError(typeof level === 'string' ? level : undefined);
  }
}

/**
 * Takes `plan`, in its order, as the first thing the transaction does after its context is set. Resolves when every lock is
 * held; the locks release with the transaction.
 */
export async function acquirePolicyLocks(
  transaction: DatabaseTransaction,
  plan: PolicyLockPlan,
): Promise<void> {
  const facts = transactionFacts(transaction);
  if (facts === undefined) {
    throw new PolicyLockError('Policy locks are taken in a transaction of the database service');
  }
  if (held.has(transaction)) {
    throw new PolicyLockError(
      'Policy locks are taken once per transaction: to need a key in a stronger mode, roll back and restart with that plan',
    );
  }
  if (facts.statementsSinceContext() !== 0) {
    throw new PolicyLockError(
      'Policy locks are taken before any other statement of the transaction: only its security context may precede them',
    );
  }
  // Recorded at once, so that a second call made before this one ends is refused.
  held.set(transaction, plan);

  await assertReadCommitted(transaction);
  for (const lock of plan) {
    await transaction.execute(
      lock.mode === 'shared'
        ? sql`select pg_advisory_xact_lock_shared(${lock.class}::int4, ${lock.key}::int4)`
        : sql`select pg_advisory_xact_lock(${lock.class}::int4, ${lock.key}::int4)`,
    );
  }

  // The level check and one statement for each lock are the only statements there should have been. Anything more was issued
  // while the locks were being taken, so it may have run before them: the transaction fails, and rolls back.
  if (facts.statementsSinceContext() !== 1 + plan.length) {
    throw new PolicyLockError(
      'Another statement was issued while the policy locks were being taken: nothing may run before them',
    );
  }
}

import type { TransactionHandle, UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import type { SecurityContext } from '../database/transaction-context.js';

/**
 * The committed-failure shape that authentication bookkeeping needs (audit.md §2.1 and §5.4; AuditWriter's description). A failed
 * sign-in writes its failed-attempt counter and its `auth.session.failed` event, and **those must survive the refusal**: a use case
 * that raised the refusal from inside its transaction would roll its own record of the attempt back with it, and the lockout
 * would never count. So the use case does its bookkeeping in a transaction of its own, the transaction commits, and only then is
 * the refusal raised, outside the transaction.
 *
 * `work` does the bookkeeping against the transaction it is given and **returns** the error to answer; it does not throw it. What
 * this function guarantees, and the use case need not remember:
 *
 * - the refusal is raised after the commit, never before it and never from inside the transaction;
 * - if the bookkeeping cannot be written (the work throws, or the commit fails) **that** failure is raised, not the refusal: a
 *   lost counter must not read as an ordinary wrong password, and an uncertain commit (`CommitOutcomeUnknownError`) is never
 *   turned into a definite answer about the credential;
 * - it never resolves: a refused request cannot go on as if it had succeeded.
 *
 * It builds no sign-in. The operations that use it (S0.32 onward) decide what the bookkeeping is and what the refusal says.
 */
export async function commitThenRefuse(
  unitOfWork: Pick<UnitOfWork, 'run'>,
  context: SecurityContext,
  work: (transaction: TransactionHandle) => Promise<Error>,
): Promise<never> {
  const refusal = await unitOfWork.run(context, async (transaction) => {
    const answer = await work(transaction);
    // Judged before the commit: work that gave nothing to raise is a defect, and its bookkeeping is not kept.
    if (!(answer instanceof Error)) {
      throw new TypeError('The work of a committed failure gives back the error to raise');
    }
    return answer;
  });
  // The transaction has committed, and nothing of it is open: the refusal is answered outside it.
  throw refusal;
}

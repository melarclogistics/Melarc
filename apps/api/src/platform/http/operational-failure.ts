import {
  AuthenticationUnavailableError,
  FixedPolicyUnavailableError,
  SessionSnapshotUnreadableError,
} from '../auth/sessions/session-errors.js';
import {
  AcquireTimeoutError,
  PoolClosedError,
  PoolSaturatedError,
} from '../database/connection-queue.js';
import { CommitOutcomeUnknownError, DatabaseDeadlineError } from '../database/database-failures.js';
import { PolicyCoordinationError } from '../database/policy-lock/coordinate.js';
import { BudgetExpiredError } from '../execution/execution-budget.js';
import { LimiterUnavailableError } from '../limiter/limiter-errors.js';

/**
 * How the platform reads a failure that ended a request (S0.20; plan obligations OB-37, OB-55).
 *
 * - **Operational**: the service could not do the work in the time or with the resources it has, and it is known that the work
 *   did not take effect. The request budget ran out (`BudgetExpiredError`), a database time bound ended the work
 *   (`DatabaseDeadlineError`), or no connection could be had (`PoolSaturatedError`, `AcquireTimeoutError`, `PoolClosedError`).
 *   The caller is told `503`, which SECURITY_DESIGN.md §15.3 states as the platform's answer outside the operation contract.
 * - **Commit outcome unknown**: a commit was in flight when the connection ended or the budget ran out, so the work may have taken
 *   effect (`CommitOutcomeUnknownError`). It must never be answered as the first kind: a `503` says "try again", and trying again
 *   is safe only through the operation's idempotency key. The owner decided its answer on 11 October 2026 (OB-55): `500`, no
 *   code, no `Retry-After`, and its own fixed text.
 * - **Unexpected**: anything else, a definite rollback (`TransactionRolledBackError`) among them, which is a defect of whoever
 *   wrote the work and so is a plain `500`.
 *
 * The typed error is read from anywhere in the `cause` chain, because inside the work drizzle wraps what a statement throws
 * and keeps it as the cause. An unknown commit outcome anywhere in the chain decides the reading, even beneath an operational
 * failure: it is the one that is wrong to understate.
 */
export type FailureKind =
  | { readonly kind: 'operational' }
  | {
      readonly kind: 'commit-outcome-unknown';
      readonly reason: CommitOutcomeUnknownError['reason'];
    }
  | { readonly kind: 'unexpected' };

/** An engineering bound on how far a chain of causes is followed: a longer or looping chain is read as far as this and no further. */
const MAX_CAUSE_DEPTH = 8;

const OPERATIONAL: readonly (abstract new (...args: never[]) => Error)[] = [
  BudgetExpiredError,
  DatabaseDeadlineError,
  PoolSaturatedError,
  AcquireTimeoutError,
  PoolClosedError,
  // The authoritative limiter could not decide (S0.22): it fails closed for credential mutations, with the generic operational
  // answer and never a permissive fallback (SECURITY_DESIGN.md §14.12).
  LimiterUnavailableError,
  // S0.24. The policy changed under an operation on each of its bounded attempts (SECURITY_DESIGN.md §13.10a, "restart"); this
  // instance cannot be sure of the fixed policy of an audience and so serves nothing of it (§13.10, part 2); it cannot read the
  // snapshot of a session of a format it does not know; a credential was presented and no store is composed to judge it. In each the
  // session or the principal is not at fault and nothing was done, so the answer is retryable and ends no session.
  PolicyCoordinationError,
  FixedPolicyUnavailableError,
  SessionSnapshotUnreadableError,
  AuthenticationUnavailableError,
];

export function classifyFailure(error: unknown): FailureKind {
  let operational = false;
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current instanceof Error; depth += 1) {
    if (current instanceof CommitOutcomeUnknownError) {
      return { kind: 'commit-outcome-unknown', reason: current.reason };
    }
    if (OPERATIONAL.some((type) => current instanceof type)) operational = true;
    current = current.cause;
  }
  return operational ? { kind: 'operational' } : { kind: 'unexpected' };
}

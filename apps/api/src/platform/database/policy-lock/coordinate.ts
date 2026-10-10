import type { Clock } from '../../auth/ports/clock.port.js';
import { ExecutionBudget, currentBudget, runWithBudget } from '../../execution/execution-budget.js';
import type { DatabaseService, DatabaseTransaction } from '../database.service.js';
import type { SecurityContext } from '../transaction-context.js';
import { acquirePolicyLocks } from './acquire.js';
import { planPolicyLocks, type PolicyLockRequest } from './plan.js';

/**
 * The coordinator (S0.7; SECURITY_DESIGN.md §13.10a, "Discovery, the planned set and restart"). It runs an operation that rests
 * on policy content in the five steps of the specification, and nothing that uses a policy table is in it:
 *
 * 1. **Discover**, in a short transaction of its own before the locked one. A hint only: it decides nothing and has no effect.
 * 2. **Plan** the complete set of locks (`plan`), merged and sorted by `planPolicyLocks`.
 * 3. **Acquire** them before any other statement that reads or writes data (`acquirePolicyLocks`), then **revalidate** under the
 *    locks: read again the facts the plan rested on.
 * 4. **If anything changed**, roll the whole transaction back, releasing every lock, and start again from step 1, at most
 *    `maxAttempts` attempts in all, then fail with `PolicyCoordinationError` (the platform's generic operational failure). **No
 *    effect precedes the revalidation**: `work` runs only after it passed, and what ran before it (the discovery, the locks,
 *    the revalidation reads) wrote nothing.
 * 5. **No upgrades.** The locks are taken once per transaction. An act that finds it needs a key it holds shared in exclusive mode
 *    throws `PolicyRestartRequired` with the stronger requests; the transaction rolls back and the next attempt plans them from
 *    the start.
 *
 * **Every attempt, restarts included, runs inside one total operation deadline**: an `ExecutionBudget` made here (a child of the
 * request's, when there is one, so it is never longer than what the request has left), under which each attempt's transactions
 * run. A restart never grants a fresh deadline. A lock that cannot be taken within `lock_timeout` is the database's
 * `DatabaseDeadlineError`, which is not retried here: the caller answers the generic failure.
 */

/**
 * The most attempts one operation makes: the first, and two restarts. A restart is caused only by a policy object changing
 * between the discovery and the locks (a bundle reassigned, a bundle replaced), and two such changes in a row for one operation
 * are already rare; a third is a sign of something wrong, and failing is the safer answer. **Development-qualified, not
 * production-qualified** (DEPLOYMENT_AND_ENVIRONMENTS.md §12.5, "What S0.7 applied and where it was exercised"); S0.65 proposes the
 * release value.
 */
export const POLICY_MAX_ATTEMPTS = 3;
const MAX_ATTEMPTS_LIMIT = 10;

export interface PolicyCoordination<Discovered, Result> {
  /** Step 1: a non-authoritative read, in its own short transaction. It decides nothing and has no effect. */
  discover(tx: DatabaseTransaction): Promise<Discovered>;
  /** Step 2: every lock the operation needs: from what was discovered, and from what the act reads or writes. */
  plan(discovered: Discovered): readonly PolicyLockRequest[];
  /** Step 3, under the locks: read again the facts the plan was built on, and return them. */
  revalidate(tx: DatabaseTransaction, discovered: Discovered): Promise<Discovered>;
  /** Step 3: true when what was read under the locks is what the plan was built on. */
  unchanged(discovered: Discovered, revalidated: Discovered): boolean;
  /** The act. Runs only after the revalidation passed, in the transaction that holds the locks. */
  work(tx: DatabaseTransaction, revalidated: Discovered): Promise<Result>;
}

/** The act found it needs more than it planned: roll back and plan these as well from the start. */
export class PolicyRestartRequired extends Error {
  constructor(readonly additional: readonly PolicyLockRequest[]) {
    super('The operation needs stronger policy locks than it planned: restart with them');
    this.name = 'PolicyRestartRequired';
  }
}

/** The operation could not be completed: its facts kept changing. Answers the platform's generic operational failure. */
export class PolicyCoordinationError extends Error {
  constructor(
    readonly kind: 'restarts-exhausted',
    readonly attempts: number,
  ) {
    super(
      `The policy changed under the operation on each of its ${String(attempts)} attempts; nothing was done`,
    );
    this.name = 'PolicyCoordinationError';
  }
}

/** The revalidation found the facts changed: roll back and restart. Internal. */
class PlanChanged extends Error {
  constructor() {
    super('The facts the policy locks were planned on have changed');
    this.name = 'PlanChanged';
  }
}

export interface PolicyCoordinatorOptions {
  readonly clock: Clock;
  /** The one total deadline for every attempt of one operation, in milliseconds: finite and positive. */
  readonly totalDeadlineMs: number;
  /** At most this many attempts (the first included). */
  readonly maxAttempts?: number;
}

export class PolicyCoordinator {
  private readonly clock: Clock;
  private readonly totalDeadlineMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly database: Pick<DatabaseService, 'transactionWithContext'>,
    options: PolicyCoordinatorOptions,
  ) {
    const maxAttempts = options.maxAttempts ?? POLICY_MAX_ATTEMPTS;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS_LIMIT) {
      throw new RangeError(
        `An operation makes between 1 and ${String(MAX_ATTEMPTS_LIMIT)} attempts, not ${String(maxAttempts)}`,
      );
    }
    if (!Number.isFinite(options.totalDeadlineMs) || options.totalDeadlineMs <= 0) {
      throw new RangeError(
        'The total deadline of an operation is a finite, positive number of milliseconds',
      );
    }
    this.clock = options.clock;
    this.totalDeadlineMs = options.totalDeadlineMs;
    this.maxAttempts = maxAttempts;
  }

  async run<Discovered, Result>(
    context: SecurityContext,
    operation: PolicyCoordination<Discovered, Result>,
  ): Promise<Result> {
    const request = currentBudget();
    const deadline =
      request === undefined
        ? new ExecutionBudget(this.clock, 'policy-coordination', this.totalDeadlineMs)
        : request.child('policy-coordination', this.totalDeadlineMs);
    try {
      return await runWithBudget(deadline, async () => {
        // Requests the acts of earlier attempts asked for, planned from the start of every later one.
        let required: readonly PolicyLockRequest[] = [];
        for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
          deadline.throwIfExpired();
          const discovered = await this.database.transactionWithContext(context, (tx) =>
            operation.discover(tx),
          );
          const plan = planPolicyLocks([...operation.plan(discovered), ...required]);
          try {
            return await this.database.transactionWithContext(context, async (tx) => {
              await acquirePolicyLocks(tx, plan);
              const current = await operation.revalidate(tx, discovered);
              if (!operation.unchanged(discovered, current)) throw new PlanChanged();
              return operation.work(tx, current);
            });
          } catch (error) {
            if (error instanceof PolicyRestartRequired)
              required = [...required, ...error.additional];
            else if (!(error instanceof PlanChanged)) throw error;
          }
        }
        throw new PolicyCoordinationError('restarts-exhausted', this.maxAttempts);
      });
    } finally {
      deadline.finish();
    }
  }
}

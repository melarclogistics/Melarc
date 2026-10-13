import { sql } from 'drizzle-orm';

import type { StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle, UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import { judgeSession } from '../auth/sessions/session-judgement.js';
import { PolicyCoordinator } from '../database/policy-lock/coordinate.js';
import { bundleLock, fixedLock, type PolicyLockRequest } from '../database/policy-lock/plan.js';
import { timestampOf } from '../database/timestamps.js';
import { transactionOf } from '../database/transaction-handle.js';
import { isUuid } from '../database/transaction-context.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';
import type { AuthorizedRequest } from './authorized-request.js';
import type { OperationContexts } from './operation-contexts.js';
import { requireTargetTier, type TierRules } from './tier-policy.js';

/**
 * What a session is, read **by the session itself** in a transaction of its own principal (`session_select` admits a principal
 * its own rows), with the database's clock at the moment of the read. It is the revalidation of a state-changing request: ended,
 * past its end or idle, judged on one fresh instant read after the locks are held.
 */
interface Standing {
  readonly state: 'ACTIVE' | 'TERMINATED';
  readonly terminationReason: StoredSession['terminationReason'];
  readonly expiresAt: Date;
  readonly lastActivityAt: Date;
  readonly now: Date;
}

interface StandingRow {
  readonly terminated_at: Date | string | null;
  readonly termination_reason: StoredSession['terminationReason'];
  readonly expires_at: Date | string;
  readonly last_activity_at: Date | string;
  readonly now: Date | string;
}

async function readStanding(
  handle: TransactionHandle,
  sessionId: string,
): Promise<Standing | null> {
  const result = await transactionOf(handle).execute(sql`
    select terminated_at, termination_reason, expires_at, last_activity_at, clock_timestamp() as now
      from session where id = ${sessionId}`);
  const row = result.rows[0] as unknown as StandingRow | undefined;
  if (row === undefined) return null;
  return {
    state: row.terminated_at === null ? 'ACTIVE' : 'TERMINATED',
    terminationReason: row.termination_reason,
    expiresAt: timestampOf(row.expires_at),
    lastActivityAt: timestampOf(row.last_activity_at),
    now: timestampOf(row.now),
  };
}

export interface OperationRunnerOptions {
  readonly coordinator: Pick<PolicyCoordinator, 'run'>;
  readonly unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly contexts: OperationContexts;
  /** The rules a route may name (`TIER_RULES`); a test composes its own. */
  readonly tierRules?: TierRules;
}

export type OperationWork<T> = (
  transaction: TransactionHandle,
  authorized: AuthorizedRequest,
) => Promise<T>;

/**
 * The transaction a use case runs in, opened under the context its authorization decided (S0.26; SECURITY_DESIGN.md section 13.10a,
 * "Who takes which mode", "One order for every identity transaction" and "Reads follow acquisition, and are never cached"; plan
 * `OB-131`). The use case does not open its own: it asks this, so that the lock order and the revalidation are built once.
 *
 * - **`read`**: no policy lock ("a read-only request: none"). One transaction under the operation's context, at the database's
 *   default isolation. The authority check of such a request is the one authentication made; a read racing a reduction is simply
 *   ordered before it.
 * - **`mutate`**: the five steps of the specification on the toolkit of S0.7. **(1)** A non-authoritative read, before the
 *   transaction, of the acting session's own row. **(2)** The plan: the shared lock on the acting session's **bundle** and, for a
 *   Vendor or a Rider, on the **fixed policy** of the audience, in canonical order. **(3)** The locks are taken before any other
 *   statement; then the session is read again **under them**, and judged on one fresh database instant read after the locks:
 *   a session that a reduction ended while this request waited for the lock, one that has expired, and one that has gone idle, are
 *   refused `401 SESSION_INVALID` (`SESSION_SUPERSEDED` for a displaced vendor) and **nothing the use case would have written is
 *   written**. **(4)** The use case's work, in the same transaction, holding the locks: an authorized mutation either finishes
 *   before a reduction takes its exclusive lock or sees the reduction and does not proceed (`GBT-B12`). The restart bound and the
 *   one total deadline are the coordinator's.
 *
 * **Why the revalidation reads the session and not the floors.** A reduction holds the exclusive lock, raises the floor and ends
 * every session below it in one transaction. A session that is still `ACTIVE` when read under the shared lock therefore cannot be
 * below a floor that any reduction raised: it was either ended with that reduction or issued after it, from the reduced content.
 * The floors themselves are in tables a Vendor or a Rider context may not read (`data-scope-registry.md`), and the question the
 * request needs answered is exactly "is my session still live under these locks". The comparison with the floors, for sessions an
 * obsolete instance may have issued, is the authentication step's (`session-authority.ts`).
 *
 * **What it does not do.** It takes no lock for the sake of a target's sessions (a target revocation takes the identity and session
 * rows and no policy lock, section 13.10a), and it takes no row lock on a policy table, which the runtime may not hold.
 */
export class OperationRunner {
  readonly #options: OperationRunnerOptions;

  constructor(options: OperationRunnerOptions) {
    this.#options = options;
  }

  /**
   * Step 6 again, inside the transaction that acts: asks the route's tier rule what the target needs, on the record as this transaction
   * sees it, and refuses (`403 INSUFFICIENT_AUTHORITY`) unless the grant's tier meets it. The guard asked once, before the body was
   * validated; what a target needs can change while a request waits for a lock, and an authorization decided on the earlier answer must
   * not outlive it. `mutate` asks before the work runs; a use case that locks its target asks again after it holds the lock, so that
   * the answer is the one for the version it then changes. A route that declares no rule has nothing to ask.
   */
  async requireTargetTier(
    authorized: AuthorizedRequest,
    transaction: TransactionHandle,
  ): Promise<void> {
    const target = authorized.target;
    if (target?.tierRule === undefined || !isUuid(target.id)) return;
    const rules = this.#options.tierRules ?? {};
    const rule = Object.hasOwn(rules, target.tierRule) ? rules[target.tierRule] : undefined;
    if (rule === undefined) throw new Error('That tier rule is not one of the application’s');
    await requireTargetTier(rule, authorized.grant?.tier ?? null, transaction, target.id);
  }

  async read<T>(
    authorized: AuthorizedRequest,
    correlationId: string,
    work: OperationWork<T>,
  ): Promise<T> {
    // The lock-free path is for a request that changes nothing. A state-changing request that came here would act on authority that
    // a reduction could end while it ran: it is a defect of the use case, found at the first call, and nothing is opened for it.
    if (authorized.stateChanging) {
      throw new TypeError(
        'A state-changing request runs through OperationRunner.mutate, which takes the shared policy locks first',
      );
    }
    const context = await this.#options.contexts.of(authorized, correlationId);
    return this.#options.unitOfWork.run(context, (transaction) => work(transaction, authorized));
  }

  async mutate<T>(
    authorized: AuthorizedRequest,
    correlationId: string,
    work: OperationWork<T>,
  ): Promise<T> {
    const context = await this.#options.contexts.of(authorized, correlationId);
    const { session } = authorized;
    return this.#options.coordinator.run<Standing | null, T>(context, {
      discover: (_transaction, handle) => readStanding(handle, session.id),

      plan: () => {
        const locks: PolicyLockRequest[] = [bundleLock(session.authority.bundleId, 'shared')];
        if (session.principalType !== 'STAFF')
          locks.push(fixedLock(session.principalType, 'shared'));
        return locks;
      },

      // Under the locks: the session is read again, and its standing is what the work is allowed to rest on.
      revalidate: (_transaction, _discovered, handle) => readStanding(handle, session.id),

      // The bundle and the principal of a session never change (the table refuses it), so the plan never rests on anything that can
      // have moved. What can move is the session's standing, and the work below judges it: a session that is gone is `401`, not a
      // plan to be made again.
      unchanged: () => true,

      work: async (_transaction, standing, handle) => {
        if (standing === null) throw refusal(session, null);
        const verdict = judgeSession(
          {
            state: standing.state,
            terminationReason: standing.terminationReason,
            expiresAt: standing.expiresAt,
            lastActivityAt: standing.lastActivityAt,
            principalType: session.principalType,
          },
          standing.now,
          authorized.idleMinutes,
        );
        if (verdict.kind !== 'ACTIVE') {
          throw refusal(session, verdict.kind === 'TERMINATED' ? verdict.reason : null);
        }
        // The locks are held and the session stands: what the target needs is judged again on the record as it is now.
        await this.requireTargetTier(authorized, handle);
        return work(handle, authorized);
      },
    });
  }
}

/** The answer to a session that is no longer live under the locks: the same one authentication gives, and the same for every cause. */
function refusal(
  session: Pick<StoredSession, 'principalType'>,
  reason: StoredSession['terminationReason'],
): ApiException {
  return session.principalType === 'VENDOR' && reason === 'SUPERSEDED_BY_NEW_LOGIN'
    ? ApiException.of(ErrorCode.SessionSuperseded, 'Session superseded')
    : ApiException.of(ErrorCode.SessionInvalid, 'No usable session');
}

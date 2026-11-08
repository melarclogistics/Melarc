import type { AuthorizedRequest } from '../../authorization/authorized-request.js';
import type { OperationRunner } from '../../authorization/operation-runner.js';
import type { SecurityContext } from '../../database/transaction-context.js';
import { ApiException } from '../../http/api-exception.js';
import { ErrorCode } from '../../http/error-codes.js';
import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { UnitOfWork } from '../ports/unit-of-work.port.js';
import { currentSessionOf, type CurrentSessionView, type DisplayNames } from './current-session.js';
import { AUTHENTICATION_PRINCIPAL_ID } from './session-parameters.js';

export interface SessionOperationsOptions {
  /** Opens the transaction of a state-changing request under the context its authorization decided, with the shared locks. */
  readonly runner: Pick<OperationRunner, 'mutate'>;
  readonly unitOfWork: Pick<UnitOfWork, 'run'>;
  readonly sessions: Pick<SessionStore, 'terminate'>;
  readonly audit: AuditWriter;
  /** What gives a principal's name: the directory of the principal's own domain. */
  readonly names: DisplayNames;
}

/**
 * The two operations on the caller's own session (S0.34): `getCurrentSession` and `signOut`. Both are `self` operations: the session
 * is the one the request authenticated with, never one a client names, and they hold no permission.
 *
 * - **`current`** is the answer the sign-ins give, built by the same function (`currentSessionOf`) and in the same way: in a short
 *   transaction under the `authentication` capability, which is what may read the hubs and the identity of a principal of **any** of
 *   the three types (a Vendor's and a Rider's own contexts may not read a hub, and a read that said "no hubs" for a rider because
 *   row-level security filtered them quietly would be a wrong answer). It reads nothing the authenticated session does not name: the
 *   labels (the principal's name, the hubs' names) are read fresh, so that a rename shows, and the **authority stays the snapshot
 *   the session was issued with**: the permission keys are its keys and a label grants nothing. It writes nothing.
 * - **`signOut`** ends the session that signs out with `SIGNED_OUT` and records it, **in one transaction under the principal's own
 *   context** (the owner's decision of 11 October 2026, P-1: the act is the principal's, so its event names the principal and not the
 *   system, and the ending and the record commit together or not at all). It runs through `OperationRunner.mutate`, which takes the
 *   shared locks and judges the session again under them, so a session that ended while the request waited is `401 SESSION_INVALID`
 *   and **nothing is written**; a second sign-out of the same credential is refused the same way, and changes nothing. It ends the one
 *   session and no other of the same person (migration `0023` admits nothing wider).
 */
export class SessionOperations {
  readonly #options: SessionOperationsOptions;

  constructor(options: SessionOperationsOptions) {
    this.#options = options;
  }

  async current(authorized: AuthorizedRequest, correlationId: string): Promise<CurrentSessionView> {
    const context: SecurityContext = {
      principalType: 'SYSTEM',
      principalId: AUTHENTICATION_PRINCIPAL_ID,
      surface: 'SYSTEM',
      taskCapability: 'authentication',
      correlationId,
    };
    return this.#options.unitOfWork.run(context, (handle) =>
      currentSessionOf(handle, authorized.session, this.#options.names),
    );
  }

  async signOut(authorized: AuthorizedRequest, correlationId: string): Promise<void> {
    const { runner, sessions, audit } = this.#options;
    const sessionId = authorized.session.id;
    await runner.mutate(authorized, correlationId, async (handle) => {
      const ended = await sessions.terminate(handle, { by: 'session', sessionId }, 'SIGNED_OUT');
      // The standing was judged under the locks, so this is a request that lost a race with an ending that did not take the locks
      // it is ordered after (an expiry): the session is not one this request may end, and it writes nothing.
      if (ended.length === 0) throw ApiException.of(ErrorCode.SessionInvalid, 'No usable session');
      await audit.write(handle, {
        code: 'auth.session.terminated',
        enhanced: false,
        enhancedBasis: 'ROUTINE_TERMINATION',
        outcome: 'SUCCEEDED',
        object: { type: 'Session', id: sessionId },
        reason: { code: 'SIGNED_OUT', label: 'Signed out' },
      });
    });
  }
}

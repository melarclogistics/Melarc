import type { AuditWriter } from '../ports/audit-writer.port.js';
import type { SessionStore } from '../ports/session-store.port.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';

export interface ExpiryDependencies {
  readonly sessions: Pick<SessionStore, 'expire'>;
  readonly audit: AuditWriter;
}

/**
 * Ends one session because its time has run out, and records it (AC-SLICE-000-35: "the session is terminated with EXPIRED"; the
 * `EXPIRED` termination is recorded by `auth.session.terminated`, SECURITY_DESIGN.md §15.4, which says no `auth.session.expired` is
 * added): `EXPIRED` and one ordinary `auth.session.terminated` by the system, **in the caller's transaction**, so the ending and its
 * record commit together or not at all. Expiry is decided at request time and never by a job (SECURITY_DESIGN.md §13.3); the session
 * is judged on the database's clock **by the statement that ends it, after the row lock**, so a session that was recorded as active
 * while this waited is left live and no event is written for it. A session that is already ended (a sign-out or a revocation got
 * there first, and wrote its own record) keeps its first reason and gets no second event. Returns whether this call ended it.
 *
 * It names the bound that ran out (`IDLE` or `ABSOLUTE`) as the one fact of the event beyond the reason, which tells an operator why a
 * person was signed out without a secret in it.
 */
export async function endForExpiry(
  handle: TransactionHandle,
  dependencies: ExpiryDependencies,
  sessionId: string,
  idleMinutes: number | null,
  cause: 'IDLE' | 'ABSOLUTE',
): Promise<boolean> {
  const ended = await dependencies.sessions.expire(handle, sessionId, idleMinutes);
  if (!ended) return false;
  await dependencies.audit.write(handle, {
    code: 'auth.session.terminated',
    enhanced: false,
    enhancedBasis: 'ROUTINE_TERMINATION',
    outcome: 'SUCCEEDED',
    object: { type: 'Session', id: sessionId },
    reason: { code: 'EXPIRED', label: 'Expired' },
    detail: { cause },
  });
  return true;
}

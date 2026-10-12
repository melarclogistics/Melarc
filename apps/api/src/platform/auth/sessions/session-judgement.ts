import type { SessionTerminationReason, StoredSession } from '../ports/session-store.port.js';

/** What a session is, at one instant. The first three are refusals; a request whose session is `ACTIVE` goes on. */
export type SessionVerdict =
  | { readonly kind: 'ACTIVE' }
  | { readonly kind: 'TERMINATED'; readonly reason: SessionTerminationReason }
  | { readonly kind: 'EXPIRED'; readonly cause: 'ABSOLUTE' | 'IDLE' };

const MINUTE_MS = 60_000;

/**
 * Judges a session at `now` (SECURITY_DESIGN.md §13.3 and §13.3a; state-machines.md §14), by arithmetic on its own record and
 * on one instant. **`now` is one fresh value of the database's wall clock**, read after anything the decision waited for; this
 * function reads no clock, so what it decides is what its caller measured.
 *
 * - An ended session is refused with the reason it ended, however long it has left.
 * - **Valid means `now < expires_at`; equality is expired.** The absolute bound is named before the idle one when both are passed.
 * - A **browser** session (staff, vendor) is also expired when `now - last_activity_at >= idle`; equality is expired here too.
 *   A **rider** session has no idle rule, and the caller gives it `null`: the exemption is from evaluation, not from recording.
 * - A recorded activity later than `now` (the database's clock stepped back, or two instances' reads crossed) is not idle.
 *
 * A browser session judged with no idle limit, or with one that is not a positive whole number of minutes, is a programming error
 * and a `RangeError`: a missing setting must not read as "no idle rule", which would be the permissive way to fail.
 */
export function judgeSession(
  session: Pick<
    StoredSession,
    'state' | 'terminationReason' | 'expiresAt' | 'lastActivityAt' | 'principalType'
  >,
  now: Date,
  idleMinutes: number | null,
): SessionVerdict {
  if (idleMinutes !== null && (!Number.isInteger(idleMinutes) || idleMinutes < 1)) {
    throw new RangeError('An idle limit is a positive whole number of minutes');
  }
  if (idleMinutes === null && session.principalType !== 'RIDER') {
    throw new RangeError('A browser session has an idle limit');
  }
  if (session.state === 'TERMINATED') {
    // A terminated row always carries its reason (the table holds the two together); the fallback only keeps the type honest.
    return { kind: 'TERMINATED', reason: session.terminationReason ?? 'ADMIN_REVOKED' };
  }
  if (now.getTime() >= session.expiresAt.getTime()) return { kind: 'EXPIRED', cause: 'ABSOLUTE' };
  if (
    idleMinutes !== null &&
    session.principalType !== 'RIDER' &&
    now.getTime() - session.lastActivityAt.getTime() >= idleMinutes * MINUTE_MS
  ) {
    return { kind: 'EXPIRED', cause: 'IDLE' };
  }
  return { kind: 'ACTIVE' };
}

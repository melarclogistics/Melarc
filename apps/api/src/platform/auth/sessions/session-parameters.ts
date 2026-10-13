import type { BundleSnapshot, SessionPrincipalType } from '../ports/session-store.port.js';

/**
 * The reserved `SYSTEM` principal of the pre-authentication paths (S0.24): session lookup, session issue and the ending of
 * sessions, which run before any principal exists or on behalf of one that has none to act as. The first four bytes are the ASCII
 * word "auth", as the limiter's and the delivery worker's are theirs. It is a context label, never a row: no table holds it.
 */
export const AUTHENTICATION_PRINCIPAL_ID = '61757468-0000-4000-8000-000000000001';

/**
 * How long one recorded activity covers (SECURITY_DESIGN.md §13.3: "implementations may coalesce activity writes ... the externally
 * observable timeout must remain accurate within the coalescing window"). A request records activity only when the recorded one is
 * at least this old, so a burst of requests writes once. The idle limit is judged against the recorded activity, so a session
 * can end up to this much **earlier** than its last request plus the limit, never later: the error is on the safe side, and with
 * the shortest idle limit (15 minutes, privileged) it is 3.3 percent.
 *
 * An engineering parameter, not a product value, and **development-qualified, not production-qualified**: it has been exercised on
 * the development database only. S0.65 proposes the release value after measuring the write rate it saves.
 */
export const ACTIVITY_COALESCE_MS = 30_000;

/** The settings that bound a session (settings.md §7.5), each an object keyed by tier. */
export const SESSION_LIFETIME_SETTING = 'session_lifetime_minutes';
export const SESSION_IDLE_SETTING = 'session_idle_timeout_minutes';

/**
 * The tiers the two settings are keyed by: a rider; a privileged staff member (Senior Ops and Platform Admin, and no other bundle);
 * everyone else, which is the other staff bundles and a vendor.
 */
export const SESSION_TIERS = ['rider', 'standard', 'privileged'] as const;
export type SessionTier = (typeof SESSION_TIERS)[number];

/**
 * The tier of a session, from what it holds and never from a name: a rider is a rider, and a staff or vendor session is privileged
 * exactly when the bundle it was issued from is (the snapshot carries the flag, so a bundle that has since changed does not move a
 * session between tiers).
 */
export function tierOf(
  principalType: SessionPrincipalType,
  snapshot: Pick<BundleSnapshot, 'privileged'>,
): SessionTier {
  if (principalType === 'RIDER') return 'rider';
  return snapshot.privileged ? 'privileged' : 'standard';
}

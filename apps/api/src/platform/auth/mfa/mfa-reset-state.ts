import { sql } from 'drizzle-orm';

import { isUuid } from '../../database/transaction-context.js';
import { transactionOf } from '../../database/transaction-handle.js';
import type { TransactionHandle } from '../ports/unit-of-work.port.js';

/**
 * The one rule that says whether a staff identity's second factor can be reset, and which branch of the reset it is (S0.35;
 * state-machines.md section 18, "What `resetStaffMfa` accepts and refuses"; domain-model.md section 6.8). It is the projection
 * `StaffIdentity.mfa_reset_state` and, by the same function, the decision `resetStaffMfa` makes (S0.37), so the screen and the
 * operation cannot disagree except by time or by a concurrent change. **Eligibility is read from durable records and never from
 * absence**: an identity with no factor record at all, or whose latest factor the system ended, is never eligible.
 *
 * The decision is a pure function of facts (`decideMfaResetState`); the facts are gathered from the recorded rows by one database
 * function (`melarc.staff_reset_facts`, migration 0027, which states the mechanism), because a factor, a grant and a delivery job are
 * rows that only the `authentication` capability reads: the function lets a staff read ask for **the facts, and nothing else, of the
 * identities its scope shows**, in the caller's own snapshot and at one instant, and lets the reset operation ask under the capability
 * itself. The caller (a read of staff identities in a `REPEATABLE READ` transaction, or the reset under its identity lock) opens the
 * transaction; this opens none.
 */
export const MFA_RESET_STATES = ['FACTOR_ACTIVE', 'ENROLMENT_UNFINISHED', 'NOT_ELIGIBLE'] as const;
export type MfaResetState = (typeof MFA_RESET_STATES)[number];

/** The most recent factor of an identity (the greatest `ordinal`: the place the database allocated it; an id is not an order), by what the rule asks of it. */
export interface LatestFactor {
  readonly status: string;
  /** An administrator ended it (`revoked_by` is set); the system's ending leaves it null. */
  readonly revokedByAdministrator?: boolean;
  /** An administrative revocation records the reset episode it opened. */
  readonly hasRevocationEpisode?: boolean;
}

export interface ResetFacts {
  readonly status: string;
  readonly origin: string;
  /** Whether the identity's bundle is privileged (Senior Ops and Platform Admin): only a privileged identity has a second factor. */
  readonly privileged: boolean;
  /** The password is established (the moment it was is recorded: the hash itself is not readable by the runtime). */
  readonly hasCredential: boolean;
  readonly hasActiveFactor: boolean;
  readonly hasPendingFactor: boolean;
  /** A `PENDING` MFA enrolment or re-enrolment grant that has not reached its end, at the database's time of the read. */
  readonly hasUsableGrant: boolean;
  /** A delivery attempt of such a grant that is queued, leased or waiting to be retried. */
  readonly hasPendingDelivery: boolean;
  readonly latestFactor: LatestFactor | null;
}

/**
 * The rule. The target must be `ACTIVE` or `SUSPENDED` (a `PENDING_APPROVAL` or `REJECTED` identity holds no factor, and `OFFBOARDED` is
 * terminal), privileged, and have an established password; then exactly one of three recorded states must hold:
 *
 * 1. **An `ACTIVE` factor** to revoke: `FACTOR_ACTIVE`.
 * 2. **A stranded enrolment**: a `PENDING` factor with no usable enrolment or re-enrolment grant and no pending delivery attempt:
 *    `ENROLMENT_UNFINISHED`.
 * 3. **An unfinished reset**: neither an `ACTIVE` nor a `PENDING` factor, and the most recent factor `REVOKED` by an administrator with
 *    the episode it opened (no replacement was created because the re-enrolment grant lapsed or failed delivery): `ENROLMENT_UNFINISHED`.
 *
 * **A seeded bootstrap administrator (`origin = BOOTSTRAP`) is reached in state 1 only**: in states 2 and 3 it is resumed through the
 * provisioning channel and is not eligible. Anything else, and any status this build does not know, is `NOT_ELIGIBLE`.
 */
export function decideMfaResetState(facts: ResetFacts): MfaResetState {
  if (facts.status !== 'ACTIVE' && facts.status !== 'SUSPENDED') return 'NOT_ELIGIBLE';
  if (!facts.privileged || !facts.hasCredential) return 'NOT_ELIGIBLE';
  if (facts.hasActiveFactor) return 'FACTOR_ACTIVE';
  if (facts.origin === 'BOOTSTRAP') return 'NOT_ELIGIBLE';
  if (facts.hasPendingFactor) {
    return !facts.hasUsableGrant && !facts.hasPendingDelivery
      ? 'ENROLMENT_UNFINISHED'
      : 'NOT_ELIGIBLE';
  }
  const latest = facts.latestFactor;
  if (
    latest !== null &&
    latest.status === 'REVOKED' &&
    latest.revokedByAdministrator === true &&
    latest.hasRevocationEpisode === true
  ) {
    return 'ENROLMENT_UNFINISHED';
  }
  return 'NOT_ELIGIBLE';
}

/** What a read of a staff identity shows of its factors, beside the rule's answer. */
export interface MfaPosture {
  /** A proven (`ACTIVE`) factor exists. Never settable by a caller, and never a stand-in for `resetState`. */
  readonly mfaEnrolled: boolean;
  readonly resetState: MfaResetState;
}

interface FactRow {
  readonly identity_id: string;
  readonly status: string;
  readonly origin: string;
  readonly privileged: boolean;
  readonly has_credential: boolean;
  readonly has_active_factor: boolean;
  readonly has_pending_factor: boolean;
  readonly has_usable_grant: boolean;
  readonly has_pending_delivery: boolean;
  readonly latest_status: string | null;
  readonly latest_revoked_by_admin: boolean | null;
  readonly latest_has_episode: boolean | null;
}

/**
 * The facts of the identities named, by one call of `melarc.staff_reset_facts`, for those **the caller's context shows** (a staff
 * context in a `REPEATABLE READ` transaction under the authorization of `staff.read`: the identities of its scope; the `authentication`
 * capability: every one that exists). An identity that does not exist, or that the scope does not show, is not in the answer, and the
 * caller that must answer for each identity it read checks that it got one (`StaffIdentitiesService`). A usable grant is judged on the
 * database's clock, once for the call, never the application's.
 */
export async function loadResetFacts(
  handle: TransactionHandle,
  ids: readonly string[],
): Promise<ReadonlyMap<string, ResetFacts>> {
  const facts = new Map<string, ResetFacts>();
  if (ids.length === 0) return facts;
  if (!ids.every((id) => isUuid(id)))
    throw new TypeError('A staff identity is named by its id (a UUID)');
  const list = `{${[...new Set(ids.map((id) => id.toLowerCase()))].join(',')}}`;
  const result = await transactionOf(handle).execute(
    sql`select * from melarc.staff_reset_facts(${list}::uuid[])`,
  );
  for (const row of result.rows as unknown as FactRow[]) {
    facts.set(row.identity_id, factsOfRow(row));
  }
  return facts;
}

function factsOfRow(row: FactRow): ResetFacts {
  return {
    status: row.status,
    origin: row.origin,
    privileged: row.privileged,
    hasCredential: row.has_credential,
    hasActiveFactor: row.has_active_factor,
    hasPendingFactor: row.has_pending_factor,
    hasUsableGrant: row.has_usable_grant,
    hasPendingDelivery: row.has_pending_delivery,
    latestFactor:
      row.latest_status === null
        ? null
        : {
            status: row.latest_status,
            revokedByAdministrator: row.latest_revoked_by_admin === true,
            hasRevocationEpisode: row.latest_has_episode === true,
          },
  };
}

/**
 * The facts of **one** identity, read by a mutation **under the identity's lock** (S0.36, S0.37; migration 0029, `melarc.staff_locked_facts`).
 * The function takes the lock itself, in the caller's own context and scope, at READ COMMITTED under the key of the operation, and
 * returns the same closed list as the read does, so the ETag a mutation recomputes here is the ETag the read gave. `null` is an identity
 * the caller's scope does not show, or that does not exist: the function says nothing more of it, and neither does this. After this
 * call the transaction holds the identity's lock, and a comparison of `If-Match` made now is made against the facts of the row it then
 * acts on.
 */
export async function loadLockedFacts(
  handle: TransactionHandle,
  id: string,
): Promise<ResetFacts | null> {
  if (!isUuid(id)) throw new TypeError('A staff identity is named by its id (a UUID)');
  const result = await transactionOf(handle).execute(
    sql`select * from melarc.staff_locked_facts(${id.toLowerCase()}::uuid)`,
  );
  const row = (result.rows as unknown as FactRow[])[0];
  return row === undefined ? null : factsOfRow(row);
}

/** The posture of each identity named that the caller's context shows: the facts, decided by the one rule. */
export async function mfaPostureOf(
  handle: TransactionHandle,
  ids: readonly string[],
): Promise<ReadonlyMap<string, MfaPosture>> {
  const postures = new Map<string, MfaPosture>();
  for (const [id, facts] of await loadResetFacts(handle, ids)) {
    postures.set(id, {
      mfaEnrolled: facts.hasActiveFactor,
      resetState: decideMfaResetState(facts),
    });
  }
  return postures;
}

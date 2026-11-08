import type { AuditJson, AuditJsonObject } from '../auth/ports/audit-writer.port.js';
import { isUuid } from '../database/transaction-context.js';

/**
 * The facts of `auth.mfa.reset` (audit.md §5.4; state-machines.md §18, "What `resetStaffMfa` accepts and refuses"), as one explicit
 * shape the writer validates. The internal names below are this module's, given to facts the retained specifications already
 * require; they add no product behaviour, no OpenAPI field and no table. They live in `related_ids` and `before_after`, which are
 * the ledger's own structured columns.
 *
 * **What the writer can establish, and what it cannot.** It checks that each required fact is there, that an identifier is a
 * UUID, that a state is one of the closed states, and that the facts agree with one another (a reset of a live factor issues a
 * grant; a coalesced reset revokes and issues nothing; a factor is named exactly where one was revoked). It does **not** know that
 * an episode, a factor or a grant exists, belongs to the target, or was in the state it is said to have been in: that is the use
 * case's, established under the identity's lock, in the transaction that writes the event. An identifier that is a well-formed
 * UUID proves nothing about lineage, and this module does not pretend it does.
 *
 * ## The shape
 *
 * - `object`: the target, `{ type: 'StaffIdentity', id }`. The actor is a Platform Admin (a `STAFF` transaction) and is **not the
 *   target** (`SELF_APPROVAL_FORBIDDEN` refuses a self-reset, and a refusal is not this event).
 * - `outcome`: `SUCCEEDED`. A refused reset is not this event (§5.4).
 * - `previous_state`: the state acted on, `ACTIVE_FACTOR`, `STRANDED_ENROLMENT` or `UNFINISHED_RESET`.
 * - `resulting_state`: `ISSUED` (a new `MFA_REENROLMENT` grant was issued) or `COALESCED` (a usable grant or a pending delivery
 *   attempt already existed and nothing was issued). A reset of a live factor (`ACTIVE_FACTOR`) always revokes it and issues a
 *   grant, and a stranded enrolment is by definition one with no usable grant and no pending attempt, so **`COALESCED` is possible
 *   only for `UNFINISHED_RESET`** (the repeated call of state-machines.md §18, "Repeated reissue").
 * - `reason`: the branch's reason of the MFA-reset domain: `MFA_AUTHENTICATOR_UNAVAILABLE` for `ACTIVE_FACTOR`,
 *   `MFA_ENROLMENT_EXPIRED` for the other two (domain-model.md §3.9).
 * - `related_ids`, exactly these keys and no others:
 *   - `episode_id` (UUID), always: the reset episode the act belongs to.
 *   - `revoked_factor_id` (UUID), when `ISSUED` and a factor was revoked (`ACTIVE_FACTOR`, `STRANDED_ENROLMENT`); absent for
 *     `UNFINISHED_RESET`, where no factor legitimately exists to revoke, and absent when `COALESCED`.
 *   - `new_grant_id` (UUID), when `ISSUED`; absent when `COALESCED` (nothing was issued).
 *   - `superseded_grant_ids` (a list of distinct UUIDs), always: the grants that were still `PENDING` and became `SUPERSEDED`. An
 *     empty list is valid and means nothing was superseded; it is empty when `COALESCED`; it does not name the new grant.
 * - `before_after`, when `ISSUED`, exactly these keys, each `{ before, after }`:
 *   - `reenrolment_grant`: `NONE` to `PENDING`, always.
 *   - `mfa_factor`: `ACTIVE` (or `PENDING` for `STRANDED_ENROLMENT`) to `REVOKED`, exactly when `revoked_factor_id` is present.
 *   - `superseded_grants`: `PENDING` to `SUPERSEDED`, exactly when `superseded_grant_ids` is not empty.
 *   When `COALESCED` nothing changed, and there is no `before_after`.
 *
 * Never in the event: a seed, a token, a QR, a code, a destination or a secret. The identifiers above are the whole of it.
 */
export const MFA_RESET_STATES = [
  'ACTIVE_FACTOR',
  'STRANDED_ENROLMENT',
  'UNFINISHED_RESET',
] as const;
export const MFA_RESET_RESULTS = ['ISSUED', 'COALESCED'] as const;
type ResetState = (typeof MFA_RESET_STATES)[number];

const REASON_OF_STATE: Readonly<Record<ResetState, string>> = {
  ACTIVE_FACTOR: 'MFA_AUTHENTICATOR_UNAVAILABLE',
  STRANDED_ENROLMENT: 'MFA_ENROLMENT_EXPIRED',
  UNFINISHED_RESET: 'MFA_ENROLMENT_EXPIRED',
};
/** The state of the revoked factor before the act, for the states in which a factor is revoked. */
const FACTOR_BEFORE: Readonly<Partial<Record<ResetState, string>>> = {
  ACTIVE_FACTOR: 'ACTIVE',
  STRANDED_ENROLMENT: 'PENDING',
};
const RELATED_KEYS = [
  'episode_id',
  'revoked_factor_id',
  'new_grant_id',
  'superseded_grant_ids',
] as const;
const DIFF_KEYS = ['reenrolment_grant', 'mfa_factor', 'superseded_grants'] as const;

export interface MfaResetFacts {
  readonly outcome: string;
  readonly previousState: unknown;
  readonly resultingState: unknown;
  readonly reasonCode: string | undefined;
  readonly objectType: unknown;
  readonly objectId: string | null;
  readonly actorId: string | null;
  readonly relatedIds: AuditJsonObject | null;
  readonly beforeAfter: AuditJsonObject | null;
}

const uuid = (value: AuditJson | undefined): string | undefined =>
  typeof value === 'string' && isUuid(value) ? value.toLowerCase() : undefined;

const isTransition = (value: AuditJson | undefined, before: string, after: string): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).toSorted().join(',') === 'after,before' &&
  (value as Record<string, AuditJson>).before === before &&
  (value as Record<string, AuditJson>).after === after;

/**
 * Refuses (by `refuse`, which throws) an `auth.mfa.reset` whose facts are not the shape above. Called by the writer for this event
 * only, after the generic checks of its requirements. It reads the event and nothing else.
 */
export function validateMfaResetFacts(
  facts: MfaResetFacts,
  refuse: (field: string) => never,
): void {
  if (facts.outcome !== 'SUCCEEDED') refuse('outcome');
  const state = facts.previousState;
  if (typeof state !== 'string' || !(MFA_RESET_STATES as readonly string[]).includes(state)) {
    return refuse('previousState');
  }
  const acted = state as ResetState;
  const result = facts.resultingState;
  if (result !== 'ISSUED' && result !== 'COALESCED') return refuse('resultingState');
  if (result === 'COALESCED' && acted !== 'UNFINISHED_RESET') refuse('resultingState');

  if (facts.reasonCode !== REASON_OF_STATE[acted]) refuse('reason.code');

  // The target is an identity and not the actor (a self-reset is refused, and a refusal is not this event).
  if (facts.objectType !== 'StaffIdentity' || facts.objectId === null) refuse('object');
  if (facts.actorId !== null && facts.objectId === facts.actorId) refuse('object');

  const related = facts.relatedIds;
  if (related === null) return refuse('relatedIds');
  for (const key of Object.keys(related)) {
    if (!(RELATED_KEYS as readonly string[]).includes(key)) refuse('relatedIds');
  }
  if (uuid(related.episode_id) === undefined) refuse('relatedIds.episode_id');

  const issued = result === 'ISSUED';
  const revokesAFactor = issued && acted !== 'UNFINISHED_RESET';
  if (revokesAFactor) {
    if (uuid(related.revoked_factor_id) === undefined) refuse('relatedIds.revoked_factor_id');
  } else if (related.revoked_factor_id !== undefined) {
    refuse('relatedIds.revoked_factor_id');
  }
  const newGrant = uuid(related.new_grant_id);
  if (issued) {
    if (newGrant === undefined) refuse('relatedIds.new_grant_id');
  } else if (related.new_grant_id !== undefined) {
    refuse('relatedIds.new_grant_id');
  }

  const listed = related.superseded_grant_ids;
  if (!Array.isArray(listed)) return refuse('relatedIds.superseded_grant_ids');
  const superseded = (listed as AuditJson[]).map(uuid);
  if (superseded.some((id) => id === undefined)) refuse('relatedIds.superseded_grant_ids');
  const distinct = new Set(superseded as string[]);
  if (distinct.size !== superseded.length) refuse('relatedIds.superseded_grant_ids');
  if (newGrant !== undefined && distinct.has(newGrant)) refuse('relatedIds.superseded_grant_ids');
  if (!issued && superseded.length > 0) refuse('relatedIds.superseded_grant_ids');

  // The safe diff, from the approved state facts: what became of the factor and of the grants.
  const diff = facts.beforeAfter;
  if (!issued) {
    if (diff !== null) refuse('beforeAfter');
    return;
  }
  if (diff === null) return refuse('beforeAfter');
  for (const key of Object.keys(diff)) {
    if (!(DIFF_KEYS as readonly string[]).includes(key)) refuse('beforeAfter');
  }
  if (!isTransition(diff.reenrolment_grant, 'NONE', 'PENDING'))
    refuse('beforeAfter.reenrolment_grant');
  const factorBefore = FACTOR_BEFORE[acted];
  if (revokesAFactor && factorBefore !== undefined) {
    if (!isTransition(diff.mfa_factor, factorBefore, 'REVOKED')) refuse('beforeAfter.mfa_factor');
  } else if (diff.mfa_factor !== undefined) {
    refuse('beforeAfter.mfa_factor');
  }
  if (superseded.length > 0) {
    if (!isTransition(diff.superseded_grants, 'PENDING', 'SUPERSEDED')) {
      refuse('beforeAfter.superseded_grants');
    }
  } else if (diff.superseded_grants !== undefined) {
    refuse('beforeAfter.superseded_grants');
  }
}

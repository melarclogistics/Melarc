import type { AuditActorType } from '../database/audit-actor.js';
import type { AuditEventCode } from './audit-event-codes.js';

/**
 * Which tier each event of the catalogue is, and which facts the identity events whose requirements are settled must carry (G2-06;
 * audit.md sections 5 and 6). The writer enforces these centrally, so that a caller can neither downgrade an event the catalogue
 * makes enhanced nor leave out a fact the catalogue says it records: an enhanced event fails closed and has its own retention and
 * export treatment (audit.md section 3), and an event written at the wrong tier is the wrong kind of evidence for ever, because the
 * ledger is append-only.
 *
 * **Every code has a tier, and the document is the authority.** `audit-classification.test.ts` reads the catalogue rows of
 * `contracts/audit.md` and fails when a row says **Enhanced**, "Not enhanced" or "Enhanced when ..." and this module says
 * otherwise, so a tier changes in the document and here in one change.
 *
 * - `ENHANCED`: fixed. The caller states `enhanced: true`; `false` is refused.
 * - `STANDARD`: fixed. `enhanced: true` is refused, because it would put an ordinary event into the retention and export treatment of
 *   the enhanced ones.
 * - `CONDITIONAL`: the tier depends on a fact of the act. The caller states **which basis applies** (`enhancedBasis`), the basis
 *   fixes the tier, and where the basis can be checked against the transaction's own context it is (an administrator-initiated
 *   recovery is a staff transaction; a seed is the `seed` capability), so that the basis is not only the caller's say-so. A basis
 *   that cannot be checked here (a payment already taken; a platform-wide block) is the emitting operation's to state truthfully,
 *   and is recorded in the plan as such.
 */

/** The events the catalogue makes enhanced, wherever they sit: 76 of the 190, read from the rows of `contracts/audit.md`. */
export const ENHANCED_CODES = [
  'pickup.cancellation_charge.waived',
  'pickup.handshake.fallback_override',
  'pickup.exception.approved',
  'fleet.custody.initiated',
  'fleet.custody.accepted',
  'pickup.attempt.extended',
  'pickup.request.escalated',
  'pickup.handshake.manually_resolved',
  'pickup.request.hub_reassigned',
  'pickup.service_window.overridden',
  'pickup.request.single_package_fee_posted',
  'pickup.request.single_package_approved',
  'hub.osd.resolved',
  'hub.intake.closed_exception',
  'hub.intake.reopened',
  'dispatch.run.dispatched',
  'dispatch.run.rollback',
  'payment.adjustment.resolution_decided',
  'payment.ledger.exported',
  'payment.ledger.export_retrieval_authorized',
  'delivery.custody.received',
  'delivery.custody.variance_opened',
  'delivery.custody.variance_resolved',
  'delivery.handoff.recorded',
  'delivery.handoff.outcome_recorded',
  'delivery.otp.overridden',
  'order.return.initiated',
  'delivery.commitment.revised',
  'courier.provider.registered',
  'courier.provider.deactivated',
  'courier.provider.reactivated',
  'courier.agent.approved',
  'courier.agent.withdrawn',
  'auth.mfa.completed',
  'auth.mfa.failed',
  'auth.device.registered',
  'auth.device.revoked',
  'auth.device.replaced',
  'auth.mfa.enrolled',
  'auth.mfa.revoked',
  'auth.mfa.reset',
  'auth.bootstrap.completed',
  'auth.bootstrap.succeeded',
  'auth.session.authority_revoked',
  'auth.mfa.reenrolment_begun',
  'auth.hub_boundary.crossed',
  'pricing.correction.approved',
  'pricing.reprice.approved',
  'pricing.size_class.selected',
  'pricing.carrier_cost.captured',
  'staff.identity.approved',
  'staff.identity.rejected',
  'staff.identity.suspended',
  'staff.identity.offboarded',
  'permission.bundle.assigned',
  'vendor.organization.approved',
  'vendor.organization.rejected',
  'vendor.allowance.enabled',
  'vendor.allowance.disabled',
  'vendor.suspension.created',
  'vendor.suspension.lifted',
  'vendor.held_parcel.decided',
  'vendor.held_parcel.escalated',
  'vendor.organization.terminated',
  'vendor.security_hold.opened',
  'vendor.security_hold.cleared',
  'payment.cash.custody_accepted',
  'payment.cash.variance_opened',
  'payment.cash.variance_resolved',
  'payment.cash.hub_reconciled',
  'payment.cash.hub_variance_opened',
  'payment.cash.disposition_recorded',
  'payment.momo.manually_confirmed',
  'payment.road_expense.decided',
  'payment.road_expense.applied',
  'settings.reason.catalog_changed',
] as const satisfies readonly AuditEventCode[];

/** One way an event whose tier depends on the act can be classified. */
export interface ConditionalBasis {
  /** The tier this basis gives. */
  readonly enhanced: boolean;
  /** Checked against the actor the event is recorded for (the transaction's own, or the person a sign-in names), where it can be. */
  readonly actorType?: AuditActorType;
  /** Checked against the transaction: a `SYSTEM` transaction under this capability. */
  readonly systemCapability?: string;
  /** What the catalogue says in words, for a refusal's reader and for the plan. */
  readonly meaning: string;
}

/**
 * The four events whose tier the catalogue makes depend on a fact of the act (audit.md section 5). The basis names are this
 * module's, for the facts the catalogue words: they are not stored, and add no field to the ledger.
 */
export const CONDITIONAL_CODES = {
  'auth.recovery.requested': {
    ADMINISTRATOR_INITIATED: {
      enhanced: true,
      actorType: 'STAFF',
      meaning: 'an administrator initiated the recovery (the actor is the administrator)',
    },
    SELF_SERVICE: {
      enhanced: false,
      actorType: 'SYSTEM',
      meaning:
        'a self-service request, whose anonymous caller proved nothing (the actor is SYSTEM)',
    },
  },
  'staff.identity.created': {
    BOOTSTRAP_SEED: {
      enhanced: true,
      systemCapability: 'seed',
      meaning: 'the bootstrap seed, whose identities have no independent checker',
    },
    OPERATION: {
      enhanced: false,
      actorType: 'STAFF',
      meaning: 'createStaffIdentity, a maker act at ordinary level',
    },
  },
  'delivery.stop.failed': {
    PAYMENT_TAKEN: { enhanced: true, meaning: 'a payment was already taken when the stop failed' },
    NO_PAYMENT_TAKEN: { enhanced: false, meaning: 'no payment had been taken' },
  },
  'vendor.sender_block.created': {
    PLATFORM_WIDE: { enhanced: true, meaning: 'the block reaches the whole platform' },
    LOCAL: { enhanced: false, meaning: 'the block reaches one hub' },
  },
  // Outside the row of audit.md section 5.4, which lists the event without a tier: AC-SLICE-000-99 says that when a Platform Admin
  // ends a shared vendor session with `revokeSession` (`ADMIN_REVOKED`) "an enhanced audit event is written", and section 6
  // category 6 (account status and credential administration) is why. Sign-out, expiry, a credential change, a suspension and the
  // rest remain ordinary.
  'auth.session.terminated': {
    ADMINISTRATIVE_REVOCATION: {
      enhanced: true,
      actorType: 'STAFF',
      meaning:
        "an administrator ended another principal's session (ADMIN_REVOKED; section 6 category 6)",
    },
    ROUTINE_TERMINATION: {
      enhanced: false,
      meaning:
        'sign-out, expiry, a credential change, a suspension, a supersession or a replacement',
    },
  },
} as const satisfies Partial<Record<AuditEventCode, Readonly<Record<string, ConditionalBasis>>>>;

export type ConditionalCode = keyof typeof CONDITIONAL_CODES;

/**
 * The enhanced events that record **no change of business state**, so that no before and after exists for them and none is accepted
 * (audit.md section 6): a read, an accepted or rejected second factor, an export, an authorisation to retrieve one, and a
 * rolled-back attempt. They keep every mandatory fact of their own; what they do not do is fill a field with a change that did not
 * happen. Every other enhanced event records a change and, when it succeeds, carries the values or safe diff of it. The two events
 * whose answer depends on the branch, `auth.mfa.reset` and `auth.recovery.requested`, are decided in `diffRuleFor`.
 */
export const NO_DIFF_CODES = [
  'auth.hub_boundary.crossed',
  'auth.mfa.completed',
  'auth.mfa.failed',
  'payment.ledger.exported',
  'payment.ledger.export_retrieval_authorized',
  'dispatch.run.rollback',
] as const satisfies readonly AuditEventCode[];

const NO_DIFF: ReadonlySet<string> = new Set(NO_DIFF_CODES);

export type DiffRule = 'REQUIRED' | 'ABSENT' | 'OPTIONAL';

/**
 * Whether an event carries a before and after (G2 follow-up; audit.md section 6). **The tier does not decide it; the change does.**
 *
 * - An enhanced attempt that was `REJECTED`, `FAILED` or `REPLAYED` changed nothing: `ABSENT`.
 * - An enhanced event of the list above records no change: `ABSENT`.
 * - `auth.mfa.reset` that was `COALESCED` issued nothing and revoked nothing, so changed nothing; one that was `ISSUED` changed a
 *   factor, a grant or both: `REQUIRED`, in the shape `audit-mfa-reset.ts` states.
 * - `auth.recovery.requested` that was `COALESCED` created no request, no link and no job: `ABSENT`; one that was `ISSUED` created a
 *   request and queued a job: `REQUIRED` when it is enhanced (an administrator initiated it), `OPTIONAL` when it is not.
 * - Any other enhanced event records the change it names and `REQUIRED` of a success. An ordinary event is `OPTIONAL`.
 */
export function diffRuleFor(event: {
  readonly code: string;
  readonly enhanced: boolean;
  readonly outcome: string;
  readonly resultingState?: string | undefined;
}): DiffRule {
  const succeeded = event.outcome === 'SUCCEEDED' || event.outcome === 'RECONCILED';
  if (event.enhanced && !succeeded) return 'ABSENT';
  if (NO_DIFF.has(event.code)) return 'ABSENT';
  if (event.code === 'auth.mfa.reset') {
    return event.resultingState === 'COALESCED' ? 'ABSENT' : 'REQUIRED';
  }
  if (event.code === 'auth.recovery.requested' && event.resultingState === 'COALESCED') {
    return 'ABSENT';
  }
  return event.enhanced ? 'REQUIRED' : 'OPTIONAL';
}
export type AuditTier = 'ENHANCED' | 'STANDARD' | 'CONDITIONAL';

const ENHANCED: ReadonlySet<string> = new Set(ENHANCED_CODES);

export function tierOf(code: AuditEventCode): AuditTier {
  if (Object.hasOwn(CONDITIONAL_CODES, code)) return 'CONDITIONAL';
  return ENHANCED.has(code) ? 'ENHANCED' : 'STANDARD';
}

export function conditionalBases(
  code: string,
): Readonly<Record<string, ConditionalBasis>> | undefined {
  return Object.hasOwn(CONDITIONAL_CODES, code)
    ? (CONDITIONAL_CODES as Readonly<Record<string, Readonly<Record<string, ConditionalBasis>>>>)[
        code
      ]
    : undefined;
}

/**
 * The facts an event must carry, for the events whose requirements the catalogue states clearly. Only what the catalogue says is
 * required: a fact whose name or shape it does not state is not invented here (no placeholder, no guessed key), and an event with no
 * entry carries what its tier requires and nothing more. Each entry names the sentence of audit.md it comes from.
 */
export interface EventRequirements {
  /** The reason is mandatory. */
  readonly reason?: true;
  /** The state acted on, one of these. */
  readonly previousState?: readonly string[];
  /** The resulting state, one of these. */
  readonly resultingState?: readonly string[];
  /** `related_ids` is present and not empty. Its keys are the catalogue's to name; where it names none, none is required here. */
  readonly relatedIdsPresent?: true;
  /** `related_ids` holds all the keys of at least one of these groups. */
  readonly relatedIdsAnyOf?: readonly (readonly string[])[];
  /** `related_ids` holds these keys when the object is of the type named. */
  readonly relatedIdsWhenObject?: Readonly<Record<string, readonly string[]>>;
  /** The hub context is present (`responsible_hub_id`). */
  readonly responsibleHub?: true;
  /** The actor types the event can be recorded for. */
  readonly actorTypes?: readonly AuditActorType[];
  /** No object exists to name in the documented case, so `object.id` may be null. Otherwise it may not. */
  readonly objectMayBeAbsent?: true;
}

export const EVENT_REQUIREMENTS: Readonly<Partial<Record<AuditEventCode, EventRequirements>>> = {
  // audit.md 5.4: "with the mandatory reason"; "the state it acted on (ACTIVE_FACTOR, STRANDED_ENROLMENT or UNFINISHED_RESET)"; "the
  // episode, the revoked factor, the new grant, the grants it superseded ... in related_ids"; "resulting_state ISSUED ... or COALESCED";
  // "A Platform Admin acted on another identity's MFA". The facts are held to the shape of `audit-mfa-reset.ts`, which
  // `enforceRequirements` calls for this event.
  'auth.mfa.reset': {
    reason: true,
    previousState: ['ACTIVE_FACTOR', 'STRANDED_ENROLMENT', 'UNFINISHED_RESET'],
    resultingState: ['ISSUED', 'COALESCED'],
    relatedIdsPresent: true,
    actorTypes: ['STAFF'],
  },
  // 5.4: "terminated because the principal's authority changed, carrying the reason"; "naming the bundle with its new revision and
  // reduction_floor in related_ids (a compiled-policy reduction names the principal type and the new minimum_revision)".
  'auth.session.authority_revoked': {
    reason: true,
    relatedIdsAnyOf: [['revision', 'reduction_floor'], ['minimum_revision']],
  },
  // 5.4: "Sign-out, expiry, credential change, suspension or admin revocation, with the reason".
  'auth.session.terminated': { reason: true },
  // 5.4: "resulting_state ISSUED ... COALESCED"; "related_ids carries the principal type and id and initiated_by".
  'auth.recovery.requested': {
    resultingState: ['ISSUED', 'COALESCED'],
    relatedIdsAnyOf: [['initiated_by']],
  },
  // 5.4: "One event per read of a record ... the hub of the record and a reference to the record"; "the event names that hub
  // (object_type HUB, object_id the hub id) and the operation (related_ids, key operation_id)"; "a read changes nothing, so
  // before_after stays empty" (it is in `NO_DIFF_CODES`).
  'auth.hub_boundary.crossed': {
    responsibleHub: true,
    relatedIdsWhenObject: { HUB: ['operation_id'] },
  },
  // 5.6: "Records both actors ... With created_by and approved_by both on the event".
  'staff.identity.approved': { relatedIdsAnyOf: [['created_by', 'approved_by']] },
  // 5.6: "A pending profile was refused, with reason".
  'staff.identity.rejected': { reason: true },
  // 5.4: for an unknown principal the attempted identifier is "a hash and the identifier's kind", and there is no object to name.
  'auth.session.failed': { objectMayBeAbsent: true },
  // 5.4: "the principal only where a session identified one: a pre-session refusal has none and records none, so no principal that
  // does not exist is invented".
  'auth.csrf.rejected': { objectMayBeAbsent: true },
};

import { HANDSHAKE_CHANNELS, HANDSHAKE_TYPES } from './collection-record.schema.js';
import { HANDSHAKE_STATES } from './collection-handshake.schema.js';
import type {
  PickupManifestState,
  PickupStopState,
  StopContactAttempt,
  StopFailureSnapshot,
} from './pickup-manifest-view.js';
import type { PickupFailureCategory } from './pickup-vocabulary.js';

/**
 * The four reads the Ops work lists of the collection and the failure are made of (D-A3, OB-S1-70, the Product Owner's decision of 11 November 2026):
 * `listCollectionDisputes`, `listHandshakesForOps`, `listCollectionShortfalls` and `listPickupFailures`. Each item is **a closed projection of what the
 * tables keep**, copied member by member, so that nothing else a row holds can reach the wire, and every figure on it is the table's or the database's
 * clock's: nothing is left for a browser to compute. **What no item carries:** a handshake code or its digest, a phone number, an address, the rider's
 * contact attempts of a collection, the Ops note of a handshake (the API's login may not read it), or a payer, a price or a destination.
 */

/** Why a handshake needs Ops now, as the database judges it at the moment of the read. */
export const HANDSHAKE_ROUTED_BECAUSE = [
  'CODE_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'FALLBACK_LIMIT_REACHED',
] as const;
export type HandshakeRoutedBecause = (typeof HANDSHAKE_ROUTED_BECAUSE)[number];

/** What became of a failed stop's request: waiting for the office, escalated by it, rescheduled (cancelled with a replacement) or cancelled. */
export const FAILURE_DECISIONS = ['PENDING', 'ESCALATED', 'RESCHEDULED', 'CANCELLED'] as const;
export type FailureDecision = (typeof FAILURE_DECISIONS)[number];

export type HandshakeState = (typeof HANDSHAKE_STATES)[number];
export type HandshakeType = (typeof HANDSHAKE_TYPES)[number];
export type HandshakeChannel = (typeof HANDSHAKE_CHANNELS)[number];

const instant = (value: string | Date): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

const iso = (value: string | Date | null): string | null =>
  value === null ? null : instant(value);

/** The pickup a work-list item is about, in the words an officer finds it by: the request's code and the sender as booked. Never a phone number or an address. */
interface PickupContext {
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly responsible_hub_id: string;
  readonly request_code: string;
  readonly sender_name: string;
}

/** What every statement of a work list returns beside its own columns: the hub (for the audit of a crossing) and the position of the row in the page. */
export interface ListedRow {
  readonly responsible_hub_id: string;
  /** The moment the list is ordered by, as the database prints it (with its microseconds): the position of a page. */
  readonly position_text: string;
  readonly position_id: string;
}

// ---- Collection disputes ------------------------------------------------------------------------------------------------------------------------------

export interface CollectionDisputeRow extends ListedRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly vendor_organization_id: string;
  readonly request_code: string;
  readonly sender_name: string;
  readonly state: 'OPEN' | 'RESOLVED';
  readonly note: string;
  readonly created_at: string | Date;
  readonly resolved_at: string | Date | null;
  readonly stop_state: PickupStopState;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: 'MATCH' | 'SHORT';
}

export interface CollectionDisputeView extends PickupContext {
  readonly id: string;
  readonly vendor_organization_id: string;
  readonly state: 'OPEN' | 'RESOLVED';
  /** The vendor's own words about its pickup: staff of the hub read them, and no rider does. */
  readonly note: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly stop_state: PickupStopState;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: 'MATCH' | 'SHORT';
}

export function disputeViewOf(row: CollectionDisputeRow): CollectionDisputeView {
  return {
    id: row.id,
    pickup_stop_id: row.pickup_stop_id,
    pickup_manifest_id: row.pickup_manifest_id,
    pickup_request_id: row.pickup_request_id,
    responsible_hub_id: row.responsible_hub_id,
    request_code: row.request_code,
    sender_name: row.sender_name,
    vendor_organization_id: row.vendor_organization_id,
    state: row.state,
    note: row.note,
    created_at: instant(row.created_at),
    resolved_at: iso(row.resolved_at),
    stop_state: row.stop_state,
    declared_count: row.declared_count,
    collected_count: row.collected_count,
    variance: row.variance,
  };
}

// ---- Handshakes that route to Ops ---------------------------------------------------------------------------------------------------------------------

export interface OpsHandshakeRow extends ListedRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly request_code: string;
  readonly sender_name: string;
  readonly direction: HandshakeType;
  readonly state: HandshakeState;
  readonly stop_state: PickupStopState;
  readonly routed_because: HandshakeRoutedBecause | null;
  readonly expires_at: string | Date | null;
  readonly attempts: number;
  readonly attempt_limit: number | null;
  readonly fallback_sends: number;
  readonly fallback_limit: number | null;
  readonly channel: HandshakeChannel | null;
  readonly confirmed_at: string | Date | null;
  readonly authorised_by: string | null;
  readonly created_at: string | Date;
}

export interface OpsHandshakeView extends PickupContext {
  readonly id: string;
  readonly direction: HandshakeType;
  readonly state: HandshakeState;
  readonly stop_state: PickupStopState;
  /** Why it needs Ops now; null for a handshake Ops has already settled (an override or a hand resolution). */
  readonly routed_because: HandshakeRoutedBecause | null;
  readonly expires_at: string | null;
  readonly attempts: number;
  /** The platform's `handshake_max_wrong_attempts` as the platform holds it now; null where it holds no usable value (never a default). */
  readonly attempt_limit: number | null;
  readonly fallback_sends: number;
  /** The platform's `sms_fallback_max_per_pickup` as the platform holds it now; null where it holds no usable value (never a default). */
  readonly fallback_limit: number | null;
  readonly channel: HandshakeChannel | null;
  readonly confirmed_at: string | null;
  /** The officer who overrode or resolved by hand; null for any other way the handshake ended and while it has not. */
  readonly authorised_by: string | null;
  readonly created_at: string;
}

export function opsHandshakeViewOf(row: OpsHandshakeRow): OpsHandshakeView {
  return {
    id: row.id,
    pickup_stop_id: row.pickup_stop_id,
    pickup_manifest_id: row.pickup_manifest_id,
    pickup_request_id: row.pickup_request_id,
    responsible_hub_id: row.responsible_hub_id,
    request_code: row.request_code,
    sender_name: row.sender_name,
    direction: row.direction,
    state: row.state,
    stop_state: row.stop_state,
    routed_because: row.routed_because,
    expires_at: iso(row.expires_at),
    attempts: row.attempts,
    attempt_limit: row.attempt_limit,
    fallback_sends: row.fallback_sends,
    fallback_limit: row.fallback_limit,
    channel: row.channel,
    confirmed_at: iso(row.confirmed_at),
    authorised_by: row.authorised_by,
    created_at: instant(row.created_at),
  };
}

// ---- Short counts flagged to the office ---------------------------------------------------------------------------------------------------------------

export interface CollectionShortfallRow extends ListedRow {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly request_code: string;
  readonly sender_name: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance_reason_snapshot: {
    readonly reason_code: string;
    readonly label: string;
    readonly attribution: string;
    readonly note?: string;
  };
  readonly office_notified_at: string | Date;
  readonly recorded_at: string | Date;
  readonly recorded_by: string;
  readonly stop_state: PickupStopState;
  readonly run_state: PickupManifestState;
}

export interface CollectionShortfallView extends PickupContext {
  /** The collection record. */
  readonly id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  /** The declared count less the counted one: the parcels the office was told are missing. */
  readonly shortfall_count: number;
  readonly reason: { readonly code: string; readonly label: string; readonly attribution: string };
  /** The rider's note where the reason asked for one; staff read it, no vendor does. */
  readonly note: string | null;
  /** The moment the office flag was raised: the database's own, taken with the count. */
  readonly office_notified_at: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
  readonly stop_state: PickupStopState;
  readonly run_state: PickupManifestState;
}

export function shortfallViewOf(row: CollectionShortfallRow): CollectionShortfallView {
  const reason = row.variance_reason_snapshot;
  return {
    id: row.id,
    pickup_stop_id: row.pickup_stop_id,
    pickup_manifest_id: row.pickup_manifest_id,
    pickup_request_id: row.pickup_request_id,
    responsible_hub_id: row.responsible_hub_id,
    request_code: row.request_code,
    sender_name: row.sender_name,
    declared_count: row.declared_count,
    collected_count: row.collected_count,
    shortfall_count: row.declared_count - row.collected_count,
    reason: { code: reason.reason_code, label: reason.label, attribution: reason.attribution },
    note: reason.note ?? null,
    office_notified_at: instant(row.office_notified_at),
    recorded_at: instant(row.recorded_at),
    recorded_by: row.recorded_by,
    stop_state: row.stop_state,
    run_state: row.run_state,
  };
}

// ---- The failure decision queue -----------------------------------------------------------------------------------------------------------------------

export interface PickupFailureRow extends ListedRow {
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly request_code: string;
  readonly sender_name: string;
  readonly failure_category: PickupFailureCategory;
  readonly failure_reason_snapshot: StopFailureSnapshot;
  readonly failed_at: string | Date;
  readonly waiting_seconds: number;
  readonly request_state: 'CONFIRMED' | 'CANCELLED' | 'PENDING' | 'DECLINED';
  readonly decision: FailureDecision;
  readonly attempt_number: number;
  readonly attempt_extended: boolean;
  readonly escalated_at: string | Date | null;
  readonly decided_at: string | Date | null;
  readonly replacement_request_id: string | null;
  readonly rider_id: string | null;
  /** How many photos the rider attached to the failure (`pickup_stop_evidence`). */
  readonly photo_count: number;
}

/** A contact attempt of the rider, copied member by member (the table keeps no more than these). */
export interface FailureContactAttemptView {
  readonly method: StopContactAttempt['method'];
  readonly attempted_at: string;
  readonly outcome: string;
  readonly note?: string;
}

export interface PickupFailureView extends PickupContext {
  readonly category: PickupFailureCategory;
  readonly reason: { readonly code: string; readonly label: string; readonly attribution: string };
  /** The rider's note: staff's own, and read by no vendor. */
  readonly note: string | null;
  readonly contact_attempts: readonly FailureContactAttemptView[];
  /** The moment the failure was reported: the database's own, taken with the failure. */
  readonly failed_at: string;
  /** How long the failure has waited for the office, by the database's clock: until the decision where there is one, until the read where there is not. */
  readonly waiting_seconds: number;
  readonly request_state: 'CONFIRMED' | 'CANCELLED' | 'PENDING' | 'DECLINED';
  readonly decision: FailureDecision;
  readonly attempt_number: number;
  /** Whether Senior Ops force-extended the request's attempts. */
  readonly attempt_extended: boolean;
  readonly escalated_at: string | null;
  readonly decided_at: string | null;
  readonly replacement_request_id: string | null;
  readonly rider_id: string | null;
  /**
   * How many photos the rider attached to the failure. The photos themselves are read one at a time, through the evidence store's own
   * authorization (`createEvidenceRetrievalAuthorization`): the queue carries a count and never an address.
   */
  readonly photo_count: number;
}

function contactAttemptsOf(snapshot: StopFailureSnapshot): FailureContactAttemptView[] {
  return (snapshot.contact_attempts ?? []).map((attempt) => ({
    method: attempt.method,
    attempted_at: attempt.attempted_at,
    outcome: attempt.outcome,
    ...(attempt.note === undefined ? {} : { note: attempt.note }),
  }));
}

export function failureViewOf(row: PickupFailureRow): PickupFailureView {
  const snapshot = row.failure_reason_snapshot;
  return {
    pickup_stop_id: row.pickup_stop_id,
    pickup_manifest_id: row.pickup_manifest_id,
    pickup_request_id: row.pickup_request_id,
    responsible_hub_id: row.responsible_hub_id,
    request_code: row.request_code,
    sender_name: row.sender_name,
    category: row.failure_category,
    reason: {
      code: snapshot.reason_code,
      label: snapshot.label,
      attribution: snapshot.attribution,
    },
    note: snapshot.note ?? null,
    contact_attempts: contactAttemptsOf(snapshot),
    failed_at: instant(row.failed_at),
    waiting_seconds: row.waiting_seconds,
    request_state: row.request_state,
    decision: row.decision,
    attempt_number: row.attempt_number,
    attempt_extended: row.attempt_extended,
    escalated_at: iso(row.escalated_at),
    decided_at: iso(row.decided_at),
    replacement_request_id: row.replacement_request_id,
    rider_id: row.rider_id,
    photo_count: row.photo_count,
  };
}

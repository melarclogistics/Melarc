import type { components } from '@melarc/api-client';

import { MANIFEST_STATES, STOP_STATES } from '../manifest/manifest-shape';
import { OPERATIONAL_CODE } from '../pickup/pickup-shape';
import { instantOf, isOneOf, isRecord, lineOf, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the screens of the door and the failure (S1.30: the failed pickups, the handshakes that need Ops, the short counts, the collection disputes and the stop's photos) believe of
 * an answer, judged field by field before anything is drawn, as the pickup, manifest and identity screens' are (`pickup-shape.ts`, `manifest-shape.ts`). The types are the
 * contract's, narrowed to the fields a screen reads; a field the contract adds and this does not read goes nowhere, and an answer that is not the API's (a proxy's page, another
 * version's list) is refused whole rather than shown in part. `test/pickup-work-contract.test.ts` holds every guard below to the contract.
 *
 * **What no item here carries, and no screen draws:** a handshake code or digest, the Ops note of an override, a phone number, an object key, an address or a signed operation of the
 * evidence store (the authorization of one photo is the one exception, and is `RetrievalAuthorizationView`: transient, held only while its photo is open). An officer who escalated a
 * request or let a count through without photos is **an officer and never a name**: the answers carry an identifier and the portal has no read of the staff directory under these keys.
 */
type FailureBody = components['schemas']['PickupFailureQueueItem'];
type HandshakeBody = components['schemas']['OpsHandshake'];
type ShortfallBody = components['schemas']['CollectionShortfall'];
type DisputeBody = components['schemas']['CollectionDisputeListItem'];
type EvidenceItemBody = components['schemas']['StopEvidenceItem'];

export type FailureCategory = FailureBody['category'];
export type FailureDecision = FailureBody['decision'];
export type RequestState = FailureBody['request_state'];
export type EscalationActor = NonNullable<FailureBody['escalation']>['by'];
export type ContactMethod = FailureBody['contact_attempts'][number]['method'];
export type HandshakeState = HandshakeBody['state'];
export type HandshakeDirection = HandshakeBody['direction'];
export type RoutedBecause = NonNullable<HandshakeBody['routed_because']>;
export type HandshakeChannel = NonNullable<HandshakeBody['channel']>;
export type StopState = HandshakeBody['stop_state'];
export type RunState = ShortfallBody['run_state'];
export type DisputeState = DisputeBody['state'];
export type CountVariance = DisputeBody['variance'];
export type EvidencePurpose = EvidenceItemBody['purpose'];
export type EvidenceState = EvidenceItemBody['state'];

export const FAILURE_CATEGORIES = [
  'VENDOR_UNAVAILABLE',
  'ACCESS_DENIED',
  'PARCEL_NOT_READY',
  'REFUSED_COLLECTION',
] as const;
export const FAILURE_DECISIONS = ['PENDING', 'ESCALATED', 'RESCHEDULED', 'CANCELLED'] as const;
export const REQUEST_STATES = ['PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED'] as const;
export const ESCALATION_ACTORS = ['PERSON', 'BACKSTOP', 'UNKNOWN'] as const;
export const CONTACT_METHODS = ['PHONE_CALL', 'SMS', 'IN_PERSON'] as const;
export const HANDSHAKE_STATES = [
  'PENDING',
  'CODE_GENERATED',
  'CODE_DELIVERED',
  'VERIFIED',
  'EXPIRED',
  'EXHAUSTED',
  'DISPUTED',
  'MANUALLY_RESOLVED',
] as const;
export const HANDSHAKE_DIRECTIONS = [
  'VENDOR_ENTERED_RIDER_DISPLAYED',
  'SENDER_SMS_RIDER_ENTERED',
] as const;
export const ROUTED_BECAUSE = [
  'CODE_EXPIRED',
  'ATTEMPTS_EXHAUSTED',
  'FALLBACK_LIMIT_REACHED',
] as const;
export const HANDSHAKE_CHANNELS = ['PORTAL', 'SMS_FALLBACK', 'OPS_OVERRIDE'] as const;
export const DISPUTE_STATES = ['OPEN', 'RESOLVED'] as const;
export const COUNT_VARIANCES = ['MATCH', 'SHORT'] as const;
export const EVIDENCE_PURPOSES = ['PARCEL_PHOTO', 'COLLECTION_PROOF'] as const;
export const EVIDENCE_STATES = ['PENDING_UPLOAD', 'STORED', 'EXPIRED'] as const;

/** The most a page of any of these lists can hold (the contract's largest `page_size`). */
export const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;
/** The longest note the audit ledger keeps, and so the longest a screen is shown. */
const MAX_NOTE = 1000;
const MAX_CODE_LENGTH = 64;
const REASON_CODE = /^[A-Za-z0-9_.-]+$/;
/** Far beyond what a counter or a count of parcels can be, and bounded so that a figure is a figure. */
const MAX_FIGURE = 10_000_000;
/** The longest wait a failure can have: a century of seconds. A longer one is not a clock's. */
const MAX_SECONDS = 3_153_600_000;
const MAX_ATTEMPTS_LISTED = 50;
const MAX_URL = 4096;

/** A text an officer or a vendor wrote, as one block: not blank, bounded, and with no control character but a line break or a tab. It is drawn as text and never as markup. */
function noteTextOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NOTE) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if ((unit < 0x20 && unit !== 0x0a && unit !== 0x09 && unit !== 0x0d) || unit === 0x7f) {
      return undefined;
    }
  }
  return value;
}

/** Whether a text has a space or a control character in it: an address a browser is given is neither. */
function hasBlankOrControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x20 || unit === 0x7f) return true;
  }
  return false;
}

const wholeAtLeast = (value: unknown, least: number, most = MAX_FIGURE): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least && value <= most
    ? value
    : undefined;

const codeOf = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_CODE_LENGTH &&
  REASON_CODE.test(value)
    ? value
    : undefined;

const operationalCodeOf = (value: unknown): string | undefined =>
  typeof value === 'string' && OPERATIONAL_CODE.test(value) ? value : undefined;

/** A page of any of the lists: its items, and the position of the next page (`null` at the end). */
export interface WorkListPageView<Item> {
  readonly items: readonly Item[];
  readonly nextPageToken: string | null;
}

function pageOf<Item>(
  body: unknown,
  parse: (entry: unknown) => Item | undefined,
  keyOf: (item: Item) => string,
): WorkListPageView<Item> | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: Item[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parse(entry);
    if (item === undefined || seen.has(keyOf(item).toLowerCase())) return undefined;
    seen.add(keyOf(item).toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: token };
}

/** What every item says of the pickup it is about: the ids to open it from and the words to find it by. Never a phone number or an address. */
export interface PickupContextView {
  readonly pickup_stop_id: string;
  readonly pickup_manifest_id: string;
  readonly pickup_request_id: string;
  readonly responsible_hub_id: string;
  readonly request_code: string;
  readonly sender_name: string;
}

function parseContext(body: Record<string, unknown>): PickupContextView | undefined {
  const stop = uuidOf(body.pickup_stop_id);
  const manifest = uuidOf(body.pickup_manifest_id);
  const request = uuidOf(body.pickup_request_id);
  const hub = uuidOf(body.responsible_hub_id);
  const code = operationalCodeOf(body.request_code);
  const sender = lineOf(body.sender_name);
  if (
    stop === undefined ||
    manifest === undefined ||
    request === undefined ||
    hub === undefined ||
    code === undefined ||
    sender === undefined
  ) {
    return undefined;
  }
  return {
    pickup_stop_id: stop,
    pickup_manifest_id: manifest,
    pickup_request_id: request,
    responsible_hub_id: hub,
    request_code: code,
    sender_name: sender,
  };
}

/** A reason of a catalogue as it was when the rider gave it: its code, its label and who the cause is attributed to. */
export interface ReasonView {
  readonly code: string;
  readonly label: string;
  readonly attribution: string;
}

function parseReason(body: unknown): ReasonView | undefined {
  if (!isRecord(body)) return undefined;
  const code = codeOf(body.code);
  const label = lineOf(body.label);
  const attribution = lineOf(body.attribution);
  if (code === undefined || label === undefined || attribution === undefined) return undefined;
  return { code, label, attribution };
}

// ---- The failed pickups ---------------------------------------------------------------------------------------------------------------------------------

export interface ContactAttemptView {
  readonly method: ContactMethod;
  readonly attempted_at: string;
  readonly outcome: string;
  readonly note?: string;
}

function parseContactAttempt(body: unknown): ContactAttemptView | undefined {
  if (!isRecord(body)) return undefined;
  const at = instantOf(body.attempted_at);
  const outcome = lineOf(body.outcome);
  const note = optional(body.note, noteTextOf);
  if (
    !isOneOf(CONTACT_METHODS, body.method) ||
    at === undefined ||
    outcome === undefined ||
    note === undefined
  ) {
    return undefined;
  }
  return {
    method: body.method,
    attempted_at: at,
    outcome,
    ...(note === null ? {} : { note }),
  };
}

/**
 * Who escalated a failure's request (section 17.3): `PERSON` an officer (never named), `BACKSTOP` the scheduled backstop with the threshold it judged by and the wait the failure had
 * reached, as its event recorded them, and `UNKNOWN` where the ledger holds no event for it. The threshold and the wait are stated for the backstop alone.
 */
export interface EscalationView {
  readonly by: EscalationActor;
  readonly threshold_hours: number | null;
  readonly waited_seconds: number | null;
}

function parseEscalation(body: unknown): EscalationView | undefined {
  if (!isRecord(body) || !isOneOf(ESCALATION_ACTORS, body.by)) return undefined;
  const threshold = optional(body.threshold_hours, (value) => wholeAtLeast(value, 1, 8760));
  const waited = optional(body.waited_seconds, (value) => wholeAtLeast(value, 0, MAX_SECONDS));
  if (threshold === undefined || waited === undefined) return undefined;
  // The contract states both for the backstop alone: a person's or an unknown escalation that carries either is not the API's.
  if (body.by !== 'BACKSTOP' && (threshold !== null || waited !== null)) return undefined;
  return { by: body.by, threshold_hours: threshold, waited_seconds: waited };
}

export interface PickupFailureView extends PickupContextView {
  readonly category: FailureCategory;
  readonly reason: ReasonView;
  /** The rider's note: staff's own. */
  readonly note: string | null;
  readonly contact_attempts: readonly ContactAttemptView[];
  readonly failed_at: string;
  /** How long it has waited, by the database's clock: the page works out no time. */
  readonly waiting_seconds: number;
  readonly request_state: RequestState;
  readonly decision: FailureDecision;
  readonly attempt_number: number;
  readonly attempt_extended: boolean;
  readonly escalated_at: string | null;
  readonly escalation: EscalationView | null;
  readonly decided_at: string | null;
  readonly replacement_request_id: string | null;
  readonly rider_id: string | null;
  /** How many photos the rider attached to the failure: a count and never an address. */
  readonly photo_count: number;
}

/** The fields each guard reads, held to the contract by `test/pickup-work-contract.test.ts`. */
export const PICKUP_WORK_FIELDS = {
  PickupFailureQueueItem: {
    required: [
      'pickup_stop_id',
      'pickup_manifest_id',
      'pickup_request_id',
      'responsible_hub_id',
      'request_code',
      'sender_name',
      'category',
      'reason',
      'note',
      'contact_attempts',
      'failed_at',
      'waiting_seconds',
      'request_state',
      'decision',
      'attempt_number',
      'attempt_extended',
      'escalated_at',
      'escalation',
      'decided_at',
      'replacement_request_id',
      'rider_id',
      'photo_count',
    ],
    optional: [],
    enums: {
      category: FAILURE_CATEGORIES,
      request_state: REQUEST_STATES,
      decision: FAILURE_DECISIONS,
    },
  },
  OpsHandshake: {
    required: [
      'id',
      'pickup_stop_id',
      'pickup_manifest_id',
      'pickup_request_id',
      'responsible_hub_id',
      'request_code',
      'sender_name',
      'direction',
      'state',
      'stop_state',
      'routed_because',
      'expires_at',
      'attempts',
      'attempt_limit',
      'fallback_sends',
      'fallback_limit',
      'channel',
      'confirmed_at',
      'authorised_by',
      'created_at',
    ],
    optional: [],
    enums: {
      direction: HANDSHAKE_DIRECTIONS,
      state: HANDSHAKE_STATES,
      stop_state: STOP_STATES,
      routed_because: ROUTED_BECAUSE,
      channel: HANDSHAKE_CHANNELS,
    },
  },
  CollectionShortfall: {
    required: [
      'id',
      'pickup_stop_id',
      'pickup_manifest_id',
      'pickup_request_id',
      'responsible_hub_id',
      'request_code',
      'sender_name',
      'declared_count',
      'collected_count',
      'shortfall_count',
      'reason',
      'note',
      'office_notified_at',
      'recorded_at',
      'recorded_by',
      'stop_state',
      'run_state',
    ],
    optional: [],
    enums: { stop_state: STOP_STATES, run_state: MANIFEST_STATES },
  },
  CollectionDisputeListItem: {
    required: [
      'id',
      'pickup_stop_id',
      'pickup_manifest_id',
      'pickup_request_id',
      'responsible_hub_id',
      'request_code',
      'sender_name',
      'vendor_organization_id',
      'state',
      'note',
      'created_at',
      'resolved_at',
      'stop_state',
      'declared_count',
      'collected_count',
      'variance',
    ],
    optional: [],
    enums: { state: DISPUTE_STATES, stop_state: STOP_STATES, variance: COUNT_VARIANCES },
  },
  StopEvidenceItem: {
    required: [
      'id',
      'purpose',
      'state',
      'captured_at',
      'uploaded_at',
      'content_type',
      'scanned_clean',
    ],
    optional: [],
    enums: { purpose: EVIDENCE_PURPOSES, state: EVIDENCE_STATES },
  },
  StopEvidenceList: {
    required: ['items', 'next_page_token', 'parcel_photos', 'parcel_photo_exception'],
    optional: [],
    enums: {},
  },
  ParcelPhotoException: {
    required: ['id', 'pickup_stop_id', 'authorised_by', 'authorised_at', 'note'],
    optional: [],
    enums: {},
  },
  EvidenceRetrievalAuthorization: {
    required: ['method', 'url', 'expires_at'],
    optional: ['headers'],
    enums: {},
  },
  Handshake: {
    required: ['stop_id', 'state', 'direction'],
    optional: ['channel', 'attempts', 'expires_at', 'fallback_used', 'authorised_by'],
    enums: {
      state: HANDSHAKE_STATES,
      direction: HANDSHAKE_DIRECTIONS,
      channel: HANDSHAKE_CHANNELS,
    },
  },
} as const;

export function parsePickupFailure(body: unknown): PickupFailureView | undefined {
  if (!isRecord(body)) return undefined;
  const context = parseContext(body);
  const reason = parseReason(body.reason);
  const note = optional(body.note, noteTextOf);
  const failedAt = instantOf(body.failed_at);
  const waiting = wholeAtLeast(body.waiting_seconds, 0, MAX_SECONDS);
  const attempt = wholeAtLeast(body.attempt_number, 1, 1000);
  const escalatedAt = optional(body.escalated_at, instantOf);
  const escalation = optional(body.escalation, parseEscalation);
  const decidedAt = optional(body.decided_at, instantOf);
  const replacement = optional(body.replacement_request_id, uuidOf);
  const rider = optional(body.rider_id, uuidOf);
  const photos = wholeAtLeast(body.photo_count, 0);
  if (
    context === undefined ||
    reason === undefined ||
    note === undefined ||
    failedAt === undefined ||
    waiting === undefined ||
    attempt === undefined ||
    escalatedAt === undefined ||
    escalation === undefined ||
    decidedAt === undefined ||
    replacement === undefined ||
    rider === undefined ||
    photos === undefined ||
    typeof body.attempt_extended !== 'boolean' ||
    !isOneOf(FAILURE_CATEGORIES, body.category) ||
    !isOneOf(REQUEST_STATES, body.request_state) ||
    !isOneOf(FAILURE_DECISIONS, body.decision) ||
    !Array.isArray(body.contact_attempts) ||
    body.contact_attempts.length > MAX_ATTEMPTS_LISTED
  ) {
    return undefined;
  }
  const attempts = body.contact_attempts.map(parseContactAttempt);
  if (attempts.some((each) => each === undefined)) return undefined;
  // What the contract states of how the facts go together: an escalation is stated exactly when the request has the moment of one, and a decision says what became of the request.
  if ((escalation === null) !== (escalatedAt === null)) return undefined;
  if ((body.decision === 'RESCHEDULED') !== (replacement !== null)) return undefined;
  if (
    (body.decision === 'RESCHEDULED' || body.decision === 'CANCELLED') !==
    (body.request_state === 'CANCELLED')
  ) {
    return undefined;
  }
  // A decision that waits says whether the request was escalated: `ESCALATED` has the moment of one, and `PENDING` has none.
  if (body.decision === 'ESCALATED' && escalatedAt === null) return undefined;
  if (body.decision === 'PENDING' && escalatedAt !== null) return undefined;
  return {
    ...context,
    category: body.category,
    reason,
    note,
    contact_attempts: attempts as ContactAttemptView[],
    failed_at: failedAt,
    waiting_seconds: waiting,
    request_state: body.request_state,
    decision: body.decision,
    attempt_number: attempt,
    attempt_extended: body.attempt_extended,
    escalated_at: escalatedAt,
    escalation,
    decided_at: decidedAt,
    replacement_request_id: replacement,
    rider_id: rider,
    photo_count: photos,
  };
}

/** A page of `listPickupFailures`. One entry that is not a failure makes the whole page unusable, and a stop listed twice is not the API's. */
export function parsePickupFailurePage(
  body: unknown,
): WorkListPageView<PickupFailureView> | undefined {
  return pageOf(body, parsePickupFailure, (item) => item.pickup_stop_id);
}

// ---- The handshakes that need Ops -----------------------------------------------------------------------------------------------------------------------

export interface OpsHandshakeView extends PickupContextView {
  readonly id: string;
  readonly direction: HandshakeDirection;
  readonly state: HandshakeState;
  readonly stop_state: StopState;
  /** Why it needs Ops now; `null` for one Ops has already settled. */
  readonly routed_because: RoutedBecause | null;
  readonly expires_at: string | null;
  readonly attempts: number;
  /** The platform's limit as it stands; `null` where the platform holds no usable value: never a default. */
  readonly attempt_limit: number | null;
  readonly fallback_sends: number;
  readonly fallback_limit: number | null;
  readonly channel: HandshakeChannel | null;
  readonly confirmed_at: string | null;
  /** The officer who overrode or resolved by hand: an identifier, never a name. */
  readonly authorised_by: string | null;
  readonly created_at: string;
}

export function parseOpsHandshake(body: unknown): OpsHandshakeView | undefined {
  if (!isRecord(body)) return undefined;
  const context = parseContext(body);
  const id = uuidOf(body.id);
  const routed = optional(body.routed_because, (value) =>
    isOneOf(ROUTED_BECAUSE, value) ? value : undefined,
  );
  const channel = optional(body.channel, (value) =>
    isOneOf(HANDSHAKE_CHANNELS, value) ? value : undefined,
  );
  const expiresAt = optional(body.expires_at, instantOf);
  const confirmedAt = optional(body.confirmed_at, instantOf);
  const authorisedBy = optional(body.authorised_by, uuidOf);
  const created = instantOf(body.created_at);
  const attempts = wholeAtLeast(body.attempts, 0);
  const fallbackSends = wholeAtLeast(body.fallback_sends, 0);
  const attemptLimit = optional(body.attempt_limit, (value) => wholeAtLeast(value, 1));
  const fallbackLimit = optional(body.fallback_limit, (value) => wholeAtLeast(value, 1));
  if (
    context === undefined ||
    id === undefined ||
    routed === undefined ||
    channel === undefined ||
    expiresAt === undefined ||
    confirmedAt === undefined ||
    authorisedBy === undefined ||
    created === undefined ||
    attempts === undefined ||
    fallbackSends === undefined ||
    attemptLimit === undefined ||
    fallbackLimit === undefined ||
    !isOneOf(HANDSHAKE_DIRECTIONS, body.direction) ||
    !isOneOf(HANDSHAKE_STATES, body.state) ||
    !isOneOf(STOP_STATES, body.stop_state)
  ) {
    return undefined;
  }
  return {
    ...context,
    id,
    direction: body.direction,
    state: body.state,
    stop_state: body.stop_state,
    routed_because: routed,
    expires_at: expiresAt,
    attempts,
    attempt_limit: attemptLimit,
    fallback_sends: fallbackSends,
    fallback_limit: fallbackLimit,
    channel,
    confirmed_at: confirmedAt,
    authorised_by: authorisedBy,
    created_at: created,
  };
}

/** A page of `listHandshakesForOps`. */
export function parseOpsHandshakePage(
  body: unknown,
): WorkListPageView<OpsHandshakeView> | undefined {
  return pageOf(body, parseOpsHandshake, (item) => item.id);
}

// ---- The short counts and the disputes ------------------------------------------------------------------------------------------------------------------

export interface ShortfallView extends PickupContextView {
  readonly id: string;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly shortfall_count: number;
  readonly reason: ReasonView;
  readonly note: string | null;
  readonly office_notified_at: string;
  readonly recorded_at: string;
  readonly recorded_by: string;
  readonly stop_state: StopState;
  readonly run_state: RunState;
}

export function parseShortfall(body: unknown): ShortfallView | undefined {
  if (!isRecord(body)) return undefined;
  const context = parseContext(body);
  const id = uuidOf(body.id);
  const declared = wholeAtLeast(body.declared_count, 1);
  const collected = wholeAtLeast(body.collected_count, 1);
  const shortfall = wholeAtLeast(body.shortfall_count, 1);
  const reason = parseReason(body.reason);
  const note = optional(body.note, noteTextOf);
  const notified = instantOf(body.office_notified_at);
  const recorded = instantOf(body.recorded_at);
  const by = uuidOf(body.recorded_by);
  if (
    context === undefined ||
    id === undefined ||
    declared === undefined ||
    collected === undefined ||
    shortfall === undefined ||
    reason === undefined ||
    note === undefined ||
    notified === undefined ||
    recorded === undefined ||
    by === undefined ||
    !isOneOf(STOP_STATES, body.stop_state) ||
    !isOneOf(MANIFEST_STATES, body.run_state)
  ) {
    return undefined;
  }
  // What the contract states of the three figures: the shortfall is the declared count less the counted one.
  if (declared - collected !== shortfall) return undefined;
  return {
    ...context,
    id,
    declared_count: declared,
    collected_count: collected,
    shortfall_count: shortfall,
    reason,
    note,
    office_notified_at: notified,
    recorded_at: recorded,
    recorded_by: by,
    stop_state: body.stop_state,
    run_state: body.run_state,
  };
}

/** A page of `listCollectionShortfalls`. */
export function parseShortfallPage(body: unknown): WorkListPageView<ShortfallView> | undefined {
  return pageOf(body, parseShortfall, (item) => item.id);
}

export interface DisputeView extends PickupContextView {
  readonly id: string;
  readonly vendor_organization_id: string;
  readonly state: DisputeState;
  /** The vendor's own words about its pickup: drawn as text and never as markup. */
  readonly note: string;
  readonly created_at: string;
  readonly resolved_at: string | null;
  readonly stop_state: StopState;
  readonly declared_count: number;
  readonly collected_count: number;
  readonly variance: CountVariance;
}

export function parseDispute(body: unknown): DisputeView | undefined {
  if (!isRecord(body)) return undefined;
  const context = parseContext(body);
  const id = uuidOf(body.id);
  const vendor = uuidOf(body.vendor_organization_id);
  const note = noteTextOf(body.note);
  const created = instantOf(body.created_at);
  const resolved = optional(body.resolved_at, instantOf);
  const declared = wholeAtLeast(body.declared_count, 1);
  const collected = wholeAtLeast(body.collected_count, 1);
  if (
    context === undefined ||
    id === undefined ||
    vendor === undefined ||
    note === undefined ||
    created === undefined ||
    resolved === undefined ||
    declared === undefined ||
    collected === undefined ||
    !isOneOf(DISPUTE_STATES, body.state) ||
    !isOneOf(STOP_STATES, body.stop_state) ||
    !isOneOf(COUNT_VARIANCES, body.variance)
  ) {
    return undefined;
  }
  // A dispute is resolved exactly when it has the moment of its resolution, and a count says what it was: short exactly when it is below the declared one.
  if ((body.state === 'RESOLVED') !== (resolved !== null)) return undefined;
  if ((body.variance === 'SHORT') !== collected < declared) return undefined;
  return {
    ...context,
    id,
    vendor_organization_id: vendor,
    state: body.state,
    note,
    created_at: created,
    resolved_at: resolved,
    stop_state: body.stop_state,
    declared_count: declared,
    collected_count: collected,
    variance: body.variance,
  };
}

/** A page of `listCollectionDisputes`. */
export function parseDisputePage(body: unknown): WorkListPageView<DisputeView> | undefined {
  return pageOf(body, parseDispute, (item) => item.id);
}

// ---- The evidence of a stop -----------------------------------------------------------------------------------------------------------------------------

export interface StopEvidenceItemView {
  readonly id: string;
  readonly purpose: EvidencePurpose;
  readonly state: EvidenceState;
  readonly captured_at: string;
  /** The completion of the upload; `null` until the record is stored. */
  readonly uploaded_at: string | null;
  readonly content_type: string;
  /** Whether the malicious-content check found the stored file clean. */
  readonly scanned_clean: boolean;
}

const CONTENT_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]*$/;

export function parseStopEvidenceItem(body: unknown): StopEvidenceItemView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const captured = instantOf(body.captured_at);
  const uploaded = optional(body.uploaded_at, instantOf);
  if (
    id === undefined ||
    captured === undefined ||
    uploaded === undefined ||
    typeof body.scanned_clean !== 'boolean' ||
    typeof body.content_type !== 'string' ||
    body.content_type.length > 127 ||
    !CONTENT_TYPE.test(body.content_type) ||
    !isOneOf(EVIDENCE_PURPOSES, body.purpose) ||
    !isOneOf(EVIDENCE_STATES, body.state)
  ) {
    return undefined;
  }
  // A record is stored exactly when its upload was completed, and a verdict is on a stored file alone: a record that says one thing and shows the other is not one the API sent.
  if ((body.state === 'STORED') !== (uploaded !== null)) return undefined;
  if (body.scanned_clean && body.state !== 'STORED') return undefined;
  return {
    id,
    purpose: body.purpose,
    state: body.state,
    captured_at: captured,
    uploaded_at: uploaded,
    content_type: body.content_type,
    scanned_clean: body.scanned_clean,
  };
}

/** The progress of a stop's parcel photos as the server counts it for the whole stop: the page works out none of it. */
export interface ParcelPhotoProgressView {
  /** What the rider has made and is sending, `stored` and `pending` together: an expired record is never part of it. */
  readonly declared: number;
  readonly stored: number;
  readonly pending: number;
  readonly expired: number;
}

function parseProgress(body: unknown): ParcelPhotoProgressView | undefined {
  if (!isRecord(body)) return undefined;
  const declared = wholeAtLeast(body.declared, 0);
  const stored = wholeAtLeast(body.stored, 0);
  const pending = wholeAtLeast(body.pending, 0);
  const expired = wholeAtLeast(body.expired, 0);
  if (
    declared === undefined ||
    stored === undefined ||
    pending === undefined ||
    expired === undefined
  ) {
    return undefined;
  }
  if (declared !== stored + pending) return undefined;
  return { declared, stored, pending, expired };
}

/** The exception that let a stop's count through without parcel photos: who (an officer, never a name), when and why. */
export interface ParcelPhotoExceptionView {
  readonly id: string;
  readonly pickup_stop_id: string;
  readonly authorised_by: string;
  readonly authorised_at: string;
  readonly note: string;
}

export function parseParcelPhotoException(body: unknown): ParcelPhotoExceptionView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const stop = uuidOf(body.pickup_stop_id);
  const by = uuidOf(body.authorised_by);
  const at = instantOf(body.authorised_at);
  const note = noteTextOf(body.note);
  if (
    id === undefined ||
    stop === undefined ||
    by === undefined ||
    at === undefined ||
    note === undefined
  ) {
    return undefined;
  }
  return { id, pickup_stop_id: stop, authorised_by: by, authorised_at: at, note };
}

export interface StopEvidencePageView {
  readonly items: readonly StopEvidenceItemView[];
  readonly nextPageToken: string | null;
  readonly parcel_photos: ParcelPhotoProgressView;
  readonly parcel_photo_exception: ParcelPhotoExceptionView | null;
}

/** A page of `listPickupStopEvidence`, with the progress and the exception that every page repeats. */
export function parseStopEvidencePage(body: unknown): StopEvidencePageView | undefined {
  const page = pageOf(body, parseStopEvidenceItem, (item) => item.id);
  if (page === undefined || !isRecord(body)) return undefined;
  const progress = parseProgress(body.parcel_photos);
  const exception = optional(body.parcel_photo_exception, parseParcelPhotoException);
  if (progress === undefined || exception === undefined) return undefined;
  return {
    items: page.items,
    nextPageToken: page.nextPageToken,
    parcel_photos: progress,
    parcel_photo_exception: exception,
  };
}

// ---- One photo, opened -----------------------------------------------------------------------------------------------------------------------------------

/**
 * The authorization to read one photo (`createEvidenceRetrievalAuthorization`): a temporary bearer capability, held only while its photo is open and never logged, kept in a store or written
 * anywhere. The portal draws the image with an `<img>`, which can send no header, so an authorization that asks for one, or for any method but `GET`, is not one it can use.
 */
export interface RetrievalAuthorizationView {
  readonly url: string;
  /** When the authorization runs out (five minutes after it was issued): the photo is dropped by then, and opening it again asks again. */
  readonly expires_at: string;
}

export function parseRetrievalAuthorization(body: unknown): RetrievalAuthorizationView | undefined {
  if (!isRecord(body)) return undefined;
  const expires = instantOf(body.expires_at);
  const url = body.url;
  if (
    expires === undefined ||
    body.method !== 'GET' ||
    typeof url !== 'string' ||
    url === '' ||
    url.length > MAX_URL ||
    hasBlankOrControl(url)
  ) {
    return undefined;
  }
  // No header is asked for: an `<img>` has no way to send one, and the platform's own store asks for none.
  const headers = body.headers;
  if (headers !== undefined && !(isRecord(headers) && Object.keys(headers).length === 0)) {
    return undefined;
  }
  return { url, expires_at: expires };
}

// ---- The answers of the acts -----------------------------------------------------------------------------------------------------------------------------

/** What `authoriseHandshakeOverride` and `resolveHandshake` answer: the handshake as it now stands, which the page reads the list again to confirm. */
export interface HandshakeView {
  readonly stop_id: string;
  readonly state: HandshakeState;
  readonly direction: HandshakeDirection;
  readonly channel: HandshakeChannel | null;
}

export function parseHandshake(body: unknown): HandshakeView | undefined {
  if (!isRecord(body)) return undefined;
  const stop = uuidOf(body.stop_id);
  const channel = optional(body.channel, (value) =>
    isOneOf(HANDSHAKE_CHANNELS, value) ? value : undefined,
  );
  if (
    stop === undefined ||
    channel === undefined ||
    !isOneOf(HANDSHAKE_STATES, body.state) ||
    !isOneOf(HANDSHAKE_DIRECTIONS, body.direction)
  ) {
    return undefined;
  }
  return { stop_id: stop, state: body.state, direction: body.direction, channel };
}

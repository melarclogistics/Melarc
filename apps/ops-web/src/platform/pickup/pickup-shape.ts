import type { components } from '@melarc/api-client';

import { isMinorAmount } from '../../components/ui/money/money-value';
import { instantOf, isOneOf, isRecord, lineOf, optional, uuidOf } from '../staff/staff-shape';

/**
 * What the pickup screens (S1.19) believe of an answer, judged field by field before anything is drawn, as the identity, vendor and rider
 * screens' are (`staff-shape.ts`, `vendor-shape.ts`, `rider-shape.ts`). The types are the contract's, narrowed to the fields a screen reads; a
 * field the contract adds and this does not read goes nowhere, and an answer that is not the API's (a proxy's page, another version's list) is
 * refused whole rather than shown in part. `test/pickup-contract.test.ts` holds every list below to the contract.
 *
 * Money stays an integer of pesewas from the wire to the screen (`isMinorAmount`), and the estimate stays what it is: indicative, provisional,
 * and the server's. Nothing here computes a price, a total or a zone.
 */
type PickupRequestBody = components['schemas']['PickupRequest'];
type LocationBody = components['schemas']['Location'];
type MoneyBody = components['schemas']['Money'];
type EstimateBody = components['schemas']['IndicativeEstimate'];
type EstimateComponentBody = components['schemas']['EstimateComponent'];
type CollectionPointBody = components['schemas']['CollectionPoint'];
type CollectionReferenceBody = components['schemas']['CollectionReference'];
type CollectionItemBody = components['schemas']['CollectionItem'];
type AdHocSenderBody = components['schemas']['AdHocSender'];
type VendorPickupLocationBody = components['schemas']['VendorPickupLocation'];
type ApprovalBody = components['schemas']['Approval'];
type OnePackageExceptionBody = components['schemas']['OnePackageException'];
type CancellationReasonBody = NonNullable<PickupRequestBody['cancellation_reason']>;
type ReasonDefinitionBody = components['schemas']['ReasonDefinition'];

export type PickupState = PickupRequestBody['state'];
export type PickupIntent = NonNullable<PickupRequestBody['pickup_intent']>;
export type CancellationChargeOutcome = NonNullable<
  PickupRequestBody['cancellation_charge_outcome']
>;
export type CutoffExceptionState = NonNullable<PickupRequestBody['cutoff_exception_state']>;
export type ReasonAttribution = ReasonDefinitionBody['attribution'];
export type EstimateStatus = EstimateBody['status'];
/** Where a one-package exception is: waiting for its checker, approved, or refused. */
export type ExceptionState = OnePackageExceptionBody['state'];
export type SplitBasis = NonNullable<PickupRequestBody['split_basis']>;

/** A record's fields as the guards hand them on: a field the answer left out or sent as null is left out, so null is never one of its values. */
type Present<Body> = { readonly [Key in keyof Body]: Exclude<Body[Key], null> };

/** An address as a screen shows it: the address, and the landmark people find it by. Coordinates and links are not drawn. */
export type LocationView = Pick<LocationBody, 'address' | 'landmark'>;
export type MoneyView = Pick<MoneyBody, 'amount_minor' | 'currency'>;
export type EstimateComponentView = Pick<EstimateComponentBody, 'kind' | 'quantity'> & {
  readonly amount: MoneyView;
};
export interface EstimateView {
  readonly status: EstimateStatus;
  /** Present exactly when the status is `AVAILABLE`. */
  readonly total: MoneyView | null;
  readonly assumesSizeClass: EstimateBody['assumes_size_class'] | null;
  readonly excludes: NonNullable<EstimateBody['excludes']>;
  readonly components: readonly EstimateComponentView[];
}
export type CollectionPointView = Present<
  Pick<CollectionPointBody, 'contact_name' | 'phone' | 'landmark'>
> & {
  readonly location: LocationView;
};
export type CollectionReferenceView = Present<
  Pick<CollectionReferenceBody, 'reference_name' | 'seller_order_reference'>
>;
export type CollectionItemView = Present<
  Pick<CollectionItemBody, 'description' | 'quantity' | 'handling_note'>
>;
/** A snapshot of a setting as it stood when it was applied or acknowledged: the amount alone is drawn. */
export interface SnapshotView {
  readonly amount_minor?: number;
}
/** The reason a cancellation was made with, by the words it had then. Its code is the server's and is never drawn. */
export type CancellationReasonView = Present<Pick<CancellationReasonBody, 'label'>>;
/** The person a single package travels to, who travels with its exception (§21.1). */
export type ExceptionRecipientView = Pick<
  OnePackageExceptionBody['recipient'],
  'name' | 'phone'
> & {
  readonly location: LocationView;
};
/**
 * A one-package exception as staff read it, in whole (the contract's `OnePackageException`): who asked and when, why, the recipient, and, once a
 * checker decided it, who and when. The fee that became due is the server's snapshot, kept only when the answer carries one; nothing here works
 * one out. **Who asked, who decided it and why are staff's** (the Product Owner's decision of 29 October 2026): the contract's other view of an
 * exception, `OnePackageExceptionOutcome`, is what every other reader gets and has none of the three, and this portal is staff's, so the guard
 * below refuses a body that lacks them rather than draw an exception that was not meant for it.
 */
export type OnePackageExceptionView = Present<
  Pick<
    OnePackageExceptionBody,
    'id' | 'state' | 'requested_by' | 'requested_at' | 'note' | 'decided_at'
  >
> & {
  /** The checker: the staff view always carries the member, null until someone decides, and the view leaves it out until then. */
  readonly approved_by?: string;
  readonly recipient: ExceptionRecipientView;
  readonly single_package_fee?: MoneyView;
};

/** One pickup request, with the fields the screens read and no other. */
export type PickupRequestView = Present<
  Pick<
    PickupRequestBody,
    | 'id'
    | 'code'
    | 'state'
    | 'responsible_hub_id'
    | 'scheduled_service_date'
    | 'attempt_number'
    | 'pickup_intent'
    | 'current_item_description'
    | 'declared_package_count'
    | 'one_package_exception_id'
    | 'replaces_request_id'
    | 'replacement_request_id'
    | 'cancelled_by_actor_type'
    | 'declared_value_minor'
    | 'liability_cap_acknowledged_at'
    | 'cancellation_charge_outcome'
    | 'created_at'
    | 'confirmed_at'
    | 'cutoff_exception_state'
    | 'primary_phone'
    | 'secondary_phone'
    | 'sender_name'
    | 'split_basis'
    | 'split_sender_percentage'
    | 'attempt_extension_id'
    | 'cancelled_at'
    | 'escalated_at'
    | 'rider_assigned'
  >
> & {
  readonly default_payer_intent?: PayerIntent;
  readonly resolved_pickup_location?: LocationView;
  readonly collection_point?: CollectionPointView;
  readonly collection_reference?: CollectionReferenceView;
  readonly collection_item?: CollectionItemView;
  readonly cancellation_charge?: MoneyView;
  readonly cancellation_charge_snapshot?: SnapshotView;
  readonly liability_cap_snapshot?: SnapshotView;
  readonly indicative_estimate?: EstimateView;
  readonly split_sender_amount?: MoneyView;
  readonly cancellation_reason?: CancellationReasonView;
  readonly one_package_exception?: OnePackageExceptionView;
};

export interface PickupRequestPageView {
  readonly items: readonly PickupRequestView[];
  readonly nextPageToken: string | null;
}

export type AdHocSenderView = Pick<
  AdHocSenderBody,
  'id' | 'display_name' | 'phone' | 'state' | 'blocked'
>;
export type VendorPickupLocationView = Pick<
  VendorPickupLocationBody,
  'id' | 'vendor_organization_id' | 'label' | 'is_default' | 'active'
> & { readonly location: LocationView };
/** The maker-checker record an exception's two acts answer with: the maker, and the checker once there is one. */
export type ApprovalView = Present<
  Pick<ApprovalBody, 'id' | 'state' | 'requested_by' | 'approved_by'>
>;

/** A reason of a pickup catalogue as a screen offers it: which one, its words, whether it needs a note, and whom it attributes the cause to. */
export interface AttributedReason {
  readonly code: string;
  readonly label: string;
  readonly requiresNote: boolean;
  readonly attribution: ReasonAttribution;
}

/**
 * The catalogue domains of the slice (domain-model.md section 3.9, D-05 of 29 October 2026): the cancellation of a request (S1.19), the reason
 * a request is carried over onto a later day's manifest, and the reason an officer skips a stop (S1.25).
 */
export type PickupReasonDomain = 'PICKUP_CANCELLATION' | 'PICKUP_CARRYOVER' | 'PICKUP_STOP_SKIP';

export const PICKUP_STATES = ['PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED'] as const;
export const PICKUP_INTENTS = ['OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER'] as const;
/** The create schema's enumeration of payer intent; the read carries the same values as a plain string. */
export const PAYER_INTENTS = ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] as const;
export type PayerIntent = (typeof PAYER_INTENTS)[number];
export const SPLIT_BASES = ['FIXED_AMOUNT', 'PERCENTAGE'] as const;
const ACTOR_TYPES = ['VENDOR', 'OPS'] as const;
export const CHARGE_OUTCOMES = [
  'APPLIED',
  'WAIVED',
  'NOT_APPLIED',
  'UNAVAILABLE',
  'EXEMPT',
] as const;
export const CUTOFF_STATES = ['PENDING_OPS_REVIEW', 'SAME_DAY_APPROVED', 'RESCHEDULED'] as const;
export const ESTIMATE_STATUSES = [
  'AVAILABLE',
  'UNAVAILABLE_OUTSIDE_SERVICE_AREA',
  'UNAVAILABLE_SETTING_MISSING',
] as const;
const ESTIMATE_EXCLUDES = ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'] as const;
export const ESTIMATE_COMPONENT_KINDS = [
  'SERVICE_AREA_BASE_FEE',
  'CORRIDOR_OFF_DAY_FEE',
  'SINGLE_PACKAGE_PICKUP_FEE',
] as const;
const SIZE_CLASSES = ['SMALL'] as const;
const SENDER_STATES = ['PROVISIONAL', 'REUSABLE'] as const;
/** The states of an approval and of a one-package exception, which is the approval of the maker-checker shape with its recipient. */
export const EXCEPTION_STATES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;
export const ATTRIBUTIONS = ['CUSTOMER', 'MELARC', 'EXTERNAL'] as const;
export const CUTOFF_DECISIONS = ['APPROVE_SAME_DAY', 'RESCHEDULE_NEXT_DAY'] as const;
export type CutoffDecision = (typeof CUTOFF_DECISIONS)[number];

/**
 * The operational code of a request (MSC-DEC-202): the contract's own pattern, letters and figures that cannot be confused when read aloud. A
 * code that breaks it is not one the server sends, and is never drawn.
 */
export const OPERATIONAL_CODE = /^[A-Z]{3}-(PR|MF|IN|OR|DR)-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;

/** The fields each guard reads, held to the contract by `test/pickup-contract.test.ts`. */
export const PICKUP_FIELDS = {
  PickupRequest: {
    required: [
      'id',
      'code',
      'state',
      'responsible_hub_id',
      'scheduled_service_date',
      'attempt_number',
    ],
    optional: [
      'pickup_intent',
      'collection_point',
      'collection_reference',
      'collection_item',
      'resolved_pickup_location',
      'current_item_description',
      'declared_package_count',
      'default_payer_intent',
      'one_package_exception_id',
      'replaces_request_id',
      'replacement_request_id',
      'cancelled_by_actor_type',
      'declared_value_minor',
      'liability_cap_acknowledged_at',
      'liability_cap_snapshot',
      'cancellation_charge_outcome',
      'cancellation_charge',
      'cancellation_charge_snapshot',
      'created_at',
      'confirmed_at',
      'cutoff_exception_state',
      'primary_phone',
      'secondary_phone',
      'indicative_estimate',
      'sender_name',
      'split_basis',
      'split_sender_amount',
      'split_sender_percentage',
      'attempt_extension_id',
      'cancelled_at',
      'escalated_at',
      'cancellation_reason',
      'rider_assigned',
      'one_package_exception',
    ],
    enums: {
      state: PICKUP_STATES,
      pickup_intent: PICKUP_INTENTS,
      cancelled_by_actor_type: ACTOR_TYPES,
      cancellation_charge_outcome: CHARGE_OUTCOMES,
      cutoff_exception_state: CUTOFF_STATES,
      split_basis: SPLIT_BASES,
    },
  },
  Location: { required: ['address'], optional: ['landmark'], enums: {} },
  Money: { required: ['amount_minor', 'currency'], optional: [], enums: { currency: ['GHS'] } },
  IndicativeEstimate: {
    required: ['status', 'provisional'],
    optional: ['total', 'assumes_size_class', 'excludes', 'components'],
    enums: { status: ESTIMATE_STATUSES, assumes_size_class: SIZE_CLASSES },
  },
  EstimateComponent: {
    required: ['kind', 'hub_id', 'setting_key', 'effective_version', 'quantity', 'amount'],
    optional: [],
    enums: { kind: ESTIMATE_COMPONENT_KINDS },
  },
  CollectionPoint: {
    required: ['contact_name', 'phone', 'location'],
    optional: ['landmark'],
    enums: {},
  },
  CollectionReference: {
    required: ['reference_name'],
    optional: ['seller_order_reference'],
    enums: {},
  },
  CollectionItem: {
    required: ['description', 'quantity'],
    optional: ['handling_note'],
    enums: {},
  },
  AdHocSender: {
    required: ['id', 'display_name', 'phone', 'state'],
    optional: ['blocked'],
    enums: { state: SENDER_STATES },
  },
  VendorPickupLocation: {
    required: ['id', 'vendor_organization_id', 'label', 'location', 'is_default', 'active'],
    optional: [],
    enums: {},
  },
  Approval: {
    required: ['id', 'state', 'requested_by'],
    optional: ['approved_by'],
    enums: { state: EXCEPTION_STATES },
  },
  // The staff view of an exception: the three members that are staff's alone (`requested_by`, `approved_by`, `note`) are required of it, as the
  // contract requires them of this view and of no other (`OnePackageExceptionOutcome` has none and is not a body this portal draws).
  OnePackageException: {
    required: ['id', 'state', 'requested_by', 'requested_at', 'approved_by', 'note', 'recipient'],
    optional: ['decided_at', 'single_package_fee'],
    enums: { state: EXCEPTION_STATES },
  },
  ReasonDefinition: {
    required: [
      'code',
      'domain',
      'label',
      'attribution',
      'active',
      'consumesDeliveryAttempt',
      'permittedOperations',
    ],
    optional: ['requiresNote'],
    enums: { attribution: ATTRIBUTIONS },
  },
} as const;

/** The most a page of the list can hold (the contract's largest `page_size`). */
const MAX_PAGE_ITEMS = 100;
const MAX_TOKEN = 2048;
/** An estimate is a few components; a list far beyond that is not the API's. */
const MAX_COMPONENTS = 20;
/** A search by phone answers zero or one sender (`findAdHocSender`, `maxItems: 1`). */
const MAX_SENDERS = 1;
/** A vendor keeps a few saved locations; a list far beyond what a business keeps is not the API's. */
const MAX_LOCATIONS = 200;
const MAX_REASONS = 500;
const MAX_CODE_LENGTH = 64;
const REASON_CODE = /^[A-Za-z0-9_.-]+$/;
/** The longest note the audit ledger keeps (its own bound, which the API screens a note against before the act): one line. */
const MAX_NOTE = 1000;
/** A calendar date as the API carries it, `YYYY-MM-DD`. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date that exists (not 30 February), as the text it came as. */
export function calendarDateOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = CALENDAR_DATE.exec(value);
  if (match === null) return undefined;
  const [, year, month, day] = match.map(Number);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : undefined;
}

const wholeAtLeast = (value: unknown, least: number): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= least ? value : undefined;

/** An enumerated value of one of the lists above, or nothing. */
const oneOf =
  <const List extends readonly string[]>(list: List) =>
  (value: unknown): List[number] | undefined =>
    isOneOf(list, value) ? value : undefined;

/** A line the record holds that may be blank, absent or null: blank is nothing, as absent is. */
function optionalLine(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  return lineOf(value);
}

function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
}

/** A note a person wrote and the ledger kept: not blank, one line, within the ledger's bound (longer than a label's). */
function noteOf(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_NOTE &&
    !hasControlCharacter(value)
    ? value
    : undefined;
}

const booleanOf = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** A share of a split as the contract bounds it: from 0 to 100. */
const percentageOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : undefined;

/** The reason of a cancellation, by its label; a code that is there must be one, and is not kept. */
function parseCancellationReason(body: unknown): CancellationReasonView | undefined {
  if (!isRecord(body)) return undefined;
  if (
    body.code !== undefined &&
    !(
      typeof body.code === 'string' &&
      body.code.length <= MAX_CODE_LENGTH &&
      REASON_CODE.test(body.code)
    )
  ) {
    return undefined;
  }
  const label = optional(body.label, lineOf);
  if (label === undefined) return undefined;
  return label === null ? {} : { label };
}

function parseRecipient(body: unknown): ExceptionRecipientView | undefined {
  if (!isRecord(body)) return undefined;
  const name = lineOf(body.name);
  const phone = lineOf(body.phone);
  const location = parseLocation(body.location);
  if (name === undefined || phone === undefined || location === undefined) return undefined;
  return { name, phone, location };
}

/**
 * The one-package exception a request carries (`one_package_exception`), or nothing when it is not one: **the staff view, in whole**. Who
 * asked, who decided it and why must be there (the checker as an identifier, or null while nobody has decided), so an exception that came
 * without them, the outcome every other reader gets, is refused and not drawn: a requester this portal cannot name is one it cannot warn a
 * would-be approver about, and an approval must never look eligible for want of one. The fee is the server's snapshot of what became due on
 * approval, kept as money only when it is there: it is never worked out here.
 */
export function parseOnePackageException(body: unknown): OnePackageExceptionView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const requestedBy = uuidOf(body.requested_by);
  const requestedAt = instantOf(body.requested_at);
  // Present either way: null is what the staff view says until someone decides, and a member that is not there is not that.
  const approvedBy = body.approved_by === null ? null : uuidOf(body.approved_by);
  const decidedAt = optional(body.decided_at, instantOf);
  const note = noteOf(body.note);
  const recipient = parseRecipient(body.recipient);
  const fee = optional(body.single_package_fee, parseMoney);
  if (
    id === undefined ||
    requestedBy === undefined ||
    requestedAt === undefined ||
    approvedBy === undefined ||
    decidedAt === undefined ||
    note === undefined ||
    recipient === undefined ||
    fee === undefined ||
    !isOneOf(EXCEPTION_STATES, body.state)
  ) {
    return undefined;
  }
  return {
    id,
    state: body.state,
    requested_by: requestedBy,
    requested_at: requestedAt,
    ...(approvedBy === null ? {} : { approved_by: approvedBy }),
    ...(decidedAt === null ? {} : { decided_at: decidedAt }),
    note,
    recipient,
    ...(fee === null ? {} : { single_package_fee: fee }),
  };
}

export function parseMoney(body: unknown): MoneyView | undefined {
  if (!isRecord(body) || !isMinorAmount(body.amount_minor) || body.amount_minor < 0) {
    return undefined;
  }
  return body.currency === 'GHS' ? { amount_minor: body.amount_minor, currency: 'GHS' } : undefined;
}

export function parseLocation(body: unknown): LocationView | undefined {
  if (!isRecord(body)) return undefined;
  const address = lineOf(body.address);
  const landmark = optionalLine(body.landmark);
  if (address === undefined || landmark === undefined) return undefined;
  return { address, ...(landmark === null ? {} : { landmark }) };
}

/** A snapshot (domain-model.md section 3.7): every field optional by the contract; the amount, when there, is whole pesewas. */
function parseSnapshot(body: unknown): SnapshotView | undefined {
  if (!isRecord(body)) return undefined;
  if (body.amount_minor === undefined) return {};
  return isMinorAmount(body.amount_minor) && body.amount_minor >= 0
    ? { amount_minor: body.amount_minor }
    : undefined;
}

function parseEstimateComponent(body: unknown): EstimateComponentView | undefined {
  if (!isRecord(body)) return undefined;
  const amount = parseMoney(body.amount);
  const quantity = wholeAtLeast(body.quantity, 0);
  if (
    amount === undefined ||
    quantity === undefined ||
    !isOneOf(ESTIMATE_COMPONENT_KINDS, body.kind) ||
    uuidOf(body.hub_id) === undefined ||
    lineOf(body.setting_key) === undefined ||
    lineOf(body.effective_version) === undefined
  ) {
    return undefined;
  }
  return { kind: body.kind, quantity, amount };
}

/**
 * The booking estimate (MSC-DEC-211), or nothing when the answer is not one: always provisional, with a figure exactly when the status says
 * one is available, and none when the area is outside the service or the hub has no approved fee. A figure with an unavailable status, or an
 * available status with no figure, is not an estimate the server gives.
 */
export function parseEstimate(body: unknown): EstimateView | undefined {
  if (!isRecord(body) || body.provisional !== true || !isOneOf(ESTIMATE_STATUSES, body.status)) {
    return undefined;
  }
  const total = optional(body.total, parseMoney);
  if (total === undefined) return undefined;
  if ((body.status === 'AVAILABLE') !== (total !== null)) return undefined;
  const size = optional(body.assumes_size_class, oneOf(SIZE_CLASSES));
  if (size === undefined) return undefined;
  const excludes = body.excludes ?? [];
  if (
    !Array.isArray(excludes) ||
    !excludes.every((entry) => isOneOf(ESTIMATE_EXCLUDES, entry)) ||
    new Set(excludes).size !== excludes.length
  ) {
    return undefined;
  }
  const parts = body.components ?? [];
  if (!Array.isArray(parts) || parts.length > MAX_COMPONENTS) return undefined;
  const components = parts.map(parseEstimateComponent);
  if (components.some((part) => part === undefined)) return undefined;
  return {
    status: body.status,
    total,
    assumesSizeClass: size,
    excludes,
    components: components as EstimateComponentView[],
  };
}

function parseCollectionPoint(body: unknown): CollectionPointView | undefined {
  if (!isRecord(body)) return undefined;
  const name = lineOf(body.contact_name);
  const phone = lineOf(body.phone);
  const location = parseLocation(body.location);
  const landmark = optionalLine(body.landmark);
  if (
    name === undefined ||
    phone === undefined ||
    location === undefined ||
    landmark === undefined
  ) {
    return undefined;
  }
  return { contact_name: name, phone, location, ...(landmark === null ? {} : { landmark }) };
}

function parseCollectionReference(body: unknown): CollectionReferenceView | undefined {
  if (!isRecord(body)) return undefined;
  const name = lineOf(body.reference_name);
  const order = optionalLine(body.seller_order_reference);
  if (name === undefined || order === undefined) return undefined;
  return { reference_name: name, ...(order === null ? {} : { seller_order_reference: order }) };
}

function parseCollectionItem(body: unknown): CollectionItemView | undefined {
  if (!isRecord(body)) return undefined;
  const description = lineOf(body.description);
  const quantity = wholeAtLeast(body.quantity, 1);
  const note = optionalLine(body.handling_note);
  if (description === undefined || quantity === undefined || note === undefined) return undefined;
  return { description, quantity, ...(note === null ? {} : { handling_note: note }) };
}

/**
 * One pickup request, or nothing when it is not one the screens may show. The six fields the contract requires must be there and sound; every
 * other field the screens read is judged when it is there (`optional`: absent and null are nothing, anything else is judged), and one that is
 * there and not sound makes the whole record unusable: a record with a charge that is not money, or an estimate that is not one, is not drawn
 * in part.
 */
export function parsePickupRequest(body: unknown): PickupRequestView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const hub = uuidOf(body.responsible_hub_id);
  const date = calendarDateOf(body.scheduled_service_date);
  const attempt = wholeAtLeast(body.attempt_number, 1);
  const intent = optional(body.pickup_intent, oneOf(PICKUP_INTENTS));
  const resolved = optional(body.resolved_pickup_location, parseLocation);
  const point = optional(body.collection_point, parseCollectionPoint);
  const reference = optional(body.collection_reference, parseCollectionReference);
  const item = optional(body.collection_item, parseCollectionItem);
  const goods = optional(body.current_item_description, optionalLine);
  const packages = optional(body.declared_package_count, (value) => wholeAtLeast(value, 1));
  const payer = optional(body.default_payer_intent, oneOf(PAYER_INTENTS));
  const exception = optional(body.one_package_exception_id, uuidOf);
  const replaces = optional(body.replaces_request_id, uuidOf);
  const replacement = optional(body.replacement_request_id, uuidOf);
  const cancelledBy = optional(body.cancelled_by_actor_type, oneOf(ACTOR_TYPES));
  const declaredValue = optional(body.declared_value_minor, (value) => wholeAtLeast(value, 0));
  const acknowledgedAt = optional(body.liability_cap_acknowledged_at, instantOf);
  const capSnapshot = optional(body.liability_cap_snapshot, parseSnapshot);
  const outcome = optional(body.cancellation_charge_outcome, oneOf(CHARGE_OUTCOMES));
  const charge = optional(body.cancellation_charge, parseMoney);
  const chargeSnapshot = optional(body.cancellation_charge_snapshot, parseSnapshot);
  const createdAt = optional(body.created_at, instantOf);
  const confirmedAt = optional(body.confirmed_at, instantOf);
  const cutoff = optional(body.cutoff_exception_state, oneOf(CUTOFF_STATES));
  const primaryPhone = optional(body.primary_phone, optionalLine);
  const secondaryPhone = optional(body.secondary_phone, optionalLine);
  const estimate = optional(body.indicative_estimate, parseEstimate);
  const senderName = optional(body.sender_name, optionalLine);
  const splitBasis = optional(body.split_basis, oneOf(SPLIT_BASES));
  const splitAmount = optional(body.split_sender_amount, parseMoney);
  const splitPercentage = optional(body.split_sender_percentage, percentageOf);
  const extension = optional(body.attempt_extension_id, uuidOf);
  const cancelledAt = optional(body.cancelled_at, instantOf);
  const escalatedAt = optional(body.escalated_at, instantOf);
  const reason = optional(body.cancellation_reason, parseCancellationReason);
  const riderAssigned = optional(body.rider_assigned, booleanOf);
  const oneException = optional(body.one_package_exception, parseOnePackageException);
  if (
    id === undefined ||
    hub === undefined ||
    date === undefined ||
    attempt === undefined ||
    typeof body.code !== 'string' ||
    !OPERATIONAL_CODE.test(body.code) ||
    !isOneOf(PICKUP_STATES, body.state) ||
    intent === undefined ||
    resolved === undefined ||
    point === undefined ||
    reference === undefined ||
    item === undefined ||
    goods === undefined ||
    packages === undefined ||
    payer === undefined ||
    exception === undefined ||
    replaces === undefined ||
    replacement === undefined ||
    cancelledBy === undefined ||
    declaredValue === undefined ||
    acknowledgedAt === undefined ||
    capSnapshot === undefined ||
    outcome === undefined ||
    charge === undefined ||
    chargeSnapshot === undefined ||
    createdAt === undefined ||
    confirmedAt === undefined ||
    cutoff === undefined ||
    primaryPhone === undefined ||
    secondaryPhone === undefined ||
    estimate === undefined ||
    senderName === undefined ||
    splitBasis === undefined ||
    splitAmount === undefined ||
    splitPercentage === undefined ||
    extension === undefined ||
    cancelledAt === undefined ||
    escalatedAt === undefined ||
    reason === undefined ||
    riderAssigned === undefined ||
    oneException === undefined
  ) {
    return undefined;
  }

  // A field the answer left out, or sent as null, is left out: the screens say "not recorded" for what is not there.
  return {
    id,
    code: body.code,
    state: body.state,
    responsible_hub_id: hub,
    scheduled_service_date: date,
    attempt_number: attempt,
    ...(intent === null ? {} : { pickup_intent: intent }),
    ...(resolved === null ? {} : { resolved_pickup_location: resolved }),
    ...(point === null ? {} : { collection_point: point }),
    ...(reference === null ? {} : { collection_reference: reference }),
    ...(item === null ? {} : { collection_item: item }),
    ...(goods === null ? {} : { current_item_description: goods }),
    ...(packages === null ? {} : { declared_package_count: packages }),
    ...(payer === null ? {} : { default_payer_intent: payer }),
    ...(exception === null ? {} : { one_package_exception_id: exception }),
    ...(replaces === null ? {} : { replaces_request_id: replaces }),
    ...(replacement === null ? {} : { replacement_request_id: replacement }),
    ...(cancelledBy === null ? {} : { cancelled_by_actor_type: cancelledBy }),
    ...(declaredValue === null ? {} : { declared_value_minor: declaredValue }),
    ...(acknowledgedAt === null ? {} : { liability_cap_acknowledged_at: acknowledgedAt }),
    ...(capSnapshot === null ? {} : { liability_cap_snapshot: capSnapshot }),
    ...(outcome === null ? {} : { cancellation_charge_outcome: outcome }),
    ...(charge === null ? {} : { cancellation_charge: charge }),
    ...(chargeSnapshot === null ? {} : { cancellation_charge_snapshot: chargeSnapshot }),
    ...(createdAt === null ? {} : { created_at: createdAt }),
    ...(confirmedAt === null ? {} : { confirmed_at: confirmedAt }),
    ...(cutoff === null ? {} : { cutoff_exception_state: cutoff }),
    ...(primaryPhone === null ? {} : { primary_phone: primaryPhone }),
    ...(secondaryPhone === null ? {} : { secondary_phone: secondaryPhone }),
    ...(estimate === null ? {} : { indicative_estimate: estimate }),
    ...(senderName === null ? {} : { sender_name: senderName }),
    ...(splitBasis === null ? {} : { split_basis: splitBasis }),
    ...(splitAmount === null ? {} : { split_sender_amount: splitAmount }),
    ...(splitPercentage === null ? {} : { split_sender_percentage: splitPercentage }),
    ...(extension === null ? {} : { attempt_extension_id: extension }),
    ...(cancelledAt === null ? {} : { cancelled_at: cancelledAt }),
    ...(escalatedAt === null ? {} : { escalated_at: escalatedAt }),
    ...(reason === null ? {} : { cancellation_reason: reason }),
    // Whether a rider is assigned decides what a cancellation must carry (the charge decision); left out when the answer does not say.
    ...(riderAssigned === null ? {} : { rider_assigned: riderAssigned }),
    ...(oneException === null ? {} : { one_package_exception: oneException }),
  };
}

/** A page of `listPickupRequests`. One entry that is not a request makes the whole page unusable, and a request listed twice is not the API's. */
export function parsePickupRequestPage(body: unknown): PickupRequestPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const token = body.next_page_token;
  if (token !== null && !(typeof token === 'string' && token !== '' && token.length <= MAX_TOKEN)) {
    return undefined;
  }
  const items: PickupRequestView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const request = parsePickupRequest(entry);
    if (request === undefined || seen.has(request.id.toLowerCase())) return undefined;
    seen.add(request.id.toLowerCase());
    items.push(request);
  }
  return { items, nextPageToken: token };
}

/** A returning sender found by phone (`findAdHocSender`): zero or one. */
export function parseAdHocSenders(body: unknown): AdHocSenderView[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_SENDERS) {
    return undefined;
  }
  const senders: AdHocSenderView[] = [];
  for (const entry of body.items as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.id);
    const name = lineOf(entry.display_name);
    const phone = lineOf(entry.phone);
    const blocked = entry.blocked ?? false;
    if (
      id === undefined ||
      name === undefined ||
      phone === undefined ||
      !isOneOf(SENDER_STATES, entry.state) ||
      typeof blocked !== 'boolean'
    ) {
      return undefined;
    }
    senders.push({ id, display_name: name, phone, state: entry.state, blocked });
  }
  return senders;
}

/** A vendor's saved locations (`listVendorPickupLocations`), each judged to belong to the vendor asked about. */
export function parseVendorPickupLocations(
  body: unknown,
  vendorId: string,
): VendorPickupLocationView[] | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_LOCATIONS) {
    return undefined;
  }
  const locations: VendorPickupLocationView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.id);
    const owner = uuidOf(entry.vendor_organization_id);
    const label = lineOf(entry.label);
    const location = parseLocation(entry.location);
    if (
      id === undefined ||
      owner?.toLowerCase() !== vendorId.toLowerCase() ||
      label === undefined ||
      location === undefined ||
      typeof entry.is_default !== 'boolean' ||
      typeof entry.active !== 'boolean' ||
      seen.has(id.toLowerCase())
    ) {
      return undefined;
    }
    seen.add(id.toLowerCase());
    locations.push({
      id,
      vendor_organization_id: owner,
      label,
      location,
      is_default: entry.is_default,
      active: entry.active,
    });
  }
  // One active location at most is the default (VendorPickupLocation): two would leave the booking's own default unclear.
  return locations.filter((location) => location.active && location.is_default).length <= 1
    ? locations
    : undefined;
}

/** The answer of `requestOnePackageException` and `approveOnePackageException`: the approval record, with its checker once there is one. */
export function parseApproval(body: unknown): ApprovalView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const requestedBy = uuidOf(body.requested_by);
  const approvedBy = optional(body.approved_by, uuidOf);
  if (
    id === undefined ||
    requestedBy === undefined ||
    approvedBy === undefined ||
    !isOneOf(EXCEPTION_STATES, body.state)
  ) {
    return undefined;
  }
  return {
    id,
    state: body.state,
    requested_by: requestedBy,
    ...(approvedBy === null ? {} : { approved_by: approvedBy }),
  };
}

/**
 * The active reasons of one catalogue domain, in the server's order, or nothing when the answer is not the catalogue. Every reason must be of
 * the domain asked for and carry an attribution (the cancellation charge is decided by it, MSC-DEC-388); one that is not active is left out,
 * because the server would refuse it. An empty list is an answer: the domain has no codes yet.
 */
export function parseAttributedReasons(
  body: unknown,
  domain: PickupReasonDomain,
): AttributedReason[] | undefined {
  if (!Array.isArray(body) || body.length > MAX_REASONS) return undefined;
  const reasons: AttributedReason[] = [];
  const seen = new Set<string>();
  for (const entry of body as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const { code, active, requiresNote, attribution, permittedOperations } = entry;
    const label = lineOf(entry.label);
    if (
      typeof code !== 'string' ||
      code.length === 0 ||
      code.length > MAX_CODE_LENGTH ||
      !REASON_CODE.test(code) ||
      entry.domain !== domain ||
      label === undefined ||
      typeof active !== 'boolean' ||
      typeof entry.consumesDeliveryAttempt !== 'boolean' ||
      !(permittedOperations === null || Array.isArray(permittedOperations)) ||
      !(requiresNote === undefined || typeof requiresNote === 'boolean') ||
      !isOneOf(ATTRIBUTIONS, attribution) ||
      seen.has(code)
    ) {
      return undefined;
    }
    seen.add(code);
    if (active) reasons.push({ code, label, requiresNote: requiresNote === true, attribution });
  }
  return reasons;
}

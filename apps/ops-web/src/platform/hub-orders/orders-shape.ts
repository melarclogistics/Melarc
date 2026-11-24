import type { components } from '@melarc/api-client';

import { MAX_COUNT } from '../api/count-range';
import type { VendorMode } from '../hub-receiving/receiving-shape';
import {
  OPERATIONAL_CODE,
  parseLocation,
  parseMoney,
  type LocationView,
  type MoneyView,
} from '../pickup/pickup-shape';
import type { WorkListPageView } from '../pickup-work/pickup-work-shape';
import {
  instantOf,
  isOneOf,
  isRecord,
  lineOf,
  optional,
  uuidListOf,
  uuidOf,
} from '../staff/staff-shape';

/**
 * What the order screens (S1.40: the orders of a vendor, the order form and its review, an order's record, the amendment, the close, the summary, the payer corrections and the closes that left work)
 * believe of an answer, judged field by field before anything is drawn, as the receiving screens' are. The types are the contract's, narrowed to the fields a screen reads; a field the contract adds and
 * this does not read goes nowhere, and an answer that is not the API's is refused whole rather than shown in part. `test/hub-orders-contract.test.ts` holds every guard below to the contract.
 *
 * **Money stays an integer of pesewas from the wire to `MoneyAmount`**, and nothing here adds, subtracts or compares two amounts: a price, a portion, a total and a difference are the server's. A figure the
 * answer did not give is `null`, never zero. An officer is an identifier and never a name (the portal has no read of the staff directory), except where the answer itself carries the name.
 */
export const WORK_STATES = [
  'NEEDS_ORDER',
  'AWAITING_ARRIVAL',
  'PREPARED',
  'ITEMIZED',
  'MISSING',
] as const;
export const WORKLIST_VIEWS = [
  'all',
  'needs_order',
  'awaiting_arrival',
  'prepared',
  'itemized',
  'payment_required',
  'missing',
  'waiting_for_vendor',
] as const;
export const SIZE_CLASSES = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export const RECEIVING_MODES = ['PHOTO_CHECK_IN', 'BLIND_COUNT'] as const;
export const PARCEL_STATES = ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID'] as const;
export const PARCEL_ORIGINS = ['DOOR_PHOTO', 'HUB_EXTRA'] as const;
export const LANES = ['DOORSTEP', 'THIRD_PARTY_HANDOFF'] as const;
export const COMMERCIAL_MODES = ['STATION_DROP', 'MELARC_COVERED_THIRD_PARTY_DELIVERY'] as const;
export const PAYER_INTENTS = ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] as const;
export const SPLIT_BASES = ['FIXED_AMOUNT', 'PERCENTAGE'] as const;
export const WILL_CONFIRM = ['ON_CONFIRMATION', 'WHEN_ARRIVAL_IS_COMMITTED'] as const;
export const GATE_STATES = ['NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED'] as const;
export const COMMERCIAL_STATES = [
  'PRICED',
  'PAYMENT_REQUIRED',
  'CREDIT_RESERVED',
  'NO_VENDOR_CHARGE',
  'PREPAID',
  'CLOSED',
  'REVERSED',
] as const;
export const CORRECTION_STATES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;
export const CORRECTION_VIEWS = ['REQUESTED', 'APPROVED', 'REJECTED', 'all'] as const;
export const BLOCKERS = ['intake_not_ready', 'orders_exceed_received', 'order_unpriced'] as const;
export const RESOLUTIONS = ['SERVER_RESOLVED', 'EXPLICITLY_AUTHORIZED'] as const;
export const PRICE_STATUSES = ['EARLY_QUOTE', 'FROZEN'] as const;

export type WorkState = (typeof WORK_STATES)[number];
export type WorklistViewId = (typeof WORKLIST_VIEWS)[number];
export type SizeClass = (typeof SIZE_CLASSES)[number];
export type ParcelState = (typeof PARCEL_STATES)[number];
export type ParcelOrigin = (typeof PARCEL_ORIGINS)[number];
export type Lane = (typeof LANES)[number];
export type CommercialMode = (typeof COMMERCIAL_MODES)[number];
export type PayerIntent = (typeof PAYER_INTENTS)[number];
export type SplitBasis = (typeof SPLIT_BASES)[number];
export type WillConfirm = (typeof WILL_CONFIRM)[number];
export type GateState = (typeof GATE_STATES)[number];
export type CorrectionState = (typeof CORRECTION_STATES)[number];
export type CorrectionFilter = (typeof CORRECTION_VIEWS)[number];
export type Blocker = (typeof BLOCKERS)[number];
export type PriceStatus = (typeof PRICE_STATUSES)[number];

/** The most a page of any of these lists holds: the contract's page size is far smaller, and a longer list is not the API's. */
const MAX_PAGE_ITEMS = 500;
const MAX_TOKEN = 2048;
const MAX_NOTE = 1000;
const MAX_COMPONENTS = 32;
const MAX_CANDIDATES = 64;
const MAX_OUTSTANDING = 100;
const MAX_HISTORY = 500;
const SHA256 = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const whole = (value: unknown, most = MAX_COUNT): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= most
    ? value
    : undefined;

const flag = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** A calendar day as the API writes it (`2026-11-24`), whole and real. */
export function dayOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !DAY.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

/** A text an officer wrote, as one block: not blank, bounded, no control character but a line break or a tab. Drawn as text and never as markup. */
function noteOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_NOTE) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if ((unit < 0x20 && unit !== 0x0a && unit !== 0x09 && unit !== 0x0d) || unit === 0x7f) {
      return undefined;
    }
  }
  return value;
}

const tokenOf = (value: unknown): string | undefined =>
  typeof value === 'string' && SHA256.test(value) ? value : undefined;

const codeOf = (value: unknown): string | undefined =>
  typeof value === 'string' && OPERATIONAL_CODE.test(value) ? value : undefined;

/** A page token the API gave: a bounded opaque text, or none. */
function nextTokenOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value !== '' && value.length <= MAX_TOKEN ? value : undefined;
}

// ---- The worklist ---------------------------------------------------------------------------------------------------------------------------------

/** The counts of the whole intake, never of a page. `received` and `needs_order` are null for a vendor counted blind whose count is not committed: nothing is known to have arrived, which is not zero. */
export interface ProgressView {
  readonly received: number | null;
  readonly awaiting_arrival: number;
  readonly needs_order: number | null;
  readonly prepared: number;
  readonly itemized: number;
  readonly payment_required: number;
  readonly missing: number;
  readonly orders: number;
  /** The parcels the officer is waiting on the vendor's details for (D-S7-12): the rows the view of this name opens. Null where the answer did not say (a missing figure is never zero). */
  readonly waiting_for_vendor: number | null;
}

export function parseProgress(body: unknown): ProgressView | undefined {
  if (!isRecord(body)) return undefined;
  const received = optional(body.received, (value) => whole(value));
  const needsOrder = optional(body.needs_order, (value) => whole(value));
  const awaiting = whole(body.awaiting_arrival);
  const prepared = whole(body.prepared);
  const itemized = whole(body.itemized);
  const paymentRequired = whole(body.payment_required);
  const missing = whole(body.missing);
  const orders = whole(body.orders);
  const waiting = optional(body.waiting_for_vendor, (value) => whole(value));
  if (
    waiting === undefined ||
    received === undefined ||
    needsOrder === undefined ||
    awaiting === undefined ||
    prepared === undefined ||
    itemized === undefined ||
    paymentRequired === undefined ||
    missing === undefined ||
    orders === undefined
  ) {
    return undefined;
  }
  return {
    received,
    awaiting_arrival: awaiting,
    needs_order: needsOrder,
    prepared,
    itemized,
    payment_required: paymentRequired,
    missing,
    orders,
    waiting_for_vendor: waiting,
  };
}

/** The mark of a parcel the officer is waiting on the vendor's details for (D-S7-12): since when, and the officer's note (one short line), if one was written. */
export interface WaitingMarkView {
  readonly since: string;
  readonly note: string | null;
}

function parseWaitingMark(value: unknown): WaitingMarkView | undefined {
  if (!isRecord(value)) return undefined;
  const since = instantOf(value.since);
  const note = optional(value.note, lineOf);
  return since === undefined || note === undefined ? undefined : { since, note };
}

export interface WorkParcelView {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: ParcelOrigin;
  readonly state: ParcelState;
  /** The rider's photo of the parcel, by its record: a photo is fetched only when it is wanted. */
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
  /** The officer is waiting on the vendor's details for this parcel (D-S7-12), held by the server so that every officer and tablet sees it; null when it is not waiting. */
  readonly waiting_for_vendor: WaitingMarkView | null;
}

export interface WorkOrderView {
  readonly id: string;
  readonly code: string;
  readonly recipient_name: string | null;
  readonly service_area: string | null;
  readonly size_class: SizeClass;
  readonly commercial_state: string | null;
  /** Whether the order is final (its price frozen): an order made before its parcel's arrival is committed is not. */
  readonly confirmed: boolean;
  readonly payment_required: boolean;
}

export interface WorkItemView {
  readonly work_state: WorkState;
  /** The parcel the row is about; null for a vendor counted blind, which has none. */
  readonly parcel: WorkParcelView | null;
  readonly order: WorkOrderView | null;
  /** The order of this parcel whose arrival was reversed, kept as history. */
  readonly reversed_order: { readonly id: string; readonly code: string } | null;
}

export interface WorklistPageView extends WorkListPageView<WorkItemView> {
  readonly intake_id: string;
  readonly intake_state: string;
  readonly receiving_mode: VendorMode;
  readonly progress: ProgressView;
}

function parseWorkParcel(body: unknown): WorkParcelView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const ordinal = whole(body.ordinal);
  const door = optional(body.door_photo_evidence_id, uuidOf);
  const hub = optional(body.hub_photo_evidence_id, uuidOf);
  const waiting = optional(body.waiting_for_vendor, parseWaitingMark);
  if (
    waiting === undefined ||
    id === undefined ||
    ordinal === undefined ||
    ordinal < 1 ||
    !isOneOf(PARCEL_ORIGINS, body.origin) ||
    !isOneOf(PARCEL_STATES, body.state) ||
    door === undefined ||
    hub === undefined
  ) {
    return undefined;
  }
  return {
    id,
    ordinal,
    origin: body.origin,
    state: body.state,
    door_photo_evidence_id: door,
    hub_photo_evidence_id: hub,
    waiting_for_vendor: waiting,
  };
}

function parseWorkOrder(body: unknown): WorkOrderView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const code = codeOf(body.code);
  const name = optional(body.recipient_name, lineOf);
  const area = optional(body.service_area, lineOf);
  const state = optional(body.commercial_state, (value) =>
    isOneOf(COMMERCIAL_STATES, value) ? value : undefined,
  );
  const confirmed = flag(body.confirmed);
  const paymentRequired = flag(body.payment_required);
  if (
    id === undefined ||
    code === undefined ||
    name === undefined ||
    area === undefined ||
    state === undefined ||
    !isOneOf(SIZE_CLASSES, body.size_class) ||
    confirmed === undefined ||
    paymentRequired === undefined
  ) {
    return undefined;
  }
  return {
    id,
    code,
    recipient_name: name,
    service_area: area,
    size_class: body.size_class,
    commercial_state: state,
    confirmed,
    payment_required: paymentRequired,
  };
}

function parseWorkItem(body: unknown, mode: VendorMode): WorkItemView | undefined {
  if (!isRecord(body) || !isOneOf(WORK_STATES, body.work_state)) return undefined;
  const parcel = optional(body.parcel, parseWorkParcel);
  const order = optional(body.order, parseWorkOrder);
  const reversed = optional(body.reversed_order, (value) => {
    if (!isRecord(value)) return undefined;
    const id = uuidOf(value.id);
    const code = codeOf(value.code);
    return id === undefined || code === undefined ? undefined : { id, code };
  });
  if (parcel === undefined || order === undefined || reversed === undefined) return undefined;
  // A vendor with door photos is a list of parcels, and a vendor counted blind is a list of orders: a row that is the other kind is not this list's.
  if (mode === 'PHOTO_CHECK_IN' && parcel === null) return undefined;
  if (mode === 'BLIND_COUNT' && (parcel !== null || order === null)) return undefined;
  // What the row says it is must be what it holds: a parcel with an order is prepared or done, one without is not.
  if (
    (body.work_state === 'NEEDS_ORDER' || body.work_state === 'AWAITING_ARRIVAL') &&
    order !== null
  ) {
    return undefined;
  }
  if ((body.work_state === 'PREPARED' || body.work_state === 'ITEMIZED') && order === null) {
    return undefined;
  }
  // A parcel is waited on while it still needs its order: the mark ends when the order is made (D-S7-12), so a parcel with an order that is drawn as waited on is not the API's.
  if (parcel?.waiting_for_vendor != null && order !== null) return undefined;
  return { work_state: body.work_state, parcel, order, reversed_order: reversed };
}

/** The rows of a list are told apart by the parcel they are about, and by the order for a vendor counted blind. */
export const workItemKey = (item: WorkItemView): string =>
  (item.parcel?.id ?? item.order?.id ?? '').toLowerCase();

export function parseWorklist(body: unknown): WorklistPageView | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const intakeId = uuidOf(body.intake_id);
  const progress = parseProgress(body.progress);
  const next = nextTokenOf(body.next_page_token);
  if (
    intakeId === undefined ||
    typeof body.intake_state !== 'string' ||
    !isOneOf(RECEIVING_MODES, body.receiving_mode) ||
    progress === undefined ||
    next === undefined
  ) {
    return undefined;
  }
  const items: WorkItemView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseWorkItem(entry, body.receiving_mode);
    if (item === undefined) return undefined;
    const key = workItemKey(item);
    if (key === '' || seen.has(key)) return undefined;
    seen.add(key);
    items.push(item);
  }
  return {
    intake_id: intakeId,
    intake_state: body.intake_state,
    receiving_mode: body.receiving_mode,
    progress,
    items,
    nextPageToken: next,
  };
}

// ---- What an order would be: the terms the officer reviews --------------------------------------------------------------------------------------------

export interface PriceComponentView {
  readonly kind: string;
  readonly amount: MoneyView;
}

export interface CitedEvidenceView {
  /** The records of a high-value parcel's evidence, by identity, sorted. */
  readonly high_value: readonly string[];
  readonly carrier_waybill: string | null;
}

export interface DestinationView {
  readonly resolution: (typeof RESOLUTIONS)[number];
  /** The zone the address resolved to, or the one the officer chose; null where the parcel goes outside the service area. */
  readonly zone_name: string | null;
  readonly service_area: string | null;
  readonly outside_service_area: boolean;
}

export interface DeliveryView {
  readonly default_date: string;
  readonly requested_date: string | null;
  readonly committed_date: string;
  readonly window_start: string | null;
  readonly window_end: string | null;
}

export interface PayerTermsView {
  readonly source: 'ORDER' | 'REQUEST';
  readonly payer_intent: string;
  readonly sender: MoneyView;
  readonly recipient: MoneyView;
  readonly commercial_state_after_confirmation: GateState;
}

/** What the order held before an amendment, read beside what it would become. */
export interface EarlyQuoteView {
  readonly total: MoneyView;
  readonly is_high_value: boolean;
  readonly derived_delivery_date: string | null;
  readonly destination_zone_resolution: string;
  readonly cited_evidence: CitedEvidenceView;
}

/**
 * What confirming an order (or an amendment) would give, **calculated by the server and written nowhere** (`previewOrder`, `previewOrderAmendment`), and the digest of it (`terms_token`) the save is given back
 * as `reviewed_terms`. The screen draws these and calculates none of them.
 */
export interface TermsView {
  readonly intake_id: string;
  readonly parcel_id: string | null;
  readonly order_id: string | null;
  readonly order_version: number | null;
  readonly evidence: 'NONE_CITED' | 'VERIFIED';
  readonly cited_evidence: CitedEvidenceView;
  readonly will_confirm: WillConfirm;
  readonly total: MoneyView;
  readonly components: readonly PriceComponentView[];
  readonly is_high_value: boolean;
  readonly high_value_surcharge: MoneyView | null;
  readonly destination: DestinationView;
  readonly delivery: DeliveryView;
  readonly payer: PayerTermsView;
  readonly current: EarlyQuoteView | null;
  readonly terms_token: string;
}

function parseCitedEvidence(body: unknown): CitedEvidenceView | undefined {
  if (!isRecord(body)) return undefined;
  const highValue = uuidListOf(body.high_value);
  const waybill = optional(body.carrier_waybill, uuidOf);
  return highValue === undefined || waybill === undefined
    ? undefined
    : { high_value: highValue, carrier_waybill: waybill };
}

function parseDestination(snapshot: unknown, resolution: unknown): DestinationView | undefined {
  if (!isRecord(snapshot) || !isOneOf(RESOLUTIONS, resolution)) return undefined;
  const outside = snapshot.scope === 'OUTSIDE_SERVICE_AREA';
  if (!outside && snapshot.scope !== 'SERVICE_AREA') return undefined;
  const name = optional(snapshot.zone_name, lineOf);
  const area = optional(snapshot.service_area, lineOf);
  if (name === undefined || area === undefined) return undefined;
  // A zone is named exactly when the parcel goes to one: a service-area destination with no zone is not a thing the API says.
  if (!outside && name === null) return undefined;
  return {
    resolution,
    zone_name: outside ? null : name,
    service_area: outside ? null : area,
    outside_service_area: outside,
  };
}

function parseDelivery(body: unknown): DeliveryView | undefined {
  if (!isRecord(body)) return undefined;
  const defaultDate = dayOf(body.default_date);
  const requested = optional(body.requested_date, dayOf);
  const committed = dayOf(body.committed_date);
  const start = optional(body.window_start, lineOf);
  const end = optional(body.window_end, lineOf);
  if (
    defaultDate === undefined ||
    requested === undefined ||
    committed === undefined ||
    start === undefined ||
    end === undefined
  ) {
    return undefined;
  }
  return {
    default_date: defaultDate,
    requested_date: requested,
    committed_date: committed,
    window_start: start,
    window_end: end,
  };
}

function parsePayerTerms(body: unknown): PayerTermsView | undefined {
  if (!isRecord(body)) return undefined;
  const sender = parseMoney(body.sender);
  const recipient = parseMoney(body.recipient);
  const intent = lineOf(body.payer_intent);
  if (
    (body.source !== 'ORDER' && body.source !== 'REQUEST') ||
    sender === undefined ||
    recipient === undefined ||
    intent === undefined ||
    !isOneOf(GATE_STATES, body.commercial_state_after_confirmation)
  ) {
    return undefined;
  }
  return {
    source: body.source,
    payer_intent: intent,
    sender,
    recipient,
    commercial_state_after_confirmation: body.commercial_state_after_confirmation,
  };
}

function parseEarlyQuote(body: unknown): EarlyQuoteView | undefined {
  if (!isRecord(body)) return undefined;
  const total = parseMoney(body.total);
  const date = optional(body.derived_delivery_date, dayOf);
  const cited = parseCitedEvidence(body.cited_evidence);
  const highValue = flag(body.is_high_value);
  const resolution = lineOf(body.destination_zone_resolution);
  if (
    total === undefined ||
    date === undefined ||
    cited === undefined ||
    highValue === undefined ||
    resolution === undefined
  ) {
    return undefined;
  }
  return {
    total,
    is_high_value: highValue,
    derived_delivery_date: date,
    destination_zone_resolution: resolution,
    cited_evidence: cited,
  };
}

export function parseTerms(body: unknown): TermsView | undefined {
  if (
    !isRecord(body) ||
    body.status !== 'CURRENT_PREVIEW' ||
    body.quote_policy !== 'PROTECTED_UNTIL_AMENDED'
  ) {
    return undefined;
  }
  const intakeId = uuidOf(body.intake_id);
  const parcelId = optional(body.parcel_id, uuidOf);
  const orderId = optional(body.order_id, uuidOf);
  const orderVersion = optional(body.order_version, (value) => whole(value));
  const validation = isRecord(body.validation) ? body.validation.evidence : undefined;
  const cited = parseCitedEvidence(body.cited_evidence);
  const price = isRecord(body.price) ? body.price : undefined;
  const total = price === undefined ? undefined : parseMoney(price.total);
  const surcharge = optional(body.high_value_surcharge, parseMoney);
  const destination = parseDestination(
    body.destination_zone_snapshot,
    body.destination_zone_resolution,
  );
  const delivery = parseDelivery(body.delivery);
  const payer = parsePayerTerms(body.payer);
  const current = optional(body.current, parseEarlyQuote);
  const token = tokenOf(body.terms_token);
  const highValue = flag(body.is_high_value);
  if (
    intakeId === undefined ||
    parcelId === undefined ||
    orderId === undefined ||
    orderVersion === undefined ||
    (validation !== 'NONE_CITED' && validation !== 'VERIFIED') ||
    cited === undefined ||
    !isOneOf(WILL_CONFIRM, body.will_confirm) ||
    price === undefined ||
    total === undefined ||
    !Array.isArray(price.components) ||
    price.components.length > MAX_COMPONENTS ||
    surcharge === undefined ||
    destination === undefined ||
    delivery === undefined ||
    payer === undefined ||
    current === undefined ||
    token === undefined ||
    highValue === undefined
  ) {
    return undefined;
  }
  const components: PriceComponentView[] = [];
  for (const entry of price.components as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const kind = lineOf(entry.kind);
    const amount = parseMoney(entry.amount);
    if (kind === undefined || amount === undefined) return undefined;
    components.push({ kind, amount });
  }
  // An order is for an order or for none, and a preview of one names the version it was made on.
  if ((orderId === null) !== (orderVersion === null)) return undefined;
  return {
    intake_id: intakeId,
    parcel_id: parcelId,
    order_id: orderId,
    order_version: orderVersion,
    evidence: validation,
    cited_evidence: cited,
    will_confirm: body.will_confirm,
    total,
    components,
    is_high_value: highValue,
    high_value_surcharge: surcharge,
    destination,
    delivery,
    payer,
    current,
    terms_token: token,
  };
}

// ---- An order -----------------------------------------------------------------------------------------------------------------------------------

export interface PayerChoiceView {
  readonly payer_intent: PayerIntent;
  readonly split_basis: SplitBasis | null;
  readonly split_sender_amount: MoneyView | null;
  readonly split_sender_percentage: number | null;
}

export interface AllocationView {
  readonly sender_minor: number;
  readonly recipient_minor: number;
}

export interface AmendmentView {
  readonly id: string;
  readonly amended_by: string;
  readonly amended_at: string;
  readonly note: string;
  /** The members that changed, by name: never their values. */
  readonly changed: readonly string[];
}

export interface ReversalNoteView {
  readonly id: string;
  readonly reversed_by: string;
  readonly reversed_at: string;
  readonly note: string;
}

/** An order as the staff of its hub read it (`getOrder`, `pricing.read`): what it holds, the price as the server calculated or froze it, who pays, and how it was corrected. */
export interface OrderView {
  readonly id: string;
  readonly code: string;
  readonly pickup_intake_id: string | null;
  readonly intake_parcel_id: string | null;
  readonly intake_parcel_state: ParcelState | null;
  /** The picture of the parcel the order is made for (D-S7-14): the rider's door photo, or the officer's photo of an extra. Null for a vendor counted without photos. The identifier is never drawn. */
  readonly intake_parcel_photo_evidence_id: string | null;
  readonly commercial_state: string | null;
  readonly size_class: SizeClass;
  readonly size_class_selected_by: string | null;
  readonly carrier_cost: MoneyView | null;
  readonly derived_delivery_date: string | null;
  readonly requested_delivery_date: string | null;
  readonly is_high_value: boolean;
  /** The flag the officer gave, kept apart from what the declared value says. Null for an order made before it was kept apart. */
  readonly is_high_value_manual: boolean | null;
  readonly price_status: PriceStatus;
  readonly lane: Lane;
  readonly commercial_mode: CommercialMode | null;
  /** The frozen price. Null until the freeze: an early order is calculated and not locked. */
  readonly locked_price: MoneyView | null;
  /** The total the order was calculated at, with its components: the early quote while the price is not frozen. */
  readonly calculated_total_minor: number | null;
  readonly components: readonly PriceComponentView[];
  readonly recipient: {
    readonly name: string;
    readonly phone: string;
    readonly location: LocationView;
  } | null;
  readonly declared_value_minor: number | null;
  readonly is_serialized_goods: boolean;
  readonly serial_imei: string | null;
  readonly destination: DestinationView;
  readonly authorization_note: string | null;
  readonly payer_override: PayerChoiceView | null;
  readonly high_value_evidence_ids: readonly string[];
  readonly carrier_waybill_evidence_id: string | null;
  readonly amendments: readonly AmendmentView[];
  readonly reversal: ReversalNoteView | null;
  readonly payer_allocation: AllocationView | null;
}

export function parseAllocation(body: unknown): AllocationView | undefined {
  if (!isRecord(body)) return undefined;
  const sender = whole(body.sender_minor, Number.MAX_SAFE_INTEGER);
  const recipient = whole(body.recipient_minor, Number.MAX_SAFE_INTEGER);
  return sender === undefined || recipient === undefined
    ? undefined
    : { sender_minor: sender, recipient_minor: recipient };
}

export function parsePayerChoice(body: unknown): PayerChoiceView | undefined {
  if (!isRecord(body) || !isOneOf(PAYER_INTENTS, body.payer_intent)) return undefined;
  const basis = optional(body.split_basis, (value) =>
    isOneOf(SPLIT_BASES, value) ? value : undefined,
  );
  const amount = optional(body.split_sender_amount, parseMoney);
  const percentage = optional(body.split_sender_percentage, (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      ? value
      : undefined,
  );
  if (basis === undefined || amount === undefined || percentage === undefined) return undefined;
  return {
    payer_intent: body.payer_intent,
    split_basis: basis,
    split_sender_amount: amount,
    split_sender_percentage: percentage,
  };
}

function parseAmendment(body: unknown): AmendmentView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const by = uuidOf(body.amended_by);
  const at = instantOf(body.amended_at);
  const note = noteOf(body.note);
  if (
    id === undefined ||
    by === undefined ||
    at === undefined ||
    note === undefined ||
    !Array.isArray(body.changed) ||
    body.changed.length > 64 ||
    !(body.changed as unknown[]).every(
      (member) => typeof member === 'string' && /^[a-z_]{1,64}$/.test(member),
    )
  ) {
    return undefined;
  }
  return { id, amended_by: by, amended_at: at, note, changed: body.changed as string[] };
}

function parseReversalNote(body: unknown): ReversalNoteView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const by = uuidOf(body.reversed_by);
  const at = instantOf(body.reversed_at);
  const note = noteOf(body.note);
  return id === undefined || by === undefined || at === undefined || note === undefined
    ? undefined
    : { id, reversed_by: by, reversed_at: at, note };
}

/** The price an order was calculated at: its total and the components (a kind and an amount), in the order the API gave them. */
function parseSnapshot(
  body: unknown,
): { total: number | null; components: PriceComponentView[] } | undefined {
  if (!isRecord(body)) return undefined;
  const total = optional(body.total_minor, (value) => whole(value, Number.MAX_SAFE_INTEGER));
  if (total === undefined) return undefined;
  const list = body.components;
  if (list !== undefined && (!Array.isArray(list) || list.length > MAX_COMPONENTS))
    return undefined;
  const components: PriceComponentView[] = [];
  for (const entry of (list ?? []) as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const kind = lineOf(entry.kind);
    const amount = whole(entry.amount_minor, Number.MAX_SAFE_INTEGER);
    if (kind === undefined || amount === undefined) return undefined;
    components.push({ kind, amount: { amount_minor: amount, currency: 'GHS' } });
  }
  return { total, components };
}

export function parseOrder(body: unknown): OrderView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const code = codeOf(body.code);
  const intake = optional(body.pickup_intake_id, uuidOf);
  const parcel = optional(body.intake_parcel_id, uuidOf);
  const photo = optional(body.intake_parcel_photo_evidence_id, uuidOf);
  const parcelState = optional(body.intake_parcel_state, (value) =>
    isOneOf(PARCEL_STATES, value) ? value : undefined,
  );
  const state = optional(body.commercial_state, (value) =>
    isOneOf(COMMERCIAL_STATES, value) ? value : undefined,
  );
  const selectedBy = optional(body.size_class_selected_by, uuidOf);
  const carrier = optional(body.carrier_cost, parseMoney);
  const derived = optional(body.derived_delivery_date, dayOf);
  const requested = optional(body.requested_delivery_date, dayOf);
  const highValue = flag(body.is_high_value);
  const manual = optional(body.is_high_value_manual, flag);
  const locked = optional(body.locked_price, parseMoney);
  const snapshot = parseSnapshot(body.price_components_snapshot ?? {});
  const declared = optional(body.declared_value_minor, (value) =>
    whole(value, Number.MAX_SAFE_INTEGER),
  );
  const serialised = flag(body.is_serialized_goods ?? false);
  const serial = optional(body.serial_imei, lineOf);
  const override = optional(body.payer_override, parsePayerChoice);
  const evidence =
    body.high_value_evidence_ids === undefined ? [] : uuidListOf(body.high_value_evidence_ids);
  const waybill = optional(body.carrier_waybill_evidence_id, uuidOf);
  const allocation = optional(body.payer_allocation, parseAllocation);
  const mode = optional(body.commercial_mode, (value) =>
    isOneOf(COMMERCIAL_MODES, value) ? value : undefined,
  );
  if (
    id === undefined ||
    code === undefined ||
    intake === undefined ||
    parcel === undefined ||
    photo === undefined ||
    parcelState === undefined ||
    state === undefined ||
    selectedBy === undefined ||
    carrier === undefined ||
    derived === undefined ||
    requested === undefined ||
    highValue === undefined ||
    manual === undefined ||
    locked === undefined ||
    snapshot === undefined ||
    declared === undefined ||
    serialised === undefined ||
    serial === undefined ||
    override === undefined ||
    evidence === undefined ||
    waybill === undefined ||
    allocation === undefined ||
    mode === undefined ||
    !isOneOf(SIZE_CLASSES, body.size_class) ||
    !isOneOf(LANES, body.lane) ||
    !isOneOf(PRICE_STATUSES, body.price_status)
  ) {
    return undefined;
  }
  // A price is frozen exactly when it is locked: an order that says one thing and holds the other is not the API's.
  if ((body.price_status === 'FROZEN') !== (locked !== null)) return undefined;

  let recipient: OrderView['recipient'] = null;
  if (body.recipient !== undefined) {
    if (!isRecord(body.recipient)) return undefined;
    const name = lineOf(body.recipient.name);
    const phone = lineOf(body.recipient.phone);
    const location = parseLocation(body.recipient.location);
    if (name === undefined || phone === undefined || location === undefined) return undefined;
    recipient = { name, phone, location };
  }

  const resolution = body.destination_zone_resolution;
  const destination = parseDestination(
    body.destination_zone_snapshot ?? {},
    resolution ?? 'SERVER_RESOLVED',
  );
  const authorizationNote = isRecord(body.destination_zone_snapshot)
    ? optional(body.destination_zone_snapshot.authorization_note, lineOf)
    : null;
  if (authorizationNote === undefined) return undefined;

  const amendments: AmendmentView[] = [];
  if (body.amendments !== undefined) {
    if (!Array.isArray(body.amendments) || body.amendments.length > MAX_HISTORY) return undefined;
    for (const entry of body.amendments as unknown[]) {
      const amendment = parseAmendment(entry);
      if (amendment === undefined) return undefined;
      amendments.push(amendment);
    }
  }
  const reversal = optional(body.reversal, parseReversalNote);
  if (reversal === undefined) return undefined;

  return {
    id,
    code,
    pickup_intake_id: intake,
    intake_parcel_id: parcel,
    intake_parcel_photo_evidence_id: photo,
    intake_parcel_state: parcelState,
    commercial_state: state,
    size_class: body.size_class,
    size_class_selected_by: selectedBy,
    carrier_cost: carrier,
    derived_delivery_date: derived,
    requested_delivery_date: requested,
    is_high_value: highValue,
    is_high_value_manual: manual,
    price_status: body.price_status,
    lane: body.lane,
    commercial_mode: mode,
    locked_price: locked,
    calculated_total_minor: snapshot.total,
    components: snapshot.components,
    recipient,
    declared_value_minor: declared,
    is_serialized_goods: serialised,
    serial_imei: serial,
    destination: destination ?? {
      resolution: 'SERVER_RESOLVED',
      zone_name: null,
      service_area: null,
      outside_service_area: false,
    },
    authorization_note: authorizationNote,
    payer_override: override,
    high_value_evidence_ids: evidence,
    carrier_waybill_evidence_id: waybill,
    amendments,
    reversal,
    payer_allocation: allocation,
  };
}

/** What a reversal of an arrival did (`reverseOrderArrival`): the order is `REVERSED`, the parcel is missing or taken back, and the count is what the parcels now say. */
export interface ReversalView {
  readonly id: string;
  readonly order_id: string;
  readonly intake_id: string;
  readonly parcel_id: string;
  readonly parcel_state: 'MISSING' | 'VOID';
  readonly intake_state: string;
  readonly received_before: number;
  readonly received_after: number;
  readonly note: string;
  readonly reversed_at: string;
}

export function parseReversal(body: unknown): ReversalView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const orderId = uuidOf(body.order_id);
  const intakeId = uuidOf(body.intake_id);
  const parcelId = uuidOf(body.parcel_id);
  const before = whole(body.received_before);
  const after = whole(body.received_after);
  const note = noteOf(body.note);
  const at = instantOf(body.reversed_at);
  if (
    id === undefined ||
    orderId === undefined ||
    intakeId === undefined ||
    parcelId === undefined ||
    before === undefined ||
    after === undefined ||
    note === undefined ||
    at === undefined ||
    body.commercial_state !== 'REVERSED' ||
    (body.parcel_state !== 'MISSING' && body.parcel_state !== 'VOID') ||
    typeof body.intake_state !== 'string'
  ) {
    return undefined;
  }
  return {
    id,
    order_id: orderId,
    intake_id: intakeId,
    parcel_id: parcelId,
    parcel_state: body.parcel_state,
    intake_state: body.intake_state,
    received_before: before,
    received_after: after,
    note,
    reversed_at: at,
  };
}

// ---- The close ----------------------------------------------------------------------------------------------------------------------------------

export interface OutstandingParcelView {
  readonly parcel_id: string;
  readonly ordinal: number;
  readonly origin: ParcelOrigin;
  readonly door_photo_evidence_id: string | null;
  readonly hub_photo_evidence_id: string | null;
}

/** What closing a vendor would find (`getIntakeClosure`): the facts the close judges, each apart, and the received parcels that still have no order, named (the first hundred: a display limit). */
export interface ClosureView {
  readonly intake_id: string;
  readonly intake_state: string;
  readonly receiving_mode: VendorMode;
  readonly received: number | null;
  readonly ordered: number;
  readonly unpriced: number;
  readonly payment_required: number;
  readonly missing: number;
  readonly outstanding_count: number | null;
  readonly excess_count: number;
  readonly outstanding_parcels: readonly OutstandingParcelView[];
  /** The digest of what this assessment found: the approved exception is closed against it (`reviewed_assessment`). */
  readonly assessment_token: string;
  readonly closed_at: string | null;
  readonly parity_exception_note: string | null;
  readonly can_close: boolean;
  readonly needs_exception: boolean;
  readonly blockers: readonly Blocker[];
  readonly payment_still_required: boolean;
}

export function parseClosure(body: unknown): ClosureView | undefined {
  if (!isRecord(body)) return undefined;
  const intakeId = uuidOf(body.intake_id);
  const received = optional(body.received, (value) => whole(value));
  const outstandingCount = optional(body.outstanding_count, (value) => whole(value));
  const ordered = whole(body.ordered);
  const unpriced = whole(body.unpriced);
  const paymentRequired = whole(body.payment_required);
  const missing = whole(body.missing);
  const excess = whole(body.excess_count);
  const token = tokenOf(body.assessment_token);
  const closedAt = optional(body.closed_at, instantOf);
  const exceptionNote = optional(body.parity_exception_note, noteOf);
  const canClose = flag(body.can_close);
  const needsException = flag(body.needs_exception);
  const paymentStill = flag(body.payment_still_required);
  if (
    intakeId === undefined ||
    typeof body.intake_state !== 'string' ||
    !isOneOf(RECEIVING_MODES, body.receiving_mode) ||
    received === undefined ||
    outstandingCount === undefined ||
    ordered === undefined ||
    unpriced === undefined ||
    paymentRequired === undefined ||
    missing === undefined ||
    excess === undefined ||
    token === undefined ||
    closedAt === undefined ||
    exceptionNote === undefined ||
    canClose === undefined ||
    needsException === undefined ||
    paymentStill === undefined ||
    !Array.isArray(body.outstanding_parcels) ||
    body.outstanding_parcels.length > MAX_OUTSTANDING ||
    !Array.isArray(body.blockers) ||
    body.blockers.length > BLOCKERS.length
  ) {
    return undefined;
  }
  const parcels: OutstandingParcelView[] = [];
  const seen = new Set<string>();
  for (const entry of body.outstanding_parcels as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.parcel_id);
    const ordinal = whole(entry.ordinal);
    const door = optional(entry.door_photo_evidence_id, uuidOf);
    const hub = optional(entry.hub_photo_evidence_id, uuidOf);
    if (
      id === undefined ||
      ordinal === undefined ||
      ordinal < 1 ||
      !isOneOf(PARCEL_ORIGINS, entry.origin) ||
      door === undefined ||
      hub === undefined ||
      seen.has(id.toLowerCase())
    ) {
      return undefined;
    }
    seen.add(id.toLowerCase());
    parcels.push({
      parcel_id: id,
      ordinal,
      origin: entry.origin,
      door_photo_evidence_id: door,
      hub_photo_evidence_id: hub,
    });
  }
  const blockers: Blocker[] = [];
  for (const entry of body.blockers as unknown[]) {
    if (!isOneOf(BLOCKERS, entry) || blockers.includes(entry)) return undefined;
    blockers.push(entry);
  }
  return {
    intake_id: intakeId,
    intake_state: body.intake_state,
    receiving_mode: body.receiving_mode,
    received,
    ordered,
    unpriced,
    payment_required: paymentRequired,
    missing,
    outstanding_count: outstandingCount,
    excess_count: excess,
    outstanding_parcels: parcels,
    assessment_token: token,
    closed_at: closedAt,
    parity_exception_note: exceptionNote,
    can_close: canClose,
    needs_exception: needsException,
    blockers,
    payment_still_required: paymentStill,
  };
}

/** What a close answers: the vendor, closed. The rest of its record is read again, so only the fact is believed here. */
export interface ClosedView {
  readonly id: string;
}

export function parseClosed(body: unknown): ClosedView | undefined {
  if (!isRecord(body) || body.state !== 'CLOSED') return undefined;
  const id = uuidOf(body.id);
  return id === undefined ? undefined : { id };
}

/** One close that left work (`listClosedIntakeExceptions`). */
export interface ClosedExceptionView {
  readonly intake_id: string;
  readonly intake_code: string;
  readonly pickup_request_id: string;
  readonly responsible_hub_id: string;
  readonly receiving_mode: VendorMode;
  readonly closed_at: string;
  readonly closed_by: string;
  readonly exception_note: string | null;
  readonly received: number;
  readonly ordered: number;
  readonly outstanding_count: number;
}

export function parseClosedException(body: unknown): ClosedExceptionView | undefined {
  if (!isRecord(body)) return undefined;
  const intakeId = uuidOf(body.intake_id);
  const code = codeOf(body.intake_code);
  const request = uuidOf(body.pickup_request_id);
  const hub = uuidOf(body.responsible_hub_id);
  const closedAt = instantOf(body.closed_at);
  const closedBy = uuidOf(body.closed_by);
  const note = optional(body.exception_note, noteOf);
  const received = whole(body.received);
  const ordered = whole(body.ordered);
  const outstanding = whole(body.outstanding_count);
  if (
    intakeId === undefined ||
    code === undefined ||
    request === undefined ||
    hub === undefined ||
    !isOneOf(RECEIVING_MODES, body.receiving_mode) ||
    closedAt === undefined ||
    closedBy === undefined ||
    note === undefined ||
    received === undefined ||
    ordered === undefined ||
    outstanding === undefined ||
    outstanding < 1
  ) {
    return undefined;
  }
  return {
    intake_id: intakeId,
    intake_code: code,
    pickup_request_id: request,
    responsible_hub_id: hub,
    receiving_mode: body.receiving_mode,
    closed_at: closedAt,
    closed_by: closedBy,
    exception_note: note,
    received,
    ordered,
    outstanding_count: outstanding,
  };
}

export function parseClosedExceptionPage(
  body: unknown,
): WorkListPageView<ClosedExceptionView> | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const next = nextTokenOf(body.next_page_token);
  if (next === undefined) return undefined;
  const items: ClosedExceptionView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseClosedException(entry);
    if (item === undefined || seen.has(item.intake_id.toLowerCase())) return undefined;
    seen.add(item.intake_id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: next };
}

// ---- The summary of a closed vendor -------------------------------------------------------------------------------------------------------------

export interface SummaryOrderView {
  readonly id: string;
  readonly code: string;
  readonly recipient_name: string;
  readonly service_area: string;
  readonly size_class: SizeClass | null;
  /** Present only where the reader's own pricing grant reaches the hub (OB-S1-155): absent is not zero. */
  readonly locked_price: MoneyView | null;
  /** Who pays what of the price (D-S7-10): present where the price is, absent where it is not. */
  readonly payer_allocation: AllocationView | null;
  readonly commercial_state: string;
}

export interface SummaryView {
  readonly intake_id: string;
  readonly pickup_request_id: string;
  readonly closed_at: string;
  readonly orders: readonly SummaryOrderView[];
}

export function parseSummary(body: unknown): SummaryView | undefined {
  if (!isRecord(body) || !Array.isArray(body.orders) || body.orders.length > MAX_COUNT)
    return undefined;
  const intakeId = uuidOf(body.intake_id);
  const request = uuidOf(body.pickup_request_id);
  const closedAt = instantOf(body.closed_at);
  if (intakeId === undefined || request === undefined || closedAt === undefined) return undefined;
  const orders: SummaryOrderView[] = [];
  const seen = new Set<string>();
  for (const entry of body.orders as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.id);
    const code = codeOf(entry.code);
    const name = lineOf(entry.recipient_name);
    const area = lineOf(entry.service_area);
    const size = optional(entry.size_class, (value) =>
      isOneOf(SIZE_CLASSES, value) ? value : undefined,
    );
    const price = optional(entry.locked_price, parseMoney);
    const allocation = optional(entry.payer_allocation, parseAllocation);
    const state = lineOf(entry.commercial_state);
    if (
      id === undefined ||
      code === undefined ||
      name === undefined ||
      area === undefined ||
      size === undefined ||
      price === undefined ||
      allocation === undefined ||
      state === undefined ||
      seen.has(id.toLowerCase())
    ) {
      return undefined;
    }
    seen.add(id.toLowerCase());
    orders.push({
      id,
      code,
      recipient_name: name,
      service_area: area,
      size_class: size,
      locked_price: price,
      payer_allocation: allocation,
      commercial_state: state,
    });
  }
  return { intake_id: intakeId, pickup_request_id: request, closed_at: closedAt, orders };
}

// ---- The payer corrections ----------------------------------------------------------------------------------------------------------------------

export interface CorrectionView {
  readonly id: string;
  readonly order_id: string;
  readonly order_code: string | null;
  readonly state: CorrectionState;
  readonly requested_by: string;
  readonly requested_by_name: string | null;
  readonly approved_by: string | null;
  readonly approved_by_name: string | null;
  /** How the price was shared before: actual amounts, as the order kept them. */
  readonly previous_allocation: AllocationView;
  /** What was asked for, as an intent and the numbers that go with it. */
  readonly proposed: PayerChoiceView;
  /** What the proposal comes to, in actual amounts, calculated by the server. */
  readonly proposed_allocation: AllocationView | null;
  readonly proposed_commercial_state: GateState | null;
  readonly order_commercial_state: string | null;
  /** The locked price, unchanged by any correction. */
  readonly total: MoneyView | null;
  readonly resulting_allocation: AllocationView | null;
  readonly resulting_commercial_state: string | null;
  readonly note: string | null;
  readonly created_at: string | null;
  readonly decided_at: string | null;
}

export function parseCorrection(body: unknown): CorrectionView | undefined {
  if (!isRecord(body)) return undefined;
  const id = uuidOf(body.id);
  const orderId = uuidOf(body.order_id);
  const orderCode = optional(body.order_code, codeOf);
  const requestedBy = uuidOf(body.requested_by);
  const requestedByName = optional(body.requested_by_name, lineOf);
  const approvedBy = optional(body.approved_by, uuidOf);
  const approvedByName = optional(body.approved_by_name, lineOf);
  const previous = parseAllocation(body.previous_allocation);
  const proposed = parsePayerChoice(body.proposed);
  const proposedAllocation = optional(body.proposed_allocation, parseAllocation);
  const proposedState = optional(body.proposed_commercial_state, (value) =>
    isOneOf(GATE_STATES, value) ? value : undefined,
  );
  const orderState = optional(body.order_commercial_state, lineOf);
  const total = optional(body.total, parseMoney);
  const resulting = optional(body.resulting_allocation, parseAllocation);
  const resultingState = optional(body.resulting_commercial_state, lineOf);
  const note = optional(body.note, noteOf);
  const createdAt = optional(body.created_at, instantOf);
  const decidedAt = optional(body.decided_at, instantOf);
  if (
    id === undefined ||
    orderId === undefined ||
    orderCode === undefined ||
    requestedBy === undefined ||
    requestedByName === undefined ||
    approvedBy === undefined ||
    approvedByName === undefined ||
    previous === undefined ||
    proposed === undefined ||
    proposedAllocation === undefined ||
    proposedState === undefined ||
    orderState === undefined ||
    total === undefined ||
    resulting === undefined ||
    resultingState === undefined ||
    note === undefined ||
    createdAt === undefined ||
    decidedAt === undefined ||
    !isOneOf(CORRECTION_STATES, body.state)
  ) {
    return undefined;
  }
  // A correction that was decided says by whom and when, and one that was not says neither.
  if (body.state === 'REQUESTED' && (decidedAt !== null || resulting !== null)) return undefined;
  if (body.state === 'APPROVED' && resulting === null) return undefined;
  return {
    id,
    order_id: orderId,
    order_code: orderCode,
    state: body.state,
    requested_by: requestedBy,
    requested_by_name: requestedByName,
    approved_by: approvedBy,
    approved_by_name: approvedByName,
    previous_allocation: previous,
    proposed,
    proposed_allocation: proposedAllocation,
    proposed_commercial_state: proposedState,
    order_commercial_state: orderState,
    total,
    resulting_allocation: resulting,
    resulting_commercial_state: resultingState,
    note,
    created_at: createdAt,
    decided_at: decidedAt,
  };
}

export function parseCorrectionPage(body: unknown): WorkListPageView<CorrectionView> | undefined {
  if (!isRecord(body) || !Array.isArray(body.items) || body.items.length > MAX_PAGE_ITEMS) {
    return undefined;
  }
  const next = nextTokenOf(body.next_page_token);
  if (next === undefined) return undefined;
  const items: CorrectionView[] = [];
  const seen = new Set<string>();
  for (const entry of body.items as unknown[]) {
    const item = parseCorrection(entry);
    if (item === undefined || seen.has(item.id.toLowerCase())) return undefined;
    seen.add(item.id.toLowerCase());
    items.push(item);
  }
  return { items, nextPageToken: next };
}

// ---- A zone the officer is asked to choose ------------------------------------------------------------------------------------------------------

/** A zone an address matched with another: the officer chooses one and says why. The API names them in the refusal (`details.candidates`); the portal reads no list of zones. */
export interface ZoneCandidateView {
  readonly zone_id: string;
  readonly name: string;
}

export function parseCandidates(value: unknown): readonly ZoneCandidateView[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CANDIDATES)
    return undefined;
  const seen = new Set<string>();
  const found: ZoneCandidateView[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.zone_id);
    const name = lineOf(entry.name);
    if (id === undefined || name === undefined || seen.has(id.toLowerCase())) return undefined;
    seen.add(id.toLowerCase());
    found.push({ zone_id: id, name });
  }
  return found;
}

/** The most zones a hub's list may name before it is not a list a person can choose from: more is an answer that is not the API's. */
const MAX_ZONES = 200;

/**
 * The zones of the hub an intake belongs to (`listDestinationZones`, D-S7-5): `{ zone_id, name }` for each active zone and nothing else, in the order the server gave. A hub with no zone is an empty list (the form
 * then has nothing to offer and says what it said before); a list that is not the list, a zone with no usable identifier or name, or the same zone twice is not the API's answer.
 */
export function parseZoneList(value: unknown): readonly ZoneCandidateView[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_ZONES) {
    return undefined;
  }
  const seen = new Set<string>();
  const found: ZoneCandidateView[] = [];
  for (const entry of value.items as unknown[]) {
    if (!isRecord(entry)) return undefined;
    const id = uuidOf(entry.zone_id);
    const name = lineOf(entry.name);
    if (id === undefined || name === undefined || seen.has(id.toLowerCase())) return undefined;
    seen.add(id.toLowerCase());
    found.push({ zone_id: id, name });
  }
  return found;
}

/** Contract types the guards above are held to by `test/hub-orders-contract.test.ts`. */
export type ContractSchemas = components['schemas'];

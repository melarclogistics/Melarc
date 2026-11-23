import { pesewasFromCedis } from '../../components/ui/money/money-value';
import { ORDERS_WORDS } from '../problem/orders-copy';
import type {
  AmendPreviewBody,
  AmendSaveBody,
  OrderPreviewBody,
  OrderSaveBody,
  PayerChoiceBody,
} from './orders-commands';
import type {
  Lane,
  CommercialMode,
  OrderView,
  PayerChoiceView,
  PayerIntent,
  SizeClass,
  SplitBasis,
} from './orders-shape';

/**
 * What the form of an order holds, as typed, and what is sent from it (S1.40). **The form sends no price, no total, no surcharge and no zone of its own**: the price is the server's, worked out when the officer
 * checks it, and a zone is sent only as the officer's choice among the ones the server named for an address it could not place. The one amount an officer types is the carrier's charge, an observation with
 * the photo of its waybill behind it (and, for a split, what the sender pays, which the server turns into portions of a price it has not shown yet).
 *
 * The checks here are the cheap ones the server makes first, in the floor's words, so that an officer is told where to look before anything is sent; the server judges every request all the same, and a refusal it
 * gives is told on the field it names. Nothing here decides a business rule.
 */
export type Destination = 'DOORSTEP' | 'STATION_DROP' | 'CARRIER';
export const DESTINATIONS: readonly Destination[] = ['DOORSTEP', 'STATION_DROP', 'CARRIER'];

/** Who pays for this order: as the pickup request says, or its own arrangement. */
export type PayerChoice = 'AS_BOOKED' | PayerIntent;

export interface OrderFormValues {
  readonly name: string;
  readonly phone: string;
  readonly address: string;
  readonly landmark: string;
  /** Nothing is chosen for the officer: a size is a judgement. */
  readonly sizeClass: SizeClass | null;
  readonly destination: Destination | null;
  readonly carrierCost: string;
  readonly waybillEvidenceId: string | null;
  readonly declaredValue: string;
  /** The officer's own flag. What the declared value makes of it is the server's. */
  readonly highValue: boolean;
  readonly evidenceIds: readonly string[];
  readonly serialized: boolean;
  readonly serial: string;
  readonly requestedDate: string | null;
  readonly payer: PayerChoice;
  readonly splitBasis: SplitBasis | null;
  readonly splitAmount: string;
  readonly splitPercentage: string;
  /** The zone the officer chose among the ones the server named, for the address it was chosen for. */
  readonly zoneId: string | null;
  readonly zoneNote: string;
  /** The reason of an amendment. */
  readonly reason: string;
}

export const EMPTY_ORDER_FORM: OrderFormValues = {
  name: '',
  phone: '',
  address: '',
  landmark: '',
  sizeClass: null,
  destination: 'DOORSTEP',
  carrierCost: '',
  waybillEvidenceId: null,
  declaredValue: '',
  highValue: false,
  evidenceIds: [],
  serialized: false,
  serial: '',
  requestedDate: null,
  payer: 'AS_BOOKED',
  splitBasis: null,
  splitAmount: '',
  splitPercentage: '',
  zoneId: null,
  zoneNote: '',
  reason: '',
};

export type OrderField =
  | 'name'
  | 'phone'
  | 'address'
  | 'sizeClass'
  | 'destination'
  | 'carrierCost'
  | 'waybill'
  | 'declaredValue'
  | 'evidence'
  | 'serial'
  | 'requestedDate'
  | 'payer'
  | 'splitBasis'
  | 'splitAmount'
  | 'splitPercentage'
  | 'zone'
  | 'zoneNote'
  | 'reason';

export type OrderFieldErrors = Partial<Record<OrderField, string>>;

const E = ORDERS_WORDS.form.errors;
const PERCENTAGE = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/;

/** The words of what is wrong with a field, or nothing. The checks are the cheap ones the server makes first. */
/**
 * Whether a phone number, as typed, looks like a Ghana number: the national form (`024 123 4567`, ten digits from a zero) or the international one (`+233 24 123 4567`, `233…`, `00233…`). **Guidance and nothing more**:
 * the form tells the officer while they type, never refuses for it, and the server judges the number it is given.
 */
export function looksLikeGhanaNumber(text: string): boolean {
  return /^(?:(?:\+|00)?233|0)[2-5]\d{8}$/.test(text.replace(/[\s().-]/g, ''));
}

export function problemsWith(
  values: OrderFormValues,
  options: { readonly amendment?: boolean; readonly zoneNeeded?: boolean } = {},
): OrderFieldErrors {
  const found: Partial<Record<OrderField, string>> = {};
  if (values.name.trim() === '') found.name = E.name;
  if (values.phone.trim() === '') found.phone = E.phone;
  if (values.address.trim() === '') found.address = E.address;
  if (values.sizeClass === null) found.sizeClass = E.size;
  if (values.destination === null) found.destination = E.destination;
  if (values.destination === 'CARRIER') {
    if (pesewasFromCedis(values.carrierCost) === undefined) found.carrierCost = E.carrierCost;
    if (values.waybillEvidenceId === null) found.waybill = E.waybill;
  }
  if (values.declaredValue.trim() !== '' && pesewasFromCedis(values.declaredValue) === undefined) {
    found.declaredValue = E.declaredValue;
  }
  if (values.highValue && values.evidenceIds.length === 0) found.evidence = E.evidence;
  if (values.serialized && values.serial.trim() === '') found.serial = E.serial;
  if (values.payer === 'SPLIT') {
    if (values.splitBasis === null) found.splitBasis = E.splitBasis;
    else if (
      values.splitBasis === 'FIXED_AMOUNT' &&
      pesewasFromCedis(values.splitAmount) === undefined
    ) {
      found.splitAmount = E.splitAmount;
    } else if (
      values.splitBasis === 'PERCENTAGE' &&
      !PERCENTAGE.test(values.splitPercentage.trim())
    ) {
      found.splitPercentage = E.splitPercentage;
    }
  }
  if (options.zoneNeeded === true) {
    if (values.zoneId === null) found.zone = E.zone;
    else if (values.zoneNote.trim() === '') found.zoneNote = E.zoneNote;
  }
  if (options.amendment === true && values.reason.trim() === '') found.reason = E.reason;
  return found;
}

// ---- What is sent -------------------------------------------------------------------------------------------------------------------------------

interface LaneOf {
  readonly lane: Lane;
  readonly commercial_mode?: CommercialMode;
}

function laneOf(destination: Destination): LaneOf {
  switch (destination) {
    case 'DOORSTEP':
      return { lane: 'DOORSTEP' };
    case 'STATION_DROP':
      return { lane: 'THIRD_PARTY_HANDOFF', commercial_mode: 'STATION_DROP' };
    case 'CARRIER':
      return {
        lane: 'THIRD_PARTY_HANDOFF',
        commercial_mode: 'MELARC_COVERED_THIRD_PARTY_DELIVERY',
      };
  }
}

function payerBodyOf(values: OrderFormValues): PayerChoiceBody | undefined {
  if (values.payer === 'AS_BOOKED') return undefined;
  if (values.payer !== 'SPLIT') return { payer_intent: values.payer };
  if (values.splitBasis === 'FIXED_AMOUNT') {
    const amount = pesewasFromCedis(values.splitAmount);
    return amount === undefined
      ? undefined
      : {
          payer_intent: 'SPLIT',
          split_basis: 'FIXED_AMOUNT',
          split_sender_amount: { amount_minor: amount, currency: 'GHS' },
        };
  }
  if (values.splitBasis === 'PERCENTAGE') {
    return {
      payer_intent: 'SPLIT',
      split_basis: 'PERCENTAGE',
      split_sender_percentage: Number(values.splitPercentage.trim()),
    };
  }
  return undefined;
}

function recipientOf(values: OrderFormValues): OrderPreviewBody['recipient'] {
  return {
    name: values.name.trim(),
    phone: values.phone.trim(),
    location: {
      address: values.address.trim(),
      ...(values.landmark.trim() === '' ? {} : { landmark: values.landmark.trim() }),
    },
  };
}

/**
 * The body of a preview (and, with the token, of the save): only what the officer gave, in the form the contract takes. A member the officer did not fill in is left out, and none of them is a price, a
 * total or a zone the server worked out. Call it only for values that passed {@link problemsWith}.
 */
export function previewBodyOf(values: OrderFormValues, parcelId: string | null): OrderPreviewBody {
  const destination = values.destination ?? 'DOORSTEP';
  const lane = laneOf(destination);
  const declared =
    values.declaredValue.trim() === '' ? undefined : pesewasFromCedis(values.declaredValue);
  const payer = payerBodyOf(values);
  const carrier = destination === 'CARRIER' ? pesewasFromCedis(values.carrierCost) : undefined;
  return {
    ...(parcelId === null ? {} : { parcel_id: parcelId }),
    recipient: recipientOf(values),
    ...(values.sizeClass === null ? {} : { size_class: values.sizeClass }),
    lane: lane.lane,
    ...(lane.commercial_mode === undefined ? {} : { commercial_mode: lane.commercial_mode }),
    ...(carrier === undefined
      ? {}
      : { carrier_cost: { amount_minor: carrier, currency: 'GHS' as const } }),
    ...(values.waybillEvidenceId === null || destination !== 'CARRIER'
      ? {}
      : { carrier_waybill_evidence_id: values.waybillEvidenceId }),
    ...(declared === undefined ? {} : { declared_value_minor: declared }),
    is_high_value: values.highValue,
    ...(values.evidenceIds.length === 0 ? {} : { evidence_ids: [...values.evidenceIds] }),
    is_serialized_goods: values.serialized,
    ...(values.serialized ? { serial_imei: values.serial.trim() } : {}),
    ...(values.requestedDate === null ? {} : { requested_delivery_date: values.requestedDate }),
    ...(payer === undefined ? {} : { payer_override: payer }),
    ...(values.zoneId === null
      ? {}
      : {
          destination_zone_authorization: { zone_id: values.zoneId, note: values.zoneNote.trim() },
        }),
  };
}

/** The body of the save: the same facts, with the digest of the terms the officer reviewed. */
export function saveBodyOf(
  values: OrderFormValues,
  parcelId: string | null,
  token: string,
): OrderSaveBody {
  return { ...previewBodyOf(values, parcelId), reviewed_terms: token };
}

// ---- Changing an order --------------------------------------------------------------------------------------------------------------------------

/** The cedis of an amount of pesewas as text (`3500` is `35.00`), on the digits and never by arithmetic on a float. */
export function cedisText(amountMinor: number): string {
  const digits = String(Math.abs(amountMinor)).padStart(3, '0');
  return `${digits.slice(0, -2).replace(/^0+(?=\d)/, '')}.${digits.slice(-2)}`;
}

function payerValuesOf(
  choice: PayerChoiceView | null,
): Pick<OrderFormValues, 'payer' | 'splitBasis' | 'splitAmount' | 'splitPercentage'> {
  if (choice === null) {
    return { payer: 'AS_BOOKED', splitBasis: null, splitAmount: '', splitPercentage: '' };
  }
  return {
    payer: choice.payer_intent,
    splitBasis: choice.split_basis,
    splitAmount:
      choice.split_sender_amount === null ? '' : cedisText(choice.split_sender_amount.amount_minor),
    splitPercentage:
      choice.split_sender_percentage === null ? '' : String(choice.split_sender_percentage),
  };
}

/** Where an order goes, as the form says it (the lane and the mode the API keeps, told as the officer chose them). */
export function destinationOf(order: OrderView): Destination {
  if (order.lane === 'DOORSTEP') return 'DOORSTEP';
  return order.commercial_mode === 'MELARC_COVERED_THIRD_PARTY_DELIVERY'
    ? 'CARRIER'
    : 'STATION_DROP';
}

/** What an order holds, as the form shows it for a change: the values the officer wrote down, to be corrected. */
export function valuesOf(order: OrderView): OrderFormValues {
  return {
    ...EMPTY_ORDER_FORM,
    name: order.recipient?.name ?? '',
    phone: order.recipient?.phone ?? '',
    address: order.recipient?.location.address ?? '',
    landmark: order.recipient?.location.landmark ?? '',
    sizeClass: order.size_class,
    destination: destinationOf(order),
    carrierCost: order.carrier_cost === null ? '' : cedisText(order.carrier_cost.amount_minor),
    waybillEvidenceId: order.carrier_waybill_evidence_id,
    declaredValue: order.declared_value_minor === null ? '' : cedisText(order.declared_value_minor),
    highValue: order.is_high_value_manual === true,
    evidenceIds: order.high_value_evidence_ids,
    serialized: order.is_serialized_goods,
    serial: order.serial_imei ?? '',
    requestedDate: order.requested_delivery_date,
    ...payerValuesOf(order.payer_override),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((entry) => b.includes(entry));

/**
 * What an amendment changes: **only the members the officer changed**, because a member that is not named is kept (`null` clears one that may be empty). The recipient is replaced whole when any part of it
 * changed, as the contract takes it. The patch is empty when nothing changed, and the form says so before anything is sent.
 */
export function amendPatchOf(initial: OrderFormValues, now: OrderFormValues): AmendPreviewBody {
  const patch: { -readonly [Key in keyof AmendPreviewBody]: AmendPreviewBody[Key] } = {};
  if (
    now.name !== initial.name ||
    now.phone !== initial.phone ||
    now.address !== initial.address ||
    now.landmark !== initial.landmark
  ) {
    patch.recipient = recipientOf(now);
  }
  if (now.sizeClass !== initial.sizeClass && now.sizeClass !== null)
    patch.size_class = now.sizeClass;
  if (now.destination !== initial.destination && now.destination !== null) {
    const lane = laneOf(now.destination);
    patch.lane = lane.lane;
    patch.commercial_mode = lane.commercial_mode ?? null;
  }
  if (now.carrierCost !== initial.carrierCost) {
    const cost = now.destination === 'CARRIER' ? pesewasFromCedis(now.carrierCost) : undefined;
    patch.carrier_cost = cost === undefined ? null : { amount_minor: cost, currency: 'GHS' };
  }
  if (now.waybillEvidenceId !== initial.waybillEvidenceId) {
    patch.carrier_waybill_evidence_id = now.waybillEvidenceId;
  }
  if (now.highValue !== initial.highValue) patch.is_high_value = now.highValue;
  if (now.declaredValue !== initial.declaredValue) {
    patch.declared_value_minor =
      now.declaredValue.trim() === '' ? null : (pesewasFromCedis(now.declaredValue) ?? null);
  }
  if (now.serialized !== initial.serialized) patch.is_serialized_goods = now.serialized;
  if (now.serial !== initial.serial || now.serialized !== initial.serialized) {
    patch.serial_imei = now.serialized ? now.serial.trim() : null;
  }
  if (now.requestedDate !== initial.requestedDate)
    patch.requested_delivery_date = now.requestedDate;
  if (
    now.payer !== initial.payer ||
    now.splitBasis !== initial.splitBasis ||
    now.splitAmount !== initial.splitAmount ||
    now.splitPercentage !== initial.splitPercentage
  ) {
    patch.payer_override = payerBodyOf(now) ?? null;
  }
  if (now.zoneId !== null) {
    patch.destination_zone_authorization = { zone_id: now.zoneId, note: now.zoneNote.trim() };
  }
  if (!sameSet(now.evidenceIds, initial.evidenceIds)) patch.evidence_ids = [...now.evidenceIds];
  return patch;
}

/** Whether an amendment would change nothing: the officer is told before anything is sent. */
export const isEmptyPatch = (patch: AmendPreviewBody): boolean => Object.keys(patch).length === 0;

/** The body of the amendment's save: the patch, the reason and the digest of the terms reviewed. */
export function amendSaveBodyOf(
  patch: AmendPreviewBody,
  reason: string,
  token: string,
): AmendSaveBody {
  return { ...patch, note: reason.trim(), reviewed_terms: token };
}

/** What the officer is asked for the proposal of a payer correction: the intent and the numbers that go with it, never a portion of the price. */
export function payerProposalOf(
  values: Pick<OrderFormValues, 'payer' | 'splitBasis' | 'splitAmount' | 'splitPercentage'>,
): PayerChoiceBody | undefined {
  return payerBodyOf({ ...EMPTY_ORDER_FORM, ...values });
}

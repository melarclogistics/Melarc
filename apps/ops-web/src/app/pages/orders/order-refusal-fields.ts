import type { OrderField, OrderFieldErrors } from '../../../platform/hub-orders/order-form-model';
import { ORDERS_WORDS } from '../../../platform/problem/orders-copy';
import type { Problem } from '../../../platform/problem/problem-copy';

const E = ORDERS_WORDS.form.errors;

/** Where a refusal's JSON pointer lands on the form: the field it is about. */
const POINTERS: readonly (readonly [string, OrderField])[] = [
  ['/recipient/name', 'name'],
  ['/recipient/phone', 'phone'],
  ['/recipient/location', 'address'],
  ['/size_class', 'sizeClass'],
  ['/lane', 'destination'],
  ['/commercial_mode', 'destination'],
  ['/carrier_cost', 'carrierCost'],
  ['/carrier_waybill_evidence_id', 'waybill'],
  ['/declared_value_minor', 'declaredValue'],
  ['/evidence_ids', 'evidence'],
  ['/serial_imei', 'serial'],
  ['/is_serialized_goods', 'serial'],
  ['/requested_delivery_date', 'requestedDate'],
  ['/payer_override/split_basis', 'splitBasis'],
  ['/payer_override/split_sender_amount', 'splitAmount'],
  ['/payer_override/split_sender_percentage', 'splitPercentage'],
  ['/payer_override', 'payer'],
  ['/destination_zone_authorization/note', 'zoneNote'],
  ['/destination_zone_authorization', 'zone'],
  ['/note', 'reason'],
];

/** The words of what is wrong with a field, for a place the server named. */
const WORDS: Readonly<Record<OrderField, string>> = {
  name: E.name,
  phone: E.phone,
  address: E.address,
  sizeClass: E.size,
  destination: E.destination,
  carrierCost: E.carrierCost,
  waybill: E.waybill,
  declaredValue: E.declaredValue,
  evidence: E.evidence,
  serial: E.serial,
  requestedDate: ORDERS_WORDS.form.fields.requestedDateHelp,
  payer: E.payer,
  splitBasis: E.splitBasis,
  splitAmount: E.splitAmount,
  splitPercentage: E.splitPercentage,
  zone: E.zone,
  zoneNote: E.zoneNote,
  reason: E.reason,
};

const fieldOf = (pointer: string): OrderField | undefined =>
  POINTERS.find(([prefix]) => pointer === prefix || pointer.startsWith(`${prefix}/`))?.[1];

/**
 * The errors the form draws: what the server refused of what is entered (`fromServer`) and what the form itself found wrong (`invalid`). A field the officer has changed since is kept in `invalid` as `undefined`
 * ("no error of the form's"), and a plain spread would let that hide the server's refusal of the same field: only an error that is there is taken, and the form's own is the one that stands when both name a field.
 */
export function errorsOf(
  fromServer: OrderFieldErrors,
  invalid: OrderFieldErrors,
): OrderFieldErrors {
  const merged: Partial<Record<OrderField, string>> = { ...fromServer };
  for (const field of Object.keys(invalid) as OrderField[]) {
    const text = invalid[field];
    if (text !== undefined) merged[field] = text;
  }
  return merged;
}

/**
 * The fields a refusal is about, in the words of each field, **from the places the API named and from the codes that are about one field**: a refusal the server gives for the size is told on the size, the one for
 * the carrier's charge on the charge. A refusal that is about no field is the page's alert, and the page says so by getting none here.
 */
export function refusedFields(problem: Problem | undefined): OrderFieldErrors {
  if (problem === undefined) return {};
  const found: Partial<Record<OrderField, string>> = {};
  switch (problem.code) {
    case 'SIZE_CLASS_REQUIRED':
      found.sizeClass = problem.message;
      break;
    case 'CARRIER_COST_REQUIRED':
      found.carrierCost = problem.message;
      break;
    case 'VALUE_DECLARATION_REQUIRED':
      found.declaredValue = problem.message;
      break;
    case 'REASON_REQUIRED':
      // A blank reason of an amendment is about the reason; any other missing reason is the high-value parcel's photos.
      if ((problem.violations ?? []).some((violation) => violation.pointer === '/note'))
        found.reason = E.reason;
      else found.evidence = problem.message;
      break;
    case 'EVIDENCE_NOT_STORED':
      found.evidence = problem.message;
      break;
    case 'SERVICE_DATE_NOT_PERMITTED':
      found.requestedDate = problem.message;
      break;
    default:
      break;
  }
  if (problem.code === 'SETTING_MISSING' && problem.rule === 'destination_zone_unresolved') {
    found.address = problem.message;
  }
  for (const violation of problem.violations ?? []) {
    if (violation.rule === 'requested_before_default') {
      found.requestedDate ??= ORDERS_WORDS.form.fields.requestedDateHelp;
      continue;
    }
    if (violation.rule === 'destination_zone_unresolved') {
      found.address ??= E.address;
      continue;
    }
    if (violation.rule === 'destination_zone_ambiguous') {
      found.zone ??= E.zone;
      continue;
    }
    const field = fieldOf(violation.pointer);
    // A number the server will not take is not a number left empty: the word for it is another.
    if (field !== undefined) {
      found[field] ??=
        field === 'phone' && violation.rule !== 'required' ? E.phoneFormat : WORDS[field];
    }
  }
  return found;
}

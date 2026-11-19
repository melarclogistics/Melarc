import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of `itemizeOrder` as the application describes them (S1.36; the contract's `OrderItemize` and `Order`, with the parcel the order is made for, D-D6). The conformance check compares what is
 * written here with the contract's own, so a shape that drifts is a finding.
 *
 * **The body is closed, and carries no price, total, margin, surcharge or zone** (`AC-SLICE-001-47`): `additionalProperties: false` is what answers a body that carries one with `VALIDATION_FAILED`. The one
 * money value it may carry is `carrier_cost`, an observation with the waybill's photograph behind it. `size_class` is not required here so that an omitted one reaches the rule and is refused as
 * `SIZE_CLASS_REQUIRED` (`AC-SLICE-001-58`) and not as a bare schema rejection.
 */
const UUID = { type: 'string', format: 'uuid' } as const;
const NULLABLE_UUID = { type: ['string', 'null'], format: 'uuid' } as const;
const SIZE_CLASS = { type: 'string', enum: ['SMALL', 'MEDIUM', 'LARGE'] } as const;
const MONEY = {
  type: 'object',
  required: ['amount_minor', 'currency'],
  properties: {
    amount_minor: {
      type: 'integer',
      description:
        'Minor units — Ghana pesewas. Never a float, never a decimal string. 2550 is GH₵25.50.\n',
    },
    currency: {
      type: 'string',
      enum: ['GHS'],
      description: 'Only launch currency. Present so multi-currency is a data change.',
    },
  },
} as const;
const LOCATION = {
  type: 'object',
  required: ['address'],
  properties: {
    address: { type: 'string' },
    landmark: { type: 'string' },
    map_link: { type: 'string', format: 'uri' },
    latitude: { type: 'number' },
    longitude: { type: 'number' },
  },
} as const;

export const ORDER_LANES = ['DOORSTEP', 'THIRD_PARTY_HANDOFF'] as const;
export const ORDER_COMMERCIAL_MODES = [
  'STATION_DROP',
  'MELARC_COVERED_THIRD_PARTY_DELIVERY',
] as const;

/** The body of `itemizeOrder`: what the officer judged and transcribed, and nothing that is the server's to derive. */
export const ORDER_ITEMIZE_BODY = described({
  type: 'object',
  required: ['recipient'],
  additionalProperties: false,
  properties: {
    parcel_id: {
      ...UUID,
      description:
        'The parcel the order is made for (D-D6): required for an intake checked in against door photos, never given for an intake counted blind. One order for a parcel.',
    },
    recipient: {
      type: 'object',
      required: ['name', 'phone', 'location'],
      properties: {
        name: { type: 'string' },
        phone: {
          type: 'string',
          description: 'E.164, normalised. As-entered form retained server-side.',
        },
        location: LOCATION,
      },
    },
    size_class: SIZE_CLASS,
    carrier_cost: MONEY,
    is_high_value: { type: 'boolean', default: false },
    lane: { type: 'string', enum: [...ORDER_LANES] },
    commercial_mode: { type: 'string', enum: [...ORDER_COMMERCIAL_MODES] },
    payer_override: {
      type: 'object',
      required: ['payer_intent'],
      additionalProperties: false,
      properties: {
        payer_intent: { type: 'string', enum: ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] },
        split_basis: { type: 'string', enum: ['FIXED_AMOUNT', 'PERCENTAGE'] },
        split_sender_amount: MONEY,
        split_sender_percentage: { type: 'number', minimum: 0, maximum: 100 },
      },
    },
    declared_value_minor: { type: 'integer', minimum: 0 },
    is_serialized_goods: { type: 'boolean', default: false },
    serial_imei: { type: 'string' },
    requested_delivery_date: { type: 'string', format: 'date' },
    service_level: { type: 'string', enum: ['STANDARD'], default: 'STANDARD' },
    destination_zone_authorization: {
      type: 'object',
      required: ['zone_id', 'note'],
      additionalProperties: false,
      properties: { zone_id: UUID, note: { type: 'string', minLength: 1 } },
    },
    evidence_ids: { type: 'array', items: UUID },
    carrier_waybill_evidence_id: UUID,
  },
});

/** The order as `itemizeOrder` answers it. An order that waits for its parcel has no state in the commercial machine, no locked price and no portions yet. */
export const ORDER_SCHEMA = described({
  type: 'object',
  required: ['id', 'code', 'commercial_state', 'fulfilment_state', 'size_class', 'lane'],
  properties: {
    id: UUID,
    code: { type: 'string' },
    pickup_intake_id: UUID,
    responsible_hub_id: UUID,
    intake_parcel_id: NULLABLE_UUID,
    intake_parcel_state: {
      type: ['string', 'null'],
      enum: ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID', null],
    },
    commercial_state: {
      type: ['string', 'null'],
      enum: [
        'PRICED',
        'PAYMENT_REQUIRED',
        'CREDIT_RESERVED',
        'NO_VENDOR_CHARGE',
        'PREPAID',
        'CLOSED',
        'REVERSED',
        null,
      ],
    },
    fulfilment_state: {
      type: 'string',
      enum: [
        'AWAITING_RECIPIENT_CONFIRMATION',
        'READY_FOR_DISPATCH',
        'ASSIGNED',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'ATTEMPT_FAILED',
        'AT_HUB_AFTER_FAILURE',
        'READY_FOR_REATTEMPT',
        'HANDED_TO_CARRIER',
        'RETURN_TO_VENDOR_IN_PROGRESS',
        'RETURNED_TO_VENDOR',
      ],
    },
    origin_zone_snapshot: { type: 'object', additionalProperties: true },
    destination_zone_snapshot: { type: 'object', additionalProperties: true },
    size_class: SIZE_CLASS,
    size_class_selected_by: { type: ['string', 'null'], format: 'uuid' },
    carrier_cost: MONEY,
    derived_delivery_date: { type: ['string', 'null'], format: 'date' },
    is_high_value: { type: 'boolean' },
    lane: { type: 'string' },
    commercial_mode: { type: ['string', 'null'] },
    locked_price: { oneOf: [MONEY, { type: 'null' }] },
    price_components_snapshot: { type: 'object', additionalProperties: true },
    delivery_attempt_count: { type: 'integer', maximum: 3 },
    recipient: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' },
        location: LOCATION,
      },
    },
    declared_value_minor: { type: ['integer', 'null'] },
    is_serialized_goods: { type: 'boolean' },
    serial_imei: { type: ['string', 'null'] },
    requested_delivery_date: { type: ['string', 'null'], format: 'date' },
    service_level: { type: 'string', enum: ['STANDARD'] },
    destination_zone_resolution: {
      type: 'string',
      enum: ['SERVER_RESOLVED', 'EXPLICITLY_AUTHORIZED'],
    },
    delivery_date_override: { type: ['object', 'null'] },
    payer_allocation: {
      type: 'object',
      required: ['sender_minor', 'recipient_minor'],
      properties: {
        sender_minor: { type: 'integer', minimum: 0 },
        recipient_minor: { type: 'integer', minimum: 0 },
      },
    },
  },
});

/** The vendor-facing intake-completed and order summary (`IntakeSummary`, S1.38): the orders of the parcels that arrived and what a vendor may know of each, and nothing else. */
export const INTAKE_SUMMARY_SCHEMA = described({
  type: 'object',
  required: ['intake_id', 'pickup_request_id', 'closed_at', 'orders'],
  additionalProperties: false,
  properties: {
    intake_id: UUID,
    pickup_request_id: UUID,
    closed_at: { type: 'string', format: 'date-time' },
    orders: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'code', 'recipient_name', 'service_area', 'commercial_state'],
        additionalProperties: false,
        properties: {
          id: UUID,
          code: { type: 'string' },
          recipient_name: { type: 'string' },
          service_area: { type: 'string' },
          size_class: SIZE_CLASS,
          locked_price: MONEY,
          commercial_state: { type: 'string' },
        },
      },
    },
  },
});

const PAYER_PROPOSAL = {
  type: 'object',
  required: ['payer_intent'],
  additionalProperties: false,
  properties: {
    payer_intent: { type: 'string', enum: ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] },
    split_basis: { type: 'string', enum: ['FIXED_AMOUNT', 'PERCENTAGE'] },
    split_sender_amount: MONEY,
    split_sender_percentage: { type: 'number', minimum: 0, maximum: 100 },
  },
} as const;

/** The body of `requestPayerCorrection` (S1.39): the intent proposed and a reason in words (a blank one is `REASON_REQUIRED`, told by the service before the shape). */
export const PAYER_CORRECTION_REQUEST_BODY = described({
  type: 'object',
  required: ['proposed', 'note'],
  additionalProperties: false,
  properties: {
    proposed: PAYER_PROPOSAL,
    note: { type: 'string', minLength: 1 },
  },
});

/** The body of `approvePayerCorrection` (S1.39). */
export const PAYER_CORRECTION_DECISION_BODY = described({
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT'] },
    note: { type: 'string' },
  },
});

const PAYER_ALLOCATION = {
  type: 'object',
  required: ['sender_minor', 'recipient_minor'],
  properties: {
    sender_minor: { type: 'integer', minimum: 0 },
    recipient_minor: { type: 'integer', minimum: 0 },
  },
} as const;

/** The maker-checker record of a payer correction (`PayerCorrection`). */
export const PAYER_CORRECTION_SCHEMA = described({
  type: 'object',
  required: ['id', 'order_id', 'state', 'requested_by', 'previous_allocation', 'proposed'],
  properties: {
    id: UUID,
    order_id: UUID,
    state: { type: 'string', enum: ['REQUESTED', 'APPROVED', 'REJECTED'] },
    requested_by: UUID,
    approved_by: NULLABLE_UUID,
    previous_allocation: PAYER_ALLOCATION,
    proposed: PAYER_PROPOSAL,
    resulting_commercial_state: { type: ['string', 'null'] },
    note: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    decided_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

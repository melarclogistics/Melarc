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

const RECIPIENT = {
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
} as const;
const PAYER_OVERRIDE = {
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
const ZONE_AUTHORIZATION = {
  type: 'object',
  required: ['zone_id', 'note'],
  additionalProperties: false,
  properties: { zone_id: UUID, note: { type: 'string', minLength: 1 } },
} as const;
const orNull = <T extends object>(schema: T) => ({ oneOf: [schema, { type: 'null' }] }) as const;

/**
 * The token of a preview's terms (`OrderPreview.terms_token`): the digest of what the officer was shown, given back to the save as `reviewed_terms`. **The save requires it** (`VALIDATION_FAILED`, rule `required`)
 * and the preview has no such member (it is the preview's answer that carries the token); a token that is not the terms as they are now is `STATE_CONFLICT`, rule `terms_changed`.
 */
const REVIEWED_TERMS = {
  type: 'string',
  pattern: '^[0-9a-f]{64}$',
  description: 'The `terms_token` of the preview the officer read.',
} as const;

/** What the officer judged and transcribed of an order, and nothing that is the server's to derive: the members of `itemizeOrder` and of `previewOrder`. */
const ITEMIZE_PROPERTIES = {
  parcel_id: {
    ...UUID,
    description:
      'The parcel the order is made for (D-D6): required for an intake checked in against door photos, never given for an intake counted blind. One order for a parcel.',
  },
  recipient: RECIPIENT,
  size_class: SIZE_CLASS,
  carrier_cost: MONEY,
  is_high_value: { type: 'boolean', default: false },
  lane: { type: 'string', enum: [...ORDER_LANES] },
  commercial_mode: { type: 'string', enum: [...ORDER_COMMERCIAL_MODES] },
  payer_override: PAYER_OVERRIDE,
  declared_value_minor: { type: 'integer', minimum: 0 },
  is_serialized_goods: { type: 'boolean', default: false },
  serial_imei: { type: 'string' },
  requested_delivery_date: { type: 'string', format: 'date' },
  service_level: { type: 'string', enum: ['STANDARD'], default: 'STANDARD' },
  destination_zone_authorization: ZONE_AUTHORIZATION,
  evidence_ids: { type: 'array', items: UUID },
  carrier_waybill_evidence_id: UUID,
} as const;

/** The body of `previewOrder` (the review of 21 November 2026, finding 4): the order as the officer would make it, with no token, which is the answer's. */
export const ORDER_ITEMIZE_PREVIEW_BODY = described({
  type: 'object',
  required: ['recipient'],
  additionalProperties: false,
  properties: ITEMIZE_PROPERTIES,
});

/** The body of `itemizeOrder`: the same, with the `terms_token` of the preview the officer read, which the save requires. */
export const ORDER_ITEMIZE_BODY = described({
  type: 'object',
  required: ['recipient', 'reviewed_terms'],
  additionalProperties: false,
  properties: { reviewed_terms: REVIEWED_TERMS, ...ITEMIZE_PROPERTIES },
});

/**
 * The body of `amendOrder` (Stage 7; the review of 19 November 2026, findings B and C): a patch of what was transcribed, and the reason in words. A member that is not named is kept; `null` clears one that may be
 * empty. The price, the zone and the dates are the server's and are recalculated from the corrected facts: they are in no part of the body.
 */
const AMEND_PROPERTIES = {
  recipient: RECIPIENT,
  size_class: SIZE_CLASS,
  carrier_cost: orNull(MONEY),
  carrier_waybill_evidence_id: { type: ['string', 'null'], format: 'uuid' },
  is_high_value: { type: 'boolean' },
  lane: { type: 'string', enum: [...ORDER_LANES] },
  commercial_mode: { type: ['string', 'null'], enum: [...ORDER_COMMERCIAL_MODES, null] },
  payer_override: orNull(PAYER_OVERRIDE),
  declared_value_minor: { type: ['integer', 'null'], minimum: 0 },
  is_serialized_goods: { type: 'boolean' },
  serial_imei: { type: ['string', 'null'] },
  requested_delivery_date: { type: ['string', 'null'], format: 'date' },
  destination_zone_authorization: orNull(ZONE_AUTHORIZATION),
  evidence_ids: { type: 'array', items: UUID },
} as const;

/** The body of `previewOrderAmendment` (the review of 21 November 2026, finding 4): what an amendment changes, with neither the reason nor the token, which are the save's. */
export const ORDER_AMEND_PREVIEW_BODY = described({
  type: 'object',
  additionalProperties: false,
  properties: AMEND_PROPERTIES,
});

/** The body of `amendOrder`: the same, with the reason in words and the `terms_token` of the preview the officer read, which the save requires. */
export const ORDER_AMEND_BODY = described({
  type: 'object',
  required: ['note', 'reviewed_terms'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', minLength: 1 },
    reviewed_terms: REVIEWED_TERMS,
    ...AMEND_PROPERTIES,
  },
});

/** The body of `reverseOrderArrival` (Stage 7): the reason in words, which a blank one is `REASON_REQUIRED`, told by the service before the shape. */
export const ORDER_REVERSAL_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: { note: { type: 'string', minLength: 1 } },
});

/** What a reversal did (`OrderArrivalReversal`). */
export const ORDER_REVERSAL_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'order_id',
    'intake_id',
    'parcel_id',
    'previous_commercial_state',
    'commercial_state',
    'parcel_state',
    'previous_intake_state',
    'intake_state',
    'received_before',
    'received_after',
    'note',
    'reversed_at',
  ],
  properties: {
    id: UUID,
    order_id: UUID,
    intake_id: UUID,
    parcel_id: UUID,
    previous_commercial_state: { type: 'string' },
    commercial_state: { type: 'string', enum: ['REVERSED'] },
    parcel_state: { type: 'string', enum: ['MISSING', 'VOID'] },
    previous_intake_state: { type: 'string' },
    intake_state: { type: 'string' },
    received_before: { type: 'integer', minimum: 0 },
    received_after: { type: 'integer', minimum: 0 },
    note: { type: 'string' },
    reversed_at: { type: 'string', format: 'date-time' },
  },
});

/** The evidence an order cites, by identity (`OrderPreview.cited_evidence`). */
const CITED_EVIDENCE = {
  type: 'object',
  required: ['high_value', 'carrier_waybill'],
  properties: {
    high_value: { type: 'array', items: UUID },
    carrier_waybill: NULLABLE_UUID,
  },
} as const;

/** What confirming an order would give, calculated by the server and written nowhere (`OrderPreview`). */
export const ORDER_PREVIEW_SCHEMA = described({
  type: 'object',
  required: [
    'intake_id',
    'parcel_id',
    'order_id',
    'order_version',
    'status',
    'validation',
    'cited_evidence',
    'will_confirm',
    'quote_policy',
    'price',
    'is_high_value',
    'high_value_surcharge',
    'destination_zone_snapshot',
    'destination_zone_resolution',
    'delivery',
    'payer',
    'current',
    'terms_token',
  ],
  properties: {
    intake_id: UUID,
    parcel_id: NULLABLE_UUID,
    order_id: NULLABLE_UUID,
    order_version: { type: ['integer', 'null'], minimum: 0 },
    status: { type: 'string', enum: ['CURRENT_PREVIEW'] },
    validation: {
      type: 'object',
      required: ['evidence'],
      properties: { evidence: { type: 'string', enum: ['NONE_CITED', 'VERIFIED'] } },
    },
    cited_evidence: CITED_EVIDENCE,
    will_confirm: { type: 'string', enum: ['ON_CONFIRMATION', 'WHEN_ARRIVAL_IS_COMMITTED'] },
    quote_policy: { type: 'string', enum: ['PROTECTED_UNTIL_AMENDED'] },
    price: {
      type: 'object',
      required: ['total', 'components'],
      properties: {
        total: MONEY,
        components: {
          type: 'array',
          items: {
            type: 'object',
            required: ['kind', 'amount'],
            properties: { kind: { type: 'string' }, amount: MONEY },
          },
        },
      },
    },
    is_high_value: { type: 'boolean' },
    high_value_surcharge: orNull(MONEY),
    destination_zone_snapshot: { type: 'object', additionalProperties: true },
    destination_zone_resolution: {
      type: 'string',
      enum: ['SERVER_RESOLVED', 'EXPLICITLY_AUTHORIZED'],
    },
    delivery: {
      type: 'object',
      required: ['default_date', 'requested_date', 'committed_date', 'window_start', 'window_end'],
      properties: {
        default_date: { type: 'string', format: 'date' },
        requested_date: { type: ['string', 'null'], format: 'date' },
        committed_date: { type: 'string', format: 'date' },
        window_start: { type: ['string', 'null'] },
        window_end: { type: ['string', 'null'] },
      },
    },
    payer: {
      type: 'object',
      required: [
        'source',
        'payer_intent',
        'sender',
        'recipient',
        'commercial_state_after_confirmation',
      ],
      properties: {
        source: { type: 'string', enum: ['ORDER', 'REQUEST'] },
        payer_intent: { type: 'string' },
        sender: MONEY,
        recipient: MONEY,
        commercial_state_after_confirmation: {
          type: 'string',
          enum: ['NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED'],
        },
      },
    },
    current: orNull({
      type: 'object',
      required: [
        'total',
        'is_high_value',
        'derived_delivery_date',
        'destination_zone_resolution',
        'cited_evidence',
      ],
      properties: {
        total: MONEY,
        is_high_value: { type: 'boolean' },
        derived_delivery_date: { type: ['string', 'null'], format: 'date' },
        destination_zone_resolution: { type: 'string' },
        cited_evidence: CITED_EVIDENCE,
      },
    }),
    terms_token: { type: 'string', pattern: '^[0-9a-f]{64}$' },
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
    is_high_value_manual: { type: ['boolean', 'null'] },
    price_status: { type: 'string', enum: ['EARLY_QUOTE', 'FROZEN'] },
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
    payer_override: orNull(PAYER_OVERRIDE),
    high_value_evidence_ids: { type: 'array', items: UUID },
    carrier_waybill_evidence_id: NULLABLE_UUID,
    amendments: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'amended_by', 'amended_at', 'note', 'changed'],
        properties: {
          id: UUID,
          amended_by: UUID,
          amended_at: { type: 'string', format: 'date-time' },
          note: { type: 'string' },
          changed: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    reversal: {
      oneOf: [
        {
          type: 'object',
          required: ['id', 'reversed_by', 'reversed_at', 'note'],
          properties: {
            id: UUID,
            reversed_by: UUID,
            reversed_at: { type: 'string', format: 'date-time' },
            note: { type: 'string' },
          },
        },
        { type: 'null' },
      ],
    },
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

/** The maker-checker record of a payer correction (`PayerCorrection`), with what a checker needs to decide it (the order's code and unchanged total, the proposal in actual amounts) and the history it leaves. */
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
    resulting_allocation: { oneOf: [PAYER_ALLOCATION, { type: 'null' }] },
    resulting_commercial_state: { type: ['string', 'null'] },
    note: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    decided_at: { type: ['string', 'null'], format: 'date-time' },
    order_code: { type: 'string' },
    total: MONEY,
    proposed_allocation: PAYER_ALLOCATION,
    proposed_commercial_state: { type: 'string', enum: ['NO_VENDOR_CHARGE', 'PAYMENT_REQUIRED'] },
    order_commercial_state: { type: ['string', 'null'] },
    requested_by_name: { type: ['string', 'null'] },
    approved_by_name: { type: ['string', 'null'] },
  },
});

/** A page of corrections (`listPayerCorrections`). */
export const PAYER_CORRECTION_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: PAYER_CORRECTION_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

const WORK_STATES = ['NEEDS_ORDER', 'AWAITING_ARRIVAL', 'PREPARED', 'ITEMIZED', 'MISSING'] as const;
const COUNT = { type: 'integer', minimum: 0 } as const;
const COUNT_OR_NULL = { type: ['integer', 'null'], minimum: 0 } as const;

/** The counts of the whole intake (`IntakeProgress`), never of a page. */
const INTAKE_PROGRESS = {
  type: 'object',
  required: [
    'received',
    'awaiting_arrival',
    'needs_order',
    'prepared',
    'itemized',
    'payment_required',
    'missing',
    'orders',
  ],
  properties: {
    // Null for an intake counted blind whose count is not committed: nothing is known to have been received, which is not zero.
    received: COUNT_OR_NULL,
    awaiting_arrival: COUNT,
    needs_order: COUNT_OR_NULL,
    prepared: COUNT,
    itemized: COUNT,
    payment_required: COUNT,
    missing: COUNT,
    orders: COUNT,
  },
} as const;

/** The parcel worklist of an intake (`IntakeOrderList`): the counts of the whole intake, and a page of parcels with the order made for each. No price, no portion and no phone. */
export const INTAKE_ORDER_LIST_SCHEMA = described({
  type: 'object',
  required: ['intake_id', 'intake_state', 'receiving_mode', 'progress', 'items', 'next_page_token'],
  properties: {
    intake_id: UUID,
    intake_state: { type: 'string' },
    receiving_mode: { type: 'string', enum: ['PHOTO_CHECK_IN', 'BLIND_COUNT'] },
    progress: INTAKE_PROGRESS,
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: ['work_state', 'parcel', 'order', 'reversed_order'],
        properties: {
          work_state: { type: 'string', enum: [...WORK_STATES] },
          reversed_order: {
            oneOf: [
              {
                type: 'object',
                required: ['id', 'code'],
                properties: { id: UUID, code: { type: 'string' } },
              },
              { type: 'null' },
            ],
          },
          parcel: {
            oneOf: [
              {
                type: 'object',
                required: ['id', 'ordinal', 'origin', 'state'],
                properties: {
                  id: UUID,
                  ordinal: { type: 'integer', minimum: 1 },
                  origin: { type: 'string', enum: ['DOOR_PHOTO', 'HUB_EXTRA'] },
                  state: { type: 'string', enum: ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID'] },
                  door_photo_evidence_id: NULLABLE_UUID,
                  hub_photo_evidence_id: NULLABLE_UUID,
                },
              },
              { type: 'null' },
            ],
          },
          order: {
            oneOf: [
              {
                type: 'object',
                required: ['id', 'code', 'size_class', 'confirmed', 'payment_required'],
                properties: {
                  id: UUID,
                  code: { type: 'string' },
                  recipient_name: { type: ['string', 'null'] },
                  service_area: { type: ['string', 'null'] },
                  size_class: SIZE_CLASS,
                  commercial_state: { type: ['string', 'null'] },
                  confirmed: { type: 'boolean' },
                  payment_required: { type: 'boolean' },
                },
              },
              { type: 'null' },
            ],
          },
        },
      },
    },
    next_page_token: { type: ['string', 'null'] },
  },
});

/** The page of the intakes closed with the approved exception that still have received parcels without an order (`ClosedIntakeExceptionPage`). */
export const CLOSED_EXCEPTION_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        required: [
          'intake_id',
          'intake_code',
          'pickup_request_id',
          'responsible_hub_id',
          'receiving_mode',
          'closed_at',
          'closed_by',
          'exception_note',
          'received',
          'ordered',
          'outstanding_count',
        ],
        properties: {
          intake_id: UUID,
          intake_code: { type: 'string' },
          pickup_request_id: UUID,
          responsible_hub_id: UUID,
          receiving_mode: { type: 'string', enum: ['PHOTO_CHECK_IN', 'BLIND_COUNT'] },
          closed_at: { type: 'string', format: 'date-time' },
          closed_by: UUID,
          exception_note: { type: ['string', 'null'] },
          received: COUNT,
          ordered: COUNT,
          outstanding_count: { type: 'integer', minimum: 1 },
        },
      },
    },
    next_page_token: { type: ['string', 'null'] },
  },
});

/** What a close would find (`IntakeClosureAssessment`), read before the act that cannot be taken back. */
export const CLOSURE_ASSESSMENT_SCHEMA = described({
  type: 'object',
  required: [
    'intake_id',
    'intake_state',
    'receiving_mode',
    'received',
    'ordered',
    'unpriced',
    'payment_required',
    'missing',
    'outstanding_count',
    'excess_count',
    'outstanding_parcels',
    'assessment_token',
    'can_close',
    'needs_exception',
    'blockers',
    'payment_still_required',
  ],
  properties: {
    intake_id: UUID,
    intake_state: { type: 'string' },
    receiving_mode: { type: 'string', enum: ['PHOTO_CHECK_IN', 'BLIND_COUNT'] },
    // Null for an intake counted blind whose count is not committed: nothing is known to have been received, which is not zero.
    received: COUNT_OR_NULL,
    ordered: COUNT,
    unpriced: COUNT,
    payment_required: COUNT,
    missing: COUNT,
    outstanding_count: COUNT_OR_NULL,
    excess_count: COUNT,
    assessment_token: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      description:
        'The digest of what this assessment found, with the identity of every outstanding parcel (not only of the first hundred): the approved exception is closed against it.',
    },
    outstanding_parcels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['parcel_id', 'ordinal', 'origin'],
        properties: {
          parcel_id: UUID,
          ordinal: { type: 'integer', minimum: 1 },
          origin: { type: 'string', enum: ['DOOR_PHOTO', 'HUB_EXTRA'] },
          door_photo_evidence_id: NULLABLE_UUID,
          hub_photo_evidence_id: NULLABLE_UUID,
        },
      },
    },
    closed_at: { type: ['string', 'null'], format: 'date-time' },
    parity_exception_note: { type: ['string', 'null'] },
    can_close: { type: 'boolean' },
    needs_exception: { type: 'boolean' },
    blockers: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['intake_not_ready', 'orders_exceed_received', 'order_unpriced'],
      },
    },
    payment_still_required: { type: 'boolean' },
  },
});

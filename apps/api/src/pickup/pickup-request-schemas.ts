import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the pickup request as the application describes them (S1.13; `PickupRequest` and the list's envelope of the contract);
 * the conformance check compares them with the contract. `PICKUP_REQUEST_SCHEMA` is the contract's schema with its references
 * followed, so a field added to the contract and not here is a finding of the check, and a response that does not fit it is a failure
 * of the route tests, which validate every answer against the contract itself.
 *
 * **What the representation never carries:** a price. `indicative_estimate` is the inputs of the booking estimate and is labelled
 * provisional; `cancellation_charge` is the amount that was applied to a cancellation, snapshotted; no field here is a quote, a total or
 * an authoritative fee (`MSC-DEC-211`).
 */

/**
 * The members of a one-package exception that **every** reader is given: its state, when it was asked for and decided, the recipient and the
 * fee that became due (the contract's `OnePackageExceptionOutcome`). The contract states them in both of its views of an exception, because a
 * closed schema cannot be composed with another; this file states them once and builds both views from them.
 */
const EXCEPTION_OUTCOME_PROPERTIES = {
  id: { type: 'string', format: 'uuid' },
  state: { type: 'string', enum: ['REQUESTED', 'APPROVED', 'REJECTED'] },
  requested_at: { type: 'string', format: 'date-time' },
  decided_at: { type: ['string', 'null'], format: 'date-time' },
  recipient: {
    type: 'object',
    required: ['name', 'phone', 'location'],
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      location: {
        type: 'object',
        required: ['address'],
        properties: {
          address: { type: 'string' },
          landmark: { type: 'string' },
          map_link: { type: 'string', format: 'uri' },
          latitude: { type: 'number' },
          longitude: { type: 'number' },
        },
      },
    },
  },
  single_package_fee: {
    oneOf: [
      {
        type: 'object',
        required: ['amount_minor', 'currency'],
        properties: {
          amount_minor: { type: 'integer' },
          currency: { type: 'string', enum: ['GHS'] },
        },
      },
      { type: 'null' },
    ],
  },
};

/** The three members that are **staff's alone**: who asked, who decided it (null until someone has) and why. */
const EXCEPTION_STAFF_PROPERTIES = {
  requested_by: { type: 'string', format: 'uuid' },
  approved_by: { type: ['string', 'null'], format: 'uuid' },
  note: { type: 'string' },
};

export const PICKUP_REQUEST_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'code',
    'state',
    'responsible_hub_id',
    'scheduled_service_date',
    'attempt_number',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: {
      type: 'string',
      pattern: '^[A-Z]{3}-(PR|MF|IN|OR|DR)-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$',
    },
    state: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED'] },
    responsible_hub_id: { type: 'string', format: 'uuid' },
    pickup_intent: { type: 'string', enum: ['OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER'] },
    vendor_organization_id: { type: ['string', 'null'], format: 'uuid' },
    ad_hoc_sender_id: { type: ['string', 'null'], format: 'uuid' },
    collection_point: {
      type: 'object',
      required: ['contact_name', 'phone', 'location'],
      additionalProperties: false,
      properties: {
        contact_name: { type: 'string' },
        phone: { type: 'string' },
        location: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
        },
        landmark: { type: ['string', 'null'] },
      },
    },
    collection_reference: {
      type: 'object',
      required: ['reference_name'],
      additionalProperties: false,
      properties: {
        reference_name: { type: 'string' },
        seller_order_reference: { type: ['string', 'null'] },
      },
    },
    collection_item: {
      type: 'object',
      required: ['description', 'quantity'],
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        evidence_id: { type: ['string', 'null'], format: 'uuid' },
        handling_note: { type: ['string', 'null'] },
      },
    },
    destination_location_id: { type: ['string', 'null'], format: 'uuid' },
    pickup_location: {
      oneOf: [
        {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
        },
        { type: 'null' },
      ],
    },
    resolved_pickup_location: {
      allOf: [
        {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
        },
      ],
      readOnly: true,
    },
    current_item_description: { type: ['string', 'null'] },
    scheduled_service_date: { type: 'string', format: 'date' },
    declared_package_count: { type: 'integer' },
    default_payer_intent: { type: 'string' },
    one_package_exception_id: { type: ['string', 'null'], format: 'uuid' },
    attempt_number: { type: 'integer' },
    replaces_request_id: { type: ['string', 'null'], format: 'uuid' },
    cancelled_by_actor_type: { type: ['string', 'null'], enum: ['VENDOR', 'OPS', null] },
    declared_value_minor: { type: ['integer', 'null'] },
    liability_cap_acknowledged_at: { type: ['string', 'null'], format: 'date-time' },
    liability_cap_snapshot: {
      type: ['object', 'null'],
      properties: {
        amount_minor: { type: 'integer' },
        setting_key: { type: 'string' },
        effective_version: { type: 'string' },
      },
    },
    cancellation_charge_outcome: {
      type: ['string', 'null'],
      enum: ['APPLIED', 'WAIVED', 'NOT_APPLIED', 'UNAVAILABLE', 'EXEMPT', null],
    },
    cancellation_charge: {
      oneOf: [
        {
          type: 'object',
          required: ['amount_minor', 'currency'],
          properties: {
            amount_minor: { type: 'integer' },
            currency: { type: 'string', enum: ['GHS'] },
          },
        },
        { type: 'null' },
      ],
    },
    created_at: { type: 'string', format: 'date-time' },
    confirmed_at: { type: ['string', 'null'], format: 'date-time' },
    cutoff_exception_state: {
      type: ['string', 'null'],
      enum: ['PENDING_OPS_REVIEW', 'SAME_DAY_APPROVED', 'RESCHEDULED', null],
    },
    vendor_pickup_location_id: { type: ['string', 'null'], format: 'uuid' },
    primary_phone: { type: ['string', 'null'] },
    secondary_phone: { type: ['string', 'null'] },
    replacement_request_id: { type: ['string', 'null'], format: 'uuid' },
    indicative_estimate: {
      oneOf: [
        {
          type: 'object',
          required: ['status', 'provisional'],
          additionalProperties: false,
          properties: {
            status: {
              type: 'string',
              enum: [
                'AVAILABLE',
                'UNAVAILABLE_OUTSIDE_SERVICE_AREA',
                'UNAVAILABLE_SETTING_MISSING',
              ],
            },
            provisional: { type: 'boolean', const: true },
            total: {
              oneOf: [
                {
                  type: 'object',
                  required: ['amount_minor', 'currency'],
                  properties: {
                    amount_minor: { type: 'integer' },
                    currency: { type: 'string', enum: ['GHS'] },
                  },
                },
                { type: 'null' },
              ],
            },
            assumes_size_class: { type: 'string', enum: ['SMALL'] },
            excludes: {
              type: 'array',
              items: { type: 'string', enum: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'] },
            },
            components: {
              type: 'array',
              items: {
                type: 'object',
                required: [
                  'kind',
                  'hub_id',
                  'setting_key',
                  'effective_version',
                  'quantity',
                  'amount',
                ],
                additionalProperties: false,
                properties: {
                  kind: {
                    type: 'string',
                    enum: [
                      'SERVICE_AREA_BASE_FEE',
                      'CORRIDOR_OFF_DAY_FEE',
                      'SINGLE_PACKAGE_PICKUP_FEE',
                    ],
                  },
                  hub_id: { type: 'string', format: 'uuid' },
                  setting_key: { type: 'string' },
                  effective_version: { type: 'string' },
                  quantity: { type: 'integer' },
                  amount: {
                    type: 'object',
                    required: ['amount_minor', 'currency'],
                    properties: {
                      amount_minor: { type: 'integer' },
                      currency: { type: 'string', enum: ['GHS'] },
                    },
                  },
                },
              },
            },
          },
        },
        { type: 'null' },
      ],
      readOnly: true,
    },
    cancellation_charge_snapshot: {
      type: ['object', 'null'],
      properties: {
        amount_minor: { type: 'integer' },
        setting_key: { type: 'string' },
        effective_version: { type: 'string' },
      },
    },
    sender_name: { type: ['string', 'null'], readOnly: true },
    split_basis: { type: ['string', 'null'], enum: ['FIXED_AMOUNT', 'PERCENTAGE', null] },
    split_sender_amount: {
      oneOf: [
        {
          type: 'object',
          required: ['amount_minor', 'currency'],
          properties: {
            amount_minor: { type: 'integer' },
            currency: { type: 'string', enum: ['GHS'] },
          },
        },
        { type: 'null' },
      ],
    },
    split_sender_percentage: { type: ['number', 'null'], minimum: 0, maximum: 100 },
    location_overrides: {
      oneOf: [
        {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
        },
        { type: 'null' },
      ],
    },
    attempt_extension_id: { type: ['string', 'null'], format: 'uuid' },
    cancelled_at: { type: ['string', 'null'], format: 'date-time' },
    escalated_at: { type: ['string', 'null'], format: 'date-time', readOnly: true },
    cancellation_reason: {
      type: ['object', 'null'],
      readOnly: true,
      properties: { code: { type: 'string' }, label: { type: 'string' } },
    },
    rider_assigned: { type: 'boolean', readOnly: true },
    one_package_exception: {
      oneOf: [
        // What staff read: the exception in whole. Who asked, who decided it (null until someone has) and why are always present.
        {
          type: 'object',
          required: [
            'id',
            'state',
            'requested_by',
            'requested_at',
            'approved_by',
            'note',
            'recipient',
          ],
          properties: { ...EXCEPTION_OUTCOME_PROPERTIES, ...EXCEPTION_STAFF_PROPERTIES },
        },
        // What every other principal reads, a Vendor among them (the Product Owner, 29 October 2026): the outcome only, and closed, so that
        // nothing of staff's can be added to it.
        {
          type: 'object',
          required: ['id', 'state', 'requested_at', 'recipient'],
          additionalProperties: false,
          properties: EXCEPTION_OUTCOME_PROPERTIES,
        },
        { type: 'null' },
      ],
      readOnly: true,
    },
  },
});

export const PICKUP_REQUEST_CREATE_BODY = described({
  type: 'object',
  required: [
    'pickup_intent',
    'scheduled_service_date',
    'declared_package_count',
    'default_payer_intent',
  ],
  allOf: [
    {
      if: { properties: { pickup_intent: { const: 'OWN_PACKAGES' } }, required: ['pickup_intent'] },
      then: {
        required: ['vendor_organization_id'],
        properties: { collection_point: { not: {} }, collection_item: { not: {} } },
      },
    },
    {
      if: {
        properties: { pickup_intent: { const: 'COLLECT_FOR_VENDOR' } },
        required: ['pickup_intent'],
      },
      then: {
        required: [
          'vendor_organization_id',
          'collection_point',
          'collection_reference',
          'collection_item',
        ],
        anyOf: [
          { required: ['destination_location_id'] },
          { required: ['use_vendor_default_destination'] },
        ],
      },
    },
    {
      if: {
        properties: { pickup_intent: { const: 'COLLECT_FOR_VENDOR' } },
        required: ['pickup_intent'],
      },
      then: {
        properties: {
          use_vendor_default_destination: {
            type: 'boolean',
            description:
              "Resolve the destination to the Vendor's default saved location. The server refuses the request if that Vendor has none, rather than accepting a collection with no destination.",
          },
        },
      },
    },
    {
      if: { properties: { pickup_intent: { const: 'ADHOC_SENDER' } }, required: ['pickup_intent'] },
      then: {
        properties: { collection_point: { not: {} } },
        oneOf: [
          { required: ['ad_hoc_sender_id'], properties: { new_ad_hoc_sender: { not: {} } } },
          { required: ['new_ad_hoc_sender'], properties: { ad_hoc_sender_id: { not: {} } } },
        ],
      },
    },
    {
      if: { properties: { pickup_intent: { const: 'ADHOC_SENDER' } }, required: ['pickup_intent'] },
      then: { required: ['current_item_description'] },
    },
  ],
  properties: {
    pickup_intent: {
      type: 'string',
      enum: ['OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER'],
      description:
        'MSC-DEC-335. OWN_PACKAGES reuses an established Vendor and asks only what\nchanges today. COLLECT_FOR_VENDOR collects from a THIRD PARTY for a\nregistered Vendor - it is not merchandise COD, and no rider is authorised to\npay the seller. ADHOC_SENDER creates or REUSES the canonical AdHocSender\nand never auto-promotes it to a registered Vendor.\n',
    },
    hub_id: {
      type: 'string',
      format: 'uuid',
      description:
        "The hub a walk-in booking (`ADHOC_SENDER`) is made in. Optional while the session's grant of `pickup.request.create` reaches exactly one hub (the booking is then in that hub), and **required when it reaches more than one**: a grant of all hubs, or of several hubs of its own. A hub the grant does not reach is `HUB_SCOPE_VIOLATION`, judged before the hub is read: an id that names no hub is `HUB_SCOPE_VIOLATION` for a grant of fewer than all hubs, and `VALIDATION_FAILED` for a grant of all hubs. For a registered vendor's booking (`OWN_PACKAGES`, `COLLECT_FOR_VENDOR`) the hub is the vendor organisation's: naming another hub is `VALIDATION_FAILED`, and a vendor session names none that is not its organisation's.",
    },
    vendor_organization_id: { type: 'string', format: 'uuid' },
    ad_hoc_sender_id: {
      type: 'string',
      format: 'uuid',
      description:
        'An EXISTING AdHocSender, found by verified phone on a return visit. Supply this OR new_ad_hoc_sender, never both and never neither.',
    },
    new_ad_hoc_sender: {
      type: 'object',
      description:
        'First-use identity for a sender who has never used Melarc. Creating the reusable AdHocSender profile and the PickupRequest is one idempotent act - a retry must not mint a second sender identity.',
      required: ['name', 'phone'],
      additionalProperties: false,
      properties: {
        name: { type: 'string' },
        phone: {
          type: 'string',
          description:
            "E.164, normalised; as-entered form retained server-side - the same shape every other phone field in this contract declares. It carried a $ref to a `Phone` schema that HAS NEVER EXISTED here, so a generated client broke on it (Gate C C1.6, Check 45). The verified phone identity. 29.6, MSC-DEC-172 makes this the sender's identity and MSC-DEC-258 attaches blocking to it, so it is also how a returning sender is found.",
        },
        business_name: { type: ['string', 'null'] },
        pickup_contact_name: { type: ['string', 'null'] },
        pickup_location: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          description:
            'Coordinates are optional and must never be required for validity — the operation runs on\nlandmarks and phone calls. Service zone is **resolved from** a location, never stored on\nit, because zones are hub-owned and versioned.\n',
        },
      },
    },
    collection_point: {
      type: 'object',
      description:
        'The third party a COLLECT_FOR_VENDOR pickup collects from. Required for that intent and forbidden for the others.',
      required: ['contact_name', 'phone', 'location'],
      additionalProperties: false,
      properties: {
        contact_name: { type: 'string', description: 'Pickup person or business' },
        phone: {
          type: 'string',
          description:
            'E.164, normalised. Second of the two dangling `Phone` references corrected at Gate C C1.6.',
        },
        location: {
          type: 'object',
          required: ['address'],
          properties: {
            address: { type: 'string' },
            landmark: { type: 'string' },
            map_link: { type: 'string', format: 'uri' },
            latitude: { type: 'number' },
            longitude: { type: 'number' },
          },
          description:
            'Coordinates are optional and must never be required for validity — the operation runs on\nlandmarks and phone calls. Service zone is **resolved from** a location, never stored on\nit, because zones are hub-owned and versioned.\n',
        },
        landmark: { type: ['string', 'null'], description: 'Where coordinates are unavailable' },
      },
    },
    collection_reference: {
      type: 'object',
      required: ['reference_name'],
      additionalProperties: false,
      properties: {
        reference_name: { type: 'string', description: 'The name the seller holds the item under' },
        seller_order_reference: { type: ['string', 'null'] },
      },
    },
    collection_item: {
      type: 'object',
      required: ['description', 'quantity'],
      additionalProperties: false,
      properties: {
        description: { type: 'string' },
        quantity: { type: 'integer', minimum: 1 },
        evidence_id: {
          type: ['string', 'null'],
          format: 'uuid',
          description: 'Picture of the item, where the sender supplied one.',
        },
        handling_note: { type: ['string', 'null'] },
      },
    },
    destination_location_id: {
      type: ['string', 'null'],
      format: 'uuid',
      description:
        'COLLECT_FOR_VENDOR destination - a Vendor saved location or an approved alternative.',
    },
    use_vendor_default_destination: {
      type: 'boolean',
      description:
        "COLLECT_FOR_VENDOR only: resolve the destination to the Vendor's default saved location. The server refuses the request (DESTINATION_UNRESOLVED) if that Vendor has none, rather than accepting a collection with no destination. Present on any other intent it is mis-declared and refused.",
    },
    pickup_location: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
        landmark: { type: 'string' },
        map_link: { type: 'string', format: 'uri' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
      description:
        'Coordinates are optional and must never be required for validity — the operation runs on\nlandmarks and phone calls. Service zone is **resolved from** a location, never stored on\nit, because zones are hub-owned and versioned.\n',
    },
    current_item_description: {
      type: 'string',
      description:
        "Today's goods - women's shoes, clothes, phone accessories, books. REQUIRED for ADHOC_SENDER, because identity is reusable and goods are not. Optional for OWN_PACKAGES, where the Vendor's established goods profile satisfies 21.1 and an established Vendor is not re-onboarded daily.",
    },
    location_overrides: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
        landmark: { type: 'string' },
        map_link: { type: 'string', format: 'uri' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
      description:
        'Coordinates are optional and must never be required for validity — the operation runs on\nlandmarks and phone calls. Service zone is **resolved from** a location, never stored on\nit, because zones are hub-owned and versioned.\n',
    },
    scheduled_service_date: {
      type: 'string',
      format: 'date',
      description: 'Monday–Saturday only (§21.1, MSC-DEC-149). A date, not an instant.',
    },
    declared_package_count: {
      type: 'integer',
      minimum: 1,
      description:
        'Minimum 2 unless an approved one-package exception exists (§35.2.3). Accepting 1 here\nlets the server return `PICKUP_MINIMUM_NOT_MET` with its reason rather than a bare\nschema rejection, and lets an Ops session create the single-package request that the\nexception then attaches to.\n',
    },
    default_payer_intent: { type: 'string', enum: ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] },
    split_basis: { type: 'string', enum: ['FIXED_AMOUNT', 'PERCENTAGE'] },
    split_sender_amount: {
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
    },
    split_sender_percentage: { type: 'number', minimum: 0, maximum: 100 },
    declared_value_minor: {
      type: 'integer',
      minimum: 0,
      description:
        'Declared item value in pesewas. Required above `value_declaration_threshold`\n(23.4, MSC-DEC-212) - declared **at booking**, not at itemization, because booking is\nthe last moment the sender can still decline the terms.\n',
    },
    liability_cap_acknowledged: {
      type: 'boolean',
      description:
        'The sender acknowledges liability is capped at `liability_cap_amount` **regardless of\nthe value declared** (23.4, MSC-DEC-220). Mandatory once `declared_value_minor`\nexceeds the threshold; `VALUE_DECLARATION_REQUIRED` otherwise.\n\n**No field here states the cap amount, and that is the guard.** The server snapshots\nthe cap in force at this moment. A client able to state the cap it acknowledged could\nacknowledge a figure that was never in force - and MSC-DEC-220 exists precisely so the\ncustomer learns the real limit BEFORE Melarc takes custody, not after a loss.\n',
    },
    vendor_pickup_location_id: {
      type: 'string',
      format: 'uuid',
      description:
        "OWN_PACKAGES: the saved pickup location this request uses. Omit for the vendor's default. A location of another vendor is answered as one that does not exist.",
    },
    primary_phone: {
      type: 'string',
      description:
        'E.164 or as entered; normalised server-side. Required for ADHOC_SENDER and COLLECT_FOR_VENDOR, reused from the vendor for OWN_PACKAGES.',
    },
    secondary_phone: { type: 'string' },
  },
  description:
    "Carries payer **intent** only. No AUTHORITATIVE price field exists on this schema: the\nauthoritative price is still set at itemization, because the size class is selected there\nby the receiving officer and cannot be known at booking.\n\nThe response carries an indicative estimate, and **its composition depends on whether this\nbooking has a destination**. A standard multi-package request has none (5.2.1),\nso the estimate is base fee x package count. A **one-package exception** carries a mandatory\ndelivery address (21.1): the server resolves the service area and prices from the fee that\nactually applies - in-area, corridor batch day, or **corridor off-day**.\n\n**The estimate is absent for a known outside-Accra destination.** The carrier's charge is\nunknowable until itemization, and a number invented for it would be worse than\nno number: 23.6, MSC-DEC-175 showed nothing precisely to avoid that.\n\nIt stays provisional either way, for the reason that survives - the size class is selected by\na receiving officer at itemization.\n\n**The client sends an address and never a price** (42.3). The server resolves the area.\n",
});

export const PICKUP_REQUEST_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: PICKUP_REQUEST_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

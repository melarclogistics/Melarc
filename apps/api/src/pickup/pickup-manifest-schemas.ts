import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the pickup manifest as the application describes them (S1.20; `PickupManifest`, `PickupStop`, `PickupManifestCreate`
 * and the list's envelope of the contract); the conformance check compares them with the contract. They are the contract's schemas with
 * their references followed, so a member added to the contract and not here is a finding of the check, and a response that does not fit
 * is a failure of the route tests, which validate every answer against the contract itself.
 *
 * `pickup_summary` is described because the contract has it: optional on a stop, made once by `dispatchManifest` (S1.21; OB-S1-21) and
 * present on the stops of a dispatched manifest that were still to be worked then.
 */

/**
 * The most requests one manifest is built from: the Version 1 size of a run, stated in the contract as `maxItems` and **not derived from
 * anything else** (the Product Owner's decision of 1 and 2 November 2026, on the reviewer's recommendation: a software batch ceiling for Version 1 and not a statement of what a rider can carry). The audit event of the
 * creation records the membership and must be able to hold a full manifest, but that is a property the limit must keep, not a source
 * of it: the boundary is tested end to end (64 is built, 65 is refused by the schema), so a change to either limit fails a test and never
 * surfaces as a refusal after the act.
 */
export const MAX_MANIFEST_STOPS = 64;

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
};

const PICKUP_STOP_SUMMARY = {
  type: 'object',
  required: [
    'reference',
    'sender_display_name',
    'declared_package_count',
    'resolved_pickup_location',
    'location_note',
    'contact_phone',
  ],
  additionalProperties: false,
  properties: {
    reference: { type: 'string' },
    sender_display_name: { type: 'string' },
    declared_package_count: { type: 'integer' },
    resolved_pickup_location: LOCATION,
    location_note: { type: ['string', 'null'] },
    contact_phone: { type: ['string', 'null'] },
  },
};

const PICKUP_STOP = {
  type: 'object',
  required: ['id', 'pickup_manifest_id', 'pickup_request_id', 'sequence', 'state'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    pickup_manifest_id: { type: 'string', format: 'uuid' },
    pickup_request_id: { type: 'string', format: 'uuid' },
    sequence: { type: 'integer' },
    state: {
      type: 'string',
      enum: ['PENDING', 'ARRIVED', 'COLLECTED', 'PARTIALLY_COLLECTED', 'FAILED', 'SKIPPED'],
    },
    arrived_at: { type: ['string', 'null'], format: 'date-time' },
    failure_category: {
      type: ['string', 'null'],
      enum: ['VENDOR_UNAVAILABLE', 'ACCESS_DENIED', 'PARCEL_NOT_READY', 'REFUSED_COLLECTION', null],
    },
    failure: {
      type: ['object', 'null'],
      properties: {
        reason_code: { type: 'string' },
        note: { type: 'string' },
        reported_at: { type: 'string', format: 'date-time' },
      },
    },
    skipped: {
      type: ['object', 'null'],
      properties: {
        reason_code: { type: 'string' },
        note: { type: 'string' },
        skipped_at: { type: 'string', format: 'date-time' },
      },
    },
    pickup_summary: PICKUP_STOP_SUMMARY,
  },
};

/** A stop alone, as `arriveAtPickupStop` answers it (the contract's `PickupStop`). */
export const PICKUP_STOP_SCHEMA = described(PICKUP_STOP);

export const PICKUP_MANIFEST_SCHEMA = described({
  type: 'object',
  required: ['id', 'code', 'state', 'service_date', 'responsible_hub_id'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    state: {
      type: 'string',
      enum: ['DRAFT', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
    },
    service_date: { type: 'string', format: 'date' },
    responsible_hub_id: { type: 'string', format: 'uuid' },
    assigned_rider_id: { type: ['string', 'null'], format: 'uuid' },
    assigned_at: { type: ['string', 'null'], format: 'date-time' },
    dispatched_at: { type: ['string', 'null'], format: 'date-time' },
    started_at: { type: ['string', 'null'], format: 'date-time' },
    stops: { type: 'array', items: PICKUP_STOP },
    completed_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

/**
 * The body of `createPickupManifest`: the requests, in the order of their stops, the day, and the reason each overdue request is carried
 * over for. No rider and no hub. An entry of `carryover` is given for a request of the manifest that was promised for an earlier day than
 * the manifest's, and for no other; there is at most one per request, so it cannot outnumber the requests.
 */
export const PICKUP_MANIFEST_CREATE_BODY = described({
  type: 'object',
  required: ['pickup_request_ids', 'service_date'],
  additionalProperties: false,
  properties: {
    pickup_request_ids: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_MANIFEST_STOPS,
      items: { type: 'string', format: 'uuid' },
    },
    service_date: { type: 'string', format: 'date' },
    carryover: {
      type: 'array',
      maxItems: MAX_MANIFEST_STOPS,
      items: {
        type: 'object',
        required: ['pickup_request_id', 'reason_code'],
        additionalProperties: false,
        properties: {
          pickup_request_id: { type: 'string', format: 'uuid' },
          reason_code: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
});

export const PICKUP_MANIFEST_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: PICKUP_MANIFEST_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

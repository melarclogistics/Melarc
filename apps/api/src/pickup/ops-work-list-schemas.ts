import { described } from '../platform/openapi/described-schema.js';
import { HANDSHAKE_STATES } from './collection-handshake.schema.js';
import {
  COLLECTION_VARIANCES,
  HANDSHAKE_CHANNELS,
  HANDSHAKE_TYPES,
} from './collection-record.schema.js';
import { FAILURE_DECISIONS, HANDSHAKE_ROUTED_BECAUSE } from './ops-work-list-views.js';
import { PICKUP_MANIFEST_STATES } from './pickup-manifest.schema.js';
import { PICKUP_REQUEST_STATES } from './pickup-request.schema.js';
import { PICKUP_STOP_STATES } from './pickup-stop.schema.js';
import { CONTACT_ATTEMPT_METHODS, PICKUP_FAILURE_CATEGORIES } from './pickup-vocabulary.js';

/**
 * The shapes of the four Ops work lists as the application describes them (D-A3, OB-S1-70; `CollectionDisputeListItem`, `OpsHandshake`, `CollectionShortfall`
 * and `PickupFailureQueueItem` of the contract, with the list's envelope); the conformance check compares them with the contract. The closed sets are the
 * vocabularies' own, the ones the tables repeat as a CHECK, so a state added to a table and not to the contract is a finding of the check.
 *
 * **What no item carries:** a handshake code or its digest, a phone number, an address, the Ops note of a handshake, or the rider's contact attempts of a
 * collection. A route test holds each closed list of fields to the contract's, so that none grows in silently.
 */

const uuid = { type: 'string', format: 'uuid' } as const;
const moment = { type: 'string', format: 'date-time' } as const;
const nullableMoment = { type: ['string', 'null'], format: 'date-time' } as const;
const count = { type: 'integer', minimum: 0 } as const;

/** What every item says of the pickup it is about: the ids to open it from and the words to find it by. */
const CONTEXT_REQUIRED = [
  'pickup_stop_id',
  'pickup_manifest_id',
  'pickup_request_id',
  'responsible_hub_id',
  'request_code',
  'sender_name',
] as const;
const CONTEXT_PROPERTIES = {
  pickup_stop_id: uuid,
  pickup_manifest_id: uuid,
  pickup_request_id: uuid,
  responsible_hub_id: uuid,
  request_code: { type: 'string' },
  sender_name: { type: 'string' },
} as const;

const REASON = {
  type: 'object',
  required: ['code', 'label', 'attribution'],
  additionalProperties: false,
  properties: {
    code: { type: 'string' },
    label: { type: 'string' },
    attribution: { type: 'string' },
  },
} as const;

export const COLLECTION_DISPUTE_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    ...CONTEXT_REQUIRED,
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
  additionalProperties: false,
  properties: {
    id: uuid,
    ...CONTEXT_PROPERTIES,
    vendor_organization_id: uuid,
    state: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
    note: { type: 'string' },
    created_at: moment,
    resolved_at: nullableMoment,
    stop_state: { type: 'string', enum: [...PICKUP_STOP_STATES] },
    declared_count: { type: 'integer', minimum: 1 },
    collected_count: { type: 'integer', minimum: 1 },
    variance: { type: 'string', enum: [...COLLECTION_VARIANCES] },
  },
});

export const OPS_HANDSHAKE_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    ...CONTEXT_REQUIRED,
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
  additionalProperties: false,
  properties: {
    id: uuid,
    ...CONTEXT_PROPERTIES,
    direction: { type: 'string', enum: [...HANDSHAKE_TYPES] },
    state: { type: 'string', enum: [...HANDSHAKE_STATES] },
    stop_state: { type: 'string', enum: [...PICKUP_STOP_STATES] },
    routed_because: {
      type: ['string', 'null'],
      enum: [...HANDSHAKE_ROUTED_BECAUSE, null],
    },
    expires_at: nullableMoment,
    attempts: count,
    attempt_limit: { type: ['integer', 'null'], minimum: 1 },
    fallback_sends: count,
    fallback_limit: { type: ['integer', 'null'], minimum: 1 },
    channel: { type: ['string', 'null'], enum: [...HANDSHAKE_CHANNELS, null] },
    confirmed_at: nullableMoment,
    authorised_by: { type: ['string', 'null'], format: 'uuid' },
    created_at: moment,
  },
});

export const COLLECTION_SHORTFALL_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    ...CONTEXT_REQUIRED,
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
  additionalProperties: false,
  properties: {
    id: uuid,
    ...CONTEXT_PROPERTIES,
    declared_count: { type: 'integer', minimum: 1 },
    collected_count: { type: 'integer', minimum: 1 },
    shortfall_count: { type: 'integer', minimum: 1 },
    reason: REASON,
    note: { type: ['string', 'null'] },
    office_notified_at: moment,
    recorded_at: moment,
    recorded_by: uuid,
    stop_state: { type: 'string', enum: [...PICKUP_STOP_STATES] },
    run_state: { type: 'string', enum: [...PICKUP_MANIFEST_STATES] },
  },
});

export const PICKUP_FAILURE_QUEUE_ITEM_SCHEMA = described({
  type: 'object',
  required: [
    ...CONTEXT_REQUIRED,
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
    'decided_at',
    'replacement_request_id',
    'rider_id',
    'photo_count',
  ],
  additionalProperties: false,
  properties: {
    ...CONTEXT_PROPERTIES,
    category: { type: 'string', enum: [...PICKUP_FAILURE_CATEGORIES] },
    reason: REASON,
    note: { type: ['string', 'null'] },
    contact_attempts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['method', 'attempted_at', 'outcome'],
        additionalProperties: false,
        properties: {
          method: { type: 'string', enum: [...CONTACT_ATTEMPT_METHODS] },
          attempted_at: moment,
          outcome: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
    failed_at: moment,
    waiting_seconds: count,
    request_state: { type: 'string', enum: [...PICKUP_REQUEST_STATES] },
    decision: { type: 'string', enum: [...FAILURE_DECISIONS] },
    attempt_number: { type: 'integer', minimum: 1 },
    attempt_extended: { type: 'boolean' },
    escalated_at: nullableMoment,
    decided_at: nullableMoment,
    replacement_request_id: { type: ['string', 'null'], format: 'uuid' },
    rider_id: { type: ['string', 'null'], format: 'uuid' },
    photo_count: count,
  },
});

/** The envelope of a list: its items and the position of the next page, or `null` at the end. */
const pageOf = (item: object) =>
  described({
    type: 'object',
    required: ['items', 'next_page_token'],
    properties: {
      items: { type: 'array', items: item },
      next_page_token: { type: ['string', 'null'] },
    },
  });

export const COLLECTION_DISPUTE_PAGE_SCHEMA = pageOf(COLLECTION_DISPUTE_SCHEMA);
export const OPS_HANDSHAKE_PAGE_SCHEMA = pageOf(OPS_HANDSHAKE_SCHEMA);
export const COLLECTION_SHORTFALL_PAGE_SCHEMA = pageOf(COLLECTION_SHORTFALL_SCHEMA);
export const PICKUP_FAILURE_PAGE_SCHEMA = pageOf(PICKUP_FAILURE_QUEUE_ITEM_SCHEMA);

import { described } from '../platform/openapi/described-schema.js';
import {
  HUB_INTAKE_POST_COUNT_SCHEMA,
  HUB_INTAKE_PRE_COUNT_SCHEMA,
  INTAKE_STATES,
} from './hub-intake-schemas.js';

/**
 * The shapes of receiving by run as the application describes them (Run D, contract 5.108.0; S1.35b): the contract's `ReceivingMode`, `IntakeParcel`, `IntakeFinding`, `ReceivingLock`,
 * `IntakeCounts`, `HubIntakeCheckIn`, `ReceivingVendor`, `ReceivingRun`, `ReceivingRunSummary`, `MissingParcel`, `EvidenceLimits` and the bodies of the four acts. The conformance check compares what
 * is written here with the contract's own, so a shape that drifts is a finding. **No name here is anything but a display name, and no phone number, key or address is in any of them.**
 */
const UUID = { type: 'string', format: 'uuid' } as const;
const NULLABLE_UUID = { type: ['string', 'null'], format: 'uuid' } as const;
const DATE_TIME = { type: 'string', format: 'date-time' } as const;
const NULLABLE_DATE_TIME = { type: ['string', 'null'], format: 'date-time' } as const;
const NULLABLE_STRING = { type: ['string', 'null'] } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;
const NULLABLE_COUNT = { type: ['integer', 'null'], minimum: 0 } as const;
const VARIANCE_OR_NULL = {
  type: ['string', 'null'],
  enum: ['MATCH', 'SHORT', 'OVER', null],
} as const;
const CONDITIONS = ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] as const;
const STATE = { type: 'string', enum: [...INTAKE_STATES] } as const;

export const RECEIVING_MODES = ['PHOTO_CHECK_IN', 'BLIND_COUNT'] as const;
export const INTAKE_PARCEL_STATES = ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID'] as const;
export const INTAKE_PARCEL_ORIGINS = ['DOOR_PHOTO', 'HUB_EXTRA'] as const;

export const RECEIVING_MODE_SCHEMA = described({ type: 'string', enum: [...RECEIVING_MODES] });

export const INTAKE_PARCEL_CONDITION_SCHEMA = described({
  type: 'object',
  required: ['condition', 'note', 'evidence_ids', 'recorded_by_name', 'recorded_at'],
  additionalProperties: false,
  properties: {
    condition: { type: 'string', enum: [...CONDITIONS] },
    note: NULLABLE_STRING,
    evidence_ids: { type: 'array', items: UUID },
    recorded_by_name: { type: 'string' },
    recorded_at: DATE_TIME,
  },
});

export const INTAKE_PARCEL_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'ordinal',
    'origin',
    'state',
    'photo_evidence_id',
    'arrived_by_name',
    'arrived_at',
    'missing_marked_at',
    'condition',
  ],
  additionalProperties: false,
  properties: {
    id: UUID,
    ordinal: { type: 'integer', minimum: 1 },
    origin: { type: 'string', enum: [...INTAKE_PARCEL_ORIGINS] },
    state: { type: 'string', enum: [...INTAKE_PARCEL_STATES] },
    photo_evidence_id: UUID,
    arrived_by_name: NULLABLE_STRING,
    arrived_at: NULLABLE_DATE_TIME,
    missing_marked_at: NULLABLE_DATE_TIME,
    condition: { oneOf: [INTAKE_PARCEL_CONDITION_SCHEMA, { type: 'null' }] },
  },
});

export const INTAKE_FINDING_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'kind',
    'intake_parcel_id',
    'condition',
    'outcome',
    'note',
    'evidence_ids',
    'recorded_by',
    'recorded_by_name',
    'recorded_at',
  ],
  additionalProperties: false,
  properties: {
    id: UUID,
    kind: { type: 'string', enum: ['CONDITION', 'ADJUDICATION'] },
    intake_parcel_id: NULLABLE_UUID,
    condition: { type: ['string', 'null'], enum: [...CONDITIONS, null] },
    outcome: {
      type: ['string', 'null'],
      enum: ['ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED', null],
    },
    note: NULLABLE_STRING,
    evidence_ids: { type: 'array', items: UUID },
    recorded_by: UUID,
    recorded_by_name: { type: 'string' },
    recorded_at: DATE_TIME,
  },
});

export const RECEIVING_LOCK_SCHEMA = described({
  type: 'object',
  required: ['holder_name', 'held_by_you', 'opened_at', 'last_seen_at'],
  additionalProperties: false,
  properties: {
    holder_name: { type: 'string' },
    held_by_you: { type: 'boolean' },
    opened_at: DATE_TIME,
    last_seen_at: DATE_TIME,
  },
});

export const INTAKE_COUNTS_SCHEMA = described({
  type: 'object',
  required: [
    'parcels_expected',
    'arrived_count',
    'received_count',
    'count_variance',
    'missing_count',
    'extra_count',
    'damaged_count',
  ],
  additionalProperties: false,
  properties: {
    parcels_expected: NULLABLE_COUNT,
    arrived_count: NULLABLE_COUNT,
    received_count: NULLABLE_COUNT,
    count_variance: VARIANCE_OR_NULL,
    missing_count: COUNT,
    extra_count: COUNT,
    damaged_count: COUNT,
  },
});

export const HUB_INTAKE_CHECK_IN_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'code',
    'hub_id',
    'pickup_request_id',
    'pickup_manifest_id',
    'run_code',
    'state',
    'count_phase',
    'receiving_mode',
    'vendor_name',
    'handed_over_by_name',
    'handed_over_at',
    'parcels_expected',
    'rider_declared_count',
    'arrived_count',
    'received_count',
    'count_variance',
    'count_difference',
    'counted_at',
    'counted_by_name',
    'lock',
    'parcels',
    'missing_count',
    'extra_count',
    'damaged_count',
    'condition',
    'condition_findings',
  ],
  additionalProperties: false,
  properties: {
    id: UUID,
    code: { type: 'string' },
    hub_id: UUID,
    pickup_request_id: UUID,
    pickup_manifest_id: UUID,
    run_code: { type: 'string' },
    state: STATE,
    count_phase: { type: 'string', const: 'CHECK_IN' },
    receiving_mode: { type: 'string', const: 'PHOTO_CHECK_IN' },
    vendor_name: { type: 'string' },
    handed_over_by_name: { type: 'string' },
    handed_over_at: DATE_TIME,
    parcels_expected: { type: 'integer', minimum: 1 },
    rider_declared_count: COUNT,
    arrived_count: COUNT,
    received_count: NULLABLE_COUNT,
    count_variance: VARIANCE_OR_NULL,
    count_difference: { type: ['integer', 'null'] },
    counted_at: NULLABLE_DATE_TIME,
    counted_by_name: NULLABLE_STRING,
    lock: { oneOf: [RECEIVING_LOCK_SCHEMA, { type: 'null' }] },
    parcels: { type: 'array', items: INTAKE_PARCEL_SCHEMA },
    missing_count: COUNT,
    extra_count: COUNT,
    damaged_count: COUNT,
    condition: { type: 'string', enum: [...CONDITIONS] },
    condition_findings: { type: 'array', items: INTAKE_FINDING_SCHEMA },
    dispute_state: { type: ['string', 'null'] },
    parity_exception_id: NULLABLE_UUID,
  },
});

export const RECEIVING_VENDOR_SCHEMA = described({
  type: 'object',
  required: [
    'intake_id',
    'intake_code',
    'intake_etag',
    'receiving_mode',
    'state',
    'vendor_name',
    'parcels_expected',
    'arrived_count',
    'received_count',
    'count_variance',
    'lock',
    'missing_count',
    'extra_count',
    'damaged_count',
    'parcels',
  ],
  additionalProperties: false,
  properties: {
    intake_id: UUID,
    intake_code: { type: 'string' },
    intake_etag: { type: 'string' },
    receiving_mode: RECEIVING_MODE_SCHEMA,
    state: STATE,
    vendor_name: { type: 'string' },
    parcels_expected: NULLABLE_COUNT,
    arrived_count: NULLABLE_COUNT,
    received_count: NULLABLE_COUNT,
    count_variance: VARIANCE_OR_NULL,
    lock: { oneOf: [RECEIVING_LOCK_SCHEMA, { type: 'null' }] },
    missing_count: COUNT,
    extra_count: COUNT,
    damaged_count: COUNT,
    parcels: { type: 'array', items: INTAKE_PARCEL_SCHEMA },
  },
});

export const RECEIVING_RUN_SCHEMA = described({
  type: 'object',
  required: ['run', 'rider_name', 'handed_over_at', 'vendors'],
  additionalProperties: false,
  properties: {
    run: {
      type: 'object',
      required: ['id', 'code', 'hub_id', 'hub_name', 'service_date'],
      additionalProperties: false,
      properties: {
        id: UUID,
        code: { type: 'string' },
        hub_id: UUID,
        hub_name: { type: 'string' },
        service_date: { type: 'string', format: 'date' },
      },
    },
    rider_name: { type: 'string' },
    handed_over_at: DATE_TIME,
    vendors: { type: 'array', items: RECEIVING_VENDOR_SCHEMA },
  },
});

export const RECEIVING_RUN_SUMMARY_SCHEMA = described({
  type: 'object',
  required: [
    'run_id',
    'run_code',
    'hub_id',
    'hub_name',
    'rider_name',
    'vendor_names',
    'vendors_total',
    'vendors_waiting',
    'vendors_needing_decision',
    'blind_count_vendors',
    'parcels_expected',
    'missing_searching',
    'handed_over_at',
    'checking_in',
  ],
  additionalProperties: false,
  properties: {
    run_id: UUID,
    run_code: { type: 'string' },
    hub_id: UUID,
    hub_name: { type: 'string' },
    rider_name: { type: 'string' },
    vendor_names: { type: 'array', items: { type: 'string' } },
    vendors_total: { type: 'integer', minimum: 1 },
    vendors_waiting: COUNT,
    vendors_needing_decision: COUNT,
    blind_count_vendors: COUNT,
    parcels_expected: COUNT,
    missing_searching: COUNT,
    handed_over_at: DATE_TIME,
    checking_in: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'is_you'],
        additionalProperties: false,
        properties: { name: { type: 'string' }, is_you: { type: 'boolean' } },
      },
    },
  },
});

export const RECEIVING_RUN_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: RECEIVING_RUN_SUMMARY_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

export const MISSING_PARCEL_SCHEMA = described({
  type: 'object',
  required: [
    'parcel_id',
    'photo_evidence_id',
    'intake_id',
    'intake_code',
    'run_id',
    'run_code',
    'vendor_name',
    'missing_since',
    'written_off_at',
  ],
  additionalProperties: false,
  properties: {
    parcel_id: UUID,
    photo_evidence_id: UUID,
    intake_id: UUID,
    intake_code: { type: 'string' },
    run_id: UUID,
    run_code: { type: 'string' },
    vendor_name: { type: 'string' },
    missing_since: DATE_TIME,
    written_off_at: NULLABLE_DATE_TIME,
  },
});

export const MISSING_PARCEL_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: MISSING_PARCEL_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

export const PARCEL_ARRIVAL_BODY = described({
  type: 'object',
  required: ['arrived'],
  additionalProperties: false,
  properties: { arrived: { type: 'boolean' } },
});

export const CHECK_IN_FINISH_BODY = described({
  type: 'object',
  required: ['all_arrived'],
  additionalProperties: false,
  properties: {
    all_arrived: { type: 'boolean' },
    confirmed_count: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
  },
});

export const EXTRA_PARCEL_BODY = described({
  type: 'object',
  required: ['photo_evidence_id'],
  additionalProperties: false,
  properties: {
    photo_evidence_id: UUID,
    note: { type: 'string', maxLength: 1000 },
  },
});

export const INTAKE_PARCEL_CHANGE_SCHEMA = described({
  type: 'object',
  required: ['parcel_id', 'state'],
  additionalProperties: false,
  properties: {
    parcel_id: UUID,
    state: { type: 'string', enum: ['ARRIVED', 'MISSING', 'VOID'] },
  },
});

export const INTAKE_CORRECTION_BODY = described({
  type: 'object',
  required: ['reason'],
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    parcel_changes: { type: 'array', minItems: 1, items: INTAKE_PARCEL_CHANGE_SCHEMA },
    physical_count: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
  },
});

export const INTAKE_PARCEL_ANSWER_SCHEMA = described({
  type: 'object',
  required: ['parcel', 'intake_etag', 'counts'],
  additionalProperties: false,
  properties: {
    parcel: INTAKE_PARCEL_SCHEMA,
    intake_etag: { type: 'string' },
    counts: INTAKE_COUNTS_SCHEMA,
  },
});

/** The answer of `correctIntakeCount`: the intake as it now stands, in the shape its mode calls for (`HubIntakeCheckIn` for a photo intake, `HubIntakePostCount` for a blind-count one). */
export const INTAKE_CORRECTED_SCHEMA = described({
  oneOf: [HUB_INTAKE_CHECK_IN_SCHEMA, HUB_INTAKE_POST_COUNT_SCHEMA],
  discriminator: {
    propertyName: 'count_phase',
    mapping: {
      CHECK_IN: '#/components/schemas/HubIntakeCheckIn',
      POST_COUNT: '#/components/schemas/HubIntakePostCount',
    },
  },
});

/** The answer of a finding and of an adjudication, as of a correction: the intake in the shape its mode calls for. */
export const INTAKE_AFTER_COUNT_SCHEMA = INTAKE_CORRECTED_SCHEMA;

/**
 * An intake as `getHubIntake` and `acquireIntakeLock` answer it and as `listHubIntakes` lists it: the shape the intake's mode and phase call for, told apart by `count_phase`. A blind-count intake is
 * `HubIntakePreCount` until its count and `HubIntakePostCount` after; a photo intake is `HubIntakeCheckIn` throughout (Run D, D-D1).
 */
export const HUB_INTAKE_VIEW_SCHEMA = described({
  oneOf: [HUB_INTAKE_PRE_COUNT_SCHEMA, HUB_INTAKE_POST_COUNT_SCHEMA, HUB_INTAKE_CHECK_IN_SCHEMA],
  // The values on the wire, mapped to the shapes (contract 5.107.0, and 5.108.0 for the third): without a mapping a generator takes the schemas' own names as the values, which `count_phase` never carries.
  discriminator: {
    propertyName: 'count_phase',
    mapping: {
      PRE_COUNT: '#/components/schemas/HubIntakePreCount',
      POST_COUNT: '#/components/schemas/HubIntakePostCount',
      CHECK_IN: '#/components/schemas/HubIntakeCheckIn',
    },
  },
});

/** The page of `listHubIntakes`. */
export const HUB_INTAKE_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token'],
  properties: {
    items: { type: 'array', items: HUB_INTAKE_VIEW_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
  },
});

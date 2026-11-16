import { described } from '../platform/openapi/described-schema.js';

/** The states of an intake as the contract names them (`HubIntakeBase.state`). */
export const INTAKE_STATES = [
  'AWAITING_COUNT',
  'COUNTED',
  'RECONCILIATION_REQUIRED',
  'READY_FOR_ITEMIZATION',
  'ITEMIZING',
  'CLOSED',
] as const;

/** The contract's `HubIntakeBase`. */
export const HUB_INTAKE_BASE_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'code',
    'state',
    'hub_id',
    'pickup_request_id',
    'pickup_manifest_id',
    'handed_over_by',
    'handed_over_at',
    'declaration_captured_at',
    'count_phase',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    hub_id: { type: 'string', format: 'uuid' },
    pickup_request_id: { type: 'string', format: 'uuid' },
    pickup_manifest_id: { type: 'string', format: 'uuid' },
    handed_over_by: { type: 'string', format: 'uuid' },
    handed_over_at: { type: 'string', format: 'date-time' },
    declaration_captured_at: { type: 'string', format: 'date-time' },
    active_receiver_id: { type: ['string', 'null'], format: 'uuid' },
    lock_acquired_at: { type: ['string', 'null'], format: 'date-time' },
    state: { type: 'string', enum: [...INTAKE_STATES] },
    count_phase: { type: 'string', enum: ['PRE_COUNT', 'POST_COUNT'] },
  },
});

/**
 * The contract's `HubIntakePreCount`. **Deliberately has no `rider_declared_count` property** - the absence is the blind-count guarantee (§35.5.2, §43.2); the database holds the same
 * absence in the grants of its table.
 */
export const HUB_INTAKE_PRE_COUNT_SCHEMA = described({
  allOf: [
    HUB_INTAKE_BASE_SCHEMA,
    { type: 'object', properties: { count_phase: { const: 'PRE_COUNT' } } },
  ],
});

/**
 * The contract's `HubIntakePostCount`: the intake once its physical count is committed, which carries the declaration for the first time beside the count and the comparison
 * (hub-intake.md section 5.1 step 5).
 */
export const HUB_INTAKE_POST_COUNT_SCHEMA = described({
  allOf: [
    HUB_INTAKE_BASE_SCHEMA,
    {
      type: 'object',
      required: ['rider_declared_count', 'physical_count', 'count_variance', 'condition'],
      properties: {
        count_phase: { const: 'POST_COUNT' },
        rider_declared_count: { type: 'integer' },
        physical_count: { type: 'integer' },
        count_variance: { type: 'string', enum: ['MATCH', 'SHORT', 'OVER'] },
        count_difference: { type: 'integer' },
        condition: { type: 'string', enum: ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] },
        condition_findings: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
        dispute_state: { type: ['string', 'null'] },
        parity_exception_id: { type: ['string', 'null'], format: 'uuid' },
        parcel_photo_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
      },
    },
  ],
});

/**
 * The body of `submitBlindCount` as the application describes it (the contract's request): **the physical count alone**, and a body that carries anything else, the rider's declaration
 * included, is not valid (`additionalProperties: false`, `AC-SLICE-001-38`): the declaration is never accepted as input, as it is never served before the count.
 */
export const BLIND_COUNT_BODY = described({
  type: 'object',
  required: ['physical_count'],
  additionalProperties: false,
  properties: {
    physical_count: { type: 'integer', minimum: 0 },
  },
});

/**
 * The body of `recordIntakeCondition` (the contract's `IntakeConditionRecord`): the receiver's recording of a condition, independent of the count. DAMAGED and TAMPERED carry stored evidence. `parcel_id` is the
 * parcel the condition is a finding of (Run D): required for a photo intake and not allowed for a blind-count one, which the service judges.
 */
export const INTAKE_CONDITION_BODY = described({
  type: 'object',
  required: ['condition'],
  additionalProperties: false,
  properties: {
    condition: { type: 'string', enum: ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] },
    note: { type: 'string' },
    evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    parcel_id: { type: 'string', format: 'uuid' },
  },
});

/** The body of `adjudicateDiscrepancy` (the contract's `DiscrepancyAdjudication`): an outcome and a reason in words, and optionally a condition with its evidence. */
export const DISCREPANCY_ADJUDICATION_BODY = described({
  type: 'object',
  required: ['outcome', 'note'],
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: ['ACCEPTED', 'ESCALATED', 'WRITTEN_OFF', 'VENDOR_NOTIFIED'] },
    condition: { type: 'string', enum: ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] },
    evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    note: { type: 'string', minLength: 1 },
  },
});

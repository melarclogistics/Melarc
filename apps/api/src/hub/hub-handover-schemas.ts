import { described } from '../platform/openapi/described-schema.js';
import { HUB_INTAKE_PRE_COUNT_SCHEMA } from './hub-intake-schemas.js';

/** One row of the handover: the contract's `HubHandoverRow`. A zero is legal and never quiet: the intake opens and goes to reconciliation after the blind count. */
export const HUB_HANDOVER_ROW_SCHEMA = described({
  type: 'object',
  required: ['pickup_request_id', 'declared_count'],
  additionalProperties: false,
  properties: {
    pickup_request_id: { type: 'string', format: 'uuid' },
    declared_count: {
      type: 'integer',
      minimum: 0,
      maximum: 2_147_483_647,
      description:
        'The parcels the rider hands over for this request (at most 2,147,483,647, the number the intake holds). **Zero is legal**: the request’s intake still opens, and is routed to reconciliation after the blind count.',
    },
  },
});

/**
 * The body of `submitHubHandover` as the application describes it (S1.31; the contract's `HubHandoverSubmit`): one row for each collected request of the run, the device’s moment,
 * a note. The conformance check compares it with the contract. A body the schema refuses never reaches the service; what the schema cannot say (the rows being exactly the run’s
 * collected requests, each once; a moment that names an instant) is the service's.
 */
export const HUB_HANDOVER_SUBMIT_BODY = described({
  type: 'object',
  required: ['rows', 'captured_at'],
  additionalProperties: false,
  properties: {
    rows: {
      type: 'array',
      minItems: 1,
      items: HUB_HANDOVER_ROW_SCHEMA,
      description:
        'Exactly the run’s collected pickup requests, each once. Anything else is VALIDATION_FAILED, naming the row.',
    },
    captured_at: {
      type: 'string',
      format: 'date-time',
      description:
        'When the rider made the declaration on the device - the field time, distinct from the server’s receipt (§35.3.9). Recorded on each intake as declaration_captured_at.',
    },
    note: { type: 'string' },
  },
});

/** The answer of `submitHubHandover`: the intakes it opened, in the order of the rows. */
export const HUB_HANDOVER_ANSWER_SCHEMA = described({
  type: 'array',
  items: HUB_INTAKE_PRE_COUNT_SCHEMA,
});

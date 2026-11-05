import { described } from '../platform/openapi/described-schema.js';

/** The body of `disputeCollection` (S1.29; the contract's `CollectionDisputeCreate`): what the vendor disputes, mandatory. */
export const COLLECTION_DISPUTE_CREATE_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description: 'What the vendor disputes; mandatory.',
    },
  },
});

/** The answer of `disputeCollection`: the contract's `CollectionDispute`. */
export const COLLECTION_DISPUTE_SCHEMA = described({
  type: 'object',
  required: ['id', 'pickup_stop_id', 'state', 'raised_by', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    pickup_stop_id: { type: 'string', format: 'uuid' },
    state: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
    raised_by: { type: 'string', format: 'uuid' },
    note: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
});

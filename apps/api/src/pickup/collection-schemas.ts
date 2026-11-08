import { described } from '../platform/openapi/described-schema.js';

/**
 * The body of `recordCollection` as the application describes it (S1.26; the contract's `CollectionRecordCreate`): the count, the reason of a short
 * one, a note, the evidence, and the moment the device counted. The conformance check compares it with the contract. A body the schema refuses never
 * reaches the service; what the schema cannot say (zero, more than was declared, a reason for a count that matches, a reason the catalogue refuses)
 * is the service's.
 */
export const COLLECTION_RECORD_CREATE_BODY = described({
  type: 'object',
  required: ['collected_count'],
  additionalProperties: false,
  properties: {
    collected_count: {
      type: 'integer',
      minimum: 0,
      description: 'Zero is a failed pickup — `ZERO_COLLECTION_IS_FAILURE` (§36.4).',
    },
    variance_reason_code: {
      type: 'string',
      description:
        'Required when `collected_count < declared_count`. Its metadata may make a note or photo mandatory in turn (§35.9.2). Absent on a short count → `REASON_REQUIRED`.',
    },
    variance_note: { type: 'string' },
    evidence_ids: {
      type: 'array',
      items: { type: 'string', format: 'uuid' },
      description:
        'Each id must name an evidence record in `STORED` (EVIDENCE_NOT_STORED otherwise).',
    },
    captured_at: {
      type: 'string',
      format: 'date-time',
      description:
        'Field capture time, distinct from upload time. Preserved on sync along with ordering and conflict status (§35.3.9).',
    },
  },
});

/** The answer of `recordCollection`: the contract's `CollectionRecord`. */
export const COLLECTION_RECORD_SCHEMA = described({
  type: 'object',
  required: ['collected_count', 'id', 'pickup_stop_id', 'declared_count', 'variance'],
  additionalProperties: false,
  properties: {
    collected_count: { type: 'integer', minimum: 0 },
    variance_reason_code: { type: 'string' },
    variance_note: { type: 'string' },
    evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    captured_at: { type: 'string', format: 'date-time' },
    id: { type: 'string', format: 'uuid' },
    pickup_stop_id: { type: 'string', format: 'uuid' },
    declared_count: { type: 'integer' },
    variance: { type: 'string', enum: ['MATCH', 'SHORT'] },
    office_notified_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

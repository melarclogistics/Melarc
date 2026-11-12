import { described } from '../platform/openapi/described-schema.js';
import { CONTACT_ATTEMPT_METHODS, PICKUP_FAILURE_CATEGORIES } from './pickup-vocabulary.js';

/** The most contact attempts a failure keeps (a technical bound, held by the table's guard as well; the contract's `maxItems`). */
export const MAX_CONTACT_ATTEMPTS = 10;

/** The most evidence records one failure carries (a technical bound, the contract's `maxItems`); the same as its contact attempts. */
export const MAX_FAILURE_EVIDENCE = 10;

/**
 * The body of `reportPickupFailure` as the application describes it (S1.28; the contract's inline request body): the fixed category, the reason of
 * the catalogue, the note, the evidence and the contact attempts. The conformance check compares it with the contract. A body the schema refuses never
 * reaches the service; what the schema cannot say (a reason the catalogue refuses, a note the ledger could not keep, a moment that is not a day of the
 * calendar) is the service's.
 */
export const PICKUP_FAILURE_BODY = described({
  type: 'object',
  required: ['category', 'reason_code'],
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      enum: [...PICKUP_FAILURE_CATEGORIES],
      description:
        'The fixed category (§21.5), mandatory and not configurable: the escalation-only rule for REFUSED_COLLECTION (§21.6) points at it.',
    },
    reason_code: { type: 'string' },
    note: { type: 'string' },
    evidence_ids: {
      type: 'array',
      maxItems: MAX_FAILURE_EVIDENCE,
      uniqueItems: true,
      items: { type: 'string', format: 'uuid' },
      description:
        'Each id must name an evidence record in `STORED`. A `PENDING_UPLOAD` record is rejected with `EVIDENCE_NOT_STORED` - otherwise "attached evidence" is satisfiable by a declaration with no bytes behind it.',
    },
    contact_attempts: {
      type: 'array',
      maxItems: MAX_CONTACT_ATTEMPTS,
      items: {
        type: 'object',
        required: ['method', 'attempted_at', 'outcome'],
        additionalProperties: false,
        properties: {
          method: { type: 'string', enum: [...CONTACT_ATTEMPT_METHODS] },
          attempted_at: { type: 'string', format: 'date-time' },
          outcome: { type: 'string' },
          note: { type: 'string' },
        },
      },
    },
  },
});

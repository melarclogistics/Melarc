import { described } from '../platform/openapi/described-schema.js';

/**
 * The body of `resolveCutoffException` as the application describes it (S1.15): the contract's `CutoffExceptionResolution`. The decision is
 * one of two, and the note is the reason, which the audit record keeps; a note that is blank is `REASON_REQUIRED`, which the schema's
 * `minLength` cannot say (a note of spaces is long enough), so the service judges it.
 */
export const CUTOFF_EXCEPTION_RESOLUTION_BODY = described({
  type: 'object',
  required: ['decision', 'note'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['APPROVE_SAME_DAY', 'RESCHEDULE_NEXT_DAY'] },
    note: { type: 'string', minLength: 1, description: 'Mandatory (blank is REASON_REQUIRED).' },
  },
});

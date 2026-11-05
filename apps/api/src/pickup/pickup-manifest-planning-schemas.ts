import { described } from '../platform/openapi/described-schema.js';

/**
 * The bodies of the planning operations of a manifest (S1.21; `ManifestStopOrder`, `RiderAssignment` and `ManifestCancel` of the
 * contract), as the application describes them. The conformance check compares them with the contract; a member added to the contract and
 * not here is a finding, and a body the contract's schema refuses never reaches the service.
 */

/** The complete sequence of the stops of a draft manifest: every stop once, in the order Ops wants them. Not a delta, and no route optimised. */
export const MANIFEST_STOP_ORDER_BODY = described({
  type: 'object',
  required: ['ordered_stop_ids'],
  additionalProperties: false,
  properties: {
    ordered_stop_ids: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', format: 'uuid' },
    },
  },
});

/** The rider a manifest is given to: an identifier and nothing else (the hub, the state and the moment are the server's). */
export const RIDER_ASSIGNMENT_BODY = described({
  type: 'object',
  required: ['rider_id'],
  additionalProperties: false,
  properties: {
    rider_id: { type: 'string', format: 'uuid' },
  },
});

/** Why a manifest is cancelled, in the operator's own words: mandatory (a blank note is `REASON_REQUIRED`, which the service answers). */
export const MANIFEST_CANCEL_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: { type: 'string', minLength: 1 },
  },
});

import { described } from '../platform/openapi/described-schema.js';

/**
 * The body of `skipPickupStop` as the application describes it (S1.23; the contract's inline body of the operation): the reason, which is a
 * code of the `PICKUP_STOP_SKIP` catalogue, and the note, which the reason's own metadata makes mandatory or leaves optional. The conformance
 * check compares it with the contract. A body the schema refuses never reaches the service; a code the catalogue refuses is the service's
 * (`REASON_REQUIRED`, `REASON_NOT_ACTIVE`).
 */
export const STOP_SKIP_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: {
      type: 'string',
      description:
        'An ACTIVE PICKUP_STOP_SKIP code. A DELIVERY_FAILURE, RECIPIENT_CONTACT or 21.5 pickup-failure code is refused with REASON_NOT_ACTIVE - a skip is not a failure, and 5 gives them separate rows with different effects.',
    },
    note: {
      type: 'string',
      description: "Mandatory where the reason's requires_note is true (35.9.2).",
    },
  },
});

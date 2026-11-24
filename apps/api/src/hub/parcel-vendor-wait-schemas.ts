import { described } from '../platform/openapi/described-schema.js';
import { PARCEL_WAIT_NOTE_MAX } from './intake-parcel-wait.schema.js';

/**
 * The shapes of the mark of a parcel the officer is waiting on the vendor's details for (Run G1, contract 5.120.0; D-S7-12): the contract's `ParcelWaiting` (the body of `setParcelWaitingForVendor`), `ParcelWaitingForVendor`
 * (its answer) and `ParcelWaitingMark` (what a parcel's row of the worklist says of it). **No phone number, address or key is in any of them**: the note is one short line the officer writes, and the application
 * refuses a note that holds a number.
 */
export const PARCEL_WAIT_BODY = described({
  type: 'object',
  required: ['waiting'],
  additionalProperties: false,
  properties: {
    waiting: { type: 'boolean' },
    note: { type: 'string', maxLength: PARCEL_WAIT_NOTE_MAX },
  },
});

export const PARCEL_WAIT_SCHEMA = described({
  type: 'object',
  required: ['parcel_id', 'waiting', 'since', 'note'],
  additionalProperties: false,
  properties: {
    parcel_id: { type: 'string', format: 'uuid' },
    waiting: { type: 'boolean' },
    since: { type: ['string', 'null'], format: 'date-time' },
    note: { type: ['string', 'null'] },
  },
});

/** What a parcel's row of the worklist says of the mark: since when, and the officer's note, if there is one. Null when the parcel is not waiting. */
export const PARCEL_WAIT_MARK = {
  oneOf: [
    {
      type: 'object',
      required: ['since', 'note'],
      properties: {
        since: { type: 'string', format: 'date-time' },
        note: { type: ['string', 'null'] },
      },
    },
    { type: 'null' },
  ],
} as const;

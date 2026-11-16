import { described } from '../platform/openapi/described-schema.js';
import { PARCEL_PHOTO_EXCEPTION_SCHEMA } from './collection-schemas.js';
import { STOP_EVIDENCE_PURPOSES, STOP_EVIDENCE_STATES } from './pickup-stop-evidence-views.js';

/**
 * The shapes of `listPickupStopEvidence` as the application describes them (`StopEvidenceItem` and `StopEvidenceList` of the contract); the conformance check compares
 * them with the contract. **No item carries an object key, an address or a signed operation**: a route test holds the closed list of fields to the contract's.
 */

const count = { type: 'integer', minimum: 0 } as const;

export const STOP_EVIDENCE_ITEM_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'purpose',
    'state',
    'captured_at',
    'uploaded_at',
    'content_type',
    'scanned_clean',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    purpose: { type: 'string', enum: [...STOP_EVIDENCE_PURPOSES] },
    state: { type: 'string', enum: [...STOP_EVIDENCE_STATES] },
    captured_at: { type: 'string', format: 'date-time' },
    uploaded_at: { type: ['string', 'null'], format: 'date-time' },
    content_type: { type: 'string' },
    scanned_clean: { type: 'boolean' },
  },
});

export const STOP_EVIDENCE_LIST_SCHEMA = described({
  type: 'object',
  required: ['items', 'next_page_token', 'parcel_photos', 'parcel_photo_exception'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: STOP_EVIDENCE_ITEM_SCHEMA },
    next_page_token: { type: ['string', 'null'] },
    parcel_photos: {
      type: 'object',
      required: ['declared', 'stored', 'pending', 'expired'],
      additionalProperties: false,
      properties: { declared: count, stored: count, pending: count, expired: count },
    },
    parcel_photo_exception: {
      oneOf: [PARCEL_PHOTO_EXCEPTION_SCHEMA, { type: 'null' }],
    },
  },
});

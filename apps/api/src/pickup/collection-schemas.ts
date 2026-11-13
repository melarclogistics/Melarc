import { described } from '../platform/openapi/described-schema.js';

/**
 * The photo of every parcel counted (D-A10, 12 November 2026; pickup-collection.md section 5.5): the same members in the count's request and in its answer, as the other creation fields
 * are. **No `maxItems` and no `uniqueItems`**: a pickup has as many parcels as it has (the transport bounds the body), and a photo named twice is the service's `duplicate`, not a
 * generic schema refusal.
 */
const PARCEL_PHOTO_IDS = {
  type: 'array',
  items: { type: 'string', format: 'uuid' },
  description:
    'The photo of each parcel counted: exactly `collected_count` ids of `PARCEL_PHOTO` evidence of this stop, `STORED` and captured by this rider, each attached to one count only; none when Ops let the stop through without photos. A different number, or an id named twice, is `VALIDATION_FAILED` (rules `parcel_photo_count` and `duplicate`); a record that cannot be counted is `EVIDENCE_NOT_STORED`, the same answer for each.',
} as const;

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
    parcel_photo_ids: PARCEL_PHOTO_IDS,
    captured_at: {
      type: 'string',
      format: 'date-time',
      description:
        'Field capture time, distinct from upload time. Preserved on sync along with ordering and conflict status (§35.3.9).',
    },
  },
});

/**
 * The body of `authoriseParcelPhotoException` (D-A10; the contract's `ParcelPhotoExceptionCreate`): the officer's note, which is required and says why the stop is let through without
 * parcel photos. A blank note is `REASON_REQUIRED`, which the service answers; the schema only says what a note is.
 */
export const PARCEL_PHOTO_EXCEPTION_CREATE_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      description:
        'Why the stop is let through without parcel photos (the camera failed, the photos cannot be sent). Required; a blank note is `REASON_REQUIRED`. Held to the screening of every note.',
    },
  },
});

/** The answer of `authoriseParcelPhotoException`: the contract's `ParcelPhotoException`. */
export const PARCEL_PHOTO_EXCEPTION_SCHEMA = described({
  type: 'object',
  required: ['id', 'pickup_stop_id', 'authorised_by', 'authorised_at', 'note'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    pickup_stop_id: { type: 'string', format: 'uuid' },
    authorised_by: {
      type: 'string',
      format: 'uuid',
      description: 'The officer who let the stop through: the session, never the request.',
    },
    authorised_at: {
      type: 'string',
      format: 'date-time',
      description: 'The database’s clock.',
    },
    note: { type: 'string' },
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
    parcel_photo_ids: PARCEL_PHOTO_IDS,
    captured_at: { type: 'string', format: 'date-time' },
    id: { type: 'string', format: 'uuid' },
    pickup_stop_id: { type: 'string', format: 'uuid' },
    declared_count: { type: 'integer' },
    variance: { type: 'string', enum: ['MATCH', 'SHORT'] },
    office_notified_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

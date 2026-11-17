import { described } from '../platform/openapi/described-schema.js';

/**
 * The largest number of parcels a count can say (a whole number of four bytes: what the record's column holds). The contract states it on `collected_count` and on the other inputs that
 * take a number of parcels, so that a client that reads the contract knows the bound the service and the database enforce.
 */
const MAX_PARCELS = 2_147_483_647;

/**
 * The photo of every parcel counted (D-A10, 12 November 2026; pickup-collection.md section 5.5): the same members in the count's request and in its answer, as the other creation fields
 * are. **No `maxItems` and no `uniqueItems`**: a pickup has as many parcels as it has (the transport bounds the body), and a photo named twice is the service's `duplicate`, not a
 * generic schema refusal. **Since D-E1 (17 November 2026) they are the photos that were not staged beforehand**: the count attaches the staged photos and these together.
 */
const PARCEL_PHOTO_IDS = {
  type: 'array',
  items: { type: 'string', format: 'uuid' },
  description:
    'The photos of the parcels counted **that were not staged beforehand** (`stageParcelPhotos`): ids of `PARCEL_PHOTO` evidence of this stop, `STORED` and captured by this rider, each attached to one count only. **With the staged photos they are exactly `collected_count`**; none when Ops let the stop through without photos, or when every photo was staged. A different number, or an id named twice (or named and staged), is `VALIDATION_FAILED` (rules `parcel_photo_count` and `duplicate`); a record that cannot be counted is `EVIDENCE_NOT_STORED`, the same answer for each. The order is not significant. In the answer, the ones the request named, in the order named.',
} as const;

/** The body of `stageParcelPhotos` (D-E1; the contract's `ParcelPhotosStage`): the photos of a count that is not yet made, one to 500 of them. */
export const STAGE_PARCEL_PHOTOS_BODY = described({
  type: 'object',
  required: ['parcel_photo_ids'],
  additionalProperties: false,
  properties: {
    parcel_photo_ids: {
      type: 'array',
      minItems: 1,
      maxItems: 500,
      items: { type: 'string', format: 'uuid' },
      description:
        'One to 500 ids of `PARCEL_PHOTO` evidence of this stop, `STORED` and captured by this rider, none attached to a count: **a limit on a request, never on a pickup** (a collection is staged in as many batches as it needs). An id named twice is `VALIDATION_FAILED` (rule `duplicate`); a record that cannot be used is `EVIDENCE_NOT_STORED`, the same answer for each. A photo that is already staged is a no-op.',
    },
  },
});

/** The answer of `stageParcelPhotos`: the contract's `ParcelPhotosStaged`. */
export const PARCEL_PHOTOS_STAGED_SCHEMA = described({
  type: 'object',
  required: ['pickup_stop_id', 'staged_count'],
  additionalProperties: false,
  properties: {
    pickup_stop_id: { type: 'string', format: 'uuid' },
    staged_count: {
      type: 'integer',
      minimum: 1,
      description:
        'How many parcel photos are staged for the stop, at the end of this batch (never a list of them: the set is as large as the count).',
    },
  },
});

/**
 * The body of `recordCollection` as the application describes it (S1.26; the contract's `CollectionRecordCreate`): the count, the reason of a short
 * one, a note, the evidence, and the moment the device counted. The conformance check compares it with the contract. A body the schema refuses never
 * reaches the service; what the schema cannot say (zero, a count the column cannot hold, a reason for a count that matches, a reason the catalogue refuses)
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
      maximum: MAX_PARCELS,
      description:
        'Zero is a failed pickup — `ZERO_COLLECTION_IS_FAILURE` (§36.4). At most 2,147,483,647: the number the record holds.',
    },
    variance_reason_code: {
      type: 'string',
      description:
        'Required when `collected_count` is not `declared_count`: a code of the `PICKUP_SHORT_COUNT` catalogue when fewer were collected, of the `PICKUP_OVER_COUNT` catalogue when more were (D-D5). Its metadata may make a note or photo mandatory in turn (§35.9.2). Absent on a count that differs → `REASON_REQUIRED`; refused on a count that matches.',
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
    collected_count: { type: 'integer', minimum: 0, maximum: MAX_PARCELS },
    variance_reason_code: { type: 'string' },
    variance_note: { type: 'string' },
    evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    parcel_photo_ids: PARCEL_PHOTO_IDS,
    parcel_photo_count: {
      type: 'integer',
      minimum: 1,
      description:
        'How many parcel photos the count attached, **staged and named together** (equal to `collected_count`); absent, never zero, for a stop Ops let through without photos.',
    },
    captured_at: { type: 'string', format: 'date-time' },
    id: { type: 'string', format: 'uuid' },
    pickup_stop_id: { type: 'string', format: 'uuid' },
    declared_count: { type: 'integer' },
    variance: { type: 'string', enum: ['MATCH', 'SHORT', 'OVER'] },
    office_notified_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

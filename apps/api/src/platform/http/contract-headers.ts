import { described } from '../openapi/described-schema.js';

/** The contract's `Idempotency-Key` parameter: a printable token the store keeps (`isIdempotencyKey`). */
export const IDEMPOTENCY_KEY_SCHEMA = described({ type: 'string', maxLength: 128 });

/** The contract's `If-Match` parameter: the ETag of the last read of the request, which the mutation compares under the request's lock. */
export const IF_MATCH_SCHEMA = described({ type: 'string' });

/** The one header of the read of a record: the version a mutation takes back as `If-Match`. */
export const ETAG_HEADERS = {
  ETag: {
    description: 'Opaque record version. Send back as `If-Match` on the next mutation.',
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

/**
 * The header of the answer that makes an order (`itemizeOrder`): the vendor's version after the order, which the next order of the same vendor takes as `If-Match`. The first order of a cleared vendor moves it
 * from ready to being worked, so the token the screen read is stale for the next order; the answer gives the new one and the screen reads nothing between two orders. It is a header of its own because an order is
 * not the record this token is a version of.
 */
export const INTAKE_ETAG_HEADERS = {
  'Intake-ETag': {
    description:
      "The vendor's version after this order. Send it as `If-Match` on the vendor's next order. A retry under the same key answers the vendor's version as it is then.",
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

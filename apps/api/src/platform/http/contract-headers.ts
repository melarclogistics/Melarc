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

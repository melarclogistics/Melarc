import { RECORD_LOOKUP_KINDS } from '../domain-ports/record-lookup.port.js';
import { described } from '../openapi/described-schema.js';

/**
 * The shape of the answer of `lookupRecords` as the application describes it (`RecordLookupKind`, `RecordLookupResult` and `RecordLookupPage` of
 * the contract). The contract's schema is what an answer is validated against outside production; this is what the application says it gives,
 * and the conformance check compares the two (`pnpm run contract:check`). A result is a pointer to a record and the facts that say where it
 * stands, **and nothing else**: closed against any other property, so that a field of a record can never ride along in an answer, and it names
 * no page and carries no sentence (the Product Owner's decision D1, 6 November 2026).
 */
export const RECORD_LOOKUP_KIND_SCHEMA = described({
  type: 'string',
  enum: [...RECORD_LOOKUP_KINDS],
});

const RECORD_LOOKUP_HUB_SCHEMA = described({
  type: 'object',
  required: ['id', 'display_name'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    display_name: { type: 'string' },
  },
});

export const RECORD_LOOKUP_RESULT_SCHEMA = described({
  type: 'object',
  required: ['kind', 'id', 'title'],
  additionalProperties: false,
  properties: {
    kind: RECORD_LOOKUP_KIND_SCHEMA,
    id: { type: 'string', format: 'uuid' },
    code: { type: 'string' },
    title: { type: 'string' },
    state: { type: 'string' },
    hub: RECORD_LOOKUP_HUB_SCHEMA,
    service_date: { type: 'string', format: 'date' },
    sender_name: { type: 'string' },
    phone_hint: { type: 'string', maxLength: 24 },
  },
});

/**
 * The body of `lookupRecords` (`RecordLookupRequest` of the contract): the one field `q`, closed against any other. The text is in the body and
 * never in the address, because a phone number typed in full must not travel in a URL (the Product Owner's decision of 6 November 2026).
 */
export const RECORD_LOOKUP_REQUEST_SCHEMA = described({
  type: 'object',
  required: ['q'],
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 2, maxLength: 64 },
  },
});

export const RECORD_LOOKUP_PAGE_SCHEMA = described({
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: {
    items: { type: 'array', maxItems: 20, items: RECORD_LOOKUP_RESULT_SCHEMA },
  },
});

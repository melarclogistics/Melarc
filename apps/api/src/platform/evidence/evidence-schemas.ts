import { described } from '../openapi/described-schema.js';
import { EVIDENCE_OWNER_TYPES, EVIDENCE_PURPOSES, EVIDENCE_STATES } from './evidence-vocabulary.js';

/**
 * The schemas of the three evidence operations as the application describes them (S1.11; the contract's `EvidenceCreate`, `Evidence`, `EvidenceUploadTicket` and
 * `EvidenceRetrievalAuthorization`). The conformance check compares them with the contract. A body the schema refuses never reaches the service; what the schema cannot
 * say (a type the settings do not allow, a size above the ceiling, a hash that is not a SHA-256, a capture in the future, an owner the platform has no act for) is the service's.
 * **Neither scope column, the storage reference, the access rule, the retention policy nor the state is in the request**: they are the server's.
 */
export const EVIDENCE_CREATE_BODY = described({
  type: 'object',
  required: [
    'owner_type',
    'owner_id',
    'purpose',
    'captured_at',
    'content_type',
    'byte_size',
    'checksum_sha256',
  ],
  additionalProperties: false,
  properties: {
    owner_type: { type: 'string', enum: [...EVIDENCE_OWNER_TYPES] },
    owner_id: { type: 'string', format: 'uuid' },
    purpose: { type: 'string', enum: [...EVIDENCE_PURPOSES] },
    captured_at: { type: 'string', format: 'date-time' },
    device_context: { type: 'object', additionalProperties: true },
    content_type: { type: 'string' },
    byte_size: { type: 'integer', minimum: 1 },
    checksum_sha256: { type: 'string' },
  },
});

export const EVIDENCE_SCHEMA = described({
  type: 'object',
  required: [
    'id',
    'owner_type',
    'owner_id',
    'purpose',
    'captured_at',
    'captured_by_actor',
    'state',
    'access_rule',
    'retention_policy',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    owner_type: { type: 'string' },
    owner_id: { type: 'string', format: 'uuid' },
    responsible_hub_id: { type: ['string', 'null'], format: 'uuid', readOnly: true },
    vendor_organization_id: { type: ['string', 'null'], format: 'uuid', readOnly: true },
    purpose: { type: 'string' },
    captured_at: { type: 'string', format: 'date-time' },
    captured_by_actor: { type: 'string', format: 'uuid' },
    device_context: { type: ['object', 'null'], additionalProperties: true },
    state: { type: 'string', enum: [...EVIDENCE_STATES] },
    access_rule: { type: 'string' },
    retention_policy: { type: 'string' },
    content_type: { type: ['string', 'null'] },
    byte_size: { type: ['integer', 'null'] },
    uploaded_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

export const EVIDENCE_UPLOAD_TICKET_SCHEMA = described({
  type: 'object',
  required: ['evidence', 'upload'],
  properties: {
    evidence: EVIDENCE_SCHEMA,
    upload: {
      type: 'object',
      required: ['method', 'url', 'expires_at'],
      properties: {
        method: { type: 'string' },
        url: { type: 'string' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        form_fields: { type: 'object', additionalProperties: { type: 'string' } },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
  },
});

export const EVIDENCE_RETRIEVAL_SCHEMA = described({
  type: 'object',
  required: ['method', 'url', 'expires_at'],
  additionalProperties: false,
  properties: {
    method: { type: 'string' },
    url: { type: 'string' },
    headers: { type: 'object', additionalProperties: { type: 'string' } },
    expires_at: { type: 'string', format: 'date-time' },
  },
});

/** The header of a retrieval authorization: the capability is a bearer credential and is never cached. */
export const NO_STORE_HEADERS = {
  'Cache-Control': {
    description: 'Always `no-store`. The capability must not be cached by any intermediary',
    required: true,
    schema: { type: 'string', const: 'no-store' },
  },
} as unknown as Record<string, never>;

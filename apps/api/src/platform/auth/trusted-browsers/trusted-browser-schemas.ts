import { described } from '../../openapi/described-schema.js';

/**
 * The shapes of the trusted-browser operations as the application describes them (`TrustedBrowser`, `TrustedBrowserList` and
 * `TrustedBrowsersRevoked` of the contract); the conformance check compares them with the contract. A trusted browser is shown by its
 * label and its dates and **by nothing that could be used to sign in**: no credential, no hash, no factor and no generation.
 */
export const TRUSTED_BROWSER_SCHEMA = described({
  type: 'object',
  required: ['id', 'label', 'created_at', 'expires_at', 'last_used_at', 'current'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    label: { type: 'string', maxLength: 80 },
    created_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    last_used_at: { type: ['string', 'null'], format: 'date-time' },
    current: { type: 'boolean' },
  },
});

export const TRUSTED_BROWSER_LIST_SCHEMA = described({
  type: 'object',
  required: ['items'],
  additionalProperties: false,
  properties: { items: { type: 'array', items: TRUSTED_BROWSER_SCHEMA } },
});

export const TRUSTED_BROWSERS_REVOKED_SCHEMA = described({
  type: 'object',
  required: ['revoked'],
  additionalProperties: false,
  properties: { revoked: { type: 'integer', minimum: 0 } },
});

/** The headers of the removal that may clear the cookie: present on the answer that does, absent on the one that does not. */
export const TRUSTED_BROWSER_REMOVED_HEADERS = {
  'Set-Cookie': {
    description: 'One real Set-Cookie field line, when the browser removed is the one asking',
    required: false,
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

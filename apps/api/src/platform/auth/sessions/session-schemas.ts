import { described } from '../../openapi/described-schema.js';

/**
 * The shape of the caller's own session as the application describes it (`SessionRecord`, `SessionDisplay` and `CurrentSession` of the
 * contract). The contract's schema is what an answer is validated against outside production; this is what the application says it
 * gives, and the conformance check compares the two (`pnpm run contract:check`). It lives with the sessions because every operation that
 * answers with the caller's session (the staff sign-ins, `getCurrentSession`, later the vendor's) describes it the same way.
 */
const UUID = { type: 'string', format: 'uuid' } as const;
const INSTANT = { type: 'string', format: 'date-time' } as const;

export const SESSION_RECORD_SCHEMA = described({
  type: 'object',
  required: ['id', 'principal_type', 'state', 'expires_at'],
  properties: {
    id: UUID,
    principal_type: { type: 'string', enum: ['STAFF', 'RIDER', 'VENDOR'] },
    principal_id: UUID,
    state: { type: 'string', enum: ['ACTIVE', 'TERMINATED'] },
    authorized_hub_ids: { type: 'array', items: UUID },
    permissions: {
      type: 'array',
      uniqueItems: true,
      readOnly: true,
      items: { type: 'string', pattern: '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$' },
    },
    registered_device_id: { type: ['string', 'null'], format: 'uuid' },
    issued_at: INSTANT,
    expires_at: INSTANT,
    last_activity_at: INSTANT,
    termination_reason: {
      type: ['string', 'null'],
      enum: [
        'SIGNED_OUT',
        'SUPERSEDED_BY_NEW_LOGIN',
        'REPLACED_BY_NEW_SESSION',
        'EXPIRED',
        'CREDENTIAL_CHANGED',
        'SUSPENDED',
        'OFFBOARDED',
        'ADMIN_REVOKED',
        'AUTHORITY_CHANGED',
        'HUB_SCOPE_CHANGED',
        'DEVICE_REVOKED',
        'DEVICE_REPLACED',
        'MFA_RESET',
        null,
      ],
    },
  },
});

export const SESSION_DISPLAY_SCHEMA = described({
  type: 'object',
  required: ['principal_display_name', 'authorized_hubs'],
  properties: {
    principal_display_name: { type: ['string', 'null'] },
    authorized_hubs: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'display_name'],
        additionalProperties: false,
        properties: { id: UUID, display_name: { type: 'string' } },
      },
    },
  },
});

/**
 * The one header of the `204` of `signOut`: the cookies a browser sign-out expires. Not on every answer of the operation: a request
 * authenticated by a Rider's bearer credential is owed none, and gets none.
 */
export const SIGNED_OUT_HEADERS = {
  'Set-Cookie': {
    description: 'One or more real Set-Cookie field lines',
    required: false,
    schema: { type: 'string' },
  },
} as unknown as Record<string, never>;

/** `SessionRecord` and `SessionDisplay` composed, and closed against anything else. */
export const CURRENT_SESSION_SCHEMA = described({
  allOf: [SESSION_RECORD_SCHEMA, SESSION_DISPLAY_SCHEMA],
  unevaluatedProperties: false,
});

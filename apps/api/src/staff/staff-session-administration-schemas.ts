import { NOTE_MAX_LENGTH } from './staff-note.js';
import { SESSION_RECORD_SCHEMA } from '../platform/auth/sessions/session-schemas.js';
import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the three operations of S0.37 as the application describes them (`Session`, `SessionRevoke`, `MfaReset` and
 * `MfaResetResult` of the contract). The contract's schemas are what a request is validated against and an answer outside production
 * is judged by; these are what the application says it takes and gives, and the conformance check compares the two.
 */

/**
 * The ordinary projection of a session (`Session`): `SessionRecord` and nothing else, closed. It is what the list and the revocation
 * return for another principal's session, so it carries no display name, no hub list by name, no token, no hash and no bundle contents,
 * and **no `permissions`** (that list is the caller's own session's).
 */
export const SESSION_SCHEMA = described({
  allOf: [SESSION_RECORD_SCHEMA],
  unevaluatedProperties: false,
});

export const SESSION_LIST_SCHEMA = described({
  type: 'object',
  required: ['items'],
  properties: { items: { type: 'array', items: SESSION_SCHEMA } },
});

export const SESSION_REVOKE_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
    note: { type: 'string', maxLength: NOTE_MAX_LENGTH },
  },
});

export const MFA_RESET_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
    note: { type: 'string', maxLength: NOTE_MAX_LENGTH },
  },
});

/** What a reset gives back: counts and an expiry, never the grant, a seed, a token or a QR (the acting administrator must not be able to enrol). */
export const MFA_RESET_RESULT = described({
  type: 'object',
  required: ['sessions_terminated'],
  properties: {
    sessions_terminated: { type: 'integer' },
    reenrolment_grant_issued: { type: 'boolean' },
    coalesced: { type: 'boolean' },
    grant_expires_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

import { described } from '../../openapi/described-schema.js';
import { CURRENT_SESSION_SCHEMA } from '../sessions/session-schemas.js';

/**
 * The shapes of `staffSignIn` as the application describes them (`StaffSignIn`, `MfaChallenge` and `CurrentSession` of the contract);
 * the conformance check compares them with the contract. The request body is closed, and its password is capped at 128 as sent with no
 * minimum: a short guess is a wrong password, and the service bounds the length again after NFKC.
 */
export const STAFF_SIGN_IN_BODY = described({
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string' },
    password: { type: 'string', maxLength: 128 },
  },
});

/** What a privileged sign-in returns instead of a session: it grants nothing and is not a partial session. */
export const MFA_CHALLENGE_SCHEMA = described({
  type: 'object',
  required: ['challenge_id', 'expires_at'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', format: 'uuid' },
    expires_at: { type: 'string', format: 'date-time' },
  },
});

export { CURRENT_SESSION_SCHEMA };

/** The two headers of an answer that issues a session: the cookies, and `no-store` so that nothing keeps the credential. */
export const SESSION_ISSUED_HEADERS = {
  'Set-Cookie': {
    description: 'One or more real Set-Cookie field lines',
    // Not on every answer of the operation: the 202 that grants no session sets none.
    required: false,
    schema: { type: 'string' },
  },
  'Cache-Control': {
    description: 'no-store',
    required: true,
    schema: { type: 'string', const: 'no-store' },
  },
} as unknown as Record<string, never>;

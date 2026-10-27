import { described } from '../../openapi/described-schema.js';

/**
 * The shape of `completeStaffMfaSignIn` as the application describes it (`MfaSignInComplete` of the contract); the conformance check
 * compares it with the contract. The answer is the caller's own session (`CURRENT_SESSION_SCHEMA`). The body is closed, and the code
 * is exactly six decimal digits: anything else is `VALIDATION_FAILED`, and a well-formed code that does not prove the factor is
 * `MFA_PROOF_INVALID`.
 */
export const MFA_SIGN_IN_BODY = described({
  type: 'object',
  required: ['challenge_id', 'code'],
  additionalProperties: false,
  properties: {
    challenge_id: { type: 'string', format: 'uuid' },
    code: { type: 'string', pattern: '^[0-9]{6}$' },
    trust_browser: { type: 'boolean', default: false },
  },
});

import { described } from '../../openapi/described-schema.js';

/**
 * The shape of `requestCredentialRecovery`'s body as the application describes it (`RecoveryRequestCreate` of the contract); the
 * conformance check compares it with the contract. **Closed, and with no destination field**: that is the guard, and a body that names an
 * address is refused by it (`VALIDATION_FAILED`), never accepted and ignored.
 */
export const RECOVERY_REQUEST_BODY = described({
  type: 'object',
  required: ['principal_type', 'identifier'],
  additionalProperties: false,
  properties: {
    principal_type: { type: 'string', enum: ['STAFF', 'VENDOR'] },
    identifier: { type: 'string' },
  },
});

/**
 * The body of `completeCredentialRecovery` (`RecoveryComplete`): the token and the new credential, held to 12 to 128 code points as sent
 * (the service counts them again after NFKC). Closed: nothing names a principal, whose type and identity are the request's.
 */
export const RECOVERY_COMPLETE_BODY = described({
  type: 'object',
  required: ['token', 'new_credential'],
  additionalProperties: false,
  properties: {
    token: { type: 'string' },
    new_credential: { type: 'string', minLength: 12, maxLength: 128 },
  },
});

/** The headers of the completion's `204`: the device cookie of a vendor's browser, and no caching. */
export const RECOVERY_COMPLETED_HEADERS = {
  'Set-Cookie': {
    description: 'One or more real Set-Cookie field lines',
    required: false,
    schema: { type: 'string' },
  },
  'Cache-Control': {
    description: 'no-store',
    required: true,
    schema: { type: 'string', const: 'no-store' },
  },
} as unknown as Record<string, never>;

/**
 * The answer of `recoverStaffCredential` and `recoverVendorCredential` (`RecoveryRequest` of the contract): where the request stands, and
 * `coalesced` when an existing live request absorbed the call. **The token never appears here.**
 */
export const RECOVERY_REQUEST_SCHEMA = described({
  type: 'object',
  required: ['id', 'principal_type', 'channel', 'state', 'expires_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    principal_type: { type: 'string', enum: ['STAFF', 'RIDER', 'VENDOR'] },
    channel: { type: 'string', enum: ['EMAIL', 'SMS', 'OPS_VERIFIED'] },
    state: { type: 'string', enum: ['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] },
    issued_at: { type: 'string', format: 'date-time' },
    expires_at: { type: 'string', format: 'date-time' },
    consumed_at: { type: ['string', 'null'], format: 'date-time' },
    initiated_by: { type: ['string', 'null'], format: 'uuid' },
    coalesced: { type: 'boolean', readOnly: true },
  },
});

/** The body of the two administrator recoveries (`CredentialRecoveryInitiation`): a reason and an optional note; the path names the principal. */
export const CREDENTIAL_RECOVERY_INITIATION_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
    note: { type: 'string' },
  },
});

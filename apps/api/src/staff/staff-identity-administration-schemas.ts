import { NOTE_MAX_LENGTH } from './staff-note.js';
import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the three operations that make and settle a staff identity (S0.36) as the application describes them: what each takes and
 * gives. The contract's schemas are what a request is validated against at run time; these are what the application **says**, and the
 * conformance check compares the two (`pnpm run contract:check`). A body is closed (`additionalProperties: false`): there is no `status`,
 * no `created_by`, no credential and no `mfa_enrolled` to supply (`AC-SLICE-000-33`), and the approver cannot name another bundle.
 */
export const STAFF_IDENTITY_CREATE_BODY = described({
  type: 'object',
  required: ['work_email', 'full_name', 'role_bundle_id'],
  additionalProperties: false,
  properties: {
    work_email: { type: 'string' },
    full_name: { type: 'string' },
    phone: { type: 'string' },
    role_bundle_id: { type: 'string', format: 'uuid' },
    primary_hub_id: { type: 'string', format: 'uuid' },
  },
});

export const STAFF_IDENTITY_APPROVAL_BODY = described({
  type: 'object',
  required: ['approved'],
  additionalProperties: false,
  properties: {
    approved: { type: 'boolean' },
    reason_code: { type: 'string' },
    note: { type: 'string', maxLength: NOTE_MAX_LENGTH },
  },
});

export const SETUP_GRANT_REISSUE_BODY = described({
  type: 'object',
  required: ['reason_code'],
  additionalProperties: false,
  properties: {
    reason_code: { type: 'string' },
    note: { type: 'string', maxLength: NOTE_MAX_LENGTH },
  },
});

/** `SetupGrant`: where a grant stands, and never its token (the token travels to the work email, sealed in the delivery job). */
export const SETUP_GRANT_SCHEMA = described({
  type: 'object',
  required: ['id', 'principal_type', 'principal_id', 'purpose', 'state', 'issued_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    principal_type: { type: 'string', enum: ['STAFF', 'RIDER', 'VENDOR'] },
    principal_id: { type: 'string', format: 'uuid' },
    purpose: {
      type: 'string',
      enum: [
        'STAFF_CREDENTIAL_SETUP',
        'MFA_ENROLMENT',
        'MFA_REENROLMENT',
        'BOOTSTRAP_SETUP',
        'RIDER_DEVICE_ENROLMENT',
        'RIDER_DEVICE_REREGISTRATION',
        'VENDOR_CREDENTIAL_SETUP',
        'VENDOR_DEVICE_ENROLMENT',
      ],
    },
    state: { type: 'string', enum: ['PENDING', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] },
    issued_at: { type: 'string', format: 'date-time' },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    consumed_at: { type: ['string', 'null'], format: 'date-time' },
  },
});

/** The contract's `IdempotencyKey` and `IfMatch` parameters, which the application states for the operations that take them. */
export const IDEMPOTENCY_KEY_SCHEMA = { type: 'string', maxLength: 128 } as const;
export const IF_MATCH_SCHEMA = { type: 'string' } as const;

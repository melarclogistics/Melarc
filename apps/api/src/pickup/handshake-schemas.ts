import { described } from '../platform/openapi/described-schema.js';

/**
 * The shapes of the handshake's five operations as the application describes them (S1.27; the contract's `Handshake`, `HandshakeIssued`,
 * `HandshakeVerify`, `SmsFallbackRequest`, `HandshakeOverride` and `HandshakeResolve`). The conformance check compares them with the contract.
 * A body the schema refuses never reaches the service; what a schema cannot say (a blank note, a code of another length, a trigger that is not a
 * technical failure) is the service's.
 */
export const HANDSHAKE_SCHEMA = described({
  type: 'object',
  required: ['stop_id', 'state', 'direction'],
  properties: {
    stop_id: { type: 'string', format: 'uuid' },
    state: {
      type: 'string',
      enum: [
        'PENDING',
        'CODE_GENERATED',
        'CODE_DELIVERED',
        'VERIFIED',
        'EXPIRED',
        'EXHAUSTED',
        'MANUALLY_RESOLVED',
        'DISPUTED',
      ],
    },
    direction: {
      type: 'string',
      enum: ['VENDOR_ENTERED_RIDER_DISPLAYED', 'SENDER_SMS_RIDER_ENTERED'],
    },
    channel: { type: ['string', 'null'], enum: ['PORTAL', 'SMS_FALLBACK', 'OPS_OVERRIDE', null] },
    attempts: { type: 'integer' },
    expires_at: { type: ['string', 'null'], format: 'date-time' },
    fallback_used: { type: 'boolean' },
    authorised_by: { type: ['string', 'null'], format: 'uuid' },
  },
});

/** The answer of `initiateHandshake`: the handshake, and the code once, for the rider to show the vendor. */
export const HANDSHAKE_ISSUED_SCHEMA = described({
  allOf: [
    HANDSHAKE_SCHEMA,
    {
      type: 'object',
      properties: {
        display_code: {
          type: 'string',
          description:
            "The one-time code, present ONLY when direction is VENDOR_ENTERED_RIDER_DISPLAYED and ONLY in this response to the assigned rider, which shows it to the vendor. Never present for an ad-hoc sender's handshake (the code goes to the sender by SMS), never returned again, and never logged or audited.",
        },
      },
    },
  ],
});

export const HANDSHAKE_VERIFY_BODY = described({
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string' } },
});

export const SMS_FALLBACK_REQUEST_BODY = described({
  type: 'object',
  required: ['trigger'],
  additionalProperties: false,
  properties: {
    trigger: { type: 'string', enum: ['NO_DATA', 'PORTAL_DOWN', 'VENDOR_BUSY'] },
  },
});

export const HANDSHAKE_OVERRIDE_BODY = described({
  type: 'object',
  required: ['verification_note'],
  additionalProperties: false,
  properties: {
    verification_note: {
      type: 'string',
      description: 'How Ops verified the vendor by other means. Mandatory.',
    },
  },
});

export const HANDSHAKE_RESOLVE_BODY = described({
  type: 'object',
  required: ['note'],
  additionalProperties: false,
  properties: {
    note: {
      type: 'string',
      minLength: 1,
      description: 'How the collection was established by other means; mandatory.',
    },
    evidence_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
  },
});

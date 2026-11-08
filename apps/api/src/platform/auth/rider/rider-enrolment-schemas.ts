import type { OpenAPIObject } from '@nestjs/swagger';

import { DEVICE_PUBLIC_KEY_PATTERN, RIDER_PIN_PATTERN } from './rider-vocabulary.js';

/** A schema as the description of an operation holds it (not a reference to one). */
type SchemaObject = Exclude<
  NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string],
  { $ref: string }
>;

/**
 * The header of the contract's `TrustDataUnavailable` response (`RetryAfter`): whole seconds the client should wait before it tries again. The
 * grant is still good and nothing was written, so the wait is the whole of what the client owes (S0.57).
 */
export const RETRY_AFTER_HEADERS = {
  'Retry-After': {
    description: 'Whole seconds the client should wait before it tries again',
    required: false,
    schema: { type: 'integer', minimum: 1 },
  },
} as unknown as Record<string, never>;

/**
 * The shape `completeRiderDeviceEnrolment` takes, as the application describes it (S0.57; `RiderDeviceEnrolment`). The contract's schema is
 * what a request is validated against at run time; this is what the application **says** it takes, and the conformance check compares the
 * two (`pnpm run contract:check`), so a shape changed on one side only is a finding and not a surprise. What it gives is the registered device
 * the vendor's browser registration gives too (`REGISTERED_DEVICE_SCHEMA`, `vendor-setup-schemas.ts`): identity and status, never a key.
 *
 * The body is closed (`additionalProperties: false`): there is no field for a private key, a device identifier, a principal, a rider or a
 * status, so nothing a handset sends can choose whose device is registered or what it is. The grant names the rider.
 */
export const RIDER_ENROLMENT_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token', 'public_key', 'pin', 'key_attestation'],
  additionalProperties: false,
  properties: {
    setup_token: { type: 'string' },
    public_key: {
      type: 'string',
      pattern: DEVICE_PUBLIC_KEY_PATTERN,
      minLength: 124,
      maxLength: 124,
    },
    pin: { type: 'string', pattern: RIDER_PIN_PATTERN },
    key_attestation: {
      type: 'object',
      required: ['certificate_chain'],
      additionalProperties: false,
      properties: {
        certificate_chain: {
          type: 'array',
          minItems: 1,
          maxItems: 10,
          items: { type: 'string' },
        },
      },
    },
  },
};

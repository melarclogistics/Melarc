import type { OpenAPIObject } from '@nestjs/swagger';

/** A schema as the description of an operation holds it (not a reference to one). */
type SchemaObject = Exclude<
  NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string],
  { $ref: string }
>;

/**
 * The shapes of the vendor's pre-session credential operations as the application describes them (S0.47b, S0.49a; `VendorCredentialSetup`,
 * `AdditionalDeviceEnrolment`, `RegisteredDevice`). The conformance check compares them with the contract. A request body is closed: it
 * names no account, no device identifier and no destination, so nothing a caller sends chooses whose browser is registered or where.
 */
export const VENDOR_CREDENTIAL_SETUP_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token', 'secret'],
  additionalProperties: false,
  properties: {
    setup_token: { type: 'string' },
    secret: { type: 'string', minLength: 12, maxLength: 128 },
  },
};

/** `VendorSignIn`: the identifier and the secret, and no device identifier: the browser proves itself with its cookie. */
export const VENDOR_SIGN_IN_BODY: SchemaObject = {
  type: 'object',
  required: ['account_identifier', 'secret'],
  additionalProperties: false,
  properties: {
    account_identifier: { type: 'string', maxLength: 64 },
    secret: { type: 'string', maxLength: 128 },
  },
};

export const ADDITIONAL_DEVICE_ENROLMENT_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token'],
  additionalProperties: false,
  properties: { setup_token: { type: 'string' } },
};

/** A registered browser: identity and status, never the credential or its hash. */
export const REGISTERED_DEVICE_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['id', 'principal_type', 'principal_id', 'device_kind', 'status'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    principal_type: { type: 'string', enum: ['RIDER', 'VENDOR'] },
    principal_id: { type: 'string', format: 'uuid' },
    device_kind: { type: 'string', enum: ['RIDER_ANDROID_KEYPAIR', 'VENDOR_BROWSER_CREDENTIAL'] },
    status: { type: 'string', enum: ['ACTIVE', 'REPLACED', 'REVOKED'] },
    registered_at: { type: 'string', format: 'date-time' },
    registered_by: { type: ['string', 'null'], format: 'uuid' },
  },
};

/** The headers of an answer that issues the browser's credential: the cookie as a real `Set-Cookie` field line, and `no-store`. */
export const DEVICE_ISSUED_HEADERS = {
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

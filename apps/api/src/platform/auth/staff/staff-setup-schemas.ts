import type { OpenAPIObject } from '@nestjs/swagger';

/** A schema as the description of an operation holds it (not a reference to one). */
type SchemaObject = Exclude<
  NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>[string],
  { $ref: string }
>;

/**
 * The shapes of the three credential setup operations as the application describes them (S0.31). The contract's schemas are what a
 * request is validated against at run time; these are what the application **says** it takes and gives, and the conformance check
 * compares the two (`pnpm run contract:check`), so a shape changed on one side only is a finding and not a surprise.
 *
 * A request body is closed (`additionalProperties: false`): a member the contract does not name is refused, and nothing here names an
 * identity, a bundle, a status or a flag a caller could use to choose whose credential is set.
 */
const SETUP_TOKEN = { type: 'string' } as const;

export const MFA_PROVISIONING_SCHEMA: SchemaObject = {
  type: 'object',
  required: ['otpauth_uri'],
  properties: { otpauth_uri: { type: 'string' } },
};

export const CREDENTIAL_SETUP_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token', 'password'],
  additionalProperties: false,
  properties: {
    setup_token: SETUP_TOKEN,
    password: { type: 'string', minLength: 12, maxLength: 128 },
  },
};

export const CREDENTIAL_SETUP_RESULT: SchemaObject = {
  type: 'object',
  required: ['authentication_ready'],
  properties: {
    authentication_ready: { type: 'boolean' },
    mfa_enrolment_required: { type: 'boolean' },
    mfa_provisioning: MFA_PROVISIONING_SCHEMA,
    mfa_setup_token: { type: ['string', 'null'] } as unknown as SchemaObject,
  },
};

export const MFA_ENROLMENT_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token', 'totp_code'],
  additionalProperties: false,
  properties: {
    setup_token: SETUP_TOKEN,
    totp_code: { type: 'string', pattern: '^[0-9]{6}$' },
  },
};

export const MFA_ENROLMENT_RESULT: SchemaObject = {
  type: 'object',
  required: ['authentication_ready'],
  properties: { authentication_ready: { type: 'boolean' } },
};

export const MFA_REENROLMENT_BEGIN_BODY: SchemaObject = {
  type: 'object',
  required: ['setup_token'],
  additionalProperties: false,
  properties: { setup_token: SETUP_TOKEN },
};

export const MFA_REENROLMENT_BEGUN: SchemaObject = {
  type: 'object',
  required: ['mfa_provisioning', 'mfa_setup_token'],
  properties: {
    mfa_provisioning: MFA_PROVISIONING_SCHEMA,
    mfa_setup_token: SETUP_TOKEN,
  },
};

/** `no-store`, on every response that carries a credential or a secret (Product decision, 8 October 2026). */
export const NO_STORE_HEADERS = {
  'Cache-Control': {
    description: 'no-store',
    required: true,
    schema: { type: 'string', const: 'no-store' },
  },
} as unknown as Record<string, never>;

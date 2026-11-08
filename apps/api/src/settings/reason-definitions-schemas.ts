import { described } from '../platform/openapi/described-schema.js';

/**
 * The shape of `listReasonDefinitions` as the application describes it (`ReasonDefinition` and the operation's four filters of the
 * contract); the conformance check compares it with the contract. A reason drives validation (domain-model.md section 3.9): the
 * metadata below is what a workflow reads, and `permittedOperations` is the registry's own fact about which identity operations, and
 * which branch of each, accept the reason (read-only, and null for every other domain).
 */
export const REASON_CHECKPOINTS = ['PRE_DISPATCH', 'NEXT_STOP', 'DOORSTEP'] as const;

/** The identity operations that take a reason (the contract's enumeration of the `operation` filter). */
export const REASON_OPERATIONS = [
  'revokeSession',
  'approveStaffIdentity',
  'resetStaffMfa',
  'reissueStaffCredentialSetup',
  'reissueVendorCredentialSetup',
  'recoverStaffCredential',
  'recoverVendorCredential',
  'reregisterRiderDevice',
  'revokeRiderDevice',
] as const;

/** The branches of an operation that narrow which reasons it accepts. */
export const REASON_BRANCHES = [
  'APPROVAL_REJECTED',
  'FACTOR_ACTIVE',
  'ENROLMENT_UNFINISHED',
] as const;

export const REASON_DEFINITION_SCHEMA = described({
  type: 'object',
  required: [
    'code',
    'domain',
    'label',
    'attribution',
    'active',
    'consumesDeliveryAttempt',
    'permittedOperations',
  ],
  properties: {
    code: { type: 'string' },
    domain: { type: 'string' },
    validCheckpoints: {
      type: ['array', 'null'],
      items: { type: 'string', enum: [...REASON_CHECKPOINTS] },
    },
    label: { type: 'string' },
    attribution: { type: 'string', enum: ['CUSTOMER', 'MELARC', 'EXTERNAL'] },
    consumesDeliveryAttempt: { type: 'boolean' },
    requiresNote: { type: 'boolean' },
    requiresPhoto: { type: 'boolean' },
    requiresContactAttempt: { type: 'boolean' },
    requiresApproval: { type: 'boolean' },
    requiresOpsReview: { type: 'boolean' },
    requiresEscalation: { type: 'boolean' },
    active: { type: 'boolean' },
    permittedOperations: {
      type: ['array', 'null'],
      readOnly: true,
      minItems: 1,
      uniqueItems: true,
      items: {
        type: 'object',
        required: ['operationId', 'branch'],
        additionalProperties: false,
        properties: {
          operationId: { type: 'string', enum: [...REASON_OPERATIONS] },
          branch: { type: ['string', 'null'], enum: [...REASON_BRANCHES, null] },
        },
      },
    },
  },
});

export const REASON_DEFINITIONS_SCHEMA = described({
  type: 'array',
  items: REASON_DEFINITION_SCHEMA,
});

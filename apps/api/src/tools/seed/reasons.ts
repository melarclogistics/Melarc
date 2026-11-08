import type {
  REASON_ATTRIBUTIONS,
  IDENTITY_REASON_DOMAINS,
} from '../../platform/database/schema/reference-data.js';

/**
 * The twelve identity reasons (domain-model.md section 3.9; Product decision, 8 October 2026, closing the input owed on 6 October):
 * the six identity domains, two or one reason each, usable only with the operations in `permittedOperations`. A reason creates no
 * permission and bypasses no prerequisite; an entry is an `operationId`, or `operationId#BRANCH` for a branch of it.
 *
 * For all twelve (the document, "For all twelve"): active, no checkpoints, `consumes_delivery_attempt` false and inert, attribution
 * `MELARC` (which names the workflow owner, not a finding that Melarc caused anything), and no photo, contact attempt, approval,
 * Ops review, escalation or note required. The workflow domains' reasons (delivery failure, recipient contact, pickup stop skip,
 * handoff failure) belong to the slices that use them. `seed-data.test.ts` reads the document and fails when this list and its table
 * differ, and when an operation named here is not an operation of the contract.
 */
export interface ReasonSeed {
  readonly code: string;
  readonly domain: (typeof IDENTITY_REASON_DOMAINS)[number];
  readonly label: string;
  readonly validCheckpoints: null;
  readonly requiresNote: boolean;
  readonly requiresPhoto: boolean;
  readonly requiresContactAttempt: boolean;
  readonly requiresApproval: boolean;
  readonly attribution: (typeof REASON_ATTRIBUTIONS)[number];
  readonly consumesDeliveryAttempt: boolean;
  readonly requiresOpsReview: boolean;
  readonly requiresEscalation: boolean;
  readonly active: boolean;
  readonly permittedOperations: readonly string[];
}

/**
 * A reason as the database function takes it (migration 0005): the columns of `reason_code` by name, in the order of the table.
 * The reference seed and the test fixtures both write reasons, through different functions, and both map them here.
 */
export function reasonCodeRow(reason: ReasonSeed): Readonly<Record<string, unknown>> {
  return {
    code: reason.code,
    domain: reason.domain,
    valid_checkpoints: reason.validCheckpoints,
    label: reason.label,
    requires_note: reason.requiresNote,
    requires_photo: reason.requiresPhoto,
    requires_contact_attempt: reason.requiresContactAttempt,
    requires_approval: reason.requiresApproval,
    attribution: reason.attribution,
    consumes_delivery_attempt: reason.consumesDeliveryAttempt,
    requires_ops_review: reason.requiresOpsReview,
    requires_escalation: reason.requiresEscalation,
    active: reason.active,
    permitted_operations: [...reason.permittedOperations],
  };
}

const identity = (
  code: string,
  domain: ReasonSeed['domain'],
  label: string,
  permittedOperations: readonly string[],
): ReasonSeed => ({
  code,
  domain,
  label,
  validCheckpoints: null,
  requiresNote: false,
  requiresPhoto: false,
  requiresContactAttempt: false,
  requiresApproval: false,
  attribution: 'MELARC',
  consumesDeliveryAttempt: false,
  requiresOpsReview: false,
  requiresEscalation: false,
  active: true,
  permittedOperations,
});

export const IDENTITY_REASONS: readonly ReasonSeed[] = [
  identity('SESSION_SECURITY_CONCERN', 'SESSION_REVOCATION', 'Session security concern', [
    'revokeSession',
  ]),
  identity(
    'SESSION_ACCESS_NO_LONGER_REQUIRED',
    'SESSION_REVOCATION',
    'Session access no longer required',
    ['revokeSession'],
  ),
  identity(
    'STAFF_DETAILS_INCORRECT',
    'STAFF_PROFILE_REJECTION',
    'Staff details require correction',
    ['approveStaffIdentity#APPROVAL_REJECTED'],
  ),
  identity(
    'STAFF_CREATION_NOT_AUTHORISED',
    'STAFF_PROFILE_REJECTION',
    'Staff creation not authorised',
    ['approveStaffIdentity#APPROVAL_REJECTED'],
  ),
  identity(
    'MFA_AUTHENTICATOR_UNAVAILABLE',
    'STAFF_MFA_RESET',
    'Authenticator lost or unavailable',
    ['resetStaffMfa#FACTOR_ACTIVE'],
  ),
  identity('MFA_ENROLMENT_EXPIRED', 'STAFF_MFA_RESET', 'MFA enrolment could not be completed', [
    'resetStaffMfa#ENROLMENT_UNFINISHED',
  ]),
  identity(
    'CREDENTIAL_SETUP_LINK_UNUSABLE',
    'CREDENTIAL_ADMINISTRATION',
    'Setup link expired or unusable',
    ['reissueStaffCredentialSetup', 'reissueVendorCredentialSetup'],
  ),
  identity(
    'CREDENTIAL_RECOVERY_ASSISTANCE',
    'CREDENTIAL_ADMINISTRATION',
    'Verified credential recovery assistance',
    ['recoverStaffCredential', 'recoverVendorCredential'],
  ),
  identity(
    'RIDER_HANDSET_UNAVAILABLE',
    'RIDER_DEVICE_REPLACEMENT',
    'Rider handset lost or unusable',
    ['reregisterRiderDevice'],
  ),
  identity('RIDER_HANDSET_CHANGED', 'RIDER_DEVICE_REPLACEMENT', 'Rider handset changed', [
    'reregisterRiderDevice',
  ]),
  identity('RIDER_DEVICE_SECURITY_CONCERN', 'RIDER_DEVICE_REVOCATION', 'Device security concern', [
    'revokeRiderDevice',
  ]),
  identity(
    'RIDER_DEVICE_NO_LONGER_AUTHORISED',
    'RIDER_DEVICE_REVOCATION',
    'Device no longer authorised',
    ['revokeRiderDevice'],
  ),
];

/**
 * The operations of contracts/openapi.yaml that this implementation claims, by `operationId`. The contract
 * describes the whole product and the code implements it one slice at a time, so until the whole API exists
 * only this intentional scope is compared with the contract (engineering-standards.md section 4).
 *
 * It holds the three credential setup operations (S0.31), the first routes of the product beside the two technical probes, the
 * staff sign-in and its second step (S0.32, S0.33), and the read and the end of the caller's own session (S0.34). Add an id
 * here in the same change that implements the operation, and remove it only when the operation is removed. The conformance check
 * fails when this list and the router disagree in either direction, so it cannot quietly drift from what is true.
 */
export const IMPLEMENTED_OPERATIONS: readonly string[] = [
  'beginMfaReenrolment',
  'completeMfaEnrolment',
  'completeStaffCredentialSetup',
  'completeStaffMfaSignIn',
  'getCurrentSession',
  'getStaffIdentity',
  'listAssignableStaffRoleBundles',
  'listReasonDefinitions',
  'listStaffIdentities',
  'signOut',
  'staffSignIn',
];

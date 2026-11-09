import type { CopyRule } from './problem-copy';

/**
 * The words of the six identity screens (S0.44), keyed by operation, context and code like the rest of the table. They are proposed for the
 * Product Owner to review with the composed screens. Each says what happened and what the person can do, in the interface's voice: no
 * apology, no blame, no value the person typed, and nothing about a credential beyond that a link was or was not sent.
 *
 * Where one code means two things, the sentence says both: `STATE_CONFLICT` is a record that moved and, for a re-issue or a reset, a record
 * that cannot be acted on as it stands, and the contract gives the screen no way to tell which.
 */
const DELIVERY_FAILED =
  'Nothing was changed. The message channel is not available yet, so the link could not be sent. You can try again once it is.';
const OTHER_HUB = 'This profile belongs to a hub your session does not act in.';

const DELIVERY_OPERATIONS = [
  'approveStaffIdentity',
  'reissueStaffCredentialSetup',
  'resetStaffMfa',
  'recoverStaffCredential',
] as const;

export const STAFF_COPY: readonly CopyRule[] = [
  // The reads.
  { operation: 'listStaffIdentities', text: 'The staff list could not be loaded.' },
  {
    operation: 'listStaffIdentities',
    code: 'VALIDATION_FAILED',
    text: 'That search was not accepted. Use at most 128 characters.',
  },
  { operation: 'getStaffIdentity', text: 'This profile could not be loaded.' },
  {
    operation: 'getStaffIdentity',
    code: 'NOT_FOUND',
    text: 'This profile could not be found. It may have been removed, or the link may be wrong.',
  },
  {
    operation: 'listAssignableStaffRoleBundles',
    text: 'The roles could not be loaded, so a profile cannot be created now.',
  },
  { operation: 'listTrustedBrowsers', text: 'Your trusted browsers could not be loaded.' },
  {
    operation: 'revokeTrustedBrowser',
    code: 'NOT_FOUND',
    text: 'That browser has already been removed, or its seven days are over.',
  },
  {
    operation: 'revokeTrustedBrowser',
    text: 'That browser could not be removed, so it can still skip the code. Try again.',
  },
  { operation: 'listStaffTrustedBrowsers', text: 'The trusted browsers could not be loaded.' },
  {
    operation: 'listStaffTrustedBrowsers',
    code: 'INSUFFICIENT_AUTHORITY',
    text: 'Your session cannot see this person’s trusted browsers. They are seen by a Platform Admin.',
  },
  {
    operation: 'listStaffTrustedBrowsers',
    code: 'NOT_FOUND',
    text: 'That person could not be found.',
  },
  {
    operation: 'revokeStaffTrustedBrowsers',
    code: 'INSUFFICIENT_AUTHORITY',
    text: 'Your session cannot remove this person’s trusted browsers. They are removed by a Platform Admin.',
  },
  {
    operation: 'revokeStaffTrustedBrowsers',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t remove trusted browsers. Ask an administrator for access.',
  },
  {
    operation: 'revokeStaffTrustedBrowsers',
    code: 'NOT_FOUND',
    text: 'That person could not be found.',
  },
  { operation: 'listSessions', text: 'The sessions could not be loaded.' },
  { operation: 'listSessions', code: 'NOT_FOUND', text: 'That person could not be found.' },
  {
    operation: 'listSessions',
    code: 'INSUFFICIENT_AUTHORITY',
    text: 'Your session cannot see this person’s sessions. Staff and vendor sessions are seen by a Platform Admin.',
  },

  // Creating a profile.
  {
    operation: 'createStaffIdentity',
    code: 'WORK_EMAIL_IN_USE',
    text: 'A profile with this email address already exists.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'work_email',
    code: 'VALIDATION_FAILED',
    text: 'Enter an email address, for example name@example.com.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'full_name',
    code: 'VALIDATION_FAILED',
    text: 'Enter the person’s full name.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'phone',
    code: 'VALIDATION_FAILED',
    text: 'Enter the number with its country code, for example +233 24 000 0000.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'role_bundle_id',
    code: 'VALIDATION_FAILED',
    text: 'Choose a role from the list.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'primary_hub_id',
    code: 'VALIDATION_FAILED',
    text: 'Choose one of your hubs.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'primary_hub_id',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'You cannot place a profile in that hub. Choose one of your hubs.',
  },
  {
    operation: 'createStaffIdentity',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the profile was created. You can try again: if it was already created, it is not created twice.',
  },
  {
    operation: 'createStaffIdentity',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t create profiles. Ask an administrator for access.',
  },

  // Approving or rejecting.
  {
    operation: 'approveStaffIdentity',
    code: 'SELF_APPROVAL_FORBIDDEN',
    text: 'Only a Platform Admin can approve or reject a profile they made. Ask a different approver to decide this one.',
  },
  {
    operation: 'approveStaffIdentity',
    code: 'INSUFFICIENT_AUTHORITY',
    text: 'This role needs a higher authority to decide. Ask a Platform Admin.',
  },
  {
    operation: 'approveStaffIdentity',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t approve or reject profiles. Ask an administrator for access.',
  },
  { operation: 'approveStaffIdentity', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'approveStaffIdentity',
    code: 'NOT_FOUND',
    text: 'This profile could not be found. It may have been removed.',
  },
  {
    operation: 'approveStaffIdentity',
    code: 'STATE_CONFLICT',
    text: 'This profile changed after you opened it, perhaps because someone else has already decided it. Reload it to see where it stands.',
  },

  // Sending a setup link again.
  {
    operation: 'reissueStaffCredentialSetup',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t send setup links. Ask an administrator for access.',
  },
  { operation: 'reissueStaffCredentialSetup', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'reissueStaffCredentialSetup',
    code: 'NOT_FOUND',
    text: 'This profile could not be found. It may have been removed.',
  },
  {
    operation: 'reissueStaffCredentialSetup',
    code: 'STATE_CONFLICT',
    text: 'A new setup link cannot be sent. This person has already set a password, or is a bootstrap administrator.',
  },

  // Resetting an authenticator.
  {
    operation: 'resetStaffMfa',
    code: 'SELF_APPROVAL_FORBIDDEN',
    text: 'You cannot reset your own authenticator. Another Platform Admin has to do it.',
  },
  {
    operation: 'resetStaffMfa',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t reset authenticators. Ask an administrator for access.',
  },
  {
    operation: 'resetStaffMfa',
    code: 'NOT_FOUND',
    text: 'This profile could not be found. It may have been removed.',
  },
  {
    operation: 'resetStaffMfa',
    code: 'STATE_CONFLICT',
    text: 'This profile changed after you opened it, or its authenticator cannot be reset as it stands. Reload it to see where it stands.',
  },

  // Starting a staff member's password recovery (S0.52b).
  {
    operation: 'recoverStaffCredential',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t start a password recovery. Ask an administrator for access.',
  },
  {
    operation: 'recoverStaffCredential',
    code: 'NOT_FOUND',
    text: 'This profile could not be found. It may have been removed.',
  },
  {
    operation: 'recoverStaffCredential',
    code: 'STATE_CONFLICT',
    text: 'Recovery cannot start for this profile as it stands: the person has not set a password yet (send a setup link instead), the profile is closed, or it changed after you opened it. Reload it to see where it stands.',
  },

  // Ending a session.
  {
    operation: 'revokeSession',
    code: 'INSUFFICIENT_AUTHORITY',
    text: 'Your session cannot end this person’s sessions. Staff and vendor sessions are ended by a Platform Admin.',
  },
  {
    operation: 'revokeSession',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t end sessions. Ask an administrator for access.',
  },
  {
    operation: 'revokeSession',
    code: 'NOT_FOUND',
    text: 'This session has already ended or no longer exists.',
  },

  // A delivery that could not be queued says that nothing was changed, for every act that sends a link.
  ...DELIVERY_OPERATIONS.map((operation): CopyRule => ({
    operation,
    code: 'CREDENTIAL_DELIVERY_FAILED',
    text: DELIVERY_FAILED,
  })),
];

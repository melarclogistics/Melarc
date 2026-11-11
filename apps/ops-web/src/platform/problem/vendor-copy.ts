import type { CopyRule } from './problem-copy';

/**
 * The words of the two vendor screens (S0.52b), keyed by operation and code like the rest of the table, and proposed for the Product Owner to
 * review with the composed screens. Each refused act names its own permission (ops-portal.md section 7): recovery is the Platform Admin's at
 * every hub, a re-issue is the approval authority's at the vendor's own hub. Nothing says anything about a secret beyond whether a link was sent.
 */
const DELIVERY_FAILED =
  'Nothing was changed. This account has no channel a link can be sent to, or the message channel is not available yet. You can try again once it is.';
const OTHER_HUB = 'This account belongs to a vendor of a hub your account does not work in.';

export const VENDOR_COPY: readonly CopyRule[] = [
  // The reads.
  { operation: 'listVendorAccounts', text: 'The vendor accounts could not be loaded.' },
  {
    operation: 'listVendorAccounts',
    code: 'VALIDATION_FAILED',
    text: 'That search was not accepted. Use at most 128 characters.',
  },
  { operation: 'getVendorAccount', text: 'This account could not be loaded.' },
  { operation: 'getVendorAccount', code: 'NOT_FOUND', text: 'This account could not be found.' },
  { operation: 'getVendorAccount', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },

  // Sending a setup link again.
  {
    operation: 'reissueVendorCredentialSetup',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t send a vendor a setup link. Ask an administrator for access.',
  },
  { operation: 'reissueVendorCredentialSetup', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'reissueVendorCredentialSetup',
    code: 'NOT_FOUND',
    text: 'This account could not be found.',
  },
  {
    operation: 'reissueVendorCredentialSetup',
    code: 'STATE_CONFLICT',
    text: 'A new setup link cannot be sent. This account already holds a secret (start a recovery instead), or it changed after you opened it. Reload it to see where it stands.',
  },
  {
    operation: 'reissueVendorCredentialSetup',
    code: 'CREDENTIAL_DELIVERY_FAILED',
    text: DELIVERY_FAILED,
  },

  // Starting a recovery.
  {
    operation: 'recoverVendorCredential',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t start a vendor’s recovery. Ask an administrator for access.',
  },
  {
    operation: 'recoverVendorCredential',
    code: 'NOT_FOUND',
    text: 'This account could not be found.',
  },
  {
    operation: 'recoverVendorCredential',
    code: 'STATE_CONFLICT',
    text: 'Recovery cannot start for this account as it stands: it has no secret yet (send a setup link instead), its vendor is no longer approved, or it changed after you opened it. Reload it to see where it stands.',
  },
  {
    operation: 'recoverVendorCredential',
    code: 'CREDENTIAL_DELIVERY_FAILED',
    text: DELIVERY_FAILED,
  },
];

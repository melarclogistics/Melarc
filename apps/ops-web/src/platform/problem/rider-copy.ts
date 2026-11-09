import type { CopyRule } from './problem-copy';

/**
 * The words of the rider screens (S0.60), keyed by operation and code like the rest of the table, and proposed for the Product Owner to review
 * with the composed screens. Each refused act names its own permission (ops-portal.md section 7): a first binding is a Senior Ops act, a
 * replacement is one too (at the officer's own hub, for Senior Ops; a Platform Admin acts at every hub), and the report of a loss is any officer's. Nothing says anything about the
 * rider's PIN or key, which no answer carries; the words about the code say what it is for and that it is shown once.
 */
const OTHER_HUB = 'This rider belongs to a hub your session does not act in.';
const NOT_FOUND = 'This rider could not be found.';

export const RIDER_COPY: readonly CopyRule[] = [
  // The reads.
  { operation: 'listRiders', text: 'The riders could not be loaded.' },
  {
    operation: 'listRiders',
    code: 'VALIDATION_FAILED',
    text: 'That search was not accepted. Use at most 128 characters.',
  },
  { operation: 'getRider', text: 'This rider could not be loaded.' },
  { operation: 'getRider', code: 'NOT_FOUND', text: NOT_FOUND },
  { operation: 'getRider', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },

  // The first binding of a rider's device, in person.
  {
    operation: 'registerRiderDevice',
    text: 'The code could not be made. Nothing was changed.',
  },
  {
    operation: 'registerRiderDevice',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t register a rider’s first device. Ask an administrator for access.',
  },
  { operation: 'registerRiderDevice', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'registerRiderDevice', code: 'NOT_FOUND', text: NOT_FOUND },
  // The act takes nothing the officer writes, so "what was entered" would send them looking for a mistake that is not theirs.
  {
    operation: 'registerRiderDevice',
    code: 'VALIDATION_FAILED',
    text: 'The code could not be made. Nothing was changed.',
  },
  {
    operation: 'registerRiderDevice',
    code: 'STATE_CONFLICT',
    text: 'A first device cannot be registered for this rider. The rider already has an active device, or has had one revoked (a replacement binds the rider again), or no longer has access. Reload the rider to see where it stands.',
  },
  {
    operation: 'registerRiderDevice',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the code was made. Try again: the same attempt is repeated safely, and no second code is made.',
  },

  // A replacement handset, bound in person after the rider's identity was verified.
  {
    operation: 'reregisterRiderDevice',
    text: 'The code could not be made. Nothing was changed.',
  },
  {
    operation: 'reregisterRiderDevice',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t register a replacement handset. Ask an administrator for access.',
  },
  {
    operation: 'reregisterRiderDevice',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'A replacement handset is registered only for a rider of your own hub.',
  },
  { operation: 'reregisterRiderDevice', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'reregisterRiderDevice',
    code: 'STATE_CONFLICT',
    text: 'A replacement cannot be registered for this rider as it stands: the rider changed after you opened this page, has held no device yet (register a first one instead), or no longer has access. Reload the rider to see where it stands.',
  },
  {
    operation: 'reregisterRiderDevice',
    context: 'verification-note',
    code: 'VALIDATION_FAILED',
    text: 'Say how you verified the rider’s identity in person, in one line. Leave out email addresses and telephone numbers.',
  },
  {
    operation: 'reregisterRiderDevice',
    context: 'verification-note',
    code: 'REASON_REQUIRED',
    text: 'Say how you verified the rider’s identity in person.',
  },
  {
    operation: 'reregisterRiderDevice',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the code was made. Check the rider, then show a new code if you need one: a new code ends any earlier one, so only the latest can be scanned.',
  },

  // The report of a lost or stolen device. It takes no version and no verification, and it is not made slower.
  {
    operation: 'revokeRiderDevice',
    text: 'The device could not be revoked. Try again; a lost handset should be revoked at once.',
  },
  {
    operation: 'revokeRiderDevice',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t revoke a rider’s device. Ask an administrator for access.',
  },
  { operation: 'revokeRiderDevice', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'revokeRiderDevice', code: 'NOT_FOUND', text: NOT_FOUND },
];

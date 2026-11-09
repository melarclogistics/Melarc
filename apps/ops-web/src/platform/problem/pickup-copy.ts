import type { CopyRule } from './problem-copy';

/**
 * The words of the pickup screens (S1.19), keyed by operation, context and code like the rest of the table, and proposed for the Product Owner
 * to review with the composed screens. Each refused act names its own permission key and never a role (ops-portal.md section 7); a refusal that
 * states a rule says the rule and what to do next, because a refusal shown as a dead end misrepresents the policy (`cancelPickupRequest`). No
 * wording names a price, a total or an amount the screen has not been given.
 */
const OTHER_HUB = 'This pickup request belongs to a hub your session does not act in.';
const NOT_FOUND = 'This pickup request could not be found.';
const CHANGED =
  'This request changed after you opened it: someone else may have acted on it. Reload it to see where it stands.';
const SERVICE_DAYS = 'Pickups run from Monday to Saturday. Choose another date.';
const ZONE_DAY = 'The pickup area is not served on that date. Choose another date.';
const SUSPENDED =
  'This sender is suspended, so nothing new can be booked or confirmed for them. Their existing requests are held, not cancelled.';
const SINGLE_PACKAGE =
  'A single package is collected only once its one-package exception is approved. Request the exception from the request’s page.';
const NOTE_NEEDED = 'Write a note saying why.';
/** A note the ledger would not keep: the field says what to change, and the words of the note are never repeated. */
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';
/** The reschedule refused at the cap: nothing was cancelled, and what comes next depends on whether the person can extend (see the dialog). */
const NEXT_ATTEMPT_REFUSED =
  'Nothing was cancelled: this request has used all its pickup attempts, so its next attempt cannot be booked.';

export const PICKUP_COPY: readonly CopyRule[] = [
  // The reads.
  { operation: 'listPickupRequests', text: 'The pickup requests could not be loaded.' },
  {
    operation: 'listPickupRequests',
    code: 'VALIDATION_FAILED',
    text: 'That filter was not accepted. Choose a state and a whole date.',
  },
  // A page of the queue the server will not open (its `page_token` is refused): not a filter, and not worth asking for again.
  {
    operation: 'listPickupRequests',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: 'That page of the queue could not be opened: its place in the queue was not accepted. Go back to the first page to start again.',
  },
  {
    operation: 'listPickupRequests',
    context: 'approvals',
    text: 'The exceptions waiting for approval could not be loaded.',
  },
  { operation: 'getPickupRequest', text: 'This pickup request could not be loaded.' },
  { operation: 'getPickupRequest', code: 'NOT_FOUND', text: NOT_FOUND },
  { operation: 'getPickupRequest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'getPickupRequest',
    context: 'chain',
    text: 'The earlier and later attempts could not be loaded.',
  },
  { operation: 'findAdHocSender', text: 'The sender could not be looked up.' },
  {
    operation: 'findAdHocSender',
    code: 'VALIDATION_FAILED',
    text: 'That phone number was not accepted. Include the country code, for example +233 24 000 0000.',
  },
  {
    operation: 'listVendorPickupLocations',
    text: 'The vendor’s saved locations could not be loaded.',
  },
  {
    operation: 'listVendorPickupLocations',
    code: 'NOT_FOUND',
    text: 'This vendor could not be found.',
  },
  {
    operation: 'listVendorPickupLocations',
    code: 'HUB_SCOPE_VIOLATION',
    text: 'This vendor belongs to a hub your session does not act in, so its saved locations cannot be read.',
  },
  {
    operation: 'listVendorAccounts',
    context: 'vendor-picker',
    text: 'The vendors could not be searched.',
  },
  {
    operation: 'listVendorAccounts',
    context: 'vendor-picker',
    code: 'VALIDATION_FAILED',
    text: 'That search was not accepted. Use at most 128 characters.',
  },
  {
    operation: 'listReasonDefinitions',
    context: 'cancellation',
    text: 'The cancellation reasons could not be loaded.',
  },

  // A booking.
  { operation: 'createPickupRequest', text: 'The pickup was not booked.' },
  {
    operation: 'createPickupRequest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t book a pickup. Ask an administrator for access.',
  },
  { operation: 'createPickupRequest', code: 'PICKUP_MINIMUM_NOT_MET', text: SINGLE_PACKAGE },
  { operation: 'createPickupRequest', code: 'SERVICE_DATE_NOT_PERMITTED', text: SERVICE_DAYS },
  { operation: 'createPickupRequest', code: 'ZONE_NOT_SERVICED_ON_DATE', text: ZONE_DAY },
  {
    operation: 'createPickupRequest',
    code: 'CORRIDOR_DAY_NOT_PERMITTED',
    text: 'No run goes to that destination on that date, and no off-day fee is set for it. Choose another date.',
  },
  { operation: 'createPickupRequest', code: 'SENDER_SUSPENDED', text: SUSPENDED },
  {
    operation: 'createPickupRequest',
    code: 'VALUE_DECLARATION_REQUIRED',
    text: 'The declared value is above what can be booked without the liability-cap acknowledgement. Tell the sender the cap, and tick the acknowledgement once they accept it.',
  },
  {
    operation: 'createPickupRequest',
    code: 'DESTINATION_UNRESOLVED',
    text: 'This vendor has no default saved location to take the parcel to. Choose one of its saved locations as the destination.',
  },
  {
    operation: 'createPickupRequest',
    code: 'SENDER_IDENTITY_AMBIGUOUS',
    text: 'Use either the returning sender that was found or a new sender, not both.',
  },
  {
    operation: 'createPickupRequest',
    code: 'VALIDATION_FAILED',
    text: 'Some of the booking was not accepted. Check the fields marked and try again.',
  },
  {
    operation: 'createPickupRequest',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the pickup was booked. Try again: the same booking is sent again safely and is not booked twice.',
  },

  // Confirming.
  { operation: 'confirmPickupRequest', text: 'The request could not be confirmed.' },
  {
    operation: 'confirmPickupRequest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t confirm a pickup. Ask an administrator for access.',
  },
  { operation: 'confirmPickupRequest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'confirmPickupRequest', code: 'STATE_CONFLICT', text: CHANGED },
  { operation: 'confirmPickupRequest', code: 'PICKUP_MINIMUM_NOT_MET', text: SINGLE_PACKAGE },
  { operation: 'confirmPickupRequest', code: 'SERVICE_DATE_NOT_PERMITTED', text: SERVICE_DAYS },
  { operation: 'confirmPickupRequest', code: 'ZONE_NOT_SERVICED_ON_DATE', text: ZONE_DAY },
  { operation: 'confirmPickupRequest', code: 'SENDER_SUSPENDED', text: SUSPENDED },
  // An extension is made on a confirmed request only, so a pending one past the limit has one way on.
  {
    operation: 'confirmPickupRequest',
    code: 'PICKUP_ATTEMPT_LIMIT_REACHED',
    text: 'This request has passed the hub’s limit of pickup attempts, so it cannot be confirmed. It can still be cancelled.',
  },

  // Cancelling and rescheduling.
  { operation: 'cancelPickupRequest', text: 'The request could not be cancelled.' },
  {
    operation: 'cancelPickupRequest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t make this cancellation: once a rider is assigned to the request’s run it needs a further kind of access. Ask an administrator for access.',
  },
  { operation: 'cancelPickupRequest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'cancelPickupRequest', code: 'NOT_FOUND', text: NOT_FOUND },
  { operation: 'cancelPickupRequest', code: 'STATE_CONFLICT', text: CHANGED },
  // A pickup whose parcels the rider has counted (S1.26): told as that, because "reload it" would send the officer back to what cannot change.
  {
    operation: 'cancelPickupRequest',
    context: 'collection_recorded',
    code: 'STATE_CONFLICT',
    text: 'The rider has already counted the parcels for this pickup, so it is not cancelled. Nothing was changed.',
  },
  {
    operation: 'cancelPickupRequest',
    code: 'REASON_REQUIRED',
    text: 'Something this cancellation needs is missing: the note the reason asks for, or, when a rider is already assigned, the charge decision and why it was made.',
  },
  {
    operation: 'cancelPickupRequest',
    code: 'REPLACEMENT_REQUIRED',
    text: 'A reschedule creates its new attempt in the same act. Use Reschedule, not Cancel.',
  },
  {
    operation: 'cancelPickupRequest',
    code: 'SOURCE_STILL_ACTIVE',
    text: 'A new attempt of this request already exists, and two attempts are never active together. Reload the request to see its attempts.',
  },
  {
    operation: 'cancelPickupRequest',
    code: 'PICKUP_ATTEMPT_LIMIT_REACHED',
    text: NEXT_ATTEMPT_REFUSED,
  },
  // What comes next after the refusal above, by whether the session holds the key that allows one further attempt: the way on is offered to
  // the person who can take it, and the others are told who can, so that the refusal is never a dead end.
  {
    operation: 'cancelPickupRequest',
    context: 'extend-held',
    code: 'PICKUP_ATTEMPT_LIMIT_REACHED',
    text: 'Extend the attempts on this page to allow one further attempt, then reschedule it. It can also be escalated, or cancelled without a new attempt.',
  },
  {
    operation: 'cancelPickupRequest',
    context: 'extend-not-held',
    code: 'PICKUP_ATTEMPT_LIMIT_REACHED',
    text: 'One further attempt needs an extension that an approver gives. Until then it can be escalated, or cancelled without a new attempt.',
  },

  // A late booking.
  { operation: 'resolveCutoffException', text: 'The late booking could not be resolved.' },
  {
    operation: 'resolveCutoffException',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t resolve a late booking. Ask an administrator for access.',
  },
  { operation: 'resolveCutoffException', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'resolveCutoffException',
    code: 'STATE_CONFLICT',
    text: 'This late booking is no longer waiting for a decision, or the request changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'resolveCutoffException', code: 'REASON_REQUIRED', text: NOTE_NEEDED },

  // Escalation.
  { operation: 'escalatePickupRequest', text: 'The request could not be escalated.' },
  {
    operation: 'escalatePickupRequest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t escalate a pickup. Ask an administrator for access.',
  },
  { operation: 'escalatePickupRequest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'escalatePickupRequest', code: 'NOT_FOUND', text: NOT_FOUND },
  // Only a confirmed request is escalated, and only once (S1.18).
  {
    operation: 'escalatePickupRequest',
    code: 'STATE_CONFLICT',
    text: 'This request cannot be escalated now: it is no longer confirmed, it is already escalated, or it changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'escalatePickupRequest', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  { operation: 'escalatePickupRequest', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },

  // Extending the attempts: one further attempt (S1.18). The key is held only at the hub's senior level, so a caller without it is refused
  // as without the key; the contract declares no higher-authority refusal.
  { operation: 'extendPickupAttempts', text: 'The attempts could not be extended.' },
  {
    operation: 'extendPickupAttempts',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t extend the attempts of a pickup. Ask an administrator for access.',
  },
  { operation: 'extendPickupAttempts', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'extendPickupAttempts', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'extendPickupAttempts',
    code: 'STATE_CONFLICT',
    text: 'There is nothing to extend: this request can still have its next attempt, it is already extended, or it changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'extendPickupAttempts', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  { operation: 'extendPickupAttempts', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },

  // Waiving the charge.
  { operation: 'waiveCancellationCharge', text: 'The charge could not be waived.' },
  {
    operation: 'waiveCancellationCharge',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t waive a cancellation charge. Ask an administrator for access.',
  },
  { operation: 'waiveCancellationCharge', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  {
    operation: 'waiveCancellationCharge',
    code: 'NO_CHARGE_APPLIED',
    text: 'No charge was applied to this cancellation, so there is nothing to waive.',
  },
  { operation: 'waiveCancellationCharge', code: 'STATE_CONFLICT', text: CHANGED },
  { operation: 'waiveCancellationCharge', code: 'REASON_REQUIRED', text: NOTE_NEEDED },

  // The one-package exception, maker's half.
  { operation: 'requestOnePackageException', text: 'The exception could not be requested.' },
  {
    operation: 'requestOnePackageException',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t request a one-package exception. Ask an administrator for access.',
  },
  { operation: 'requestOnePackageException', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'requestOnePackageException', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'requestOnePackageException',
    code: 'VALIDATION_FAILED',
    text: 'Some of what was entered was not accepted. Check the fields marked and try again.',
  },
  {
    operation: 'requestOnePackageException',
    code: 'REASON_REQUIRED',
    text: 'Write a note saying why this single package should be collected.',
  },
  {
    operation: 'requestOnePackageException',
    code: 'STATE_CONFLICT',
    text: 'This request cannot take an exception as it stands: one is already waiting or approved, or it is no longer a pending request of one package. Check the request to see where it stands.',
  },
  // The act takes no key, so it is never sent again blindly; the request's read now shows an exception that reached the server.
  {
    operation: 'requestOnePackageException',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the exception was requested. Check the request before you send it again: one that reached the server shows there, waiting for an approver.',
  },

  // The one-package exception, checker's half (`/approvals`). The maker-checker rule is the server's, and its refusal is the rule itself.
  { operation: 'approveOnePackageException', text: 'The exception could not be approved.' },
  {
    operation: 'approveOnePackageException',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t approve a one-package exception. Ask an administrator for access.',
  },
  { operation: 'approveOnePackageException', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'approveOnePackageException', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'approveOnePackageException',
    code: 'STATE_CONFLICT',
    text: 'This exception is no longer waiting for approval: someone may already have decided it. Reload the list to see what still waits.',
  },
  {
    operation: 'approveOnePackageException',
    code: 'SELF_APPROVAL_FORBIDDEN',
    text: 'You requested this exception yourself, so a different approver has to decide it.',
  },
];

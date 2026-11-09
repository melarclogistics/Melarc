import type { CopyRule } from './problem-copy';

/**
 * The words of the manifest screens (S1.25), keyed by operation, context and code like the rest of the table, and proposed for the Product Owner
 * to review with the composed screens. Each refused act names its own permission key and never a role (ops-portal.md section 7); a refusal that
 * states a rule says the rule and what to do next, because a refusal shown as a dead end misrepresents the policy. **A refusal that declares a
 * `details.rule` is worded by it** (`problemOf` reads the rule as the context when the page gave none): `service_date_passed` and
 * `request_not_confirmed` of the dispatch are two different things to do next. No wording names a count of the hub's, a price or a role.
 */
const OTHER_HUB = 'This pickup run belongs to a hub your session does not act in.';
const NOT_FOUND = 'This pickup run could not be found.';
const CHANGED =
  'This pickup run changed after you opened it: someone else may have acted on it. Reload it to see where it stands.';
const NOTE_NEEDED = 'Write a note saying why.';
/** A note the ledger would not keep: the field says what to change, and the words of the note are never repeated. */
const NOTE_REFUSED = 'Check the note marked below: it was not accepted as written.';
const OTHER_HUB_STOP = 'This stop belongs to a hub your session does not act in.';
const OTHER_HUB_HANDOVER = 'This custody handover belongs to a hub your session does not act in.';

export const MANIFEST_COPY: readonly CopyRule[] = [
  // The reads.
  { operation: 'listPickupManifests', text: 'The pickup runs could not be loaded.' },
  // A filter the server refuses (`state`, `service_date`; the screen sends only values the contract accepts, so this is a contract that moved).
  {
    operation: 'listPickupManifests',
    code: 'VALIDATION_FAILED',
    text: 'That filter was not accepted. Choose a state and a whole date.',
  },
  // A page of the list the server will not open (its `page_token` is refused): not a filter, and not worth asking for again.
  {
    operation: 'listPickupManifests',
    context: 'cursor',
    code: 'VALIDATION_FAILED',
    text: 'That page of the pickup runs could not be opened: its place in the list was not accepted. Go back to the first page to start again.',
  },
  { operation: 'getPickupManifest', text: 'This pickup run could not be loaded.' },
  { operation: 'getPickupManifest', code: 'NOT_FOUND', text: NOT_FOUND },
  { operation: 'getPickupManifest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'getPickupStop', text: 'This stop could not be loaded.' },
  { operation: 'getPickupStop', code: 'NOT_FOUND', text: 'This stop could not be found.' },
  { operation: 'getPickupStop', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_STOP },
  {
    operation: 'getPickupRequest',
    context: 'stop',
    text: 'The pickups behind some stops could not be loaded, so those stops are named by their place in the order.',
  },
  {
    operation: 'listPickupRequests',
    context: 'pool',
    text: 'The pool of confirmed pickups could not be loaded.',
  },
  {
    operation: 'listPickupRequests',
    context: 'pool',
    code: 'VALIDATION_FAILED',
    text: 'That page of the pool could not be opened: its place in the pool was not accepted. Go back to the first page to start again.',
  },
  {
    operation: 'listReasonDefinitions',
    context: 'carryover',
    text: 'The carry-over reasons could not be loaded.',
  },
  {
    operation: 'listReasonDefinitions',
    context: 'stop-skip',
    text: 'The reasons for skipping a stop could not be loaded.',
  },
  { operation: 'listRiders', context: 'rider-picker', text: 'The riders could not be searched.' },
  {
    operation: 'listRiders',
    context: 'rider-picker',
    code: 'VALIDATION_FAILED',
    text: 'That search was not accepted. Use at most 128 characters.',
  },
  { operation: 'getRider', context: 'manifest', text: 'The rider could not be loaded.' },
  {
    operation: 'listRunCustodyHandovers',
    text: 'The custody handover of this run could not be loaded.',
  },
  { operation: 'getRunCustodyHandover', text: 'The custody handover could not be loaded.' },
  {
    operation: 'getRunCustodyHandover',
    code: 'HUB_SCOPE_VIOLATION',
    text: OTHER_HUB_HANDOVER,
  },

  // Making a manifest.
  { operation: 'createPickupManifest', text: 'The pickup run was not created.' },
  {
    operation: 'createPickupManifest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t make a pickup run. Ask an administrator for access.',
  },
  {
    operation: 'createPickupManifest',
    code: 'ALREADY_MANIFESTED',
    text: 'A request you chose is already on a pickup run, so nothing was created. The requests marked below are not available: refresh the pool and choose again.',
  },
  {
    operation: 'createPickupManifest',
    code: 'VALIDATION_FAILED',
    text: 'Some of what was entered was not accepted, so nothing was created. Check the day and the requests marked below.',
  },
  {
    operation: 'createPickupManifest',
    code: 'REASON_REQUIRED',
    text: 'A request carried over from an earlier day needs a reason, and a note where the reason asks for one. Check the requests marked below.',
  },
  {
    operation: 'createPickupManifest',
    code: 'REASON_NOT_ACTIVE',
    text: 'A carry-over reason you chose can no longer be used. Choose another for the requests marked below.',
  },
  {
    operation: 'createPickupManifest',
    context: 'unknown-outcome',
    text: 'We could not confirm whether the pickup run was created. Try again: the same pickup run is sent again safely and is not made twice.',
  },

  // Ordering the stops.
  { operation: 'setManifestStopOrder', text: 'The order was not saved.' },
  {
    operation: 'setManifestStopOrder',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t order the stops. Ask an administrator for access.',
  },
  { operation: 'setManifestStopOrder', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'setManifestStopOrder', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'setManifestStopOrder',
    code: 'STATE_CONFLICT',
    text: 'The stops cannot be ordered now: the pickup run was dispatched, or a request on it was cancelled or the pickup run changed after you opened it. Reload it to see where it stands.',
  },
  {
    operation: 'setManifestStopOrder',
    code: 'VALIDATION_FAILED',
    text: 'That order was not accepted: a stop that is no longer to be worked keeps its place, and every stop is listed once. Reload the pickup run and arrange the stops again.',
  },

  // Assigning a rider.
  { operation: 'assignRider', text: 'The rider was not assigned.' },
  {
    operation: 'assignRider',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t assign a rider. Ask an administrator for access.',
  },
  { operation: 'assignRider', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'assignRider', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'assignRider',
    code: 'RIDER_UNAVAILABLE',
    text: 'This rider cannot be given the pickup run: they are not active, or they belong to another hub. Choose another rider.',
  },
  {
    operation: 'assignRider',
    code: 'NO_SERVICEABLE_MOTORCYCLE',
    text: 'This rider has no serviceable motorcycle. Choose another rider.',
  },
  {
    operation: 'assignRider',
    code: 'STATE_CONFLICT',
    text: 'A rider can be assigned to a draft only: this pickup run was dispatched or cancelled, or it changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'assignRider', code: 'VALIDATION_FAILED', text: 'Choose a rider from the list.' },

  // Dispatching.
  { operation: 'dispatchManifest', text: 'The pickup run was not dispatched.' },
  {
    operation: 'dispatchManifest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t dispatch a pickup run. Ask an administrator for access.',
  },
  { operation: 'dispatchManifest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'dispatchManifest', code: 'NOT_FOUND', text: NOT_FOUND },
  { operation: 'dispatchManifest', code: 'STATE_CONFLICT', text: CHANGED },
  {
    operation: 'dispatchManifest',
    context: 'service_date_passed',
    code: 'STATE_CONFLICT',
    text: 'The day of this run has passed, so it is never sent out. Nothing was sent. Cancel the pickup run, then plan its requests again for a day that has not passed, each carried over with a reason.',
  },
  {
    operation: 'dispatchManifest',
    context: 'request_not_confirmed',
    code: 'STATE_CONFLICT',
    text: 'A pickup on this pickup run is no longer confirmed, so nothing was sent and the pickup run is still a draft. A cancelled pickup is never sent to a rider. The stops concerned are marked on the page: reload the pickup run to see them.',
  },
  {
    operation: 'dispatchManifest',
    code: 'MANIFEST_EMPTY',
    text: 'Nothing is left to be worked on this pickup run, so there is nothing to send. Cancel it, or plan its requests again.',
  },
  {
    operation: 'dispatchManifest',
    code: 'RIDER_UNAVAILABLE',
    text: 'The pickup run has no rider, or its rider is no longer active or no longer belongs to this hub. Assign a rider and dispatch again.',
  },
  {
    operation: 'dispatchManifest',
    code: 'NO_SERVICEABLE_MOTORCYCLE',
    text: 'The rider has no serviceable motorcycle. Assign another rider.',
  },

  // Cancelling the manifest.
  { operation: 'cancelPickupManifest', text: 'The pickup run was not cancelled.' },
  {
    operation: 'cancelPickupManifest',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t cancel a pickup run. Ask an administrator for access.',
  },
  { operation: 'cancelPickupManifest', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'cancelPickupManifest', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'cancelPickupManifest',
    code: 'RUN_ALREADY_STARTED',
    text: 'This run has started, so the pickup run cannot be cancelled. From here the way out is to skip a stop, or to hand custody over.',
  },
  {
    operation: 'cancelPickupManifest',
    code: 'STATE_CONFLICT',
    text: 'This pickup run can no longer be cancelled: it is already cancelled or completed, or it changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'cancelPickupManifest', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  { operation: 'cancelPickupManifest', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },

  // Skipping a stop.
  { operation: 'skipPickupStop', text: 'The stop was not skipped.' },
  {
    operation: 'skipPickupStop',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t skip a stop. Ask an administrator for access.',
  },
  { operation: 'skipPickupStop', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB_STOP },
  { operation: 'skipPickupStop', code: 'NOT_FOUND', text: 'This stop could not be found.' },
  {
    operation: 'skipPickupStop',
    code: 'STATE_CONFLICT',
    text: 'This stop can no longer be skipped: it was collected, failed or skipped already, or it changed after you opened it. Reload it to see where it stands.',
  },
  // A stop whose parcels the rider has counted (S1.26): told as that, because "reload it" would send the officer back to what cannot change.
  {
    operation: 'skipPickupStop',
    context: 'collection_recorded',
    code: 'STATE_CONFLICT',
    text: 'The rider has already counted the parcels at this stop, so it is not skipped. Nothing was changed: the handshake closes the stop.',
  },
  {
    operation: 'skipPickupStop',
    code: 'REASON_REQUIRED',
    text: 'Something this skip needs is missing: a reason, or the note the reason asks for.',
  },
  {
    operation: 'skipPickupStop',
    code: 'REASON_NOT_ACTIVE',
    text: 'That reason can no longer be used to skip a stop. Choose another.',
  },
  { operation: 'skipPickupStop', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },

  // The custody handover, Ops's side.
  { operation: 'initiateRunCustodyHandover', text: 'The handover was not opened.' },
  {
    operation: 'initiateRunCustodyHandover',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t open a custody handover. Ask an administrator for access.',
  },
  { operation: 'initiateRunCustodyHandover', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'initiateRunCustodyHandover', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'initiateRunCustodyHandover',
    code: 'STATE_CONFLICT',
    text: 'A handover cannot be opened now: the run is not in progress, one is already waiting, custody is already with the hub, or the pickup run changed after you opened it. Reload it to see where it stands.',
  },
  {
    operation: 'initiateRunCustodyHandover',
    code: 'RIDER_UNAVAILABLE',
    text: 'That rider cannot take custody: they are not active, they belong to another hub, or they hold it already. Choose another rider.',
  },
  {
    operation: 'initiateRunCustodyHandover',
    code: 'VALIDATION_FAILED',
    text: 'The destination was not accepted. Name one other rider, or this hub, and not both.',
  },
  { operation: 'initiateRunCustodyHandover', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  // The rules a refused handover declares (`details.rule`): each is a different thing to do next, so none is told as "it changed, reload".
  {
    operation: 'initiateRunCustodyHandover',
    context: 'run_not_in_progress',
    code: 'STATE_CONFLICT',
    text: 'The run is not in progress, so custody cannot be handed over. A run that has not started, or is over, has nothing to hand over. Reload the pickup run to see where it stands.',
  },
  {
    operation: 'initiateRunCustodyHandover',
    context: 'custody_handover_pending',
    code: 'STATE_CONFLICT',
    text: 'A handover of this run is already waiting, and only one can wait at a time. Reload the pickup run to see it, then accept it or mark it as failed.',
  },
  {
    operation: 'initiateRunCustodyHandover',
    context: 'custody_with_hub',
    code: 'STATE_CONFLICT',
    text: 'The hub already holds custody of this run, so there is no rider to hand it on from.',
  },
  { operation: 'acceptRunCustodyHandover', text: 'The handover was not accepted.' },
  {
    operation: 'acceptRunCustodyHandover',
    context: 'run_not_in_progress',
    code: 'STATE_CONFLICT',
    text: 'The run is not in progress any more, so there is nothing to accept. Reload the pickup run to see where it stands.',
  },
  {
    operation: 'acceptRunCustodyHandover',
    context: 'no_custody_handover_pending',
    code: 'STATE_CONFLICT',
    text: 'No handover is waiting on this run: it was accepted or marked as failed already. Reload the pickup run to see where it stands.',
  },
  {
    operation: 'failRunCustodyHandover',
    context: 'run_not_in_progress',
    code: 'STATE_CONFLICT',
    text: 'The run is not in progress any more, so there is nothing to mark as failed. Reload the pickup run to see where it stands.',
  },
  {
    operation: 'failRunCustodyHandover',
    context: 'no_custody_handover_pending',
    code: 'STATE_CONFLICT',
    text: 'No handover is waiting on this run: it was accepted or marked as failed already. Reload the pickup run to see where it stands.',
  },
  {
    operation: 'acceptRunCustodyHandover',
    code: 'PERMISSION_DENIED',
    text: 'Ops accepts only a handover to the hub, and only an account that can accept a custody handover can. A handover to a rider is the rider’s to accept.',
  },
  { operation: 'acceptRunCustodyHandover', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'acceptRunCustodyHandover', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'acceptRunCustodyHandover',
    code: 'STATE_CONFLICT',
    text: 'This handover is no longer waiting: it was accepted or marked failed already, or the run changed after you opened it. Reload it to see where it stands.',
  },
  {
    operation: 'acceptRunCustodyHandover',
    code: 'VALIDATION_FAILED',
    text: 'The number of parcels taken was not accepted. Use a whole number, zero or more.',
  },
  { operation: 'failRunCustodyHandover', text: 'The handover was not marked as failed.' },
  {
    operation: 'failRunCustodyHandover',
    code: 'PERMISSION_DENIED',
    text: 'Your account can’t mark a custody handover as failed. Ask an administrator for access.',
  },
  { operation: 'failRunCustodyHandover', code: 'HUB_SCOPE_VIOLATION', text: OTHER_HUB },
  { operation: 'failRunCustodyHandover', code: 'NOT_FOUND', text: NOT_FOUND },
  {
    operation: 'failRunCustodyHandover',
    code: 'STATE_CONFLICT',
    text: 'This handover is no longer waiting: it was accepted or marked failed already, or the run changed after you opened it. Reload it to see where it stands.',
  },
  { operation: 'failRunCustodyHandover', code: 'REASON_REQUIRED', text: NOTE_NEEDED },
  { operation: 'failRunCustodyHandover', code: 'VALIDATION_FAILED', text: NOTE_REFUSED },
];

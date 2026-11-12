import type { ActMethod } from '../api/answer-observer';
import type { QueueName } from './queue-summary-shape';

/**
 * **Which acts of the portal can change what a queue holds**, so that the menu's counts and My work never lag an act the person has just taken
 * (the Product Owner's decision D11(b), 6 November 2026). The mechanism is one: the API client tells the portal whenever one of these is answered with
 * success (`observeActs`, `ApiClientProvider`), and the portal reads the queue summary again at once. No page calls it, so no page can forget it,
 * and an act a later task adds is either in {@link QUEUE_CHANGING_ACTS} or in {@link QUEUE_NEUTRAL_CALLS}: `test/queue-changing-acts.test.ts`
 * reads the source and fails on a call of the API that is in neither, and holds every entry to an operation of the contract.
 *
 * What an act can do to a queue is read from the queue's own definition ([the data dictionary](../../../../../features/reporting/reporting-data-dictionary.md),
 * section 5.5) and from the state machines: `queues` names every queue the act can move a record into or out of. It is a list of what is
 * possible and not of what happened (a confirmation of a request booked in time does not enter the cut-off review): re-reading is cheap, and a count
 * that lags an act is the failure this exists to prevent. The `path` is the one the call names (`/pickup-requests/{id}/confirm`), the way the
 * generated client is called.
 */
export interface QueueChangingAct {
  readonly method: ActMethod;
  readonly path: string;
  /** The contract's `operationId`, which the test holds the entry to. */
  readonly operation: string;
  /** The queues the act can move a record into or out of. Empty only for an act the decision names and no queue counts today. */
  readonly queues: readonly QueueName[];
  /** Why the act is here, in a line. */
  readonly why: string;
}

export const QUEUE_CHANGING_ACTS: readonly QueueChangingAct[] = [
  {
    method: 'POST',
    path: '/pickup-requests',
    operation: 'createPickupRequest',
    queues: ['PICKUP_AWAITING_CONFIRMATION'],
    why: 'A booking is made `PENDING`, which is the queue of requests waiting for confirmation.',
  },
  {
    method: 'POST',
    path: '/pickup-requests/{id}/confirm',
    operation: 'confirmPickupRequest',
    queues: ['PICKUP_AWAITING_CONFIRMATION', 'PICKUP_CUTOFF_REVIEW', 'PICKUP_UNMANIFESTED_POOL'],
    why: 'A confirmed request leaves the waiting queue and enters the pool, or the cut-off review when it was booked late.',
  },
  {
    method: 'POST',
    path: '/pickup-requests/{id}/cancel',
    operation: 'cancelPickupRequest',
    queues: [
      'PICKUP_AWAITING_CONFIRMATION',
      'PICKUP_CUTOFF_REVIEW',
      'PICKUP_EXCEPTION_APPROVAL',
      'PICKUP_UNMANIFESTED_POOL',
      'PICKUP_RUNS_IN_PROGRESS',
    ],
    why: 'A cancelled request leaves every queue it was in (AC-QSUM-12), its stop on a run is skipped, and a rescheduled one is a new request.',
  },
  {
    method: 'POST',
    path: '/pickup-requests/{id}/cutoff-exception',
    operation: 'resolveCutoffException',
    queues: ['PICKUP_CUTOFF_REVIEW', 'PICKUP_UNMANIFESTED_POOL', 'PICKUP_AWAITING_CONFIRMATION'],
    why: 'A decided late booking leaves the review and enters the pool, or is moved to the next day as a new request.',
  },
  {
    method: 'POST',
    path: '/pickup-requests/{id}/one-package-exception',
    operation: 'requestOnePackageException',
    queues: ['PICKUP_EXCEPTION_APPROVAL'],
    why: 'A requested exception enters the approvers’ queue.',
  },
  {
    method: 'POST',
    path: '/pickup-requests/{id}/one-package-exception/approve',
    operation: 'approveOnePackageException',
    queues: ['PICKUP_EXCEPTION_APPROVAL'],
    why: 'A decided exception, approved or rejected, leaves the approvers’ queue.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests',
    operation: 'createPickupManifest',
    queues: ['PICKUP_UNMANIFESTED_POOL'],
    why: 'The requests put on a new run leave the pool.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests/{id}/assign-rider',
    operation: 'assignRider',
    queues: [],
    why: 'Named by the decision. No queue counts a run before the rider starts it, so none changes today; it is here so that a queue defined later is not left behind.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests/{id}/dispatch',
    operation: 'dispatchManifest',
    queues: [],
    why: 'Named by the decision, on the same terms as the assignment: a dispatched run is not yet in progress.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests/{id}/cancel',
    operation: 'cancelPickupManifest',
    queues: ['PICKUP_UNMANIFESTED_POOL', 'PICKUP_RUNS_IN_PROGRESS'],
    why: 'The requests of a cancelled run return to the pool, and a run in progress stops being one.',
  },
  {
    method: 'POST',
    path: '/pickup-stops/{id}/skip',
    operation: 'skipPickupStop',
    queues: ['PICKUP_RUNS_IN_PROGRESS'],
    why: 'The system completes a run in the same act as the skip of its last stop, and a completed run is no longer in progress.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests/{id}/custody-handover/accept',
    operation: 'acceptRunCustodyHandover',
    queues: ['PICKUP_RUNS_IN_PROGRESS'],
    why: 'The system may complete the run in the same act as an acceptance of its custody.',
  },
  {
    method: 'POST',
    path: '/pickup-manifests/{id}/custody-handover/fail',
    operation: 'failRunCustodyHandover',
    queues: ['PICKUP_RUNS_IN_PROGRESS'],
    why: 'The system may complete the run in the same act as a failed handover.',
  },
  {
    method: 'POST',
    path: '/staff-identities',
    operation: 'createStaffIdentity',
    queues: ['STAFF_AWAITING_APPROVAL'],
    why: 'A new profile is `PENDING_APPROVAL` from creation.',
  },
  {
    method: 'POST',
    path: '/staff-identities/{id}/approve',
    operation: 'approveStaffIdentity',
    queues: ['STAFF_AWAITING_APPROVAL'],
    why: 'A profile approved or rejected leaves the approvers’ queue.',
  },
];

/** A call that can change something and changes no queue, and why. The test that reads the source needs every call of the API to be here or above. */
export interface QueueNeutralCall {
  readonly method: ActMethod;
  readonly path: string;
  readonly operation: string;
  readonly why: string;
}

const neutral = (
  why: string,
  calls: readonly (readonly [ActMethod, string, string])[],
): QueueNeutralCall[] =>
  calls.map(([method, path, operation]) => ({ method, path, operation, why }));

export const QUEUE_NEUTRAL_CALLS: readonly QueueNeutralCall[] = [
  ...neutral(
    'Works a failed or cancelled request, which none of the six queues counts: a failed stop keeps its claim and its request stays confirmed and on a run (state-machines.md section 4), and a cancelled request is in no queue.',
    [
      ['POST', '/pickup-requests/{id}/escalate', 'escalatePickupRequest'],
      ['POST', '/pickup-requests/{id}/attempt-extension', 'extendPickupAttempts'],
      ['POST', '/pickup-requests/{id}/cancellation-charge/waiver', 'waiveCancellationCharge'],
    ],
  ),
  ...neutral('Changes the order or the custody of a run, and no queue counts either.', [
    ['PUT', '/pickup-manifests/{id}/stops', 'setManifestStopOrder'],
    ['POST', '/pickup-manifests/{id}/custody-handover', 'initiateRunCustodyHandover'],
  ]),
  ...neutral('Acts on a rider’s device, which no queue counts.', [
    ['POST', '/ops/riders/{riderId}/device/register', 'registerRiderDevice'],
    ['POST', '/ops/riders/{riderId}/device/reregister', 'reregisterRiderDevice'],
    ['POST', '/ops/riders/{riderId}/device/revoke', 'revokeRiderDevice'],
  ]),
  ...neutral('Acts on a credential, a session or a trusted browser, which no queue counts.', [
    ['POST', '/ops/staff/{id}/credential/setup/reissue', 'reissueStaffCredentialSetup'],
    ['POST', '/ops/staff/{id}/credential/recover', 'recoverStaffCredential'],
    ['POST', '/ops/staff/{id}/mfa/reset', 'resetStaffMfa'],
    ['POST', '/auth/sessions/{id}/revoke', 'revokeSession'],
    ['DELETE', '/auth/staff/trusted-browsers/{id}', 'revokeTrustedBrowser'],
    ['POST', '/ops/staff/{id}/trusted-browsers/revoke', 'revokeStaffTrustedBrowsers'],
    ['POST', '/ops/vendors/{id}/credential/setup/reissue', 'reissueVendorCredentialSetup'],
    ['POST', '/ops/vendors/{id}/credential/recover', 'recoverVendorCredential'],
  ]),
  ...neutral('Ends the session: there is nobody left to show a count to.', [
    ['DELETE', '/auth/session', 'signOut'],
  ]),
  ...neutral('A search: a POST so that the text is not in an address, and it changes nothing.', [
    ['POST', '/ops/lookup', 'lookupRecords'],
  ]),
  ...neutral('Made with no session, before anyone is signed in to have a queue.', [
    ['POST', '/auth/staff/sign-in', 'staffSignIn'],
    ['POST', '/auth/staff/sign-in/mfa', 'completeStaffMfaSignIn'],
    ['POST', '/auth/staff/setup/credential', 'completeStaffCredentialSetup'],
    ['POST', '/auth/staff/setup/mfa/begin', 'beginMfaReenrolment'],
    ['POST', '/auth/staff/setup/mfa', 'completeMfaEnrolment'],
    ['POST', '/auth/recovery/request', 'requestCredentialRecovery'],
    ['POST', '/auth/recovery/complete', 'completeCredentialRecovery'],
  ]),
];

const KEYS = new Set(QUEUE_CHANGING_ACTS.map((act) => `${act.method} ${act.path}`));

/** Whether an act the API answered with success can have changed what a queue holds, and the summary is to be read again. */
export function changesAQueue(method: string, path: string): boolean {
  return KEYS.has(`${method} ${path}`);
}

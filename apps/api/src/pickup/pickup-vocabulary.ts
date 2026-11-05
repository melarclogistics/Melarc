import type { ReasonRequest } from '../platform/settings/reason-validator.js';

/**
 * The words the pickup operations are written in (S1.7; domain-model.md sections 3.9 and 6.5; pickup-failure.md; state-machines.md).
 * Nothing here is configuration: a category or a domain that a screen, a setting or a request could change would let a client decide what
 * the server records. `pickup-vocabulary.test.ts` reads the documents and the contract and fails when this file and they differ.
 */

/**
 * The four categories of a failed pickup visit (section 21.5): fixed, mandatory, and set exactly when a stop is `FAILED`. The reason
 * options within a category are configurable (§35.9.1, the `PICKUP_FAILURE` domain); the category is not (`CONFLICT-025`).
 */
export const PICKUP_FAILURE_CATEGORIES = Object.freeze([
  'VENDOR_UNAVAILABLE',
  'ACCESS_DENIED',
  'PARCEL_NOT_READY',
  'REFUSED_COLLECTION',
] as const);
export type PickupFailureCategory = (typeof PICKUP_FAILURE_CATEGORIES)[number];

/**
 * The categories of a failure that the rider may report only once the hub's door wait (`rider_door_wait_minutes`, 10 minutes at the launch hub) has passed since it arrived
 * at the stop: **vendor unavailability** (pickup-failure.md §9: "how long before vendor unavailability becomes a failure"; pickup-collection.md: a vendor who is simply busy is no
 * fallback trigger, the rider waits the door wait and may then fail the stop). The other three categories carry no wait: a door that security refuses, a parcel that is not packed and
 * a handover the vendor refuses are not made true by waiting. The rule attaches to the fixed category, as the escalation-only rule of a refused collection does, and the stop's guard
 * holds the same list (migration 0073). The pairing of a reason with a category is not checked (the screens group them), so the wait follows the category the rider reports.
 */
export const DOOR_WAIT_CATEGORIES: readonly PickupFailureCategory[] = Object.freeze([
  'VENDOR_UNAVAILABLE',
]);

/**
 * How a rider tried to reach the sender before it reported a failure: a call, a text, or in person at the premises. A closed set of the contract's `ContactAttempt.method`, held by the
 * stop's guard (migration 0073). The values are the Product Owner's to confirm or extend (OB-S1-67); the feature text names a "method" without listing them.
 */
export const CONTACT_ATTEMPT_METHODS = Object.freeze(['PHONE_CALL', 'SMS', 'IN_PERSON'] as const);
export type ContactAttemptMethod = (typeof CONTACT_ATTEMPT_METHODS)[number];

/**
 * The members of what a rider is shown for a stop (the contract's `PickupStopSummary`; S1.21, the Product Owner's decision of 2 November 2026):
 * the pickup's reference (its code, the one the sender is texted), the vendor or sender as booked, the packages as declared, the place the
 * rider is sent to, the pickup's note and the primary contact. **The set is closed and the table holds it** (a check of `pickup_stop`): no
 * payer, no price, no destination, no recipient and no other request can be kept in it. `location_note` is null until a pickup-instructions
 * field is defined on the request, and is never made from the landmark or a location override.
 */
export const PICKUP_STOP_SUMMARY_KEYS = Object.freeze([
  'reference',
  'sender_display_name',
  'declared_package_count',
  'resolved_pickup_location',
  'location_note',
  'contact_phone',
] as const);

/** The members of the place in a summary: the contract's `Location`, and no other. */
export const PICKUP_SUMMARY_LOCATION_KEYS = Object.freeze([
  'address',
  'landmark',
  'map_link',
  'latitude',
  'longitude',
] as const);

/**
 * The reason domain each pickup operation takes its reason from. A reason of another domain is `REASON_NOT_ACTIVE` for the operation,
 * whatever else is true of it, and a domain with no code seeded refuses every code the same way. The three admitted on 29 October 2026
 * (D-05) hold the 25 codes the Product Owner approved the same day (domain-model.md section 3.9), and the stop skip holds its four.
 *
 * Derived from the operation by the use case, never taken from the client (domain-model.md section 3.9, as for the identity operations).
 */
export const PICKUP_REASON_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  skipPickupStop: 'PICKUP_STOP_SKIP',
  cancelPickupRequest: 'PICKUP_CANCELLATION',
  reportPickupFailure: 'PICKUP_FAILURE',
  recordCollection: 'PICKUP_SHORT_COUNT',
  // The reason a manifest gives for each overdue request it carries over (S1.20 closeout, 2 November 2026).
  createPickupManifest: 'PICKUP_CARRYOVER',
});

/**
 * The request the reason validator takes for a pickup operation: the code the client sent (anything), the note, and the domain the
 * operation fixes. An operation that takes no catalogue reason is a defect of the caller, not a refusal of a client.
 */
export function pickupReasonRequest(
  operationId: string,
  reasonCode: unknown,
  note?: string | null,
): ReasonRequest {
  const domain = PICKUP_REASON_DOMAINS[operationId];
  if (domain === undefined) {
    throw new TypeError(`${operationId} takes no catalogue reason of the pickup domains`);
  }
  return note === undefined
    ? { reasonCode, operationId, domain }
    : { reasonCode, operationId, domain, note };
}

/**
 * What the Vendor is asked to do, where anything would unblock the pickup, for each reason of the skip (S1.23; domain-model.md section 3.9,
 * the column "The next action that differs" of the four `PICKUP_STOP_SKIP` rows; MSC-DEC-412, "the requested vendor action where anything
 * would unblock it"). Only a location the rider could not reach asks anything of the vendor; the other three are decisions Melarc takes, or
 * the vendor's own request honoured, and the notice says so by asking nothing. Derived by the use case from the reason it validated, never
 * taken from the client, and recorded in the audit event of the notice (`vendor.pickup_skip.notified`).
 */
export const SKIP_REQUESTED_VENDOR_ACTIONS: Readonly<
  Record<string, 'NONE' | 'CORRECT_PICKUP_LOCATION'>
> = Object.freeze({
  RUN_CUT_SHORT: 'NONE',
  VENDOR_REQUESTED_SKIP: 'NONE',
  LOCATION_INACCESSIBLE: 'CORRECT_PICKUP_LOCATION',
  STOP_RAISED_IN_ERROR: 'NONE',
});

/** The vendor action a skip asks for. A reason the catalogue gains later without a decision here asks nothing, and the notice says so. */
export function requestedVendorActionOf(reasonCode: string): 'NONE' | 'CORRECT_PICKUP_LOCATION' {
  return SKIP_REQUESTED_VENDOR_ACTIONS[reasonCode] ?? 'NONE';
}

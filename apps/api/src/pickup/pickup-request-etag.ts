import { createHash } from 'node:crypto';

import { exceptionOutcomeOf, type PickupRequestView } from './pickup-request-view.js';

/**
 * The ETag of a pickup request (S1.13; domain-model.md section 6.2; `AC-SLICE-001-10`): an **opaque strong validator of what the read
 * returned**, modelled on the staff identity's (`staff-identity-etag.ts`). It is the digest of the **complete representation** the read
 * answers and of the request's **durable version** (`version`, which the database moves for any change to the row). So it changes when
 * anything the caller was shown changes and when anything else about the row does, and a mutation that takes it compares it **under the
 * request's lock, against the ETag recomputed in that transaction**, so that two Ops users who read one request and both confirm it
 * cannot both succeed: the second one holds a token that names a request that has since moved (`STATE_CONFLICT`).
 *
 * It is opaque: the digest names no version and no field, and a client treats it as a string to send back in `If-Match`. The header is read
 * strictly: exactly one strong quoted token of this form, and equal to the current one.
 */
const DOMAIN = 'melarc.pickup-request-etag.v1';

/**
 * Every member of the representation, in the order that is hashed. The record type has exactly the keys of the view, so a member added
 * to the view (or taken from it) stops this file from building until the digest says what it does about it.
 */
function representationOf(view: PickupRequestView): readonly unknown[] {
  // A member the representation may leave out is hashed as null, so that its absence and its presence are two different tokens.
  const fields: Record<keyof PickupRequestView, unknown> = {
    id: view.id,
    code: view.code,
    state: view.state,
    responsible_hub_id: view.responsible_hub_id,
    pickup_intent: view.pickup_intent,
    vendor_organization_id: view.vendor_organization_id,
    ad_hoc_sender_id: view.ad_hoc_sender_id,
    collection_point: view.collection_point ?? null,
    collection_reference: view.collection_reference ?? null,
    collection_item: view.collection_item ?? null,
    destination_location_id: view.destination_location_id,
    pickup_location: view.pickup_location,
    resolved_pickup_location: view.resolved_pickup_location,
    current_item_description: view.current_item_description,
    scheduled_service_date: view.scheduled_service_date,
    declared_package_count: view.declared_package_count,
    default_payer_intent: view.default_payer_intent,
    one_package_exception_id: view.one_package_exception_id,
    attempt_number: view.attempt_number,
    replaces_request_id: view.replaces_request_id,
    cancelled_by_actor_type: view.cancelled_by_actor_type,
    declared_value_minor: view.declared_value_minor,
    liability_cap_acknowledged_at: view.liability_cap_acknowledged_at,
    liability_cap_snapshot: view.liability_cap_snapshot,
    cancellation_charge_outcome: view.cancellation_charge_outcome,
    cancellation_charge: view.cancellation_charge,
    created_at: view.created_at,
    confirmed_at: view.confirmed_at,
    cutoff_exception_state: view.cutoff_exception_state,
    vendor_pickup_location_id: view.vendor_pickup_location_id,
    primary_phone: view.primary_phone,
    secondary_phone: view.secondary_phone,
    replacement_request_id: view.replacement_request_id,
    indicative_estimate: view.indicative_estimate,
    cancellation_charge_snapshot: view.cancellation_charge_snapshot,
    sender_name: view.sender_name,
    split_basis: view.split_basis,
    split_sender_amount: view.split_sender_amount,
    split_sender_percentage: view.split_sender_percentage,
    location_overrides: view.location_overrides,
    attempt_extension_id: view.attempt_extension_id,
    cancelled_at: view.cancelled_at,
    escalated_at: view.escalated_at,
    cancellation_reason: view.cancellation_reason,
    rider_assigned: view.rider_assigned,
    // The outcome of the exception and no more, so that a caller who is shown only the outcome holds the token of one who is shown it all.
    one_package_exception:
      view.one_package_exception === null ? null : exceptionOutcomeOf(view.one_package_exception),
  };
  return Object.values(fields);
}

const PICKUP_ETAG = /^"[A-Za-z0-9_-]{43}"$/;

/**
 * The ETag of a request: of the stored representation (the estimate of an operation that just computed one is not part of it, so that a
 * read and the answer of the operation that made the request carry the same token).
 */
export function pickupRequestEtagOf(view: PickupRequestView, version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new RangeError('A record version is a non-negative safe integer');
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        DOMAIN,
        version,
        ...representationOf({ ...view, indicative_estimate: null }),
      ]),
      'utf8',
    )
    .digest('base64url');
  return `"${digest}"`;
}

/** Whether the header is exactly the current ETag. Missing, weak, a list, unquoted, another form and different all answer `false`. */
export function pickupRequestEtagMatches(header: string | undefined, current: string): boolean {
  return typeof header === 'string' && PICKUP_ETAG.test(header) && header === current;
}

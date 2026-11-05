import { describe, expect, it } from 'vitest';

import { pickupRequestEtagMatches, pickupRequestEtagOf } from './pickup-request-etag.js';
import {
  viewOf,
  type OnePackageExceptionView,
  type PickupRequestRow,
  type PickupRequestView,
} from './pickup-request-view.js';

const ROW: PickupRequestRow = {
  id: '5eed0200-0000-4000-8000-000000000001',
  code: 'ACC-PR-7K3M9Q',
  state: 'PENDING',
  responsible_hub_id: '5eed0100-0000-4000-8000-000000000001',
  pickup_intent: 'OWN_PACKAGES',
  vendor_organization_id: '5eed0300-0000-4000-8000-000000000001',
  ad_hoc_sender_id: null,
  sender_name: 'Demonstration Vendor',
  collection_point: null,
  collection_reference: null,
  collection_item: null,
  destination_location_id: null,
  pickup_location: null,
  resolved_pickup_location: { address: 'Shop, Community 1' },
  current_item_description: null,
  scheduled_service_date: '2026-11-03',
  declared_package_count: 3,
  default_payer_intent: 'RECIPIENT_PAYS',
  one_package_exception_id: null,
  attempt_number: 1,
  replaces_request_id: null,
  replacement_request_id: null,
  cancelled_by_actor_type: null,
  declared_value_minor: null,
  liability_cap_acknowledged_at: null,
  liability_cap_snapshot: null,
  cancellation_charge_outcome: null,
  cancellation_charge_snapshot: null,
  created_at: new Date('2026-11-02T09:00:00.000Z'),
  created_at_text: '2026-11-02 09:00:00+00',
  confirmed_at: null,
  cancelled_at: null,
  escalated_at: null,
  cutoff_exception_state: null,
  vendor_pickup_location_id: null,
  primary_phone: '+233200000001',
  secondary_phone: null,
  split_basis: null,
  split_sender_amount_minor: null,
  split_sender_percentage: null,
  location_overrides: null,
  attempt_extension_id: null,
  cancellation_reason_code: null,
  cancellation_reason_label: null,
  rider_assigned: false,
  version: 1,
};

const view = (overrides: Partial<PickupRequestRow> = {}): PickupRequestView =>
  viewOf({ ...ROW, ...overrides });

describe('the ETag of a pickup request', () => {
  // Break caught: a token that is not the form a client can send back strictly (43 base64url characters between quotes).
  it('is one strong quoted token of a SHA-256 digest', () => {
    expect(pickupRequestEtagOf(view(), 1)).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
  });

  it('is the same for the same representation and version, every time', () => {
    expect(pickupRequestEtagOf(view(), 4)).toBe(pickupRequestEtagOf(view(), 4));
  });

  // Break caught: a token that does not move with the record's version (a second confirmation would then succeed on a stale read), or one
  // that moves with nothing the caller was shown and everything else.
  it('moves with the version', () => {
    expect(pickupRequestEtagOf(view(), 2)).not.toBe(pickupRequestEtagOf(view(), 1));
  });

  // Break caught: a member of the representation left out of the digest, so that a change the caller can see goes unnoticed.
  it.each([
    ['state', { state: 'CONFIRMED' as const }],
    ['the package count', { declared_package_count: 4 }],
    ['the service date', { scheduled_service_date: '2026-11-04' }],
    ['the phone', { primary_phone: '+233200000002' }],
    ['the location', { resolved_pickup_location: { address: 'Elsewhere' } }],
    ['the cutoff state', { cutoff_exception_state: 'PENDING_OPS_REVIEW' }],
    ['the sender name', { sender_name: 'Another' }],
    ['the attempt number', { attempt_number: 2 }],
    ['the rider assignment', { rider_assigned: true }],
    ['the escalation', { escalated_at: '2026-11-03T10:00:00.000Z' }],
    ['the charge outcome', { cancellation_charge_outcome: 'NOT_APPLIED' }],
  ] as const)('moves with %s', (_label, change) => {
    expect(pickupRequestEtagOf(view(change), 1)).not.toBe(pickupRequestEtagOf(view(), 1));
  });

  // Break caught: the estimate in the token. A read carries none and the operation that made the request carries one, and the two must
  // answer the same token, or the first confirmation after a booking would be refused as stale.
  it('does not depend on the estimate an operation attached to its answer', () => {
    const withEstimate: PickupRequestView = {
      ...view(),
      indicative_estimate: {
        status: 'AVAILABLE',
        provisional: true,
        total: { amount_minor: 10500, currency: 'GHS' },
        assumes_size_class: 'SMALL',
        excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
        components: [],
      },
    };
    expect(pickupRequestEtagOf(withEstimate, 1)).toBe(pickupRequestEtagOf(view(), 1));
  });

  it('refuses a version that is not a non-negative safe integer', () => {
    for (const version of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => pickupRequestEtagOf(view(), version)).toThrow(RangeError);
    }
  });

  describe('the exception the request carries', () => {
    const exception: OnePackageExceptionView = {
      id: '5eed0500-0000-4000-8000-000000000001',
      state: 'APPROVED',
      requested_by: '5eed0600-0000-4000-8000-000000000001',
      requested_at: '2026-11-02T09:00:00.000Z',
      approved_by: '5eed0600-0000-4000-8000-000000000002',
      decided_at: '2026-11-02T09:30:00.000Z',
      note: 'The customer sends one parcel to a relative',
      recipient: {
        name: 'Kofi Recipient',
        phone: '024 400 0111',
        location: { address: 'House 7' },
      },
      single_package_fee: { amount_minor: 2000, currency: 'GHS' },
    };
    const carrying = (shown: OnePackageExceptionView) => ({
      ...view(),
      one_package_exception: shown,
    });

    // Break caught: a token that depends on what only staff are shown of the exception, so that a vendor, who is not shown it, holds
    // another token than Ops for one request and its own `If-Match` is refused (the owner's decision of 29 October 2026: a vendor
    // reads the outcome only).
    it('is the same whether or not the staff-only members are shown', () => {
      const { requested_by, approved_by, note, ...outcome } = exception;
      expect([requested_by, approved_by, note]).toHaveLength(3);
      expect(pickupRequestEtagOf(carrying(outcome), 1)).toBe(
        pickupRequestEtagOf(carrying(exception), 1),
      );
      expect(pickupRequestEtagOf(carrying({ ...exception, note: 'Another note' }), 1)).toBe(
        pickupRequestEtagOf(carrying(exception), 1),
      );
    });

    // Break caught: a member of the outcome left out of the digest, so that an approval, a refusal or a fee that a vendor can see goes
    // unnoticed by the token.
    it.each<[string, Partial<OnePackageExceptionView>]>([
      ['its state', { state: 'REJECTED' }],
      ['the moment it was asked for', { requested_at: '2026-11-02T10:00:00.000Z' }],
      ['the moment it was decided', { decided_at: '2026-11-02T11:00:00.000Z' }],
      ['the recipient', { recipient: { ...exception.recipient, name: 'Ama Recipient' } }],
      ['the fee that became due', { single_package_fee: { amount_minor: 2500, currency: 'GHS' } }],
      ['its identity', { id: '5eed0500-0000-4000-8000-000000000002' }],
    ])('moves with %s', (_label, change) => {
      expect(pickupRequestEtagOf(carrying({ ...exception, ...change }), 1)).not.toBe(
        pickupRequestEtagOf(carrying(exception), 1),
      );
    });

    it('moves with having an exception at all', () => {
      expect(pickupRequestEtagOf(carrying(exception), 1)).not.toBe(pickupRequestEtagOf(view(), 1));
    });
  });
});

describe('matching an If-Match header', () => {
  const current = pickupRequestEtagOf(view(), 1);

  it('accepts exactly the current token', () => {
    expect(pickupRequestEtagMatches(current, current)).toBe(true);
  });

  // Break caught: a weak validator, a list, an unquoted token, a missing header or another token accepted as a match.
  it.each([
    undefined,
    '',
    `W/${current}`,
    `${current}, ${current}`,
    current.slice(1, -1),
    '"short"',
    pickupRequestEtagOf(view(), 2),
  ])('refuses %j', (header) => {
    expect(pickupRequestEtagMatches(header, current)).toBe(false);
  });
});

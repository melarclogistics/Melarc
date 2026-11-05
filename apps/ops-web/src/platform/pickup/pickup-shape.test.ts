import { describe, expect, it } from 'vitest';

import {
  adHocSenderFixture,
  approvalFixture,
  approvedFixture,
  cancellationReasonFixture,
  COLLEAGUE_ID,
  estimateFixture,
  exceptionFixture,
  exceptionOutcomeFixture,
  OFFICER_ID,
  pickupRequestFixture,
  savedLocationFixture,
  unavailableEstimate,
  VENDOR_ORG_ID,
} from '../../test-support/pickup-fixture';
import {
  calendarDateOf,
  parseAdHocSenders,
  parseApproval,
  parseAttributedReasons,
  parseEstimate,
  parseOnePackageException,
  parsePickupRequest,
  parsePickupRequestPage,
  parseVendorPickupLocations,
} from './pickup-shape';

/**
 * The guards of the pickup screens (S1.19): what they keep of a real answer, and the answers they refuse whole. Each refusal is a way a
 * screen would otherwise draw something the server never said: a code that cannot be read aloud, a charge that is not money, an estimate
 * with a figure it did not give.
 */
describe('parsePickupRequest', () => {
  it('keeps the fields the screens read, and leaves out what is null or absent', () => {
    const request = parsePickupRequest(pickupRequestFixture());

    expect(request).toEqual({
      id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d',
      code: 'ACC-PR-7KQ2MZ',
      state: 'PENDING',
      responsible_hub_id: '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d',
      scheduled_service_date: '2026-11-03',
      attempt_number: 1,
      pickup_intent: 'OWN_PACKAGES',
      resolved_pickup_location: {
        address: '14 Demo Lane, Osu',
        landmark: 'Opposite the demo bakery',
      },
      declared_package_count: 3,
      default_payer_intent: 'RECIPIENT_PAYS',
      created_at: '2026-10-29T08:15:00Z',
      primary_phone: '+233201234567',
      sender_name: 'Demo Fabrics Ltd',
      rider_assigned: false,
    });
  });

  // S1.15 to S1.18: what the API now says of every request, kept as it said it.
  it('keeps the escalation, the extension, the cancellation’s reason and moment, a split and the exception', () => {
    const request = parsePickupRequest(
      pickupRequestFixture({
        state: 'CANCELLED',
        default_payer_intent: 'SPLIT',
        split_basis: 'FIXED_AMOUNT',
        split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
        attempt_extension_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
        cancelled_at: '2026-10-30T09:00:00Z',
        escalated_at: '2026-10-30T08:00:00Z',
        cancellation_reason: { code: 'DEMO_CUSTOMER_CHANGED_MIND', label: 'Demo: changed mind' },
        rider_assigned: true,
        one_package_exception: exceptionFixture(),
      }),
    );

    expect(request).toMatchObject({
      split_basis: 'FIXED_AMOUNT',
      split_sender_amount: { amount_minor: 1000, currency: 'GHS' },
      attempt_extension_id: '7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e',
      cancelled_at: '2026-10-30T09:00:00Z',
      escalated_at: '2026-10-30T08:00:00Z',
      rider_assigned: true,
    });
    // The reason's code is the server's: only its words are kept.
    expect(request?.cancellation_reason).toEqual({ label: 'Demo: changed mind' });
    expect(request?.one_package_exception?.state).toBe('REQUESTED');
  });

  // Break caught: a field the contract adds, or one a server should never send, carried onto a screen because nothing read it.
  it('carries nothing it did not read', () => {
    const request = parsePickupRequest({
      ...pickupRequestFixture(),
      vendor_organization_id: VENDOR_ORG_ID,
      internal_price_minor: 999_999,
      price: { amount_minor: 5, currency: 'GHS' },
    });

    expect(request).toBeDefined();
    expect(Object.keys(request ?? {})).not.toContain('internal_price_minor');
    expect(Object.keys(request ?? {})).not.toContain('price');
    expect(Object.keys(request ?? {})).not.toContain('vendor_organization_id');
  });

  it('keeps a cancelled request’s charge, its snapshot and the estimate, as integers of pesewas', () => {
    const request = parsePickupRequest(
      pickupRequestFixture({
        state: 'CANCELLED',
        cancelled_by_actor_type: 'OPS',
        cancellation_charge_outcome: 'APPLIED',
        cancellation_charge: { amount_minor: 2000, currency: 'GHS' },
        cancellation_charge_snapshot: {
          amount_minor: 2000,
          setting_key: 'cancellation_charge_amount',
          effective_version: '1',
        },
        indicative_estimate: estimateFixture(),
      }),
    );

    expect(request?.cancellation_charge).toEqual({ amount_minor: 2000, currency: 'GHS' });
    expect(request?.cancellation_charge_snapshot).toEqual({ amount_minor: 2000 });
    expect(request?.indicative_estimate?.total).toEqual({ amount_minor: 4500, currency: 'GHS' });
  });

  it('keeps a collection’s point, reference and item', () => {
    const request = parsePickupRequest(
      pickupRequestFixture({
        pickup_intent: 'COLLECT_FOR_VENDOR',
        collection_point: {
          contact_name: 'Demo seller',
          phone: '+233200000001',
          location: { address: '3 Demo Market Road' },
          landmark: null,
        },
        collection_reference: { reference_name: 'Demo order', seller_order_reference: null },
        collection_item: { description: 'Demo sandals', quantity: 2, handling_note: 'Fragile' },
      }),
    );

    expect(request?.collection_point).toEqual({
      contact_name: 'Demo seller',
      phone: '+233200000001',
      location: { address: '3 Demo Market Road' },
    });
    expect(request?.collection_reference).toEqual({ reference_name: 'Demo order' });
    expect(request?.collection_item).toEqual({
      description: 'Demo sandals',
      quantity: 2,
      handling_note: 'Fragile',
    });
  });

  // Break caught: a record drawn in part when one of its fields is not what the contract says, which would put a wrong fact on the screen.
  it.each([
    ['a code with letters read aloud wrongly', { code: 'ACC-PR-0OIL1Z' }],
    ['a code of another shape', { code: 'PR-12345' }],
    ['an id that is not a uuid', { id: 'request-1' }],
    ['a state the contract does not have', { state: 'HELD' }],
    ['a service date that does not exist', { scheduled_service_date: '2026-02-30' }],
    ['a service date that is an instant', { scheduled_service_date: '2026-11-03T00:00:00Z' }],
    ['an attempt of zero', { attempt_number: 0 }],
    ['an attempt that is a fraction', { attempt_number: 1.5 }],
    ['packages of zero', { declared_package_count: 0 }],
    ['an intent the contract does not have', { pickup_intent: 'COURIER' }],
    ['a payer the contract does not have', { default_payer_intent: 'NOBODY' }],
    ['a charge that is a float', { cancellation_charge: { amount_minor: 20.5, currency: 'GHS' } }],
    [
      'a charge in another currency',
      { cancellation_charge: { amount_minor: 2000, currency: 'USD' } },
    ],
    ['a negative declared value', { declared_value_minor: -1 }],
    ['an outcome the contract does not have', { cancellation_charge_outcome: 'FORGIVEN' }],
    ['a cut-off state the contract does not have', { cutoff_exception_state: 'LATE' }],
    ['a replacement that is not a uuid', { replacement_request_id: 'next' }],
    ['an address that is blank', { resolved_pickup_location: { address: '  ' } }],
    ['a time that is not an instant', { created_at: 'yesterday' }],
    ['an escalation that is not an instant', { escalated_at: 'today' }],
    ['a rider assignment that is not a yes or a no', { rider_assigned: 'yes' }],
    ['a split share above a hundred', { split_sender_percentage: 101 }],
    ['a split basis the contract does not have', { split_basis: 'HALF' }],
    ['an extension that is not a uuid', { attempt_extension_id: 'ext-1' }],
    ['a cancellation reason with a code that is not one', { cancellation_reason: { code: 'a b' } }],
    ['an exception that is not one', { one_package_exception: { state: 'REQUESTED' } }],
  ])('refuses a request with %s', (_label, change) => {
    expect(parsePickupRequest({ ...pickupRequestFixture(), ...change })).toBeUndefined();
  });

  it.each([null, [], 'request', 42])('refuses %j', (body) => {
    expect(parsePickupRequest(body)).toBeUndefined();
  });
});

describe('parseEstimate', () => {
  it('keeps an available estimate: its figure, what it assumes and leaves out, and its parts', () => {
    expect(parseEstimate(estimateFixture())).toEqual({
      status: 'AVAILABLE',
      total: { amount_minor: 4500, currency: 'GHS' },
      assumesSizeClass: 'SMALL',
      excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
      components: [
        {
          kind: 'SERVICE_AREA_BASE_FEE',
          quantity: 3,
          amount: { amount_minor: 4500, currency: 'GHS' },
        },
      ],
    });
  });

  it.each(['UNAVAILABLE_OUTSIDE_SERVICE_AREA', 'UNAVAILABLE_SETTING_MISSING'] as const)(
    'keeps an estimate that is %s, with no figure',
    (status) => {
      expect(parseEstimate(unavailableEstimate(status))).toMatchObject({ status, total: null });
    },
  );

  // Break caught: a figure shown for an estimate the server said it could not give, or a figure missing from one it gave.
  it.each([
    ['not provisional', { provisional: false }],
    ['available with no figure', { total: null }],
    ['unavailable with a figure', { status: 'UNAVAILABLE_SETTING_MISSING' }],
    ['a figure that is not money', { total: { amount_minor: '45', currency: 'GHS' } }],
    ['another size assumed', { assumes_size_class: 'LARGE' }],
    ['an exclusion it does not know', { excludes: ['FUEL'] }],
    [
      'a part that is not one',
      { components: [{ kind: 'TIP', quantity: 1, amount: { amount_minor: 1, currency: 'GHS' } }] },
    ],
  ])('refuses an estimate %s', (_label, change) => {
    expect(parseEstimate({ ...estimateFixture(), ...change })).toBeUndefined();
  });
});

describe('parsePickupRequestPage', () => {
  it('keeps a page and the token of the next', () => {
    const page = parsePickupRequestPage({ items: [pickupRequestFixture()], next_page_token: 'n2' });

    expect(page?.items).toHaveLength(1);
    expect(page?.nextPageToken).toBe('n2');
  });

  it('refuses a page with one request that is not one, a request twice, or a token that is not one', () => {
    expect(
      parsePickupRequestPage({
        items: [pickupRequestFixture(), { ...pickupRequestFixture(), state: 'HELD' }],
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(
      parsePickupRequestPage({
        items: [pickupRequestFixture(), pickupRequestFixture()],
        next_page_token: null,
      }),
    ).toBeUndefined();
    expect(parsePickupRequestPage({ items: [], next_page_token: '' })).toBeUndefined();
    expect(parsePickupRequestPage({ items: [] })).toBeUndefined();
  });
});

describe('the reads of the booking', () => {
  it('keeps a returning sender, and an unknown phone as no sender', () => {
    expect(parseAdHocSenders({ items: [adHocSenderFixture()] })).toEqual([
      {
        id: '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c',
        display_name: 'Efua Demo Sender',
        phone: '+233241112222',
        state: 'REUSABLE',
        blocked: false,
      },
    ]);
    expect(parseAdHocSenders({ items: [] })).toEqual([]);
    expect(
      parseAdHocSenders({ items: [adHocSenderFixture(), adHocSenderFixture()] }),
    ).toBeUndefined();
  });

  it('keeps the saved locations of the vendor asked about, and refuses another vendor’s', () => {
    expect(
      parseVendorPickupLocations({ items: [savedLocationFixture()] }, VENDOR_ORG_ID),
    ).toHaveLength(1);
    expect(
      parseVendorPickupLocations(
        {
          items: [
            savedLocationFixture({
              vendor_organization_id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
            }),
          ],
        },
        VENDOR_ORG_ID,
      ),
    ).toBeUndefined();
  });

  // Break caught: two active defaults, which would leave the booking's own default unclear.
  it('refuses two active default locations', () => {
    expect(
      parseVendorPickupLocations(
        {
          items: [
            savedLocationFixture(),
            savedLocationFixture({ id: '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b', label: 'Second' }),
          ],
        },
        VENDOR_ORG_ID,
      ),
    ).toBeUndefined();
  });

  it('keeps the approval a request for an exception answers', () => {
    expect(parseApproval(approvalFixture())).toEqual({
      id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
      state: 'REQUESTED',
      requested_by: '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
    });
    expect(parseApproval({ ...approvalFixture(), state: 'MAYBE' })).toBeUndefined();
  });

  it('keeps the checker of an approval, and refuses one that is not a uuid', () => {
    expect(parseApproval(approvedFixture())).toEqual({
      id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
      state: 'APPROVED',
      requested_by: COLLEAGUE_ID,
      approved_by: OFFICER_ID,
    });
    expect(parseApproval(approvedFixture({ approved_by: 'me' }))).toBeUndefined();
  });
});

describe('parseOnePackageException', () => {
  it('keeps who asked and when, why, and the recipient; a fee only when the server snapshotted one', () => {
    expect(parseOnePackageException(exceptionFixture())).toEqual({
      id: '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d',
      state: 'REQUESTED',
      requested_by: COLLEAGUE_ID,
      requested_at: '2026-10-29T08:20:00Z',
      note: 'Bridal gown, urgent',
      recipient: {
        name: 'Abena Demo',
        phone: '+233240000000',
        location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
      },
    });
    expect(
      parseOnePackageException(
        exceptionFixture({
          state: 'APPROVED',
          approved_by: OFFICER_ID,
          decided_at: '2026-10-29T09:00:00Z',
          single_package_fee: { amount_minor: 2000, currency: 'GHS' },
        }),
      ),
    ).toMatchObject({
      approved_by: OFFICER_ID,
      decided_at: '2026-10-29T09:00:00Z',
      single_package_fee: { amount_minor: 2000, currency: 'GHS' },
    });
  });

  // A note is kept as the ledger keeps it: one line of up to a thousand characters, which is longer than a label.
  it('keeps a long note the ledger keeps, and refuses one longer or on two lines', () => {
    expect(parseOnePackageException(exceptionFixture({ note: 'x'.repeat(1000) }))).toBeDefined();
    expect(parseOnePackageException(exceptionFixture({ note: 'x'.repeat(1001) }))).toBeUndefined();
    expect(parseOnePackageException(exceptionFixture({ note: 'one\ntwo' }))).toBeUndefined();
  });

  it.each([
    ['a state the contract does not have', { state: 'WITHDRAWN' }],
    ['no recipient', { recipient: undefined }],
    [
      'a recipient with a blank name',
      { recipient: { name: ' ', phone: '+233240000000', location: { address: '9 Demo Street' } } },
    ],
    ['a fee that is not money', { single_package_fee: { amount_minor: 20.5, currency: 'GHS' } }],
    ['a moment that is not an instant', { requested_at: 'this morning' }],
    ['a blank note', { note: '   ' }],
  ])('refuses an exception with %s', (_label, change) => {
    expect(parseOnePackageException({ ...exceptionFixture(), ...change })).toBeUndefined();
  });
});

/**
 * The exception this portal draws is **staff's**, in whole (the contract's `OnePackageException`): who asked, who decided it (null until someone
 * has) and why are always there, and the maker-checker screens judge by them. The outcome every other reader gets (`OnePackageExceptionOutcome`)
 * has none of the three, and an exception that arrives in that shape is refused rather than drawn: a requester the portal cannot name is one it
 * cannot warn a would-be approver about, and an approval must never look eligible for want of it.
 */
describe('parseOnePackageException: the staff view and nothing else', () => {
  const STAFF_ONLY = ['requested_by', 'approved_by', 'note'] as const;
  const decided = () =>
    exceptionFixture({
      state: 'APPROVED',
      approved_by: OFFICER_ID,
      decided_at: '2026-10-29T09:00:00Z',
    });
  const without = (body: object, member: string): object =>
    Object.fromEntries(Object.entries(body).filter(([name]) => name !== member));

  // Break caught: an exception drawn that lost a member the maker-checker screens judge by (no requester, no checker, no reason).
  it.each(STAFF_ONLY)(
    'refuses an exception that has no %s, which is not the staff view',
    (member) => {
      expect(parseOnePackageException(without(decided(), member))).toBeUndefined();
      expect(parseOnePackageException(without(exceptionFixture(), member))).toBeUndefined();
    },
  );

  it('refuses the outcome a vendor reads, whole', () => {
    expect(parseOnePackageException(exceptionOutcomeFixture())).toBeUndefined();
    expect(
      parseOnePackageException(
        exceptionOutcomeFixture({ state: 'APPROVED', decided_at: '2026-10-29T09:00:00Z' }),
      ),
    ).toBeUndefined();
  });

  // Break caught: a checker that is absent read as "nobody yet", which would make a decided exception without its checker pass for an undecided one.
  it('keeps an exception nobody has decided: its checker is null, which is a value and not a gap', () => {
    const asked = parseOnePackageException(exceptionFixture());

    expect(asked).toBeDefined();
    expect(asked).not.toHaveProperty('approved_by');
    expect(parseOnePackageException({ ...exceptionFixture(), approved_by: null })).toBeDefined();
  });

  it.each([
    ['null', null],
    ['a number', 12],
    ['text that is not an identifier', 'me'],
    ['blank', ''],
    ['a list', ['5eed0500-0000-4000-8000-000000000001']],
  ])('refuses a requester that is %s', (_label, requestedBy) => {
    expect(
      parseOnePackageException({ ...exceptionFixture(), requested_by: requestedBy }),
    ).toBeUndefined();
  });

  it.each([
    ['a number', 12],
    ['text that is not an identifier', 'me'],
    ['blank', ''],
  ])('refuses a checker that is %s', (_label, approvedBy) => {
    expect(parseOnePackageException({ ...decided(), approved_by: approvedBy })).toBeUndefined();
  });

  // Break caught: a request drawn with an exception that was not meant for the portal, or half of one, beside a requester it cannot name.
  it('refuses the request that carries an outcome, whole, and the page that holds that request', () => {
    const carrying = pickupRequestFixture({ one_package_exception: exceptionOutcomeFixture() });

    expect(parsePickupRequest(carrying)).toBeUndefined();
    expect(
      parsePickupRequestPage({
        items: [pickupRequestFixture(), carrying],
        next_page_token: null,
      }),
    ).toBeUndefined();
  });
});

describe('parseAttributedReasons', () => {
  it('keeps the active reasons of the domain asked for, with their attribution, in the server’s order', () => {
    expect(
      parseAttributedReasons(
        [
          cancellationReasonFixture(),
          cancellationReasonFixture({ code: 'DEMO_RETIRED', active: false }),
          cancellationReasonFixture({
            code: 'DEMO_MELARC',
            attribution: 'MELARC',
            requiresNote: true,
          }),
        ],
        'PICKUP_CANCELLATION',
      ),
    ).toEqual([
      {
        code: 'DEMO_CUSTOMER_CHANGED_MIND',
        label: 'Demo: the customer changed their mind',
        requiresNote: false,
        attribution: 'CUSTOMER',
      },
      {
        code: 'DEMO_MELARC',
        label: 'Demo: the customer changed their mind',
        requiresNote: true,
        attribution: 'MELARC',
      },
    ]);
  });

  // The domain's codes are the Product Owner's and may not be seeded: an empty catalogue is an answer, not a failure.
  it('keeps an empty catalogue as no reason', () => {
    expect(parseAttributedReasons([], 'PICKUP_CANCELLATION')).toEqual([]);
  });

  // Break caught: a reason of another domain offered for a cancellation, or one whose attribution cannot decide the charge.
  it.each([
    ['of another domain', { domain: 'PICKUP_FAILURE' }],
    ['with no attribution', { attribution: undefined }],
    ['with an attribution the contract does not have', { attribution: 'VENDOR' }],
    ['with a code that is not one', { code: 'two words' }],
    ['with a blank label', { label: ' ' }],
  ])('refuses a catalogue with a reason %s', (_label, change) => {
    expect(
      parseAttributedReasons(
        [{ ...cancellationReasonFixture(), ...change }],
        'PICKUP_CANCELLATION',
      ),
    ).toBeUndefined();
  });
});

describe('calendarDateOf', () => {
  it('keeps a date of the calendar, as the text it came as', () => {
    expect(calendarDateOf('2026-11-03')).toBe('2026-11-03');
    expect(calendarDateOf('2028-02-29')).toBe('2028-02-29');
  });

  it.each(['2026-02-29', '2026-13-01', '2026-11-3', '03/11/2026', '', null, 20261103])(
    'refuses %j',
    (value) => {
      expect(calendarDateOf(value)).toBeUndefined();
    },
  );
});

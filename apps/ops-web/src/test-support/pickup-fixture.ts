import type { components } from '@melarc/api-client';

/**
 * Real-shaped answers of the pickup reads and acts, for tests (S1.19). Every field the contract requires is present and each value is synthetic.
 * The types are the contract's: nothing here describes the wire a second time.
 */
type PickupRequestBody = components['schemas']['PickupRequest'];
type EstimateBody = components['schemas']['IndicativeEstimate'];
type VendorPickupLocationBody = components['schemas']['VendorPickupLocation'];
type AdHocSenderBody = components['schemas']['AdHocSender'];
type ApprovalBody = components['schemas']['Approval'];
type OnePackageExceptionBody = components['schemas']['OnePackageException'];
type OnePackageExceptionOutcomeBody = components['schemas']['OnePackageExceptionOutcome'];
type ReasonBody = components['schemas']['ReasonDefinition'];

/** The hub of `sessionFixture`, so that a session's hubs name it. */
export const PICKUP_HUB_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';
export const REQUEST_ID = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
export const EARLIER_REQUEST_ID = '1b2c3d4e-5f6a-4b7c-9d8e-9f0a1b2c3d4e';
export const LATER_REQUEST_ID = '2c3d4e5f-6a7b-4c8d-8e9f-0a1b2c3d4e5f';
export const VENDOR_ORG_ID = '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a';
export const LOCATION_ID = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';
export const OTHER_LOCATION_ID = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b';
export const SENDER_ID = '5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c';
export const APPROVAL_ID = '6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d';
/** The principal of `sessionFixture`: the signed-in officer. */
export const OFFICER_ID = '8a1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
/** Another member of staff, who asked for an exception the officer may approve. */
export const COLLEAGUE_ID = '9b2e3d4f-5a61-4b7c-8d8e-0f1a2b3c4d5e';

/**
 * A request as `getPickupRequest` answers it: three packages of a vendor's own, waiting for confirmation, at the session's hub, with the fields
 * the API sends for every request (S1.15 to S1.18) at their resting values.
 */
export function pickupRequestFixture(
  overrides: Partial<PickupRequestBody> = {},
): PickupRequestBody {
  return {
    id: REQUEST_ID,
    code: 'ACC-PR-7KQ2MZ',
    state: 'PENDING',
    responsible_hub_id: PICKUP_HUB_ID,
    pickup_intent: 'OWN_PACKAGES',
    vendor_organization_id: VENDOR_ORG_ID,
    ad_hoc_sender_id: null,
    pickup_location: null,
    resolved_pickup_location: {
      address: '14 Demo Lane, Osu',
      landmark: 'Opposite the demo bakery',
    },
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
    cancellation_charge: null,
    cancellation_charge_snapshot: null,
    created_at: '2026-10-29T08:15:00Z',
    confirmed_at: null,
    cutoff_exception_state: null,
    vendor_pickup_location_id: null,
    primary_phone: '+233201234567',
    secondary_phone: null,
    sender_name: 'Demo Fabrics Ltd',
    split_basis: null,
    split_sender_amount: null,
    split_sender_percentage: null,
    location_overrides: null,
    attempt_extension_id: null,
    cancelled_at: null,
    escalated_at: null,
    cancellation_reason: null,
    rider_assigned: false,
    one_package_exception: null,
    ...overrides,
  };
}

/** The one-package exception of a single package, asked for by a colleague and waiting for its approver. */
export function exceptionFixture(
  overrides: Partial<OnePackageExceptionBody> = {},
): OnePackageExceptionBody {
  return {
    id: APPROVAL_ID,
    state: 'REQUESTED',
    requested_by: COLLEAGUE_ID,
    requested_at: '2026-10-29T08:20:00Z',
    approved_by: null,
    decided_at: null,
    note: 'Bridal gown, urgent',
    recipient: {
      name: 'Abena Demo',
      phone: '+233240000000',
      location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
    },
    single_package_fee: null,
    ...overrides,
  };
}

/**
 * The same exception as every reader who is not staff gets it, a Vendor among them: the outcome only, with none of who asked, who decided it or
 * why. This portal is staff's and draws none of it: a body of this shape is one it refuses.
 */
export function exceptionOutcomeFixture(
  overrides: Partial<OnePackageExceptionOutcomeBody> = {},
): OnePackageExceptionOutcomeBody {
  return {
    id: APPROVAL_ID,
    state: 'REQUESTED',
    requested_at: '2026-10-29T08:20:00Z',
    decided_at: null,
    recipient: {
      name: 'Abena Demo',
      phone: '+233240000000',
      location: { address: '9 Demo Street, Tema', landmark: 'Near the demo clinic' },
    },
    single_package_fee: null,
    ...overrides,
  };
}

/** The estimate of a standard request of three packages: base fee × 3, provisional, assuming small parcels. */
export function estimateFixture(overrides: Partial<EstimateBody> = {}): EstimateBody {
  return {
    status: 'AVAILABLE',
    provisional: true,
    total: { amount_minor: 4500, currency: 'GHS' },
    assumes_size_class: 'SMALL',
    excludes: ['SIZE_SURCHARGE', 'HIGH_VALUE_SURCHARGE'],
    components: [
      {
        kind: 'SERVICE_AREA_BASE_FEE',
        hub_id: PICKUP_HUB_ID,
        setting_key: 'service_area_base_fee',
        effective_version: '1',
        quantity: 3,
        amount: { amount_minor: 4500, currency: 'GHS' },
      },
    ],
    ...overrides,
  };
}

/** An estimate the server could not give, for the reason named: no figure and no parts. */
export const unavailableEstimate = (
  status: 'UNAVAILABLE_OUTSIDE_SERVICE_AREA' | 'UNAVAILABLE_SETTING_MISSING',
): EstimateBody => ({ status, provisional: true, total: null });

export function savedLocationFixture(
  overrides: Partial<VendorPickupLocationBody> = {},
): VendorPickupLocationBody {
  return {
    id: LOCATION_ID,
    vendor_organization_id: VENDOR_ORG_ID,
    label: 'Demo shop front',
    location: { address: '14 Demo Lane, Osu' },
    is_default: true,
    active: true,
    created_by: OFFICER_ID,
    created_at: '2026-10-01T09:00:00Z',
    updated_by: null,
    updated_at: null,
    ...overrides,
  };
}

export function adHocSenderFixture(overrides: Partial<AdHocSenderBody> = {}): AdHocSenderBody {
  return {
    id: SENDER_ID,
    display_name: 'Efua Demo Sender',
    phone: '+233241112222',
    state: 'REUSABLE',
    blocked: false,
    ...overrides,
  };
}

export function approvalFixture(overrides: Partial<ApprovalBody> = {}): ApprovalBody {
  return {
    id: APPROVAL_ID,
    state: 'REQUESTED',
    requested_by: OFFICER_ID,
    approved_by: null,
    ...overrides,
  };
}

/** The answer of an approval: the colleague's exception, approved by the signed-in officer. */
export const approvedFixture = (overrides: Partial<ApprovalBody> = {}): ApprovalBody =>
  approvalFixture({
    state: 'APPROVED',
    requested_by: COLLEAGUE_ID,
    approved_by: OFFICER_ID,
    note: 'Bridal gown, urgent',
    ...overrides,
  });

/** A cancellation reason of the `PICKUP_CANCELLATION` catalogue. Synthetic: the real codes are the Product Owner's and are not seeded. */
export function cancellationReasonFixture(overrides: Partial<ReasonBody> = {}): ReasonBody {
  return {
    code: 'DEMO_CUSTOMER_CHANGED_MIND',
    domain: 'PICKUP_CANCELLATION',
    label: 'Demo: the customer changed their mind',
    attribution: 'CUSTOMER',
    active: true,
    consumesDeliveryAttempt: false,
    requiresNote: false,
    permittedOperations: null,
    ...overrides,
  };
}

/** A reason that puts the cause with Melarc: no charge is permitted with it. */
export const melarcReasonFixture = (overrides: Partial<ReasonBody> = {}): ReasonBody =>
  cancellationReasonFixture({
    code: 'DEMO_NO_RIDER_AVAILABLE',
    label: 'Demo: no rider was available',
    attribution: 'MELARC',
    ...overrides,
  });

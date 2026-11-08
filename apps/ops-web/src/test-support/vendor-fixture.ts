import type { components } from '@melarc/api-client';

/**
 * Real-shaped answers of the vendor reads, for tests (S0.52b). Every field the contract requires is present and each value is synthetic. The
 * types are the contract's: nothing here describes the wire a second time.
 */
type VendorAccountBody = components['schemas']['VendorAccountSummary'];
type RegisteredDeviceBody = components['schemas']['RegisteredDevice'];

export const VENDOR_ACCOUNT_ID = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
export const VENDOR_ORGANIZATION_ID = '8d9e0f1a-2b3c-4d4e-8f5a-6b7c8d9e0f1a';
export const VENDOR_HUB_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';

export function vendorAccountFixture(
  overrides: Partial<VendorAccountBody> = {},
): VendorAccountBody {
  return {
    id: VENDOR_ACCOUNT_ID,
    account_identifier: 'K7M2Q9X4',
    vendor_organization_id: VENDOR_ORGANIZATION_ID,
    legal_name: 'Asante Fabrics Ltd',
    responsible_hub_id: VENDOR_HUB_ID,
    status: 'ACTIVE',
    credential_established: true,
    active_device_count: 1,
    has_recovery_email: true,
    has_recovery_phone: false,
    delivery_channel: 'EMAIL',
    ...overrides,
  };
}

export function vendorDeviceFixture(
  overrides: Partial<RegisteredDeviceBody> = {},
): RegisteredDeviceBody {
  return {
    id: '9e0f1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b',
    principal_type: 'VENDOR',
    principal_id: VENDOR_ACCOUNT_ID,
    device_kind: 'VENDOR_BROWSER_CREDENTIAL',
    status: 'ACTIVE',
    registered_at: '2026-10-20T09:00:00Z',
    registered_by: null,
    ...overrides,
  };
}

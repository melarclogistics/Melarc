import type { components } from '@melarc/api-client';

/**
 * Real-shaped answers of the identity operations, for tests. Every field the contract requires is present and each value is synthetic.
 * Pass what a test needs to differ. The types are the contract's: nothing here describes the wire a second time.
 */
type StaffIdentityBody = components['schemas']['StaffIdentity'];
type Bundle = components['schemas']['AssignableStaffRoleBundle'];
type SessionRecordBody = components['schemas']['SessionRecord'];

export const MAKER_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
export const STAFF_ID = '11111111-2222-4333-8444-555555555555';
export const OTHER_STAFF_ID = '66666666-7777-4888-9999-aaaaaaaaaaaa';
export const BUNDLE_ID = 'b0000000-0000-4000-8000-000000000001';
export const PRIVILEGED_BUNDLE_ID = 'b0000000-0000-4000-8000-000000000002';
export const HUB_ID = '5b6c7d8e-9f01-4a2b-8c3d-4e5f6a7b8c9d';

export function staffIdentityFixture(
  overrides: Partial<StaffIdentityBody> = {},
): StaffIdentityBody {
  return {
    id: STAFF_ID,
    work_email: 'kofi.boateng@example.test',
    full_name: 'Kofi Boateng',
    phone: '+233240000000',
    status: 'PENDING_APPROVAL',
    role_bundle_id: BUNDLE_ID,
    primary_hub_id: HUB_ID,
    mfa_enrolled: false,
    mfa_reset_state: 'NOT_ELIGIBLE',
    created_by: MAKER_ID,
    approved_by: null,
    ...overrides,
  };
}

export function bundleFixture(overrides: Partial<Bundle> = {}): Bundle {
  return {
    id: BUNDLE_ID,
    name: 'Ops Staff',
    requires_platform_admin_approval: false,
    ...overrides,
  };
}

export const BUNDLES: Bundle[] = [
  bundleFixture(),
  bundleFixture({
    id: PRIVILEGED_BUNDLE_ID,
    name: 'Senior Ops',
    requires_platform_admin_approval: true,
  }),
];

export function sessionRecordFixture(
  overrides: Partial<SessionRecordBody> = {},
): SessionRecordBody {
  return {
    id: 'c0000000-0000-4000-8000-000000000001',
    principal_type: 'STAFF',
    principal_id: STAFF_ID,
    state: 'ACTIVE',
    issued_at: '2026-10-23T08:00:00.000Z',
    expires_at: '2026-10-23T16:00:00.000Z',
    last_activity_at: '2026-10-23T09:15:00.000Z',
    termination_reason: null,
    ...overrides,
  };
}

export interface TrustedBrowserBody {
  id: string;
  label: string;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  current: boolean;
}

/** A trusted browser as the list answers it: a label and dates, and whether it is the browser asking. Nothing that could sign anyone in. */
export function trustedBrowserFixture(
  overrides: Partial<TrustedBrowserBody> = {},
): TrustedBrowserBody {
  return {
    id: 'd1000000-0000-4000-8000-000000000001',
    label: 'Chrome on Windows',
    created_at: '2026-10-23T08:00:00.000Z',
    expires_at: '2026-10-30T08:00:00.000Z',
    last_used_at: null,
    current: false,
    ...overrides,
  };
}

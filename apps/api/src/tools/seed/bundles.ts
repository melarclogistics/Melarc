import type {
  BUNDLE_AUDIENCES,
  FIXED_POLICY_PRINCIPALS,
  GRANT_TIERS,
  HUB_SCOPES,
  OWNERSHIP_SCOPES,
} from '../../platform/database/schema/reference-data.js';

/**
 * The role bundles the reference seed writes (S0.9; MIGRATION_AND_SEEDING.md section 4; permissions.md section 8;
 * domain-model.md section 6.9): the confirmed staff bundles and the fixed Rider and Vendor bundles.
 *
 * **What a bundle holds is what the catalogue's "Holders" column says, and never what its name suggests, limited to what this slice
 * needs** (decision D-11: "grant only approved bundle contents needed by the slice"): the fifteen keys the operations of SLICE-000
 * require. A key of a later slice is granted by the migration that slice adds, which raises the bundle's revision as an addition
 * (it ends no session). Hub scope is written explicitly on every grant (D-22): `all` only where the catalogue row says all hubs for
 * that holder, `own` for "own hub", `none` where the key is global configuration or the holder's reach is ownership, not a hub.
 *
 * **Not seeded:** Auditor and Executive/Report-consumer (`PROPOSED` in permissions.md section 8: a proposed bundle governs
 * nothing) and Fleet Manager (named only as a holder of `fleet.read`; no slice key reaches it and its contents are not specified
 * beyond "additive to Senior Ops"). The tier of a grant is the holder's letter (`A`, `S`, `P`); the catalogue gives Finance, Rider
 * and Vendor no tier, so theirs is null, which no tier-compared rule is satisfied by.
 *
 * Findings for the Product Owner (S0.9 handoff): the Platform Admin grants whose catalogue scope reads "own hub" are seeded `own`,
 * not `all`; the bundles are limited to this slice's keys; and Vendor holds no key yet.
 */

/** Stable identifiers of the seeded bundles: what `StaffIdentity.role_bundle_id` and a session's lineage refer to. Never reused. */
export const BUNDLE_IDS = {
  opsStaff: '5eed0001-0000-4000-8000-000000000001',
  seniorOps: '5eed0001-0000-4000-8000-000000000002',
  platformAdmin: '5eed0001-0000-4000-8000-000000000003',
  finance: '5eed0001-0000-4000-8000-000000000004',
  rider: '5eed0001-0000-4000-8000-000000000005',
  vendor: '5eed0001-0000-4000-8000-000000000006',
} as const;

export interface BundleSeed {
  readonly id: string;
  readonly name: string;
  readonly audience: (typeof BUNDLE_AUDIENCES)[number];
  readonly privileged: boolean;
}

export const BUNDLES: readonly BundleSeed[] = [
  { id: BUNDLE_IDS.opsStaff, name: 'Ops Staff', audience: 'STAFF', privileged: false },
  { id: BUNDLE_IDS.seniorOps, name: 'Senior Ops', audience: 'STAFF', privileged: true },
  { id: BUNDLE_IDS.platformAdmin, name: 'Platform Admin', audience: 'STAFF', privileged: true },
  { id: BUNDLE_IDS.finance, name: 'Finance/Reconciliation', audience: 'STAFF', privileged: false },
  { id: BUNDLE_IDS.rider, name: 'Rider', audience: 'RIDER', privileged: false },
  { id: BUNDLE_IDS.vendor, name: 'Vendor', audience: 'VENDOR', privileged: false },
];

export interface GrantSeed {
  readonly bundleId: string;
  readonly permissionKey: string;
  readonly hubScope: (typeof HUB_SCOPES)[number];
  readonly ownershipScope: (typeof OWNERSHIP_SCOPES)[number];
  readonly tier: (typeof GRANT_TIERS)[number] | null;
}

type Scope = (typeof HUB_SCOPES)[number];

const staff = (
  bundleId: string,
  tier: 'A' | 'S' | 'P',
  grants: readonly (readonly [key: string, hub: Scope])[],
): GrantSeed[] =>
  grants.map(([permissionKey, hubScope]) => ({
    bundleId,
    permissionKey,
    hubScope,
    ownershipScope: 'any',
    tier,
  }));

export const GRANTS: readonly GrantSeed[] = [
  // Ops Staff (holder A): the keys of the slice the catalogue gives A. Not staff.read (withheld from Ops Staff on purpose), not
  // staff.device.register or .reregister (Senior Ops and above: the act that grants access).
  ...staff(BUNDLE_IDS.opsStaff, 'A', [
    ['dispatch.read', 'own'],
    ['permission.assignable_bundle.read', 'none'],
    ['settings.reason.read', 'own'],
    ['staff.device.revoke', 'own'],
    ['staff.identity.create', 'own'],
    ['vendor.read', 'own'],
  ]),
  // Senior Ops (holder S). Not staff.mfa.reset, staff.credential.recover or vendor.credential.recover (Platform Admin alone).
  ...staff(BUNDLE_IDS.seniorOps, 'S', [
    ['dispatch.read', 'own'],
    ['permission.assignable_bundle.read', 'none'],
    ['settings.reason.read', 'own'],
    ['staff.device.register', 'own'],
    ['staff.device.reregister', 'own'],
    ['staff.device.revoke', 'own'],
    ['staff.identity.approve', 'own'],
    ['staff.identity.create', 'own'],
    ['staff.read', 'own'],
    ['staff.session.revoke', 'own'],
    ['vendor.organization.approve', 'own'],
    ['vendor.read', 'own'],
  ]),
  // Platform Admin (holder P): all hubs where the catalogue says P's reach is all hubs; own hub where it says own hub.
  ...staff(BUNDLE_IDS.platformAdmin, 'P', [
    ['dispatch.read', 'own'],
    ['permission.assignable_bundle.read', 'none'],
    ['settings.reason.read', 'own'],
    ['staff.credential.recover', 'all'],
    ['staff.device.register', 'all'],
    ['staff.device.reregister', 'own'],
    ['staff.device.revoke', 'own'],
    ['staff.identity.approve', 'own'],
    ['staff.identity.create', 'own'],
    ['staff.mfa.reset', 'all'],
    ['staff.read', 'own'],
    ['staff.session.revoke', 'all'],
    ['vendor.credential.recover', 'all'],
    ['vendor.organization.approve', 'own'],
    ['vendor.read', 'all'],
  ]),
  // Finance/Reconciliation (holder Finance): vendor.read at all hubs, "Platform Admin and Finance at all hubs". No tier.
  {
    bundleId: BUNDLE_IDS.finance,
    permissionKey: 'vendor.read',
    hubScope: 'all',
    ownershipScope: 'any',
    tier: null,
  },
  // Rider (holder R): reads for its own assigned work. No hub reach (assignment is the boundary), no tier.
  {
    bundleId: BUNDLE_IDS.rider,
    permissionKey: 'dispatch.read',
    hubScope: 'none',
    ownershipScope: 'assigned',
    tier: null,
  },
  {
    bundleId: BUNDLE_IDS.rider,
    permissionKey: 'settings.reason.read',
    hubScope: 'none',
    ownershipScope: 'assigned',
    tier: null,
  },
  // Vendor (holder V): none of this slice's keys.
];

export interface FixedPolicySeed {
  readonly principalType: (typeof FIXED_POLICY_PRINCIPALS)[number];
  readonly revision: number;
  readonly minimumRevision: number;
}

/** One row for each of Vendor and Rider: revision 1, floor 1 (MIGRATION_AND_SEEDING.md section 5.1). */
export const FIXED_POLICIES: readonly FixedPolicySeed[] = [
  { principalType: 'VENDOR', revision: 1, minimumRevision: 1 },
  { principalType: 'RIDER', revision: 1, minimumRevision: 1 },
];

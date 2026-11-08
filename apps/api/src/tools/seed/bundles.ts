import { BUILD_FIXED_POLICY } from '../../platform/auth/sessions/build-fixed-policy.js';
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
 * **What a bundle holds is what the catalogue's "Holders" column says, and never what its name suggests, limited to what the slices
 * built so far need** (decision D-11: "grant only approved bundle contents needed by the slice"): the fifteen keys the operations of
 * SLICE-000 require (`SLICE_000_GRANTS`), the thirty-three of SLICE-001 (`SLICE_001_GRANTS`, S1.8) and the Ops message log's
 * `notification.read` (`NOTIFICATION_READ_GRANTS`, S1.12e). A key of a later slice is
 * granted by the migration that slice adds, which raises the bundle's revision as an addition (it ends no session). **A database that
 * was seeded before a slice's keys existed gets them from that slice's migrations (0043 and 0057 for SLICE-001); a new database gets
 * them from this seed, and `slice-001-grants.db.test.ts` holds the two to the same result.** Hub scope is written explicitly on every grant
 * (D-22): `all` only where the catalogue row says all hubs for that holder, `own` for "own hub", `none` where the key is global
 * configuration or the holder's reach is ownership, not a hub.
 *
 * **Not seeded:** Auditor and Executive/Report-consumer (`PROPOSED` in permissions.md section 8: a proposed bundle governs
 * nothing) and Fleet Manager (named only as a holder of `fleet.read`; no slice key reaches it and its contents are not specified
 * beyond "additive to Senior Ops"). The tier of a grant is the holder's letter (`A`, `S`, `P`); the catalogue gives Finance, Rider
 * and Vendor no tier, so theirs is null, which no tier-compared rule is satisfied by.
 *
 * Findings for the Product Owner (S0.9 handoff, restated at S1.8): the Platform Admin grants whose catalogue scope reads "own hub"
 * are seeded `own`, not `all` (so a Platform Admin without a primary hub reaches no hub by them); and the bundles are limited to the
 * keys the slices built so far need. The Vendor's six keys and the Rider's seven for SLICE-001 are inert until an operation checks them.
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

/** The grants SLICE-000 seeded (27 October 2026): the content of a database seeded before SLICE-001, which migration 0043 completes. */
export const SLICE_000_GRANTS: readonly GrantSeed[] = [
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
  // Platform Admin (holder P): all hubs where the catalogue says P's reach is all hubs; own hub where it says own hub. **The three keys
  // of the staff identity's lifecycle that the catalogue gives `S: own hub · P: all hubs` (staff.read, staff.identity.create,
  // staff.identity.approve) are all-hub for Platform Admin** (Product decision, 22 October 2026): a seeded Platform Admin has no primary
  // hub, so its own hub is none, and it would read, create and approve no identity at all. The scope is the grant's; being a Platform
  // Admin is no bypass.
  ...staff(BUNDLE_IDS.platformAdmin, 'P', [
    ['dispatch.read', 'own'],
    ['permission.assignable_bundle.read', 'none'],
    ['settings.reason.read', 'own'],
    ['staff.credential.recover', 'all'],
    ['staff.device.register', 'all'],
    ['staff.device.reregister', 'own'],
    ['staff.device.revoke', 'own'],
    ['staff.identity.approve', 'all'],
    ['staff.identity.create', 'all'],
    ['staff.mfa.reset', 'all'],
    ['staff.read', 'all'],
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

const own = (keys: readonly string[]): (readonly [key: string, hub: Scope])[] =>
  keys.map((key) => [key, 'own'] as const);

/** What a fixed audience holds: no hub reach (a Rider's boundary is its assignment, a Vendor's its own records) and no tier. */
const fixedAudience = (
  bundleId: string,
  ownershipScope: 'own' | 'assigned',
  keys: readonly string[],
): GrantSeed[] =>
  keys.map((permissionKey) => ({
    bundleId,
    permissionKey,
    hubScope: 'none',
    ownershipScope,
    tier: null,
  }));

/**
 * The keys Ops Staff hold for SLICE-001 (S1.8): every `A` of the catalogue rows the slice's operations name. Includes
 * `pickup.exception.approve`, which the Product Owner gave to every Ops Staff member on 29 October 2026 (D-14: the bundle holds it, and
 * the approving actor is audited; a requester still cannot approve their own request unless a Platform Admin). Not here, because the
 * operation waits for another slice or a decision: `pickup.request.reassign_hub` (SLICE-014), `pickup.request.override_window` and
 * `hub.parcel.assess_handling` (their own slices, D-09), `hub.intake.reopen` (deferred, D-07), `hub.setting.*` and `pricing.structure.*`
 * (no hub administration, D-02), `pricing.reprice.*` (controlled repricing is not built, ruling R14) and the custody keys of a delivery
 * run's return (`return`, `receive`, `variance_resolve`).
 */
const OPS_STAFF_KEYS_001 = [
  'fleet.custody.accept',
  'fleet.custody.initiate',
  'fleet.custody.read',
  'hub.intake.close',
  'hub.intake.count',
  'hub.intake.itemize',
  'hub.read',
  'pickup.exception.approve',
  'pickup.exception.request',
  'pickup.failure.resolve',
  'pickup.handshake.override',
  'pickup.manifest.assign',
  'pickup.manifest.create',
  'pickup.manifest.dispatch',
  'pickup.read',
  'pickup.request.cancel',
  'pickup.request.cancel_chargeable',
  'pickup.request.confirm',
  'pickup.request.create',
  'pickup.stop.skip',
  'pricing.correction.create',
  'pricing.read',
  'vendor.pickup_location.manage',
] as const;

/** The keys of the slice that start at Senior Ops (the catalogue's `S P` rows): Ops Staff do not hold them. */
const SENIOR_ONLY_KEYS_001 = [
  'hub.intake.close_exception',
  'hub.osd.adjudicate',
  'pickup.attempt.extend',
  'pickup.cancellation_charge.waive',
  'pickup.handshake.resolve',
  'pricing.correction.approve',
] as const;

const VENDOR_KEYS_001 = [
  'pickup.collection.confirm',
  'pickup.read',
  'pickup.request.cancel',
  'pickup.request.create',
  'pricing.read',
  'vendor.pickup_location.manage',
] as const;

const RIDER_KEYS_001 = [
  'fleet.custody.accept',
  'fleet.custody.read',
  'hub.handover.submit',
  'pickup.collection.confirm',
  'pickup.failure.report',
  'pickup.read',
  'pickup.run.execute',
] as const;

/**
 * The grants SLICE-001 adds (S1.8). Reach is the catalogue's: `own` for every staff grant whose row says own hub, and `all` only for
 * the Platform Admin's `pickup.exception.approve` ("own hub · P: all hubs") and Finance's `pricing.read` (section 8: Finance reads at
 * all hubs). **A Platform Admin created by the bootstrap has no primary hub, so its own-hub grants reach no hub** (the same as
 * `dispatch.read` today); widening them is an addition that ends no session, and is the Product Owner's decision, not made here.
 * Exported for the migration test: migration 0043 carries these rows for a database seeded before them.
 */
export const SLICE_001_GRANTS: readonly GrantSeed[] = [
  ...staff(BUNDLE_IDS.opsStaff, 'A', own(OPS_STAFF_KEYS_001)),
  ...staff(BUNDLE_IDS.seniorOps, 'S', own([...OPS_STAFF_KEYS_001, ...SENIOR_ONLY_KEYS_001])),
  ...staff(
    BUNDLE_IDS.platformAdmin,
    'P',
    [...OPS_STAFF_KEYS_001, ...SENIOR_ONLY_KEYS_001].map(
      (key) => [key, key === 'pickup.exception.approve' ? 'all' : 'own'] as const,
    ),
  ),
  {
    bundleId: BUNDLE_IDS.finance,
    permissionKey: 'pricing.read',
    hubScope: 'all',
    ownershipScope: 'any',
    tier: null,
  },
  ...fixedAudience(BUNDLE_IDS.vendor, 'own', VENDOR_KEYS_001),
  ...fixedAudience(BUNDLE_IDS.rider, 'assigned', RIDER_KEYS_001),
];

/**
 * The one grant SLICE-001 adds after migration 0043 (S1.12e): `notification.read`, the key of the Ops message log (permissions.md section
 * 7: "A S P · own hub"). Reach is the catalogue's: `own` at the holder's hub, so a Platform Admin without a primary hub reads no hub's log
 * until it has one (the same finding as `SLICE_001_GRANTS`). Exported for the migration test: migration 0057 carries these rows for a
 * database seeded before them.
 */
export const NOTIFICATION_READ_GRANTS: readonly GrantSeed[] = [
  ...staff(BUNDLE_IDS.opsStaff, 'A', [['notification.read', 'own']]),
  ...staff(BUNDLE_IDS.seniorOps, 'S', [['notification.read', 'own']]),
  ...staff(BUNDLE_IDS.platformAdmin, 'P', [['notification.read', 'own']]),
];

export const GRANTS: readonly GrantSeed[] = [
  ...SLICE_000_GRANTS,
  ...SLICE_001_GRANTS,
  ...NOTIFICATION_READ_GRANTS,
];

export interface FixedPolicySeed {
  readonly principalType: (typeof FIXED_POLICY_PRINCIPALS)[number];
  readonly revision: number;
  readonly minimumRevision: number;
}

/**
 * One row for each of Vendor and Rider: **the revision of the build that seeds** and floor 1 (MIGRATION_AND_SEEDING.md section 5.1). The
 * revision is the latest released one (SECURITY_DESIGN.md section 13.10), so a database seeded today holds what a database seeded at the
 * first release and migrated since holds; and the floor is 1, because nothing has been reduced. A revision that trailed the build would
 * make the next reduction raise the floor from too low a number and end no session (found by the release of SLICE-001).
 */
export const FIXED_POLICIES: readonly FixedPolicySeed[] = [
  { principalType: 'VENDOR', revision: BUILD_FIXED_POLICY.VENDOR ?? 1, minimumRevision: 1 },
  { principalType: 'RIDER', revision: BUILD_FIXED_POLICY.RIDER ?? 1, minimumRevision: 1 },
];

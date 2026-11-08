/**
 * The permission keys each seeded staff bundle holds, written out here by hand, **for the navigation tests only**.
 *
 * The Ops Portal names no role and decides nothing from one: it sees the keys a session holds and nothing else (surfaces/ops-portal.md
 * section 4). A test that wants to know what a person of a given kind would see needs the keys that kind of person holds, and the one place
 * that says so is the seed (`apps/api/src/tools/seed/bundles.ts`, which the Ops Portal must not import). These are a copy of it, labelled
 * with the bundle's name so a reader of a test sees whose view it is, and `scripts/shell-bundles.test.ts` fails when the seed and this copy
 * drift apart, so a new grant cannot leave the navigation tests describing a person who no longer exists.
 *
 * This file is never imported by application code (`test/navigation-no-roles.test.ts` holds that).
 */
/**
 * The keys SLICE-001 gives Ops Staff (S1.8; `OPS_STAFF_KEYS_001` of the seed), and the keys that start at Senior Ops
 * (`SENIOR_ONLY_KEYS_001`): Senior Ops and Platform Admin hold both lists, Ops Staff the first.
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

const SENIOR_ONLY_KEYS_001 = [
  'hub.intake.close_exception',
  'hub.osd.adjudicate',
  'pickup.attempt.extend',
  'pickup.cancellation_charge.waive',
  'pickup.handshake.resolve',
  'pricing.correction.approve',
] as const;

/**
 * The key of the Ops message log (S1.12e; `NOTIFICATION_READ_GRANTS` of the seed, "A S P · own hub"): the three staff bundles hold it, and
 * Finance, a vendor and a rider do not.
 */
const NOTIFICATION_KEYS = ['notification.read'] as const;

export const BUNDLE_KEY_SETS = {
  'Ops Staff': [
    'dispatch.read',
    'permission.assignable_bundle.read',
    'settings.reason.read',
    'staff.device.revoke',
    'staff.identity.create',
    'vendor.read',
    ...NOTIFICATION_KEYS,
    ...OPS_STAFF_KEYS_001,
  ],
  'Senior Ops': [
    ...OPS_STAFF_KEYS_001,
    ...SENIOR_ONLY_KEYS_001,
    ...NOTIFICATION_KEYS,
    'dispatch.read',
    'permission.assignable_bundle.read',
    'settings.reason.read',
    'staff.device.register',
    'staff.device.reregister',
    'staff.device.revoke',
    'staff.identity.approve',
    'staff.identity.create',
    'staff.read',
    'staff.session.revoke',
    'vendor.organization.approve',
    'vendor.read',
  ],
  'Platform Admin': [
    'dispatch.read',
    'permission.assignable_bundle.read',
    'settings.reason.read',
    'staff.credential.recover',
    'staff.device.register',
    'staff.device.reregister',
    'staff.device.revoke',
    'staff.identity.approve',
    'staff.identity.create',
    'staff.mfa.reset',
    'staff.read',
    'staff.session.revoke',
    'vendor.credential.recover',
    'vendor.organization.approve',
    'vendor.read',
    ...NOTIFICATION_KEYS,
    ...OPS_STAFF_KEYS_001,
    ...SENIOR_ONLY_KEYS_001,
  ],
  'Finance/Reconciliation': ['pricing.read', 'vendor.read'],
} as const satisfies Record<string, readonly string[]>;

export type BundleName = keyof typeof BUNDLE_KEY_SETS;

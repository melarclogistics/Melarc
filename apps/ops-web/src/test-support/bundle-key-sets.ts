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
export const BUNDLE_KEY_SETS = {
  'Ops Staff': [
    'dispatch.read',
    'permission.assignable_bundle.read',
    'settings.reason.read',
    'staff.device.revoke',
    'staff.identity.create',
    'vendor.read',
  ],
  'Senior Ops': [
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
  ],
  'Finance/Reconciliation': ['vendor.read'],
} as const satisfies Record<string, readonly string[]>;

export type BundleName = keyof typeof BUNDLE_KEY_SETS;

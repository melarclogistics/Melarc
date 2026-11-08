import type { SeedPlan } from '../../platform/database/seed/seed-helper.js';
import { BUNDLES, FIXED_POLICIES, GRANTS } from './bundles.js';
import { HUBS } from './hubs.js';
import { PERMISSION_KEYS } from './permission-keys.js';
import { IDENTITY_REASONS, reasonCodeRow } from './reasons.js';
import { SETTINGS } from './settings.js';

/**
 * The reference seed (S0.9, corrected by F02; MIGRATION_AND_SEEDING.md section 4): the data of this directory assembled into the one
 * document `melarc.initialize_reference_data` takes (migration 0005). It names each table by its own name and each column by its own
 * name, for the tables in the order their foreign keys need (the permissions and the bundles before the grants that refer to them),
 * and the policy keys it holds are every bundle it creates and both fixed policies. Every number is the data's own: nothing here is
 * typed in twice. The function inserts the columns it names itself, so a revision or a floor in this document would be ignored; the
 * seed starts every bundle and fixed policy at revision 1 and floor 1, which are the tables' defaults.
 */

/** A new plan on each call: the arrays are copies, so nothing a caller does to one changes the next. */
export function referenceSeedPlan(): SeedPlan {
  return {
    policyKeys: {
      bundleIds: BUNDLES.map((bundle) => bundle.id),
      fixedPolicies: FIXED_POLICIES.map((policy) => policy.principalType),
    },
    entryPoint: 'initialize_reference_data',
    payload: {
      hub: HUBS.map((each) => ({ id: each.id, name: each.name })),
      permission: PERMISSION_KEYS.map((key) => ({ key, domain: key.split('.')[0] ?? '' })),
      role_bundle: BUNDLES.map((each) => ({
        id: each.id,
        name: each.name,
        audience: each.audience,
        privileged: each.privileged,
      })),
      role_bundle_grant: GRANTS.map((each) => ({
        bundle_id: each.bundleId,
        permission_key: each.permissionKey,
        hub_scope: each.hubScope,
        ownership_scope: each.ownershipScope,
        tier: each.tier,
      })),
      fixed_permission_policy: FIXED_POLICIES.map((each) => ({
        principal_type: each.principalType,
      })),
      setting: SETTINGS.map((each) => ({
        key: each.key,
        scope: each.scope,
        value_type: each.valueType,
        value: each.value,
        unit: each.unit,
        description: each.description,
      })),
      reason_code: IDENTITY_REASONS.map((each) => reasonCodeRow(each)),
    },
  };
}

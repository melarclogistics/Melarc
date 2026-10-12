import { describe, expect, it } from 'vitest';

import { BUNDLES, FIXED_POLICIES, GRANTS } from './bundles.js';
import { HUBS } from './hubs.js';
import { PERMISSION_KEYS } from './permission-keys.js';
import { IDENTITY_REASONS } from './reasons.js';
import { referenceSeedPlan } from './reference-seed.js';
import { SETTINGS } from './settings.js';

/**
 * The plan the reference seed hands to the helper (S0.9, corrected by F02): which tables, in which order, how many rows, which policy
 * keys it holds, and the document `melarc.initialize_reference_data` takes. What the rows say is `seed-data.test.ts`'s and the
 * database test's; this is the assembly.
 */
describe('the reference seed plan', () => {
  const plan = referenceSeedPlan();

  it('is applied by the initialization function, which writes the seven tables and no other', () => {
    expect(plan.entryPoint).toBe('initialize_reference_data');
  });

  // Break caught: a referencing table inserted before the table it refers to (a grant before its bundle or its permission): the
  // foreign key would refuse the seed on a real database, and the order is the plan's to get right.
  it('inserts a table after every table it refers to', () => {
    const order = Object.keys(plan.payload);
    expect(order).toEqual([
      'hub',
      'permission',
      'role_bundle',
      'role_bundle_grant',
      'fixed_permission_policy',
      'setting',
      'reason_code',
    ]);
    expect(order.indexOf('role_bundle_grant')).toBeGreaterThan(order.indexOf('role_bundle'));
    expect(order.indexOf('role_bundle_grant')).toBeGreaterThan(order.indexOf('permission'));
  });

  // Break caught: a table that carries fewer rows than its data holds (the helper compares what was inserted with it, so a wrong figure
  // here would either refuse a good seed or pass a short one).
  it('carries exactly the rows of the data', () => {
    const planned = Object.fromEntries(
      Object.entries(plan.payload).map(([table, rows]) => [table, rows.length]),
    );
    expect(planned).toEqual({
      hub: HUBS.length,
      permission: PERMISSION_KEYS.length,
      role_bundle: BUNDLES.length,
      role_bundle_grant: GRANTS.length,
      fixed_permission_policy: FIXED_POLICIES.length,
      setting: SETTINGS.length,
      reason_code: IDENTITY_REASONS.length,
    });
  });

  // Break caught: a revision or a floor in the document, which the function ignores but a reader would take for what is written. The
  // bundles and the fixed policies start at revision 1 and floor 1, the tables' own defaults.
  it('names no revision and no floor: the tables’ defaults, 1 and 1, are what the seed starts at', () => {
    for (const row of [
      ...(plan.payload.role_bundle ?? []),
      ...(plan.payload.fixed_permission_policy ?? []),
    ]) {
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['revision']));
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['reduction_floor']));
      expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['minimum_revision']));
    }
    for (const policy of FIXED_POLICIES) {
      expect([policy.revision, policy.minimumRevision]).toEqual([1, 1]);
    }
  });

  // Break caught: a column the function does not take (a typo in a key, a camelCase name), which the database would drop and
  // answer with a missing value. Every key of every row is a column of its table; the lists are the ones of migration 0005.
  it('names, in every row, only the columns the function takes, and all of the ones the table needs', () => {
    const columns: Record<string, readonly string[]> = {
      hub: ['id', 'name'],
      permission: ['key', 'domain'],
      role_bundle: ['id', 'name', 'audience', 'privileged'],
      role_bundle_grant: ['bundle_id', 'permission_key', 'hub_scope', 'ownership_scope', 'tier'],
      fixed_permission_policy: ['principal_type'],
      setting: ['key', 'scope', 'value_type', 'value', 'unit', 'description'],
      reason_code: [
        'code',
        'domain',
        'valid_checkpoints',
        'label',
        'requires_note',
        'requires_photo',
        'requires_contact_attempt',
        'requires_approval',
        'attribution',
        'consumes_delivery_attempt',
        'requires_ops_review',
        'requires_escalation',
        'active',
        'permitted_operations',
      ],
    };
    for (const [table, rows] of Object.entries(plan.payload)) {
      for (const row of rows) {
        expect(Object.keys(row).toSorted(), table).toEqual([...(columns[table] ?? [])].toSorted());
      }
    }
  });

  // Break caught: a bundle the seed creates without naming it for its lock (a sign-in reading it half-written), or a policy object it
  // does not create locked. The helper takes the exclusive lock of every object named, in the canonical order; this is the list.
  it('names every bundle it creates and both fixed policies for their locks, and no other', () => {
    expect(plan.policyKeys.bundleIds.toSorted()).toEqual(
      BUNDLES.map((bundle) => bundle.id).toSorted(),
    );
    expect(plan.policyKeys.fixedPolicies.toSorted()).toEqual(
      FIXED_POLICIES.map((policy) => policy.principalType).toSorted(),
    );
    expect(new Set(plan.policyKeys.bundleIds).size).toBe(plan.policyKeys.bundleIds.length);
  });

  // Break caught: a grant that names a bundle or a permission the seed does not create (the foreign key refuses it at the seed, on
  // a real database; here it is refused before one is needed).
  it('has no grant for a bundle or a permission it does not seed', () => {
    const bundles = new Set(BUNDLES.map((bundle) => bundle.id));
    const keys = new Set(PERMISSION_KEYS);
    for (const grant of GRANTS) {
      expect(bundles.has(grant.bundleId), grant.permissionKey).toBe(true);
      expect(keys.has(grant.permissionKey), grant.permissionKey).toBe(true);
    }
  });

  it('plans a fresh plan each time, so that a caller cannot change what the next one seeds', () => {
    expect(referenceSeedPlan()).not.toBe(plan);
    expect(referenceSeedPlan().payload).not.toBe(plan.payload);
    expect(referenceSeedPlan().payload.hub).not.toBe(plan.payload.hub);
  });
});

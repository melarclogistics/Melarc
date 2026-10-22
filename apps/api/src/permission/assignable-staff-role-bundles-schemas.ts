import { described } from '../platform/openapi/described-schema.js';

/**
 * The shape of `listAssignableStaffRoleBundles` as the application describes it (`AssignableStaffRoleBundle` of the contract; the
 * conformance check compares it). **A minimal projection**: the bundle's `id`, its `name` and whether approving a profile that holds it
 * needs a Platform Admin. Never a permission, a count of them or who holds the bundle: none is needed to fill a form, and a maker below
 * Platform Admin does not hold `permission.read`.
 */
export const ASSIGNABLE_STAFF_ROLE_BUNDLE_SCHEMA = described({
  type: 'object',
  required: ['id', 'name', 'requires_platform_admin_approval'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    requires_platform_admin_approval: { type: 'boolean' },
  },
});

export const ASSIGNABLE_STAFF_ROLE_BUNDLES_SCHEMA = described({
  type: 'object',
  required: ['items'],
  properties: {
    items: { type: 'array', items: ASSIGNABLE_STAFF_ROLE_BUNDLE_SCHEMA },
  },
});

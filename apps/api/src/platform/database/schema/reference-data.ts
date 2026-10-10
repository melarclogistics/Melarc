import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The reference data every environment needs (S0.8; MIGRATION_AND_SEEDING.md §4): the hub registry, the closed permission
 * catalogue, the role bundles and their grants, the fixed Vendor and Rider policy, the platform and company-wide settings, and the
 * reason catalogue. None of it is written by a request: a seed, a migration and (for bundles) the SLICE-009 edit operation change it.
 * The API reads it, so the runtime login holds `SELECT` and nothing more; **the three policy tables (`role_bundle`,
 * `role_bundle_grant`, `fixed_permission_policy`) never give it more**, because a row lock needs `UPDATE` and the protocol
 * coordinates by advisory lock instead (SECURITY_DESIGN.md §13.10a).
 *
 * This file is the *shape*. Drizzle cannot express the rest, and the migration (`0003_reference_data.sql`) adds it by hand in the
 * same change: the owner (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (`STAFF` reads everything;
 * `SYSTEM` reads under the `authentication` capability alone; every other principal is denied), the grants, and the counters
 * guard that keeps a revision rising by one and a floor moving only with a reduction. Each table is classified `PLATFORM` in
 * data-scope-registry.md §4.1.
 *
 * The lists below are the closed sets the contracts name. They are exported so that the seed and the tests read one source.
 */

/** The seventeen domains of the permission catalogue (permissions.md §4). Adding an eighteenth is a Product Owner decision. */
export const PERMISSION_DOMAINS = [
  'pickup',
  'hub',
  'pricing',
  'dispatch',
  'delivery',
  'payment',
  'settlement',
  'returns',
  'vendor',
  'staff',
  'notification',
  'report',
  'settings',
  'fleet',
  'courier',
  'audit',
  'permission',
] as const;

export const BUNDLE_AUDIENCES = ['STAFF', 'RIDER', 'VENDOR'] as const;
/** Hub scope, ownership scope and tier of a grant (permissions.md §5; domain-model.md §6.9). */
export const HUB_SCOPES = ['none', 'own', 'all'] as const;
export const OWNERSHIP_SCOPES = ['own', 'assigned', 'any'] as const;
export const GRANT_TIERS = ['A', 'S', 'P'] as const;
/** The principal types that carry a fixed policy (SECURITY_DESIGN.md §13.10). */
export const FIXED_POLICY_PRINCIPALS = ['VENDOR', 'RIDER'] as const;

export const SETTING_SCOPES = ['COMPANY', 'PLATFORM'] as const;
export const SETTING_VALUE_TYPES = [
  'integer',
  'decimal',
  'boolean',
  'string',
  'list',
  'object',
] as const;

/** The workflow domains of the reason catalogue, then the six identity domains (domain-model.md §3.9). */
export const WORKFLOW_REASON_DOMAINS = [
  'DELIVERY_FAILURE',
  'RECIPIENT_CONTACT',
  'PICKUP_STOP_SKIP',
  'HANDOFF_FAILURE',
] as const;
export const IDENTITY_REASON_DOMAINS = [
  'SESSION_REVOCATION',
  'STAFF_PROFILE_REJECTION',
  'STAFF_MFA_RESET',
  'CREDENTIAL_ADMINISTRATION',
  'RIDER_DEVICE_REPLACEMENT',
  'RIDER_DEVICE_REVOCATION',
] as const;
export const REASON_DOMAINS = [...WORKFLOW_REASON_DOMAINS, ...IDENTITY_REASON_DOMAINS] as const;
export const REASON_ATTRIBUTIONS = ['CUSTOMER', 'MELARC', 'EXTERNAL'] as const;
export const REASON_CHECKPOINTS = ['PRE_DISPATCH', 'NEXT_STOP', 'DOORSTEP'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export const hub = pgTable(
  'hub',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('hub_name_key').on(table.name),
    check('hub_name_not_empty', sql`length(btrim(${table.name})) > 0`),
  ],
);

export const permission = pgTable(
  'permission',
  {
    key: text('key').primaryKey(),
    domain: text('domain').notNull(),
  },
  (table) => [
    // <domain>.<action> or <domain>.<subresource>.<action> (permissions.md §3), lower case with underscores.
    check(
      'permission_key_grammar',
      sql`${table.key} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*){1,2}$'`,
    ),
    check(
      'permission_domain_closed',
      sql.raw(`"permission"."domain" IN (${quoted(PERMISSION_DOMAINS)})`),
    ),
    check(
      'permission_domain_is_key_prefix',
      sql`split_part(${table.key}, '.', 1) = ${table.domain}`,
    ),
  ],
);

export const roleBundle = pgTable(
  'role_bundle',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    audience: text('audience').notNull(),
    revision: integer('revision').notNull().default(1),
    reductionFloor: integer('reduction_floor').notNull().default(1),
    privileged: boolean('privileged').notNull(),
  },
  (table) => [
    unique('role_bundle_name_key').on(table.name),
    check('role_bundle_name_not_empty', sql`length(btrim(${table.name})) > 0`),
    check(
      'role_bundle_audience_closed',
      sql.raw(`"role_bundle"."audience" IN (${quoted(BUNDLE_AUDIENCES)})`),
    ),
    check('role_bundle_revision_positive', sql`${table.revision} >= 1`),
    check(
      'role_bundle_floor_in_range',
      sql`${table.reductionFloor} >= 1 AND ${table.reductionFloor} <= ${table.revision}`,
    ),
  ],
);

export const roleBundleGrant = pgTable(
  'role_bundle_grant',
  {
    bundleId: uuid('bundle_id').notNull(),
    permissionKey: text('permission_key').notNull(),
    hubScope: text('hub_scope').notNull(),
    ownershipScope: text('ownership_scope').notNull(),
    // Null where the catalogue gives the holder no tier (Finance, Rider, Vendor): no tier-compared rule is satisfied by it.
    tier: text('tier'),
  },
  (table) => [
    primaryKey({ name: 'role_bundle_grant_pkey', columns: [table.bundleId, table.permissionKey] }),
    // No cascade: a bundle or a permission that grants refer to is never removed under them.
    foreignKey({
      name: 'role_bundle_grant_bundle_fkey',
      columns: [table.bundleId],
      foreignColumns: [roleBundle.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'role_bundle_grant_permission_fkey',
      columns: [table.permissionKey],
      foreignColumns: [permission.key],
    }).onDelete('restrict'),
    check(
      'role_bundle_grant_hub_scope_closed',
      sql.raw(`"role_bundle_grant"."hub_scope" IN (${quoted(HUB_SCOPES)})`),
    ),
    check(
      'role_bundle_grant_ownership_scope_closed',
      sql.raw(`"role_bundle_grant"."ownership_scope" IN (${quoted(OWNERSHIP_SCOPES)})`),
    ),
    check(
      'role_bundle_grant_tier_closed',
      sql.raw(`"role_bundle_grant"."tier" IN (${quoted(GRANT_TIERS)})`),
    ),
  ],
);

export const fixedPermissionPolicy = pgTable(
  'fixed_permission_policy',
  {
    principalType: text('principal_type').primaryKey(),
    revision: integer('revision').notNull().default(1),
    minimumRevision: integer('minimum_revision').notNull().default(1),
  },
  (table) => [
    check(
      'fixed_permission_policy_principal_closed',
      sql.raw(`"fixed_permission_policy"."principal_type" IN (${quoted(FIXED_POLICY_PRINCIPALS)})`),
    ),
    check('fixed_permission_policy_revision_positive', sql`${table.revision} >= 1`),
    check(
      'fixed_permission_policy_minimum_in_range',
      sql`${table.minimumRevision} >= 1 AND ${table.minimumRevision} <= ${table.revision}`,
    ),
  ],
);

export const setting = pgTable(
  'setting',
  {
    key: text('key').primaryKey(),
    scope: text('scope').notNull(),
    valueType: text('value_type').notNull(),
    value: jsonb('value').notNull(),
    unit: text('unit').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('setting_key_grammar', sql`${table.key} ~ '^[A-Za-z][A-Za-z0-9_]*$'`),
    check('setting_scope_closed', sql.raw(`"setting"."scope" IN (${quoted(SETTING_SCOPES)})`)),
    check(
      'setting_value_type_closed',
      sql.raw(`"setting"."value_type" IN (${quoted(SETTING_VALUE_TYPES)})`),
    ),
    check('setting_unit_not_empty', sql`length(btrim(${table.unit})) > 0`),
    check('setting_description_not_empty', sql`length(btrim(${table.description})) > 0`),
  ],
);

/** One permitted operation: an `operationId`, or `operationId#BRANCH` for a branch of it (domain-model.md §3.9). */
const PERMITTED_OPERATION = '[A-Za-z][A-Za-z0-9]*(#[A-Z][A-Z_]*)?';

export const reasonCode = pgTable(
  'reason_code',
  {
    code: text('code').primaryKey(),
    domain: text('domain').notNull(),
    validCheckpoints: text('valid_checkpoints').array(),
    label: text('label').notNull(),
    requiresNote: boolean('requires_note').notNull().default(false),
    requiresPhoto: boolean('requires_photo').notNull().default(false),
    requiresContactAttempt: boolean('requires_contact_attempt').notNull().default(false),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    attribution: text('attribution').notNull(),
    consumesDeliveryAttempt: boolean('consumes_delivery_attempt').notNull().default(false),
    requiresOpsReview: boolean('requires_ops_review').notNull().default(false),
    requiresEscalation: boolean('requires_escalation').notNull().default(false),
    active: boolean('active').notNull().default(true),
    permittedOperations: text('permitted_operations').array(),
  },
  (table) => [
    check('reason_code_code_grammar', sql`${table.code} ~ '^[A-Z][A-Z0-9_]*$'`),
    check('reason_code_label_not_empty', sql`length(btrim(${table.label})) > 0`),
    check(
      'reason_code_domain_closed',
      sql.raw(`"reason_code"."domain" IN (${quoted(REASON_DOMAINS)})`),
    ),
    check(
      'reason_code_attribution_closed',
      sql.raw(`"reason_code"."attribution" IN (${quoted(REASON_ATTRIBUTIONS)})`),
    ),
    // Checkpoints are a recipient-contact concept: mandatory and non-empty there, null for every other domain.
    check(
      'reason_code_checkpoints_by_domain',
      sql.raw(
        `("reason_code"."domain" = 'RECIPIENT_CONTACT' AND "reason_code"."valid_checkpoints" IS NOT NULL AND cardinality("reason_code"."valid_checkpoints") >= 1 AND "reason_code"."valid_checkpoints" <@ ARRAY[${quoted(REASON_CHECKPOINTS)}]::text[]) OR ("reason_code"."domain" <> 'RECIPIENT_CONTACT' AND "reason_code"."valid_checkpoints" IS NULL)`,
      ),
    ),
    // Permitted operations belong to the identity domains only: a non-empty list there, null for the workflow domains.
    // An array holding a NULL prints as {NULL}, which the pattern below reads as a name (migration 0004).
    check(
      'reason_code_operations_not_null',
      sql`array_position(${table.permittedOperations}, NULL) IS NULL`,
    ),
    check(
      'reason_code_operations_by_domain',
      sql.raw(
        `("reason_code"."domain" IN (${quoted(IDENTITY_REASON_DOMAINS)}) AND "reason_code"."permitted_operations" IS NOT NULL AND cardinality("reason_code"."permitted_operations") >= 1 AND "reason_code"."permitted_operations"::text ~ '^\\{${PERMITTED_OPERATION}(,${PERMITTED_OPERATION})*\\}$') OR ("reason_code"."domain" NOT IN (${quoted(IDENTITY_REASON_DOMAINS)}) AND "reason_code"."permitted_operations" IS NULL)`,
      ),
    ),
  ],
);

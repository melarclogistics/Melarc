import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import {
  DECIDED_ORGANIZATION_STATUSES,
  VENDOR_ORGANIZATION_STATUSES,
} from '../platform/auth/vendor/vendor-vocabulary.js';
import { hub } from '../platform/database/schema/reference-data.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../staff/reserved-system-actor.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The vendor organisation, **minimal** (S0.47; domain-model.md section 6.16 `VendorOrganization`): what the recovery guard of S0.50 reads
 * (its operational status), what scopes a staff reader (its responsible hub) and what a vendor session shows as whose it is (its names).
 * Creating, deciding, suspending and terminating an organisation are `SLICE-008`'s; nothing in this slice writes the table but the
 * non-production fixture (MIGRATION_AND_SEEDING.md section 4b) and the test kit.
 *
 * - **The maker and the checker are both on the record**, and they differ (section 35.12.2), except on a fixture row, where both record the
 *   reserved system actor (section 4b's third constraint): the record then looks like no review-free approval.
 * - **A decision is recorded with its actor and moment**, exactly when the status has left the two states before the review, and a
 *   rejection with its reason.
 *
 * This file is the *shape*. The migration (`0034_vendor_accounts.sql`) adds by hand, in the same change: the owner, `ENABLE` and `FORCE
 * ROW LEVEL SECURITY`, the policies (a staff context under a vendor key reads the master; a vendor its own; the `authentication`
 * capability; the fixture's insert), the grants (the API reads and writes nothing else) and the guard trigger.
 */
export const vendorOrganization = pgTable(
  'vendor_organization',
  {
    id: uuid('id').primaryKey(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    legalName: text('legal_name').notNull(),
    tradingName: text('trading_name'),
    contactPhone: text('contact_phone'),
    contactEmail: text('contact_email'),
    operationalStatus: text('operational_status').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionReason: text('decision_reason'),
  },
  (table) => [
    foreignKey({
      name: 'vendor_organization_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    index('vendor_organization_hub_idx').on(table.responsibleHubId),
    check(
      'vendor_organization_status_closed',
      sql.raw(
        `"vendor_organization"."operational_status" IN (${quoted(VENDOR_ORGANIZATION_STATUSES)})`,
      ),
    ),
    check(
      'vendor_organization_names_not_blank',
      sql`length(btrim(${table.legalName})) > 0 AND (${table.tradingName} IS NULL OR length(btrim(${table.tradingName})) > 0)`,
    ),
    check(
      'vendor_organization_contact_present',
      sql`${table.contactPhone} IS NOT NULL OR ${table.contactEmail} IS NOT NULL`,
    ),
    check(
      'vendor_organization_decision_by_status',
      sql.raw(
        `("vendor_organization"."decided_by" IS NOT NULL) = ("vendor_organization"."operational_status" IN (${quoted(DECIDED_ORGANIZATION_STATUSES)}))
         AND ("vendor_organization"."decided_by" IS NULL) = ("vendor_organization"."decided_at" IS NULL)`,
      ),
    ),
    check(
      'vendor_organization_checker_is_not_maker',
      sql.raw(
        `"vendor_organization"."decided_by" IS NULL OR "vendor_organization"."decided_by" <> "vendor_organization"."created_by"
         OR "vendor_organization"."created_by" = '${RESERVED_SYSTEM_ACTOR_ID}'`,
      ),
    ),
    check(
      'vendor_organization_rejection_has_reason',
      sql`${table.operationalStatus} <> 'REJECTED' OR ${table.decisionReason} IS NOT NULL`,
    ),
  ],
);

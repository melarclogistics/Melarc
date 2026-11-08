import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { vendorOrganization } from './vendor-organization.schema.js';

export const VENDOR_FINANCIAL_STATUSES = ['GOOD', 'OVERDUE'] as const;

/**
 * A vendor's financial standing (S1.10, `SLICE-001`; domain-model.md section 6.16, "the two standings"; section 35.12.8): `OVERDUE` once a
 * statement is unpaid at its due moment, and nothing else. **One of the four vendor conditions that may never become one flag**:
 * operational suspension is the organisation's `operational_status`, the account allowance is its own record, and a security or risk
 * hold is another; this is the financial one.
 *
 * **Read-only in this slice.** The statement that makes a vendor overdue is `SLICE-011`'s; the one reader here is the booking cutoff,
 * which gives a vendor that has *settled* the grace window of `vendor_credit_grace_window_minutes` (settings.md section 7.3,
 * `MSC-DEC-254`). A vendor with no row has never been overdue and is settled. Written only by the non-production fixture and the test
 * kit (an arrangement marks a vendor overdue); the production writer is `SLICE-011`.
 *
 * The migration (`0045_pickup_requests.sql`) adds by hand: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies and the
 * grants.
 */
export const vendorFinancialStanding = pgTable(
  'vendor_financial_standing',
  {
    vendorOrganizationId: uuid('vendor_organization_id').primaryKey(),
    financialStatus: text('financial_status').notNull().default('GOOD'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: 'vendor_financial_standing_org_fkey',
      columns: [table.vendorOrganizationId],
      foreignColumns: [vendorOrganization.id],
    }).onDelete('restrict'),
    check(
      'vendor_financial_standing_status_closed',
      sql.raw(
        `"vendor_financial_standing"."financial_status" IN (${VENDOR_FINANCIAL_STATUSES.map((value) => `'${value}'`).join(', ')})`,
      ),
    ),
  ],
);

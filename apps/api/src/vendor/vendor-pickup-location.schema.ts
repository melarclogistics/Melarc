import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { vendorOrganization } from './vendor-organization.schema.js';

/**
 * A vendor's saved pickup location (S1.10, `SLICE-001`; domain-model.md section 6.18; data-scope-registry.md `VendorPickupLocation`),
 * **read-only in this slice**: the management operations (`vendor.pickup_location.manage`, `setDefaultVendorPickupLocation`) are
 * `SLICE-008`'s, and nothing in this slice writes the table but the non-production fixture (MIGRATION_AND_SEEDING.md section 4b) and the
 * test kit. A booking reads it as an *input* and snapshots the place it resolves to; editing or retiring a location changes nothing
 * already booked (section 6.18).
 *
 * - **A location belongs to a vendor record** (`vendor_organization_id`), which is the scope predicate: a vendor reads its own, a staff
 *   member reads the master (a pickup address is what an Ops user needs to associate a booking), and another vendor's is answered as one
 *   that does not exist.
 * - **Exactly one default among a vendor's active locations**: a partial unique index holds it, and a check refuses a default that is not
 *   active. Deactivation is a flag, never a deletion (section 8).
 * - **The location is the shape of section 3.5** (`address` mandatory; landmark, map link and coordinates optional); no second address
 *   format is introduced, and serviceability is not evaluated here (it is revalidated per request, section 11.3).
 *
 * This file is the *shape*. The migration (`0045_pickup_requests.sql`) adds by hand, in the same change: the owner, `ENABLE` and `FORCE
 * ROW LEVEL SECURITY`, the policies and the grants (the API reads and writes nothing else).
 */
export const vendorPickupLocation = pgTable(
  'vendor_pickup_location',
  {
    id: uuid('id').primaryKey(),
    vendorOrganizationId: uuid('vendor_organization_id').notNull(),
    label: text('label').notNull(),
    location: jsonb('location').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'vendor_pickup_location_org_fkey',
      columns: [table.vendorOrganizationId],
      foreignColumns: [vendorOrganization.id],
    }).onDelete('restrict'),
    index('vendor_pickup_location_org_idx').on(table.vendorOrganizationId),
    uniqueIndex('vendor_pickup_location_one_default')
      .on(table.vendorOrganizationId)
      .where(sql`${table.isDefault} AND ${table.active}`),
    check('vendor_pickup_location_label_not_blank', sql`length(btrim(${table.label})) > 0`),
    check(
      'vendor_pickup_location_default_is_active',
      sql`NOT ${table.isDefault} OR ${table.active}`,
    ),
    check(
      'vendor_pickup_location_has_address',
      sql`jsonb_typeof(${table.location}) = 'object' AND coalesce(length(btrim(${table.location}->>'address')), 0) > 0`,
    ),
  ],
);

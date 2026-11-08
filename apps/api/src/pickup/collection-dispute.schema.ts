import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { vendorOrganization } from '../vendor/vendor-organization.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

/** The states of a `CollectionDispute` (domain-model.md section 6.19). Nothing resolves one in `SLICE-001`. */
export const DISPUTE_STATES = ['OPEN', 'RESOLVED'] as const;

/**
 * The reconciliation item of a disputed collection (S1.29, `SLICE-001`; domain-model.md section 6.19; `AC-SLICE-001-27`): the vendor says the
 * collection of its own pickup is not as the stop closed it. **It never reverses physical completion**: the stop stays as it closed
 * (`COLLECTED` or `PARTIALLY_COLLECTED`) and the manifest does not wait for it. Raising one sets the stop's handshake `DISPUTED`, in the same change.
 *
 * - **One open dispute per stop** (a partial unique key); a second is a conflict, not a second item.
 * - **Written only by `melarc.dispute_collection`** (migration `0071`), a `SECURITY DEFINER` function of the owner that the API's runtime login
 *   alone executes: the login holds `SELECT` and no write. The item is hub-scoped through its stop and owned by the vendor organisation.
 * - **Its resolution is the detailed Ops reconciliation workflow that the specification leaves to downstream design** (§21.8): no operation
 *   resolves it, the table allows the one move `OPEN` to `RESOLVED` (with its moment) to whoever the workflow will be, and nothing else changes.
 */
export const collectionDispute = pgTable(
  'collection_dispute',
  {
    id: uuid('id').primaryKey(),
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, carried by a composite key so that a dispute can never name another hub than its stop's. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The organisation whose pickup it is: the vendor reads its own disputes by this. */
    vendorOrganizationId: uuid('vendor_organization_id').notNull(),
    /** The vendor principal (account) that raised it. */
    raisedBy: uuid('raised_by').notNull(),
    /** What the vendor disputes; mandatory. */
    note: text('note').notNull(),
    state: text('state').notNull().default('OPEN'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** The ETag source, moved by the database on every change and by nothing else. */
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'collection_dispute_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_dispute_vendor_fkey',
      columns: [table.vendorOrganizationId],
      foreignColumns: [vendorOrganization.id],
    }).onDelete('restrict'),
    // At most one open dispute per stop: a second is refused. A stop is disputed once (its handshake is DISPUTED, which nothing leaves), so a resolved dispute makes room for no other.
    uniqueIndex('collection_dispute_open_key')
      .on(table.pickupStopId)
      .where(sql`${table.state} = 'OPEN'`),
    index('collection_dispute_hub_state_idx').on(table.responsibleHubId, table.state),
    index('collection_dispute_vendor_idx').on(table.vendorOrganizationId, table.createdAt),
    check(
      'collection_dispute_state_closed',
      sql.raw(
        `"collection_dispute"."state" IN (${DISPUTE_STATES.map((each) => `'${each}'`).join(', ')})`,
      ),
    ),
    check(
      'collection_dispute_note',
      sql`btrim(${table.note}) <> '' AND char_length(${table.note}) <= 1000`,
    ),
    check(
      'collection_dispute_resolved_facts',
      sql`(${table.state} = 'OPEN' AND ${table.resolvedAt} IS NULL) OR (${table.state} = 'RESOLVED' AND ${table.resolvedAt} IS NOT NULL)`,
    ),
  ],
);

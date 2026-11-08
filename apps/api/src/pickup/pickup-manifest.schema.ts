import { sql } from 'drizzle-orm';
import {
  check,
  date,
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

import { hub } from '../platform/database/schema/reference-data.js';
import { riderIdentity } from '../staff/rider-identity.schema.js';

export const PICKUP_MANIFEST_STATES = [
  'DRAFT',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The pickup manifest, a run (S1.20, `SLICE-001`; domain-model.md section 6.3; state-machines.md section 4; data-scope-registry.md
 * `PickupManifest`; features/pickup/pickup-manifest.md). Ops builds it from confirmed, unmanifested requests; a rider works it.
 *
 * - **Never vendor-owned, and never visible to a vendor.** A manifest carries the stops of many vendors, so a vendor reads neither it
 *   nor any other manifest. Staff read the manifests of the hubs of the operation's grant. A rider reads a manifest only while it is
 *   **assigned** to them **and has been dispatched** (`dispatched_at` is set): a draft is not shown to its rider, and a manifest that was
 *   cancelled before it was dispatched never is. Rider access is assignment, never hub membership, and follows the assignment at once.
 * - **`responsible_hub_id` is the domain model's `hub_id`** (section 6.3); it carries the contract's name, as the pickup request's does.
 *   The hub is derived from the requests the manifest is built from, all of which belong to it.
 * - **Rider assignment is not a state.** `assigned_rider_id` and `assigned_at` are set together (the cancellation cutoff of the requests it
 *   carries), and the manifest is `DRAFT` before and after; it leaves `DRAFT` only at dispatch. The CHECK constraints hold what each
 *   state implies of the three moments (dispatch, start and completion), so a row cannot say a state its facts contradict.
 * - **`version` is the record's ETag source**, moved by the database on every change and by nothing else.
 *
 * This file is the *shape*. The migration (`0058_pickup_manifests.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (staff by hub and key; a rider by assignment after dispatch; a vendor none; the scope
 * probe), the grants, the guard that holds the identity and the state machine, and the version trigger.
 */
export const pickupManifest = pgTable(
  'pickup_manifest',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    serviceDate: date('service_date', { mode: 'string' }).notNull(),
    state: text('state').notNull().default('DRAFT'),
    assignedRiderId: uuid('assigned_rider_id'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_manifest_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_manifest_rider_fkey',
      columns: [table.assignedRiderId],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    uniqueIndex('pickup_manifest_code_key').on(table.code),
    // The target of the stop's foreign key to its manifest **and its hub**: a stop can never name another hub than its manifest's.
    uniqueIndex('pickup_manifest_id_hub_key').on(table.id, table.responsibleHubId),
    index('pickup_manifest_hub_idx').on(table.responsibleHubId, table.state, table.serviceDate),
    index('pickup_manifest_rider_idx')
      .on(table.assignedRiderId, table.state)
      .where(sql`${table.assignedRiderId} IS NOT NULL`),
    check(
      'pickup_manifest_code_format',
      sql`${table.code} ~ '^[A-Z]{3}-MF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'`,
    ),
    check(
      'pickup_manifest_state_closed',
      sql.raw(`"pickup_manifest"."state" IN (${quoted(PICKUP_MANIFEST_STATES)})`),
    ),
    // Assignment is one moment: the rider and the instant are set together, or neither is.
    check(
      'pickup_manifest_assignment_pair',
      sql`(${table.assignedRiderId} IS NULL) = (${table.assignedAt} IS NULL)`,
    ),
    // What each state implies. A draft was not dispatched; a dispatched, started or completed run was, and has its rider. A cancelled run
    // may or may not have been dispatched (it is cancelled before it starts), so the constraint says nothing of its dispatch.
    check(
      'pickup_manifest_dispatch_facts',
      sql`(${table.state} = 'DRAFT' AND ${table.dispatchedAt} IS NULL) OR ${table.state} = 'CANCELLED' OR (${table.state} IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED') AND ${table.dispatchedAt} IS NOT NULL AND ${table.assignedRiderId} IS NOT NULL)`,
    ),
    check(
      'pickup_manifest_start_facts',
      sql`(${table.state} IN ('IN_PROGRESS', 'COMPLETED')) = (${table.startedAt} IS NOT NULL)`,
    ),
    check(
      'pickup_manifest_completion_facts',
      sql`(${table.state} = 'COMPLETED') = (${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

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

import { pickupManifest } from '../pickup/pickup-manifest.schema.js';
import { hub } from '../platform/database/schema/reference-data.js';
import { riderIdentity } from '../staff/rider-identity.schema.js';

export const RUN_CUSTODY_HANDOVER_STATES = ['PENDING', 'COMPLETED', 'FAILED'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The run custody handover (S1.24, `SLICE-001`; domain-model.md section 6.8.1; state-machines.md section 4.1; data-scope-registry.md
 * `RunCustodyHandover`; `MSC-DEC-246`): the record that moves the custody of a run's parcels from the rider who holds them to another rider or
 * to the hub, because the rider cannot go on (broken down, injured, a destroyed handset).
 *
 * - **Opening one moves nothing.** Custody is the original holder's until the receiver accepts, so there is never a moment in which nobody
 *   holds the parcels. At most one handover of a run is open (`PENDING`) at a time, by a partial unique index.
 * - **`from_rider_id` is the rider who held custody when it was opened, and is never overwritten.** The run's `assigned_rider_id` is never
 *   rewritten to effect a transfer either (domain-model.md 6.8.1: a rider-ID edit is not a handover): completed-stop attribution depends on
 *   both. The current holder of a run is read from this table (`melarc.run_custody_holder`, migration 0067), not stored on the run.
 * - **Exactly one destination**: another rider of the run's hub, or the run's own hub (`to_hub_id` equals `responsible_hub_id`; "the hub"
 *   is the hub the parcels belong to). The destination rider is never the rider handing over.
 * - **The count the receiver took is a custody record and never a count**: it is kept on the acceptance and read by nothing that counts.
 * - **The notes are Ops's own text** (a custody handover and its failure carry a mandatory note and no catalogue code: decision D-05) and are
 *   in no representation a rider reads.
 * - **`version` is the record's ETag source**, moved by the database on every change and by nothing else.
 *
 * This file is the *shape*. The migration (`0067_run_custody_handover.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (staff by hub and key; a rider as a party to the handover; a vendor none; the scope probe), the
 * grants, the guard that holds the identity, the custody chain and the state machine, and the version trigger.
 */
export const runCustodyHandover = pgTable(
  'run_custody_handover',
  {
    id: uuid('id').primaryKey(),
    manifestId: uuid('manifest_id').notNull(),
    /** The run's hub, carried from the manifest by a composite key so that a handover can never name another hub than its run's. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    fromRiderId: uuid('from_rider_id').notNull(),
    toRiderId: uuid('to_rider_id'),
    toHubId: uuid('to_hub_id'),
    state: text('state').notNull().default('PENDING'),
    parcelCountTaken: integer('parcel_count_taken'),
    initiationNote: text('initiation_note').notNull(),
    failureNote: text('failure_note'),
    initiatedBy: uuid('initiated_by').notNull(),
    /** The receiver: a rider, or the officer who accepted for the hub. Not a foreign key, since it is a person of either kind. */
    acceptedBy: uuid('accepted_by'),
    failedBy: uuid('failed_by'),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'run_custody_handover_manifest_fkey',
      columns: [table.manifestId, table.responsibleHubId],
      foreignColumns: [pickupManifest.id, pickupManifest.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_custody_handover_from_fkey',
      columns: [table.fromRiderId],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_custody_handover_to_rider_fkey',
      columns: [table.toRiderId],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_custody_handover_to_hub_fkey',
      columns: [table.toHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_custody_handover_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    // One open handover per run: a second request, a double click included, finds this index and is a conflict.
    uniqueIndex('run_custody_handover_one_open')
      .on(table.manifestId)
      .where(sql`${table.state} = 'PENDING'`),
    index('run_custody_handover_manifest_idx').on(table.manifestId, table.initiatedAt),
    index('run_custody_handover_receiver_idx')
      .on(table.toRiderId, table.initiatedAt)
      .where(sql`${table.toRiderId} IS NOT NULL`),
    index('run_custody_handover_sender_idx').on(table.fromRiderId, table.initiatedAt),
    index('run_custody_handover_hub_idx').on(table.responsibleHubId, table.initiatedAt),
    check(
      'run_custody_handover_state_closed',
      sql.raw(`"run_custody_handover"."state" IN (${quoted(RUN_CUSTODY_HANDOVER_STATES)})`),
    ),
    // Exactly one destination, and the hub destination is the run's own hub; the receiving rider is never the rider handing over.
    check(
      'run_custody_handover_one_destination',
      sql`(${table.toRiderId} IS NULL) <> (${table.toHubId} IS NULL)`,
    ),
    check(
      'run_custody_handover_hub_is_the_runs',
      sql`${table.toHubId} IS NULL OR ${table.toHubId} = ${table.responsibleHubId}`,
    ),
    check(
      'run_custody_handover_not_to_itself',
      sql`${table.toRiderId} IS NULL OR ${table.toRiderId} <> ${table.fromRiderId}`,
    ),
    // What each state implies: the count and the receiver exist exactly when it was accepted; the note and the officer, exactly when it failed;
    // the moment of resolution, exactly when it is not open.
    check(
      'run_custody_handover_accepted_facts',
      sql`(${table.state} = 'COMPLETED') = (${table.parcelCountTaken} IS NOT NULL) AND (${table.state} = 'COMPLETED') = (${table.acceptedBy} IS NOT NULL)`,
    ),
    check(
      'run_custody_handover_failed_facts',
      sql`(${table.state} = 'FAILED') = (${table.failureNote} IS NOT NULL) AND (${table.state} = 'FAILED') = (${table.failedBy} IS NOT NULL)`,
    ),
    check(
      'run_custody_handover_resolved_facts',
      sql`(${table.state} = 'PENDING') = (${table.resolvedAt} IS NULL)`,
    ),
    check(
      'run_custody_handover_count_nonnegative',
      sql`${table.parcelCountTaken} IS NULL OR ${table.parcelCountTaken} >= 0`,
    ),
    // A note is one line of plain text, which the ledger will keep (the same bound as the audit's own screening).
    check(
      'run_custody_handover_notes_bounded',
      sql`char_length(${table.initiationNote}) BETWEEN 1 AND 1000 AND btrim(${table.initiationNote}) <> '' AND (${table.failureNote} IS NULL OR (char_length(${table.failureNote}) BETWEEN 1 AND 1000 AND btrim(${table.failureNote}) <> ''))`,
    ),
  ],
);

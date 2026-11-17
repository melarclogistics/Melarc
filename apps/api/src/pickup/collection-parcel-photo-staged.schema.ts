import {
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { evidence } from '../platform/database/schema/evidence.js';
import { riderIdentity } from '../staff/rider-identity.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

/**
 * A parcel photo that a rider has put aside for a count it has not yet made (the Product Owner's decision D-E1 of 17 November 2026; pickup-collection.md section 5.5; the plan's Stage 6b): one
 * row for each stored `PARCEL_PHOTO` record of a stop, staged in a batch of at most 500 by `stageParcelPhotos`, so that a collection of any size reaches the server in requests that the transport
 * admits. `recordCollection` attaches the staged photos and the ones it names to the count together, in its own transaction; **this table is not the count's link** (`collection_parcel_photo` is)
 * and nothing that counts reads it.
 *
 * - **Append-only, and a photo is staged once**: a row is never changed or removed, for every writer, and the evidence record is its key, so a batch sent again, under the same key or another, is
 *   the same set (a duplicate key is a no-op for the operation, and refused for a direct writer).
 * - **What may be staged, held by the guard (migration 0108) for every writer**: a record that is `STORED`, captured by the rider who stages it, about this very stop (`owner_type` `PICKUP_STOP`,
 *   `owner_id` the stop) for the purpose `PARCEL_PHOTO`, not attached to a count, for a stop the rider has arrived at on a run in progress that is assigned to it.
 * - **The set is closed by the count**: no row is added once the stop has a collection record, nor for a stop that Ops let through without parcel photos. The stop's row lock orders a batch and the
 *   count, so that one of them commits first and the other is refused; the count is the end of the staged set and the only thing that closes it.
 * - **Scope**: the stop's hub, by a composite key; the rider reads and writes only what it staged, and no other principal reads it (Ops reads the stop's photos from the evidence list).
 */
export const collectionParcelPhotoStaged = pgTable(
  'collection_parcel_photo_staged',
  {
    /** The evidence record: its own key, so that a photo is staged once and for one stop. */
    evidenceId: uuid('evidence_id').primaryKey(),
    /** The stop the photo is of, set by the guard from the evidence. */
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, set by the guard from the stop and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The rider who captured the photo and stages it: set by the guard from the evidence. */
    stagedByRider: uuid('staged_by_rider').notNull(),
    /** The database's own moment (the guard); the order the photos were staged in, by moment and then by identifier. */
    stagedAt: timestamp('staged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'collection_parcel_photo_staged_evidence_fkey',
      columns: [table.evidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_parcel_photo_staged_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_parcel_photo_staged_rider_fkey',
      columns: [table.stagedByRider],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    index('collection_parcel_photo_staged_stop_idx').on(table.pickupStopId, table.stagedAt),
  ],
);

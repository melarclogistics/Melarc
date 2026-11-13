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
import { collectionRecord } from './collection-record.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

/**
 * The photo of one parcel at the door (D-A10, the Product Owner's decision of 12 November 2026; pickup-collection.md section 5.5): one row for each stored `PARCEL_PHOTO` record the
 * rider attached to the count it made, so that "this count has one photo for each parcel counted" is a fact of the database and not a claim of the application.
 *
 * - **Append-only, and each photo is attached once**: a link is made when the count is made, never changed or removed, for every writer, and the evidence record is its key, so a
 *   photo is attached to one count once (a second attachment is a duplicate key, whoever writes it).
 * - **What may be attached, held by the guard (migration 0088) for every writer**: a record that is `STORED`, captured by the rider who made the count, about this very stop
 *   (`owner_type` `PICKUP_STOP`, `owner_id` the stop) for the purpose `PARCEL_PHOTO`, and only to the count of that stop; a failure's photo (`COLLECTION_PROOF`) is not a parcel's, and
 *   a parcel's cannot be attached to a failure. The stop, the hub, the rider and the moment are the guard's, derived from the count and the evidence and the database's clock: a
 *   writer names the record and the count and nothing else.
 * - **The number is the count's, held at the end of the transaction** (a deferred constraint, on this table and on the count): exactly `collected_count` rows, or none when Ops let the
 *   stop through without photos (`parcel_photo_exception`). A count with a different number of photos, a count with none included, is refused by the database for every writer.
 * - **Scope**: the stop's hub, by a composite key, so that a link can never name another hub than its stop's; staff read it by that hub, the rider only what it attached.
 */
export const collectionParcelPhoto = pgTable(
  'collection_parcel_photo',
  {
    /** The evidence record: its own key, so that one photo is attached once and to one count. */
    evidenceId: uuid('evidence_id').primaryKey(),
    collectionRecordId: uuid('collection_record_id').notNull(),
    /** The count's stop, set by the guard from the count. */
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, set by the guard from the stop and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The rider who made the count and captured the photo: set by the guard from the evidence. */
    attachedByRider: uuid('attached_by_rider').notNull(),
    /** The database's own moment (the guard). */
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'collection_parcel_photo_evidence_fkey',
      columns: [table.evidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_parcel_photo_record_fkey',
      columns: [table.collectionRecordId],
      foreignColumns: [collectionRecord.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_parcel_photo_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_parcel_photo_rider_fkey',
      columns: [table.attachedByRider],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    index('collection_parcel_photo_record_idx').on(table.collectionRecordId),
    index('collection_parcel_photo_stop_idx').on(table.pickupStopId),
    index('collection_parcel_photo_hub_idx').on(table.responsibleHubId, table.attachedAt),
  ],
);

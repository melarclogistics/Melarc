import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { staffIdentity } from '../staff/staff-identity.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

/**
 * Ops lets a stop's count through without parcel photos (D-A10, the Product Owner's decision of 12 November 2026; pickup-collection.md section 5.5): the exception for the day the
 * camera fails or the photos cannot be sent. **One per stop, made once, before the count, and never changed or removed**, for every writer. Once it exists the stop's count takes
 * no parcel photos (and a count that names some is refused); without it a count takes one photo for each parcel counted.
 *
 * - **Written by one operation of the database** (`melarc.authorise_parcel_photo_exception`, migration 0088), which an officer of the stop's hub holding `pickup.handshake.override`
 *   reaches through `authoriseParcelPhotoException`; the runtime login holds no privilege to write the table, and the guard holds for every writer that the stop is one the rider
 *   has arrived at on a run in progress with no count yet.
 * - **The officer, the moment and the hub are the database's**: the officer is the session's, the moment is the database's clock, the hub is the stop's (a composite key). The note
 *   says why, is required, and is the officer's words; the ledger keeps the enhanced event beside it.
 */
export const parcelPhotoException = pgTable(
  'parcel_photo_exception',
  {
    id: uuid('id').primaryKey(),
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, set by the guard from the stop and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The officer who let the stop through: the session's, set by the guard. */
    authorisedBy: uuid('authorised_by').notNull(),
    /** The database's own moment (the guard). */
    authorisedAt: timestamp('authorised_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'parcel_photo_exception_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'parcel_photo_exception_officer_fkey',
      columns: [table.authorisedBy],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    // At most one per stop: a second exception for the stop finds this index and is a conflict.
    uniqueIndex('parcel_photo_exception_stop_key').on(table.pickupStopId),
    index('parcel_photo_exception_hub_idx').on(table.responsibleHubId, table.authorisedAt),
    check('parcel_photo_exception_note_present', sql`char_length(btrim(${table.note})) >= 1`),
  ],
);

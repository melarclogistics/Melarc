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
 * The evidence photo of a failed pickup stop (S1.28, the failure photo; S1.11's first owner): one row for each record of stored evidence the rider attached to the failure
 * it reported, so that "this stop's failure has a photo" is a fact of the database and not a claim of the application.
 *
 * - **Append-only and for one stop**: a link is made once and never changed or removed, for every writer, and the evidence record is its key, so a record is attached to
 *   one stop once (`EVIDENCE_NOT_STORED` for a second attachment).
 * - **What may be attached, held by the guard (migration 0083) for every writer**: a record that is `STORED`, captured by the rider who attaches it, about this very stop
 *   (`owner_type` `PICKUP_STOP`, `owner_id` the stop) for the purpose `COLLECTION_PROOF`; and only to a stop the rider has arrived at, on a run in progress that is assigned to
 *   it. The hub, the rider and the moment are the guard's, derived from the stop and the session and the database's clock: a writer gives the two keys and nothing else.
 * - **The stop's guard asks for it**: a failure whose reason requires a photo (`reason_code.requires_photo`, read from the catalogue and never hard-coded) is refused when the
 *   stop has no link, for every writer.
 * - **Scope**: the stop's hub, by a composite key, so that a link can never name another hub than its stop's; staff read it by that hub, the rider only what it attached.
 */
export const pickupStopEvidence = pgTable(
  'pickup_stop_evidence',
  {
    /** The evidence record: its own key, so that one record is attached once and to one stop. */
    evidenceId: uuid('evidence_id').primaryKey(),
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, set by the guard from the stop and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The rider who attached it: the session's, set by the guard. */
    attachedByRider: uuid('attached_by_rider').notNull(),
    /** The database's own moment (the guard). */
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_stop_evidence_evidence_fkey',
      columns: [table.evidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_stop_evidence_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_stop_evidence_rider_fkey',
      columns: [table.attachedByRider],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    index('pickup_stop_evidence_stop_idx').on(table.pickupStopId),
    index('pickup_stop_evidence_hub_idx').on(table.responsibleHubId, table.attachedAt),
  ],
);

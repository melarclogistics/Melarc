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

import { evidence } from '../platform/database/schema/evidence.js';
import { pickupIntake } from './pickup-intake.schema.js';

/** Where a parcel comes from: one of the rider's door photos, or an extra an officer found at the hub with no photo of the door. */
export const INTAKE_PARCEL_ORIGINS = ['DOOR_PHOTO', 'HUB_EXTRA'] as const;
/** What a parcel is: not yet checked in, checked in, left out when its vendor was finished, or an extra taken back (`VOID` is for an extra only). */
export const INTAKE_PARCEL_STATES = ['EXPECTED', 'ARRIVED', 'MISSING', 'VOID'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * One physical parcel as the hub checks it (Run D, S1.35b; D-D2, D-D4, D-D6, D-D8; domain-model.md section 6.6a; state-machines.md section 7; hub-intake.md sections 5.1 and 5.4 to 5.8): **one
 * row for each door photo of a photo intake**, opened by the hub handover in the order the photos were taken, and **one row for each extra** an officer records at the hub. It is what an
 * order is later made for (itemization.md): its identity is its id and its door photo's evidence record, so a package may refer to the photo before the intake exists.
 *
 * - **Written by operations of the database, as the owner, and by nobody else**: the handover opens the door parcels (`melarc.open_intake_parcels`), an officer's tap, the finishing of a vendor,
 *   an extra and a senior's correction move them (`melarc.record_parcel_arrival`, `finish_check_in`, `add_extra_parcel`, `correct_intake_count`, migration 0104). The application's login
 *   holds `SELECT` and no write. **The guard of the table holds the machine for every writer** (`EXPECTED <-> ARRIVED`; `EXPECTED -> MISSING` when the vendor is finished; `MISSING -> ARRIVED`
 *   when it is found while the case is open; an extra born `ARRIVED` and `ARRIVED <-> VOID`; the senior's moves; nothing once itemizing has started), and gives who and when: the officer and the
 *   database's moment, never the writer's.
 * - **The set is held at the end of the transaction**: a photo intake's door parcels are exactly the door photos of its stop, once each and in their order, and a finished photo intake's
 *   `physical_count` is the number of its `ARRIVED` parcels (two deferred constraint triggers, failing closed), for every writer.
 * - **The hub is the intake's**, carried by a composite key, so that a parcel can never name another hub than its intake's.
 *
 * This file is the *shape*. The migration adds by hand, in the same change: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the grant (`SELECT` alone), the guard, the
 * deferred checks and the operation that opens the door parcels.
 */
export const intakeParcel = pgTable(
  'intake_parcel',
  {
    id: uuid('id').primaryKey(),
    pickupIntakeId: uuid('pickup_intake_id').notNull(),
    /** The intake's hub, given by the guard and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The place of the parcel's photo among the stop's (an extra follows the last): the order the parcels are drawn in. */
    ordinal: integer('ordinal').notNull(),
    origin: text('origin').notNull(),
    /** The rider's `PARCEL_PHOTO` record of the stop: present exactly for a door parcel, and unique. */
    doorPhotoEvidenceId: uuid('door_photo_evidence_id'),
    /** The officer's photo of an extra (owner `PICKUP_INTAKE`, purpose `OSD`, `STORED`): present exactly for an extra, and unique. */
    hubPhotoEvidenceId: uuid('hub_photo_evidence_id'),
    state: text('state').notNull(),
    /** The officer who checked the parcel in (or found it, or added the extra), and the database's moment of it: not a foreign key, since the table that holds them is another domain's. */
    arrivedBy: uuid('arrived_by'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    /** When the vendor was finished without this parcel: kept after the parcel is found. */
    missingMarkedAt: timestamp('missing_marked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The guard's own: moved by it on every change. */
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'intake_parcel_intake_fkey',
      columns: [table.pickupIntakeId, table.responsibleHubId],
      foreignColumns: [pickupIntake.id, pickupIntake.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'intake_parcel_door_photo_fkey',
      columns: [table.doorPhotoEvidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'intake_parcel_hub_photo_fkey',
      columns: [table.hubPhotoEvidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    // The key a finding of a parcel names (migration 0105): a finding of a parcel is a finding of the parcel's own intake.
    uniqueIndex('intake_parcel_id_intake_key').on(table.id, table.pickupIntakeId),
    // The parcels of an intake are drawn in a fixed order, each place once.
    uniqueIndex('intake_parcel_ordinal_key').on(table.pickupIntakeId, table.ordinal),
    // A photo is the photo of one parcel, once (a null is no photo: the nulls of the other origin are not duplicates).
    uniqueIndex('intake_parcel_door_photo_key').on(table.doorPhotoEvidenceId),
    uniqueIndex('intake_parcel_hub_photo_key').on(table.hubPhotoEvidenceId),
    index('intake_parcel_intake_idx').on(table.pickupIntakeId, table.state),
    // The list of the parcels being searched for, by hub and how long they have been missing.
    index('intake_parcel_missing_idx')
      .on(table.responsibleHubId, table.missingMarkedAt)
      .where(sql`${table.state} = 'MISSING'`),
    check(
      'intake_parcel_origin_closed',
      sql.raw(`"intake_parcel"."origin" IN (${quoted(INTAKE_PARCEL_ORIGINS)})`),
    ),
    check(
      'intake_parcel_state_closed',
      sql.raw(`"intake_parcel"."state" IN (${quoted(INTAKE_PARCEL_STATES)})`),
    ),
    check('intake_parcel_ordinal_positive', sql`${table.ordinal} >= 1`),
    // A door parcel has its door photo and no hub photo; an extra has its hub photo and no door photo.
    check(
      'intake_parcel_origin_facts',
      sql`(${table.origin} = 'DOOR_PHOTO' AND ${table.doorPhotoEvidenceId} IS NOT NULL AND ${table.hubPhotoEvidenceId} IS NULL) OR (${table.origin} = 'HUB_EXTRA' AND ${table.hubPhotoEvidenceId} IS NOT NULL AND ${table.doorPhotoEvidenceId} IS NULL)`,
    ),
    // What each state implies: an expected parcel has nobody's check-in and no missing moment; an arrived one has its officer and moment (and keeps a missing moment it had before it was found); a
    // missing one has its missing moment and no check-in; a void one is an extra that had arrived.
    check(
      'intake_parcel_state_facts',
      sql`(${table.state} = 'EXPECTED' AND ${table.arrivedBy} IS NULL AND ${table.arrivedAt} IS NULL AND ${table.missingMarkedAt} IS NULL) OR (${table.state} = 'ARRIVED' AND ${table.arrivedBy} IS NOT NULL AND ${table.arrivedAt} IS NOT NULL) OR (${table.state} = 'MISSING' AND ${table.arrivedBy} IS NULL AND ${table.arrivedAt} IS NULL AND ${table.missingMarkedAt} IS NOT NULL) OR (${table.state} = 'VOID' AND ${table.origin} = 'HUB_EXTRA' AND ${table.arrivedBy} IS NOT NULL AND ${table.arrivedAt} IS NOT NULL AND ${table.missingMarkedAt} IS NULL)`,
    ),
    // An extra is on the table: it is born `ARRIVED` and can only be taken back; it is never expected or missing.
    check(
      'intake_parcel_extra_states',
      sql`${table.origin} = 'DOOR_PHOTO' OR ${table.state} IN ('ARRIVED', 'VOID')`,
    ),
  ],
);

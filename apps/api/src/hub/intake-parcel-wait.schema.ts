import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { intakeParcel } from './intake-parcel.schema.js';

/** How a mark ended: the officer took it off, or the parcel's order was made. */
export const PARCEL_WAIT_CLEARED_REASONS = ['UNMARKED', 'ORDER_MADE'] as const;

/** The longest note of a mark: a short line, what was asked of the vendor and how. */
export const PARCEL_WAIT_NOTE_MAX = 120;

/**
 * A parcel the officer is waiting on (Run G1, Part 1, item 2; D-S7-12 of the Product Owner's decisions of 24 November 2026; itemization.md section 5.2): **a parcel an officer cannot order yet (a label that cannot be
 * read, a missing phone, an address that makes no sense) is the officer's**, who calls or messages the vendor and gets the details. The mark says so, **held by the server, so that every officer and every tablet
 * sees it**: the parcel is *waiting for the vendor's details*, with an optional short note (what was asked and how). No senior, no money, no new permission key.
 *
 * - **One row for each mark, never deleted.** A mark ends by being cleared (`cleared_at`, `cleared_by`, `cleared_reason`): the officer took it off (`UNMARKED`) or the parcel's order was made (`ORDER_MADE`, by the
 *   database, in the transaction that makes the order). A parcel marked again later has a new row; **one live mark for a parcel** is a partial unique key.
 * - **Written only by `melarc.set_parcel_vendor_wait`** (migration `0126`), under the key that itemizes, and cleared by the order's own trigger; the runtime login holds `SELECT` alone. **The guard of the table holds
 *   the rest for every writer**: the hub, the officer and the moment are the parcel's, the principal's and the database's; a mark is never removed; a cleared mark is never changed; only the note of a live mark moves.
 * - The note is one short line (`PARCEL_WAIT_NOTE_MAX`), held by a `CHECK`. What the note may not hold (a phone number) is the application's rule and the audit's pattern (Part 1, item 5), not the table's.
 */
export const intakeParcelWait = pgTable(
  'intake_parcel_wait',
  {
    id: uuid('id').primaryKey().notNull(),
    intakeParcelId: uuid('intake_parcel_id').notNull(),
    pickupIntakeId: uuid('pickup_intake_id').notNull(),
    /** The parcel's hub, given by the guard. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    note: text('note'),
    markedBy: uuid('marked_by').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedBy: uuid('cleared_by'),
    clearedReason: text('cleared_reason'),
  },
  (table) => [
    foreignKey({
      name: 'intake_parcel_wait_parcel_fkey',
      columns: [table.intakeParcelId, table.pickupIntakeId],
      foreignColumns: [intakeParcel.id, intakeParcel.pickupIntakeId],
    }).onDelete('restrict'),
    // One live mark for a parcel.
    uniqueIndex('intake_parcel_wait_live_key')
      .on(table.intakeParcelId)
      .where(sql`${table.clearedAt} IS NULL`),
    // The count and the view of a vendor's progress ask for the live marks of an intake.
    index('intake_parcel_wait_intake_idx')
      .on(table.pickupIntakeId)
      .where(sql`${table.clearedAt} IS NULL`),
    // The history of a parcel.
    index('intake_parcel_wait_parcel_idx').on(table.intakeParcelId, table.markedAt),
    check(
      'intake_parcel_wait_note_short_line',
      sql.raw(
        `"intake_parcel_wait"."note" IS NULL OR (btrim("intake_parcel_wait"."note") <> '' AND char_length("intake_parcel_wait"."note") <= ${String(PARCEL_WAIT_NOTE_MAX)} AND "intake_parcel_wait"."note" !~ '[[:cntrl:]]')`,
      ),
    ),
    // A live mark has no clearing; a cleared one has all three, and the reason is one of the two.
    check(
      'intake_parcel_wait_cleared_together',
      sql.raw(
        `("intake_parcel_wait"."cleared_at" IS NULL AND "intake_parcel_wait"."cleared_by" IS NULL AND "intake_parcel_wait"."cleared_reason" IS NULL) OR ("intake_parcel_wait"."cleared_at" IS NOT NULL AND "intake_parcel_wait"."cleared_by" IS NOT NULL AND "intake_parcel_wait"."cleared_reason" IN ('UNMARKED', 'ORDER_MADE'))`,
      ),
    ),
  ],
);

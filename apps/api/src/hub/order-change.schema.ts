import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { intakeParcel } from './intake-parcel.schema.js';
import { orderRecord } from './order.schema.js';

/**
 * The record of an edit of an order that is not yet confirmed (Stage 7; the external review of 19 November 2026, finding B; itemization.md section 5.1). **An order is prepared before it is confirmed**: while its
 * price is not frozen, an authorized officer may correct what was transcribed (the recipient, the size, the declaration, the date, the destination, the payer arrangement of the order, the evidence), each
 * correction made on the version the officer read, recalculated by the server and recorded here with what it was and what it became. Once the price is frozen the order is confirmed and changes only by the
 * controlled workflows that exist for it (a payer correction, a reversal).
 *
 * - **Written only by `melarc.amend_order`** (migration `0115`), under the key that itemizes; the runtime login holds `SELECT` alone. **The guard of the order accepts a change of what the officer transcribed only
 *   when a row of this table, made in the same transaction for that order and for the version that was read, stands beside it**, so no other writer can edit an order without leaving this trace.
 * - `before` and `after` hold the members that changed, each as it was and as it became (the price included), so that the history is complete without the browser rebuilding it.
 */
export const orderAmendment = pgTable(
  'order_amendment',
  {
    id: uuid('id').primaryKey().notNull(),
    orderId: uuid('order_id').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    amendedBy: uuid('amended_by').notNull(),
    amendedAt: timestamp('amended_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The version of the order the officer read and amended. */
    orderVersion: integer('order_version').notNull(),
    note: text('note').notNull(),
    before: jsonb('before').notNull(),
    after: jsonb('after').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orderRecord.id],
      name: 'order_amendment_order_fkey',
    }),
    index('order_amendment_order_idx').on(table.orderId, table.amendedAt),
    check('order_amendment_note_present', sql`btrim(${table.note}) <> ''`),
  ],
);

/**
 * The record of the reversal of a confirmed order (Stage 7; the external review of 19 November 2026, finding E; itemization.md section 5.1): **a mistake in an arrival is corrected, never erased**. A senior
 * officer, with a reason in words, takes back the arrival of a parcel whose order is frozen and not yet paid for, reserved or dispatched; the order, its locked price, its portions and its audit trail are kept
 * and the order moves to `REVERSED`, the parcel moves to `MISSING` (a door parcel) or `VOID` (an extra), the intake's count is recomputed, and the intake goes back to reconciliation, where a missing parcel is
 * searched for as any is.
 *
 * - **One reversal for an order** (a unique key on the order). Written only by `melarc.reverse_order_arrival` (migration `0115`), under the key of the adjudication; the runtime login holds `SELECT` alone. **The
 *   guards of the order, of the parcel and of the intake accept the moves a reversal makes only when its row, made in the same transaction, stands beside them.**
 * - It keeps what the order and the parcel were (`previous_commercial_state`, `previous_parcel_state`), who and when, and why.
 */
export const orderReversal = pgTable(
  'order_reversal',
  {
    id: uuid('id').primaryKey().notNull(),
    orderId: uuid('order_id').notNull(),
    intakeParcelId: uuid('intake_parcel_id').notNull(),
    pickupIntakeId: uuid('pickup_intake_id').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    reversedBy: uuid('reversed_by').notNull(),
    reversedAt: timestamp('reversed_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    orderVersion: integer('order_version').notNull(),
    previousCommercialState: text('previous_commercial_state').notNull(),
    previousParcelState: text('previous_parcel_state').notNull(),
    resultingParcelState: text('resulting_parcel_state').notNull(),
    note: text('note').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orderRecord.id],
      name: 'order_reversal_order_fkey',
    }),
    foreignKey({
      columns: [table.intakeParcelId],
      foreignColumns: [intakeParcel.id],
      name: 'order_reversal_parcel_fkey',
    }),
    uniqueIndex('order_reversal_order_key').on(table.orderId),
    index('order_reversal_intake_idx').on(table.pickupIntakeId, table.reversedAt),
    check('order_reversal_note_present', sql`btrim(${table.note}) <> ''`),
    check(
      'order_reversal_parcel_states',
      sql`${table.previousParcelState} = 'ARRIVED' AND ${table.resultingParcelState} IN ('MISSING', 'VOID')`,
    ),
  ],
);

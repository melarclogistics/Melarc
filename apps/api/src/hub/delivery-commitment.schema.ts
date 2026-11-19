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
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { orderRecord } from './order.schema.js';

export const COMMITMENT_REQUESTERS = ['SENDER', 'RECIPIENT', 'MELARC', 'SYSTEM'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * What Melarc promised for an order (S1.36, `SLICE-001`; domain-model.md `DeliveryCommitment`; `MSC-DEC-305` to `-308`; `itemizeOrder` of the contract): **one row for each state of the promise,
 * appended and never edited** except to set `superseded_at`, so that a missed promise stays provable. The current commitment is the row with no `superseded_at`.
 *
 * - **The first row is written with the order, at `sequence` 1, in the same change** (`melarc.itemize_order`, migration `0110`): an order without its initial commitment is not a state that can be left
 *   behind, and the database holds it for every writer by a deferred foreign key from the order to this row (a retry under the same key cannot mint a second one: `(order_id, sequence)` is unique).
 * - **`sla_start_at` is pickup custody and nothing later** (the moment the stop's handshake confirmed the collection): the order is made hours after the custody that started its promise, and neither
 *   the hub's arrival nor the time of itemization moves it.
 * - **`default_date` is the calculated service date, kept unchanged on every revision**; `requested_date` what the sender or recipient asked for; `committed_date` what Melarc promised. A window is the hub's
 *   at the moment of the commitment, or none where the hub has not set one.
 * - **The hub is the order's**, given by the guard and never the writer's, so that a policy needs no join.
 *
 * Not here, because the task that decides them has not been built: revising a commitment (`reviseDeliveryCommitment`, `change_reason_code`, `requested_by_party` and `approved_by_staff_id` from `sequence` 2).
 * They are columns of the model and are in the table, null on the first row.
 *
 * This file is the *shape*. The migration adds by hand: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the grant (`SELECT` alone), and the guard that holds the rows append-only.
 */
export const deliveryCommitment = pgTable(
  'delivery_commitment',
  {
    id: uuid('id').primaryKey(),
    orderId: uuid('order_id').notNull(),
    /** The order's hub, given by the guard. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    sequence: integer('sequence').notNull(),
    defaultDate: date('default_date', { mode: 'string' }).notNull(),
    requestedDate: date('requested_date', { mode: 'string' }),
    committedDate: date('committed_date', { mode: 'string' }).notNull(),
    committedWindowStart: time('committed_window_start'),
    committedWindowEnd: time('committed_window_end'),
    changeReasonCode: text('change_reason_code'),
    requestedByParty: text('requested_by_party'),
    approvedByStaffId: uuid('approved_by_staff_id'),
    /** Pickup custody, never the hub's arrival. */
    slaStartAt: timestamp('sla_start_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'delivery_commitment_order_fkey',
      columns: [table.orderId, table.responsibleHubId],
      foreignColumns: [orderRecord.id, orderRecord.responsibleHubId],
    }).onDelete('restrict'),
    // One row for each state of the promise, and the key the order's own deferred foreign key names (its initial commitment is the row of sequence 1).
    uniqueIndex('delivery_commitment_order_sequence_key').on(table.orderId, table.sequence),
    uniqueIndex('delivery_commitment_order_id_sequence_key').on(
      table.orderId,
      table.id,
      table.sequence,
    ),
    // At most one current commitment for an order.
    uniqueIndex('delivery_commitment_current_key')
      .on(table.orderId)
      .where(sql`${table.supersededAt} IS NULL`),
    index('delivery_commitment_hub_idx').on(table.responsibleHubId, table.committedDate),
    check('delivery_commitment_sequence_positive', sql`${table.sequence} >= 1`),
    check(
      'delivery_commitment_requester_closed',
      sql.raw(
        `"delivery_commitment"."requested_by_party" IS NULL OR "delivery_commitment"."requested_by_party" IN (${quoted(COMMITMENT_REQUESTERS)})`,
      ),
    ),
    // A change has its reason from the second state on, and the first has none; the window is both ends or neither.
    check(
      'delivery_commitment_change_facts',
      sql`(${table.sequence} = 1 AND ${table.changeReasonCode} IS NULL) OR (${table.sequence} > 1 AND ${table.changeReasonCode} IS NOT NULL)`,
    ),
    check(
      'delivery_commitment_window_facts',
      sql`(${table.committedWindowStart} IS NULL) = (${table.committedWindowEnd} IS NULL) AND (${table.committedWindowStart} IS NULL OR ${table.committedWindowStart} < ${table.committedWindowEnd})`,
    ),
  ],
);

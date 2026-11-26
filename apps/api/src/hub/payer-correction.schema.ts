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

import { orderRecord } from './order.schema.js';

export const PAYER_CORRECTION_STATES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The maker-checker record of a payer correction after the price froze (S1.39, `SLICE-001`; itemization.md section 5.1 step 6 and `AC-SLICE-001-55`; state-machines.md section 8, *payer correction: re-runs the
 * gate*). **A locked price is never rewritten**: the correction changes how the locked price is shared between the sender and the recipient, and nothing else, and the commercial gate runs again from the new
 * portions.
 *
 * - **One request is open for an order at a time** (a partial unique index): a second is `STATE_CONFLICT`.
 * - **Complete before and after history.** `previous_allocation` is the order's allocation as the request found it (the intent and the portions of the locked price), `proposed` is the intent the maker asked for
 *   (never a portion of a price: the database resolves it), and, once decided, `resulting_allocation` and `resulting_commercial_state` are what the approval wrote to the order. A decided row is never changed.
 * - **The approver is not the requester**, unless the approver is a Platform Admin (permissions.md section 6): held by the guard for every writer (migration `0113`).
 * - Written only by `melarc.request_payer_correction` and `melarc.decide_payer_correction`, whose guard holds the rules above; the runtime login holds `SELECT` alone.
 */
export const payerCorrection = pgTable(
  'payer_correction',
  {
    id: uuid('id').primaryKey().notNull(),
    orderId: uuid('order_id').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    state: text('state').notNull().default('REQUESTED'),
    requestedBy: uuid('requested_by').notNull(),
    decidedBy: uuid('decided_by'),
    previousAllocation: jsonb('previous_allocation').notNull(),
    proposed: jsonb('proposed').notNull(),
    resultingAllocation: jsonb('resulting_allocation'),
    resultingCommercialState: text('resulting_commercial_state'),
    note: text('note').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [orderRecord.id],
      name: 'payer_correction_order_fkey',
    }),
    // One open request for an order.
    uniqueIndex('payer_correction_open_key')
      .on(table.orderId)
      .where(sql`${table.state} = 'REQUESTED'`),
    index('payer_correction_order_idx').on(table.orderId, table.createdAt),
    check(
      'payer_correction_state_closed',
      sql.raw(`"payer_correction"."state" IN (${quoted(PAYER_CORRECTION_STATES)})`),
    ),
    // A request has no decision; a decision has its decider, its moment and what it wrote, and a rejection writes nothing.
    check(
      'payer_correction_decision_facts',
      sql`(${table.state} = 'REQUESTED' AND ${table.decidedBy} IS NULL AND ${table.decidedAt} IS NULL AND ${table.resultingAllocation} IS NULL AND ${table.resultingCommercialState} IS NULL)
       OR (${table.state} = 'APPROVED' AND ${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingAllocation} IS NOT NULL AND ${table.resultingCommercialState} IS NOT NULL)
       OR (${table.state} = 'REJECTED' AND ${table.decidedBy} IS NOT NULL AND ${table.decidedAt} IS NOT NULL AND ${table.resultingAllocation} IS NULL AND ${table.resultingCommercialState} IS NULL)`,
    ),
  ],
);

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { hub } from '../platform/database/schema/reference-data.js';
import { INTAKE_CONDITIONS, pickupIntake } from './pickup-intake.schema.js';

/** What a finding is: the receiver's recording of a condition, or Senior Ops's adjudication of a discrepancy (S1.34). */
export const FINDING_KINDS = ['CONDITION', 'ADJUDICATION'] as const;
/** The outcomes of an adjudication (the contract's `DiscrepancyAdjudication.outcome`). `ESCALATED` records the act and leaves the case open. */
export const ADJUDICATION_OUTCOMES = [
  'ACCEPTED',
  'ESCALATED',
  'WRITTEN_OFF',
  'VENDOR_NOTIFIED',
] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * What was found at an intake after its blind count (S1.34, `SLICE-001`; domain-model.md section 6.6, `condition_findings`; hub-intake.md sections 5.1 and 5.2; state-machines.md section 7): one row
 * for each recording of a condition by the receiver and for each adjudication of a discrepancy by Senior Ops, **appended and never changed or removed, for every writer**. The intake's own `condition`
 * says where the case stands; these rows say how it got there, and **nothing here rewrites the counts**: the declared count, the hub count and the variance survive every finding unchanged
 * (a finding explains a discrepancy, it does not erase one, openapi.yaml `adjudicateDiscrepancy`).
 *
 * - **The evidence is the intake's own and is stored**: each identifier names a `STORED` evidence record about this very intake (the guard of the table holds it for every writer, so "attached evidence"
 *   is never satisfiable by a record with no bytes behind it), of the purpose the finding's act has (`CONDITION` for the receiver's, either for an adjudication, which may cite the receiver's photos).
 *   `DAMAGED` and `TAMPERED` carry at least one (§22.5).
 * - **The hub, the author and the moment are the guard's**: the hub is the intake's, the moment the database's; a writer names the intake, the kind and what was found.
 * - **Written by two operations of the database** (`melarc.record_intake_condition`, `melarc.adjudicate_discrepancy`, migration 0096), which also move the intake; the application's login holds `SELECT` and
 *   no write.
 *
 * This file is the *shape*. The migration adds by hand, in the same change: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the grants, the guard, the two operations, and the guard
 * of the intake restated with the one edge a condition needs.
 */
export const pickupIntakeFinding = pgTable(
  'pickup_intake_finding',
  {
    id: uuid('id').primaryKey(),
    pickupIntakeId: uuid('pickup_intake_id').notNull(),
    /** The intake's hub, given by the guard. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    kind: text('kind').notNull(),
    /** The condition recorded (a `CONDITION` finding) or the one an adjudication sets; null where an adjudication leaves it as it is. */
    condition: text('condition'),
    /** The outcome of an `ADJUDICATION`; null for a `CONDITION`. */
    outcome: text('outcome'),
    note: text('note'),
    evidenceIds: uuid('evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** The staff member who made the finding: not a foreign key, since the table that holds them is another domain's. */
    recordedBy: uuid('recorded_by').notNull(),
    /** The database's moment. */
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_intake_finding_intake_fkey',
      columns: [table.pickupIntakeId],
      foreignColumns: [pickupIntake.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_intake_finding_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    index('pickup_intake_finding_intake_idx').on(table.pickupIntakeId, table.recordedAt),
    check(
      'pickup_intake_finding_kind_closed',
      sql.raw(`"pickup_intake_finding"."kind" IN (${quoted(FINDING_KINDS)})`),
    ),
    check(
      'pickup_intake_finding_condition_closed',
      sql.raw(
        `"pickup_intake_finding"."condition" IS NULL OR "pickup_intake_finding"."condition" IN (${quoted(INTAKE_CONDITIONS)})`,
      ),
    ),
    check(
      'pickup_intake_finding_outcome_closed',
      sql.raw(
        `"pickup_intake_finding"."outcome" IS NULL OR "pickup_intake_finding"."outcome" IN (${quoted(ADJUDICATION_OUTCOMES)})`,
      ),
    ),
    // A recording of a condition names the condition and has no outcome; an adjudication has an outcome and says why, in words (there is no reason catalogue for it, D-05).
    check(
      'pickup_intake_finding_kind_facts',
      sql`(${table.kind} = 'CONDITION' AND ${table.condition} IS NOT NULL AND ${table.outcome} IS NULL) OR (${table.kind} = 'ADJUDICATION' AND ${table.outcome} IS NOT NULL AND ${table.note} IS NOT NULL AND btrim(${table.note}) <> '')`,
    ),
    // `DAMAGED` and `TAMPERED` carry supporting evidence (§22.5).
    check(
      'pickup_intake_finding_evidence_required',
      sql`${table.condition} IS NULL OR ${table.condition} NOT IN ('DAMAGED', 'TAMPERED') OR cardinality(${table.evidenceIds}) >= 1`,
    ),
  ],
);

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

import { hub } from '../platform/database/schema/reference-data.js';
import { intakeParcel } from './intake-parcel.schema.js';
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
 * - **In photo mode a condition is a finding of one parcel** (Run D, migration 0105: `intake_parcel_id`): recorded once for each parcel after the parcel has arrived, whether or not its vendor is
 *   finished; an intake that is counted blind keeps the one condition for the intake (`intake_parcel_id` null), and an adjudication is never about a parcel. The two unique indexes below hold both
 *   rules for every writer.
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
    /**
     * The parcel a `CONDITION` finding is about (photo mode, Run D); null for a finding of the whole intake (the one condition of a blind-count intake) and for every adjudication. The composite
     * foreign key below keeps the parcel inside the intake the finding names.
     */
    intakeParcelId: uuid('intake_parcel_id'),
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
    // A finding names a parcel of the intake it names and no other: the parcel's own key carries the intake (Run D, migration 0105). Not enforced where the parcel is null (a blind-count intake's condition, an adjudication).
    foreignKey({
      name: 'pickup_intake_finding_parcel_fkey',
      columns: [table.intakeParcelId, table.pickupIntakeId],
      foreignColumns: [intakeParcel.id, intakeParcel.pickupIntakeId],
    }).onDelete('restrict'),
    index('pickup_intake_finding_intake_idx').on(table.pickupIntakeId, table.recordedAt),
    // A condition is recorded once, whatever it said and whatever Senior Ops adjudicates afterwards (audit of 15 November 2026, point 1; Run D, D-D7): once for an intake that has no parcels (a blind-count intake,
    // migration 0097's rule) and once for each parcel of a photo intake. The history is what says so, and the database holds it for every writer. The adjudications are not recordings of a condition and are as many
    // as there are.
    uniqueIndex('pickup_intake_finding_one_intake_condition_idx')
      .on(table.pickupIntakeId)
      .where(sql`${table.kind} = 'CONDITION' AND ${table.intakeParcelId} IS NULL`),
    uniqueIndex('pickup_intake_finding_one_parcel_condition_idx')
      .on(table.intakeParcelId)
      .where(sql`${table.kind} = 'CONDITION' AND ${table.intakeParcelId} IS NOT NULL`),
    // "Vendor told" is a record made once for an intake, after a write-off (Run D, D-D4): the operation judges it under the intake's lock and the guard of the table for every writer; this index is what holds it
    // against two writers at once.
    uniqueIndex('pickup_intake_finding_one_vendor_told_idx')
      .on(table.pickupIntakeId)
      .where(sql`${table.kind} = 'ADJUDICATION' AND ${table.outcome} = 'VENDOR_NOTIFIED'`),
    // Only a recording of a condition is about a parcel.
    check(
      'pickup_intake_finding_parcel_condition_only',
      sql`${table.intakeParcelId} IS NULL OR ${table.kind} = 'CONDITION'`,
    ),
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

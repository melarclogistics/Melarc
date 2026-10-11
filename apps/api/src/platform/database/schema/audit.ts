import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { AUDIT_OUTCOMES } from '../../auth/ports/audit-writer.port.js';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_OBJECT_TYPES,
  AUDIT_SURFACES,
} from '../../audit/audit-vocabulary.js';

/**
 * The audit ledger (S0.11; audit.md §3; data-scope-registry.md §4.5, `AuditEvent`). One row per event, written by the audit writer
 * in the transaction of the act it records, and **never changed or removed**: the table is append-only. No login holds `UPDATE`,
 * `DELETE` or `TRUNCATE` on it, and a trigger refuses all three whoever asks, the owner and the administrator included (the grants
 * are the control against the application, the trigger the control against a mistake in a grant; neither is tamper evidence, which
 * is the signed checkpoint chain of release gate G1, audit.md §2.1).
 *
 * This file is the *shape*. The migration (`0006_audit_event.sql`) adds by hand, in the same change: the owner (`melarc_owner`),
 * `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a staff context inserts an event of its own and reads the events of its
 * hubs; a `SYSTEM` context inserts under the `authentication` capability alone; a vendor and a rider read and write nothing; the
 * closed `ELSE`), the grants (`SELECT` and `INSERT` to the API runtime and nothing else) and the append-only trigger.
 *
 * The columns are the fields of audit.md §3, with three additions the contract implies and does not name: `detail`, the home of the
 * non-secret facts the catalogue says an event "records" (the cause of a refusal, the factor, the kind of channel), which no field
 * of §3 holds; `reason_label`, the label snapshot §3 requires beside `reason_code`; and `serialisation_version`, the version of the
 * canonical form a checkpoint will hash (§2.1).
 */
export const auditEvent = pgTable(
  'audit_event',
  {
    /** The stable event id: a UUIDv7 made by the writer. */
    id: uuid('id').primaryKey().notNull(),
    eventCode: text('event_code').notNull(),
    /** When the business act happened. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * When the database inserted the row: its own `clock_timestamp()`, never the writer's and not the transaction's start (Product
     * decision, 11 October 2026; migration `0015`). Rows written before that migration carry the transaction's start, their default
     * then, and are unchanged. Distinct from `occurred_at` (rider events sync hours later), and not a commit-order cursor.
     */
    recordedAt: timestamp('recorded_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    actorType: text('actor_type').notNull(),
    /** Null for `SYSTEM`, and only for `SYSTEM`. */
    actorId: uuid('actor_id'),
    /** The bundle the actor held at the time, snapshotted (bundles are editable). */
    actorBundle: text('actor_bundle'),
    surfaceContext: text('surface_context').notNull(),
    deviceContext: jsonb('device_context'),
    vendorOrganizationId: uuid('vendor_organization_id'),
    /** The hub context of the event: audit.md §3 and §39.7. */
    responsibleHubId: uuid('responsible_hub_id'),
    objectType: text('object_type').notNull(),
    /** Null only where there is no object to name (a refusal against an identifier that matches no principal). */
    objectId: uuid('object_id'),
    correlationId: text('correlation_id').notNull(),
    previousState: text('previous_state'),
    resultingState: text('resulting_state'),
    reasonCode: text('reason_code'),
    /** The label as the actor saw it, snapshotted: a timeline never joins to the live reason catalogue. */
    reasonLabel: text('reason_label'),
    note: text('note'),
    approvalId: uuid('approval_id'),
    beforeAfter: jsonb('before_after'),
    relatedIds: jsonb('related_ids'),
    detail: jsonb('detail')
      .default(sql`'{}'::jsonb`)
      .notNull(),
    outcome: text('outcome').notNull(),
    enhanced: boolean('enhanced').notNull(),
    /** The version of the canonical serialisation this event is read under (`canonical-audit-event.ts`). */
    serialisationVersion: smallint('serialisation_version').notNull(),
  },
  (table) => [
    // The scan a checkpoint makes for the events it has not yet claimed (audit.md §2.1), and the timeline of one object.
    index('audit_event_recorded_idx').on(table.recordedAt, table.id),
    index('audit_event_object_idx').on(table.objectType, table.objectId, table.occurredAt),
    check(
      'audit_event_code_grammar',
      sql`${table.eventCode} ~ '^[a-z]+\\.[a-z0-9_]+\\.[a-z0-9_]+$'`,
    ),
    check(
      'audit_event_actor_type_closed',
      sql`${table.actorType} IN (${sql.raw(AUDIT_ACTOR_TYPES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'audit_event_surface_closed',
      sql`${table.surfaceContext} IN (${sql.raw(AUDIT_SURFACES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'audit_event_object_type_closed',
      sql`${table.objectType} IN (${sql.raw(AUDIT_OBJECT_TYPES.map((value) => `'${value}'`).join(', '))})`,
    ),
    check(
      'audit_event_outcome_closed',
      sql`${table.outcome} IN (${sql.raw(AUDIT_OUTCOMES.map((value) => `'${value}'`).join(', '))})`,
    ),
    // The system is the null actor, and a null actor is the system (audit.md §3).
    check(
      'audit_event_system_has_no_actor_id',
      sql`(${table.actorType} = 'SYSTEM') = (${table.actorId} IS NULL)`,
    ),
    // The reason is a pair: a code with no label snapshot would send a timeline to the live catalogue.
    check(
      'audit_event_reason_is_a_pair',
      sql`(${table.reasonCode} IS NULL) = (${table.reasonLabel} IS NULL)`,
    ),
    check('audit_event_correlation_bounded', sql`length(${table.correlationId}) BETWEEN 1 AND 128`),
    check(
      'audit_event_structured_are_objects',
      sql`(${table.deviceContext} IS NULL OR jsonb_typeof(${table.deviceContext}) = 'object')
        AND (${table.beforeAfter} IS NULL OR jsonb_typeof(${table.beforeAfter}) = 'object')
        AND (${table.relatedIds} IS NULL OR jsonb_typeof(${table.relatedIds}) = 'object')
        AND jsonb_typeof(${table.detail}) = 'object'`,
    ),
    check('audit_event_serialisation_version_positive', sql`${table.serialisationVersion} >= 1`),
  ],
);

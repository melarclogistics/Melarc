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

import { pickupManifest } from '../pickup/pickup-manifest.schema.js';
import { pickupRequest } from '../pickup/pickup-request.schema.js';
import { hub } from '../platform/database/schema/reference-data.js';
import { riderIdentity } from '../staff/rider-identity.schema.js';

/** The states of an intake as the contract names them (`HubIntakeBase.state`, domain-model.md section 6.6). Only the first is made by the hub handover. */
export const PICKUP_INTAKE_STATES = [
  'AWAITING_COUNT',
  'COUNTED',
  'RECONCILIATION_REQUIRED',
  'READY_FOR_ITEMIZATION',
  'ITEMIZING',
  'CLOSED',
] as const;
export const COUNT_VARIANCES = ['MATCH', 'SHORT', 'OVER'] as const;
export const INTAKE_CONDITIONS = ['OK', 'DAMAGED', 'TAMPERED', 'OTHER'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The pickup intake (S1.31, `SLICE-001`; domain-model.md section 6.6; state-machines.md section 7; hub-intake.md; data-scope-registry.md `PickupIntake`; `MSC-DEC-416`): what the hub
 * handover opens for **each collected pickup request of a run**, to be received and counted blind at the hub (S1.32, S1.33). The handover is not an entity of its own: it is recorded on
 * the intakes, which say the run, the custody holder who handed over, the server's receipt and the device's moment.
 *
 * - **The declaration is withheld by the grants, not by a policy** (the blind-count invariant is a data-exposure rule, domain-model.md section 6.6). `rider_declared_count` and
 *   `prefilled_count` are written by the handover and read by **no column grant** of the application's login: no read model, join, whole-row reference or `select *` can carry them, whoever
 *   asks and whatever the policy admits. The count the receiver commits (S1.33) is compared with the declaration inside the database, by an operation of its own, and the declaration is
 *   first served in the answer to the committed count. `prefilled_count` is **what the rider's form was pre-filled with** (the collection record's count, which the server reads at the
 *   handover): it is kept so that **a correction is a fact** (`rider_declared_count` differs from it) and it is withheld exactly as the declaration is, because it says as much.
 *   **Neither is ever seeded from the other, and the declaration is never derived from the collected count** (`MSC-DEC-194` part 3): it is the row's number, stored as given, and zero is legal.
 * - **One intake for each collected request of a run**, once (a unique key of the run and the request); the set of a run's intakes is exactly its collected requests, held at the end of
 *   the transaction for every writer (migration `0092`).
 * - **`handed_over_at` is the database's receipt** (the moment the handover completed the run) and **`declaration_captured_at` is the device's** (client-supplied, as `Evidence.captured_at`
 *   is, because the handover is Version 1's one offline command): never the same field, whatever the device's clock says (F-35).
 * - **`version` is the record's `ETag` source**, moved by the database on every change and by nothing else.
 *
 * Not here, because the task that decides them has not been built: the dispute dimension (`dispute_state`), the findings behind a condition, the closing moment and the parity exception
 * (S1.34 and the itemization tasks).
 *
 * This file is the *shape*. The migration adds by hand, in the same change: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the column grants, the guard that holds the
 * handover's facts and the state machine, the version trigger, and the deferred check of the set.
 */
export const pickupIntake = pgTable(
  'pickup_intake',
  {
    id: uuid('id').primaryKey(),
    /** The operational code of the intake (`HUB-IN-XXXXXX`, domain-model.md section 2): for people who say it aloud, and never an identifier. */
    code: text('code').notNull(),
    /** The hub, carried from the run by a composite key so that an intake can never name another hub than its run's. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    pickupRequestId: uuid('pickup_request_id').notNull(),
    pickupManifestId: uuid('pickup_manifest_id').notNull(),
    /** The custody holder who submitted the handover: the assigned rider, or whoever accepted a `RunCustodyHandover`. */
    handedOverBy: uuid('handed_over_by').notNull(),
    /** The database's receipt of the handover: the moment the run was completed by it. The guard gives it; a writer's value is not kept. */
    handedOverAt: timestamp('handed_over_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    declarationCapturedAt: timestamp('declaration_captured_at', { withTimezone: true }).notNull(),
    state: text('state').notNull().default('AWAITING_COUNT'),
    riderDeclaredCount: integer('rider_declared_count').notNull(),
    prefilledCount: integer('prefilled_count').notNull(),
    physicalCount: integer('physical_count'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    /** The receiver, a staff member: not a foreign key, since the table that holds them is another domain's. */
    countedBy: uuid('counted_by'),
    countVariance: text('count_variance'),
    countDifference: integer('count_difference'),
    /** `OK` until a condition is recorded (S1.34): the column is never null (domain-model.md section 6.6). */
    condition: text('condition').notNull().default('OK'),
    activeReceiverId: uuid('active_receiver_id'),
    lockAcquiredAt: timestamp('lock_acquired_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_intake_manifest_fkey',
      columns: [table.pickupManifestId, table.responsibleHubId],
      foreignColumns: [pickupManifest.id, pickupManifest.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_intake_request_fkey',
      columns: [table.pickupRequestId],
      foreignColumns: [pickupRequest.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_intake_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_intake_handed_over_by_fkey',
      columns: [table.handedOverBy],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    uniqueIndex('pickup_intake_code_key').on(table.code),
    // One intake for each collected request of a run: a second one for the same request, a double click or a replay that was not caught, finds this index.
    uniqueIndex('pickup_intake_one_per_request').on(table.pickupManifestId, table.pickupRequestId),
    index('pickup_intake_hub_idx').on(table.responsibleHubId, table.state, table.handedOverAt),
    index('pickup_intake_request_idx').on(table.pickupRequestId),
    check(
      'pickup_intake_state_closed',
      sql.raw(`"pickup_intake"."state" IN (${quoted(PICKUP_INTAKE_STATES)})`),
    ),
    check(
      'pickup_intake_variance_closed',
      sql.raw(
        `"pickup_intake"."count_variance" IS NULL OR "pickup_intake"."count_variance" IN (${quoted(COUNT_VARIANCES)})`,
      ),
    ),
    check(
      'pickup_intake_condition_closed',
      sql.raw(`"pickup_intake"."condition" IN (${quoted(INTAKE_CONDITIONS)})`),
    ),
    check(
      'pickup_intake_counts_nonnegative',
      sql`${table.riderDeclaredCount} >= 0 AND ${table.prefilledCount} >= 0 AND (${table.physicalCount} IS NULL OR ${table.physicalCount} >= 0)`,
    ),
    // A count, its moment, its receiver, its variance and its difference exist together, and exactly when the intake has been counted: an intake that is waiting for its count has none.
    check(
      'pickup_intake_count_facts',
      sql`(${table.state} = 'AWAITING_COUNT') = (${table.physicalCount} IS NULL) AND (${table.physicalCount} IS NULL) = (${table.countedAt} IS NULL) AND (${table.physicalCount} IS NULL) = (${table.countedBy} IS NULL) AND (${table.physicalCount} IS NULL) = (${table.countVariance} IS NULL) AND (${table.physicalCount} IS NULL) = (${table.countDifference} IS NULL)`,
    ),
    // The advisory lock names its receiver and its moment together (S1.32).
    check(
      'pickup_intake_lock_facts',
      sql`(${table.activeReceiverId} IS NULL) = (${table.lockAcquiredAt} IS NULL)`,
    ),
  ],
);

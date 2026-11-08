import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { hub } from '../platform/database/schema/reference-data.js';
import { pickupManifest } from './pickup-manifest.schema.js';
import { pickupRequest } from './pickup-request.schema.js';
import {
  PICKUP_FAILURE_CATEGORIES,
  PICKUP_STOP_SUMMARY_KEYS,
  PICKUP_SUMMARY_LOCATION_KEYS,
} from './pickup-vocabulary.js';

export const PICKUP_STOP_STATES = [
  'PENDING',
  'ARRIVED',
  'COLLECTED',
  'PARTIALLY_COLLECTED',
  'FAILED',
  'SKIPPED',
] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * What the table holds of a stop's summary (the contract's `PickupStopSummary`): exactly the six members and no other, each of the type the
 * contract gives it, and a place of the contract's `Location` members only. A summary is a closed projection, so a payer, a price, a
 * destination or a recipient cannot be written into it by any writer.
 */
const SUMMARY = `"pickup_stop"."pickup_summary"`;
/**
 * The JSON type of a member, or '' where it is not there: a check passes on NULL, so a missing member must be an answer of its own and not a
 * NULL that lets the summary through.
 */
const typeOf = (path: string): string => `coalesce(jsonb_typeof(${SUMMARY} ${path}), '')`;
const PLACE = `(${SUMMARY} -> 'resolved_pickup_location')`;
const summaryShape = (): string =>
  [
    `jsonb_typeof(${SUMMARY}) = 'object'`,
    `jsonb_exists_all(${SUMMARY}, ARRAY[${quoted(PICKUP_STOP_SUMMARY_KEYS)}])`,
    `(${SUMMARY} - ARRAY[${quoted(PICKUP_STOP_SUMMARY_KEYS)}]) = '{}'::jsonb`,
    `${typeOf(`-> 'reference'`)} = 'string'`,
    `${typeOf(`-> 'sender_display_name'`)} = 'string'`,
    `${typeOf(`-> 'declared_package_count'`)} = 'number'`,
    // The place is an object with an address, of the five members of the contract's Location and no other.
    `CASE WHEN ${typeOf(`-> 'resolved_pickup_location'`)} = 'object' THEN coalesce(jsonb_typeof(${PLACE} -> 'address'), '') = 'string' AND (${PLACE} - ARRAY[${quoted(PICKUP_SUMMARY_LOCATION_KEYS)}]) = '{}'::jsonb ELSE false END`,
    `${typeOf(`-> 'location_note'`)} IN ('string', 'null')`,
    `${typeOf(`-> 'contact_phone'`)} IN ('string', 'null')`,
  ].join(' AND ');

/**
 * The pickup stop, one request on one manifest (S1.20, `SLICE-001`; domain-model.md section 6.4; state-machines.md section 5;
 * data-scope-registry.md `PickupStop`; features/pickup/pickup-manifest.md).
 *
 * - **A stop is the claim on its request.** A confirmed request is on the manifest pool until a stop names it, and a stop keeps it
 *   claimed until the claim is **explicitly released**: `released_at` is the one release, set by an authorized act (the cancellation of
 *   the stop's manifest, S1.21, or a recovery transition that no document specifies yet) and never cleared. A skip, a failure and a
 *   collection do not release it. The partial unique index holds this for every writer: one unreleased stop per request, which is what
 *   serialises two Ops users who claim the same request at once (the second waits for the first, and is refused if it committed).
 *   Nothing here assumes that a skipped stop frees its request (the Product Owner, 1 November 2026).
 * - **`sequence` is manual and advisory** (section 7.6: no route optimisation). It is unique within a manifest, and the constraint is
 *   deferrable, so that the complete reordering of S1.21 is one statement that may pass through a state in which two stops share a
 *   number. The migration adds that constraint by hand (a unique index cannot be deferred).
 * - **The hub is copied from the manifest and held to it**: the composite foreign key names the manifest and its hub together, so a stop
 *   cannot belong to another hub than its manifest. A staff context reads the stops of the hubs of the operation's grant by this column.
 * - **A rider reads a stop through its manifest, never through the hub**, and a vendor reads none in this slice (the registry's vendor
 *   read of its own stop is a deferred capability, OB-S1-23). The policies follow the manifest's, in the migration.
 * - **Only what S1.20 writes is set at creation**; the failure and skip snapshots, the arrival and the resolution are the later tasks'
 *   (S1.22, S1.23, S1.26), and their constraints say when they may be set.
 * - **`version` is the record's ETag source**, moved by the database on every change.
 *
 * This file is the *shape*. The migration (`0058_pickup_manifests.sql`) adds by hand: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`,
 * the policies, the grants, the deferrable sequence constraint, the guard (identity, the state machine, the one-way release) and the
 * version trigger.
 */
export const pickupStop = pgTable(
  'pickup_stop',
  {
    id: uuid('id').primaryKey(),
    pickupManifestId: uuid('pickup_manifest_id').notNull(),
    pickupRequestId: uuid('pickup_request_id').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    sequence: integer('sequence').notNull(),
    state: text('state').notNull().default('PENDING'),
    arrivedAt: timestamp('arrived_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    failureCategory: text('failure_category'),
    failureReasonSnapshot: jsonb('failure_reason_snapshot'),
    skipSnapshot: jsonb('skip_snapshot'),
    // Why a request promised for an earlier day than its manifest's was carried over: the reason (code and label as the actor saw them)
    // and the note, set at creation and never changed. Null for a request on its own day.
    carryoverSnapshot: jsonb('carryover_snapshot'),
    // What the rider is shown for this stop, made once by the dispatch of the manifest from the request, in the dispatching officer's own
    // transaction, and never changed (migration 0063). Null until the manifest is dispatched, and null for a stop that was already resolved
    // when it was: a cancelled request is never sent to a rider. The registry denies a rider any read of the request, so this is the only
    // place the stop shows it.
    pickupSummary: jsonb('pickup_summary'),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_stop_manifest_fkey',
      columns: [table.pickupManifestId, table.responsibleHubId],
      foreignColumns: [pickupManifest.id, pickupManifest.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_stop_request_fkey',
      columns: [table.pickupRequestId],
      foreignColumns: [pickupRequest.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_stop_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    // The claim: one unreleased stop for a request, whatever the stop's state.
    uniqueIndex('pickup_stop_request_claim')
      .on(table.pickupRequestId)
      .where(sql`${table.releasedAt} IS NULL`),
    // The stop's identity with its hub, which a table that belongs to a stop carries by a composite key (S1.26: the collection record).
    uniqueIndex('pickup_stop_id_hub_key').on(table.id, table.responsibleHubId),
    index('pickup_stop_manifest_idx').on(table.pickupManifestId, table.sequence),
    index('pickup_stop_request_idx').on(table.pickupRequestId),
    index('pickup_stop_hub_idx').on(table.responsibleHubId, table.state),
    check('pickup_stop_sequence_positive', sql`${table.sequence} >= 1`),
    check(
      'pickup_stop_state_closed',
      sql.raw(`"pickup_stop"."state" IN (${quoted(PICKUP_STOP_STATES)})`),
    ),
    check(
      'pickup_stop_failure_category_closed',
      sql.raw(
        `"pickup_stop"."failure_category" IS NULL OR "pickup_stop"."failure_category" IN (${quoted(PICKUP_FAILURE_CATEGORIES)})`,
      ),
    ),
    // What the domain model states of the facts a state carries (section 6.4): the failure category is set exactly when the stop is
    // FAILED. The snapshots of a failure and of a skip are held in one direction only, to the state they describe: which of them every
    // way of reaching SKIPPED must carry (a skip by Ops, the cancellation of a manifest) is for the tasks that build those acts to say.
    check(
      'pickup_stop_failure_facts',
      sql`(${table.state} = 'FAILED') = (${table.failureCategory} IS NOT NULL) AND (${table.failureReasonSnapshot} IS NULL OR ${table.state} = 'FAILED')`,
    ),
    check(
      'pickup_stop_skip_facts',
      sql`${table.skipSnapshot} IS NULL OR ${table.state} = 'SKIPPED'`,
    ),
    // A carry-over always names its reason.
    check(
      'pickup_stop_carryover_facts',
      sql`${table.carryoverSnapshot} IS NULL OR (${table.carryoverSnapshot} ->> 'reason_code') IS NOT NULL`,
    ),
    // The summary is the six members the contract names for a rider, of the types it gives them, and nothing else.
    check('pickup_stop_summary_shape', sql.raw(`${SUMMARY} IS NULL OR (${summaryShape()})`)),
    // A stop that is still PENDING has not been arrived at, and a stop that is not yet terminal has no moment of resolution.
    check(
      'pickup_stop_moment_facts',
      sql`(${table.state} <> 'PENDING' OR ${table.arrivedAt} IS NULL) AND (${table.state} NOT IN ('PENDING', 'ARRIVED') OR ${table.resolvedAt} IS NULL)`,
    ),
  ],
);

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
import { riderIdentity } from '../staff/rider-identity.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

export const COLLECTION_VARIANCES = ['MATCH', 'SHORT'] as const;
export const HANDSHAKE_TYPES = [
  'VENDOR_ENTERED_RIDER_DISPLAYED',
  'SENDER_SMS_RIDER_ENTERED',
] as const;
export const HANDSHAKE_CHANNELS = ['PORTAL', 'SMS_FALLBACK', 'OPS_OVERRIDE'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The collection record (S1.26, `SLICE-001`; domain-model.md section 6.5; pickup-collection.md; state-machines.md section 5;
 * `AC-SLICE-001-20`, `-21`, `-28` and `-29`): what the rider counted at the door, made **at the count** and not at the end of the handshake
 * (the Product Owner's decision of 29 October 2026, "count, then confirm": D-04 option 1).
 *
 * - **One per stop that reached the door**, by a unique key; and **never an empty one**: a count of zero is a failed pickup and makes no record
 *   (`ZERO_COLLECTION_IS_FAILURE`), so `collected_count` is at least one.
 * - **The actual count, never the declared one.** `declared_count` is what the request said (a copy, so that the variance can be read without
 *   the request), `collected_count` is what the rider counted, and **neither seeds the hub's `rider_declared_count`** (`MSC-DEC-194` part 3).
 * - **`variance` is recorded on every collection**: `MATCH` when the counts are equal and `SHORT` when fewer were collected, which needs the
 *   catalogue reason (`variance_reason_snapshot`, the code and its label as they were, the domain-model's section 3.7) and sets
 *   `office_notified_at` in the same transaction. More than was declared is not a variance either section names, and is refused (OB-S1-50).
 * - **The handshake is not run here** (S1.27): `handshake_type` says which direction it will take, fixed by the kind of sender (a registered
 *   vendor enters the code the rider shows; an individual sender is texted it and the rider enters it), and the channel, the override and the
 *   confirmation are null until the handshake sets them. The stop stays `ARRIVED` until it closes.
 * - **Written once and then only by the handshake**: the count, the variance, the reason and the hub never change; the rider has no update.
 * - **`version` is the ETag source**, moved by the database on every change and by nothing else.
 *
 * This file is the *shape*. The migration (`0068_collection_record.sql`) adds by hand, in the same change: the owner, `ENABLE` and `FORCE ROW LEVEL
 * SECURITY`, the policies (the rider that recorded it and staff of the hub read it; one writer, the assigned rider's key), the grants, the guard
 * that holds the identity and the counts, the version trigger, the stop that is kept while a record stands, the rider's read of the short-count
 * reasons, the individual sender's promotion and the ledger's rider arm.
 */
export const collectionRecord = pgTable(
  'collection_record',
  {
    id: uuid('id').primaryKey(),
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The stop's hub, carried by a composite key so that a record can never name another hub than its stop's. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    declaredCount: integer('declared_count').notNull(),
    collectedCount: integer('collected_count').notNull(),
    variance: text('variance').notNull(),
    varianceReasonSnapshot: jsonb('variance_reason_snapshot'),
    officeNotifiedAt: timestamp('office_notified_at', { withTimezone: true }),
    handshakeType: text('handshake_type').notNull(),
    handshakeChannel: text('handshake_channel'),
    handshakeOverrideBy: uuid('handshake_override_by'),
    handshakeConfirmedAt: timestamp('handshake_confirmed_at', { withTimezone: true }),
    /** The rider who counted. */
    recordedBy: uuid('recorded_by').notNull(),
    /** When the rider counted, as its device said it (never the receipt time, which is `recorded_at`). */
    capturedAt: timestamp('captured_at', { withTimezone: true }),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'collection_record_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_record_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'collection_record_rider_fkey',
      columns: [table.recordedBy],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    // At most one per stop: a second submission under another key finds this index and is a conflict.
    uniqueIndex('collection_record_stop_key').on(table.pickupStopId),
    index('collection_record_hub_idx').on(table.responsibleHubId, table.recordedAt),
    index('collection_record_rider_idx').on(table.recordedBy, table.recordedAt),
    check(
      'collection_record_variance_closed',
      sql.raw(`"collection_record"."variance" IN (${quoted(COLLECTION_VARIANCES)})`),
    ),
    check(
      'collection_record_handshake_type_closed',
      sql.raw(`"collection_record"."handshake_type" IN (${quoted(HANDSHAKE_TYPES)})`),
    ),
    check(
      'collection_record_handshake_channel_closed',
      sql.raw(
        `"collection_record"."handshake_channel" IS NULL OR "collection_record"."handshake_channel" IN (${quoted(HANDSHAKE_CHANNELS)})`,
      ),
    ),
    // Never an empty collection, and the declared count is a real one.
    check(
      'collection_record_counts',
      sql`${table.collectedCount} >= 1 AND ${table.declaredCount} >= 1`,
    ),
    // The variance is the comparison of the counts and nothing else: equal is MATCH, fewer is SHORT, and more is not recorded.
    check(
      'collection_record_variance_follows_counts',
      sql`(${table.variance} = 'MATCH' AND ${table.collectedCount} = ${table.declaredCount})
          OR (${table.variance} = 'SHORT' AND ${table.collectedCount} < ${table.declaredCount})`,
    ),
    // A shortfall has its reason and has raised the office flag; a clean count has neither.
    check(
      'collection_record_shortfall_facts',
      sql`(${table.variance} = 'SHORT' AND ${table.varianceReasonSnapshot} IS NOT NULL AND ${table.officeNotifiedAt} IS NOT NULL)
          OR (${table.variance} = 'MATCH' AND ${table.varianceReasonSnapshot} IS NULL AND ${table.officeNotifiedAt} IS NULL)`,
    ),
    check(
      'collection_record_reason_snapshot_object',
      sql`${table.varianceReasonSnapshot} IS NULL OR jsonb_typeof(${table.varianceReasonSnapshot}) = 'object'`,
    ),
    // The handshake's facts are all null until it has verified, and an override names its officer: the handshake sets them (S1.27), the count never.
    check(
      'collection_record_handshake_facts',
      sql`(${table.handshakeChannel} IS NULL AND ${table.handshakeConfirmedAt} IS NULL AND ${table.handshakeOverrideBy} IS NULL)
          OR (${table.handshakeChannel} IS NOT NULL AND ${table.handshakeConfirmedAt} IS NOT NULL
              AND ((${table.handshakeChannel} = 'OPS_OVERRIDE') = (${table.handshakeOverrideBy} IS NOT NULL)))`,
    ),
  ],
);

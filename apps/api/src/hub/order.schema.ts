import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
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

import { evidence } from '../platform/database/schema/evidence.js';
import { intakeParcel } from './intake-parcel.schema.js';
import { pickupIntake } from './pickup-intake.schema.js';

/** The commercial machine of an order (state-machines.md §8). Null before the freeze: an order that waits for its parcel is not in it yet. */
export const ORDER_COMMERCIAL_STATES = [
  'PRICED',
  'PAYMENT_REQUIRED',
  'CREDIT_RESERVED',
  'NO_VENDOR_CHARGE',
  'PREPAID',
  'CLOSED',
  'REVERSED',
] as const;
/** The fulfilment machine of an order (state-machines.md §9). An order is made at the first. */
export const ORDER_FULFILMENT_STATES = [
  'AWAITING_RECIPIENT_CONFIRMATION',
  'READY_FOR_DISPATCH',
  'ASSIGNED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'ATTEMPT_FAILED',
  'AT_HUB_AFTER_FAILURE',
  'READY_FOR_REATTEMPT',
  'HANDED_TO_CARRIER',
  'RETURN_TO_VENDOR_IN_PROGRESS',
  'RETURNED_TO_VENDOR',
] as const;
export const ORDER_LANES = ['DOORSTEP', 'THIRD_PARTY_HANDOFF'] as const;
export const COMMERCIAL_MODES = ['STATION_DROP', 'MELARC_COVERED_THIRD_PARTY_DELIVERY'] as const;
export const ORDER_SIZE_CLASSES = ['SMALL', 'MEDIUM', 'LARGE'] as const;
export const DESTINATION_ZONE_RESOLUTIONS = ['SERVER_RESOLVED', 'EXPLICITLY_AUTHORIZED'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The order (S1.36, `SLICE-001`; domain-model.md §6.7; state-machines.md §8 and §9; itemization.md §5.1, §5.4; data-scope-registry.md `Order`; `MSC-DEC-187`): **the single itemized delivery unit**, made
 * for one parcel by `itemizeOrder`, where price first becomes authoritative.
 *
 * - **Written by operations of the database, as the owner, and by nobody else** (`melarc.itemize_order` and `melarc.freeze_orders`, migration `0110`): the application's login holds `SELECT` and no write,
 *   and the guard of the table holds what an order is for every writer.
 * - **An order is made for a parcel, one order for a parcel and one parcel for an order, by the database** (D-D6): `intake_parcel_id` is unique and its pair with the intake is a composite foreign key, so
 *   that a parcel of another intake cannot be ordered. It is null only for an intake counted blind, which has no parcels.
 * - **The price is calculated when the order is made, always, and frozen when its parcel's arrival is committed** (§5.4): `price_components_snapshot` is the calculation, each component with its hub, key,
 *   scope, version and value; `locked_price_minor`, `locked_at`, `payer_allocation` and `commercial_state` (`PRICED`) are set together at the freeze, by the database, and never changed afterwards (a
 *   correction is a linked adjustment, never a rewrite, §35.6.7). An order that is not frozen has `commercial_state` null: it waits for its parcel and is not in the commercial machine yet.
 * - **Everything the officer judged is recorded with the officer**: `size_class` is never null and `size_class_selected_by` is the staff member who selected it (a human judgement, `MSC-DEC-209`); a carrier's
 *   cost is an observation with the waybill photograph behind it; a high-value parcel names the stored evidence that verified it.
 * - **The origin zone is the request's, resolved once** (`AC-SLICE-001-57`): every order of an intake carries the same snapshot, which the guard holds. **The destination zone is the server's**:
 *   `destination_zone_resolution` says whether it resolved it or an authorized selection did.
 * - **Its first promise is written with it**: `initial_commitment_id` names the `delivery_commitment` row of `sequence` 1 by a foreign key that is checked at the end of the transaction, so that an order
 *   without its initial commitment cannot be committed. The foreign key is added by hand in the migration (a deferrable key is not one this schema can say).
 *
 * Not here, because the task that decides them has not been built: the reprice history, the carrier's identity and the return fee (S1.39 and the delivery tasks), the payer corrections, the commercial
 * gate's own facts (S1.37: the state moves; its reservation is SLICE-007's, D-12) and the delivery milestones.
 *
 * This file is the *shape*. The migration adds by hand, in the same change: the owner, `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the grant (`SELECT` alone), the guard, the version trigger,
 * the deferred key and the two operations that write it.
 */
export const orderRecord = pgTable(
  'order',
  {
    id: uuid('id').primaryKey(),
    /** The operational code (`ORD-XXXXXX`, or the hub's: `operationalCode(hub, 'OR')`): for people who say it aloud, never an identifier. */
    code: text('code').notNull(),
    pickupIntakeId: uuid('pickup_intake_id').notNull(),
    /** The intake's hub, given by the guard and carried by a composite key. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The parcel the order is made for: null only for a blind-count intake, which has none. Unique. */
    intakeParcelId: uuid('intake_parcel_id'),
    /** The sender, inherited from the request by the guard and never the writer's: exactly one of the two. */
    vendorOrganizationId: uuid('vendor_organization_id'),
    adHocSenderId: uuid('ad_hoc_sender_id'),
    /** Null until the freeze (see above). */
    commercialState: text('commercial_state'),
    fulfilmentState: text('fulfilment_state').notNull().default('AWAITING_RECIPIENT_CONFIRMATION'),
    recipient: jsonb('recipient').notNull(),
    originZoneSnapshot: jsonb('origin_zone_snapshot').notNull(),
    destinationZoneSnapshot: jsonb('destination_zone_snapshot').notNull(),
    destinationZoneResolution: text('destination_zone_resolution').notNull(),
    declaredValueMinor: integer('declared_value_minor'),
    isSerializedGoods: boolean('is_serialized_goods').notNull().default(false),
    serialImei: text('serial_imei'),
    serviceLevel: text('service_level').notNull().default('STANDARD'),
    requestedDeliveryDate: date('requested_delivery_date', { mode: 'string' }),
    derivedDeliveryDate: date('derived_delivery_date', { mode: 'string' }).notNull(),
    deliveryDateOverride: jsonb('delivery_date_override'),
    sizeClass: text('size_class').notNull(),
    sizeClassSelectedBy: uuid('size_class_selected_by').notNull(),
    carrierCostMinor: integer('carrier_cost_minor'),
    /** The photograph of the carrier's waybill behind `carrier_cost_minor`: present exactly with it. */
    carrierWaybillEvidenceId: uuid('carrier_waybill_evidence_id'),
    isHighValue: boolean('is_high_value').notNull(),
    /** The stored evidence that verified a high-value parcel at itemization: at least one exactly when `is_high_value`. */
    highValueEvidenceIds: uuid('high_value_evidence_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    lane: text('lane').notNull(),
    commercialMode: text('commercial_mode'),
    /** The parcel-level override of the request's payer arrangement, as it was given (an intent, never a portion of a price). */
    payerOverride: jsonb('payer_override'),
    payerOverrideApplied: boolean('payer_override_applied').notNull().default(false),
    /** The resolved portions of the locked price, set at the freeze: the intent that was applied and the sender's and the recipient's pesewas. */
    payerAllocation: jsonb('payer_allocation'),
    /** The price as calculated when the order was made: its total and each component with hub, key, scope, version and value. */
    priceComponentsSnapshot: jsonb('price_components_snapshot').notNull(),
    lockedPriceMinor: integer('locked_price_minor'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    /** The row of `delivery_commitment` of `sequence` 1, made with the order: a deferred key says so. */
    initialCommitmentId: uuid('initial_commitment_id').notNull(),
    /** Always 1: the sequence the initial commitment has, so that the deferred key names that row and no later one. */
    initialSequence: integer('initial_sequence').notNull().default(1),
    deliveryAttemptCount: integer('delivery_attempt_count').notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** The record's `ETag` source, moved by the database on every change. */
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'order_intake_fkey',
      columns: [table.pickupIntakeId, table.responsibleHubId],
      foreignColumns: [pickupIntake.id, pickupIntake.responsibleHubId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_parcel_fkey',
      columns: [table.intakeParcelId, table.pickupIntakeId],
      foreignColumns: [intakeParcel.id, intakeParcel.pickupIntakeId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'order_waybill_evidence_fkey',
      columns: [table.carrierWaybillEvidenceId],
      foreignColumns: [evidence.id],
    }).onDelete('restrict'),
    uniqueIndex('order_code_key').on(table.code),
    // The key a commitment's composite foreign key names: a commitment can never name another hub than its order's.
    uniqueIndex('order_id_hub_key').on(table.id, table.responsibleHubId),
    // One order for a parcel (a null is no parcel: the blind-count intakes' orders are not duplicates of one another).
    uniqueIndex('order_parcel_key').on(table.intakeParcelId),
    index('order_intake_idx').on(table.pickupIntakeId, table.createdAt),
    index('order_hub_idx').on(table.responsibleHubId, table.createdAt),
    check(
      'order_commercial_state_closed',
      sql.raw(
        `"order"."commercial_state" IS NULL OR "order"."commercial_state" IN (${quoted(ORDER_COMMERCIAL_STATES)})`,
      ),
    ),
    check(
      'order_fulfilment_state_closed',
      sql.raw(`"order"."fulfilment_state" IN (${quoted(ORDER_FULFILMENT_STATES)})`),
    ),
    check('order_lane_closed', sql.raw(`"order"."lane" IN (${quoted(ORDER_LANES)})`)),
    check(
      'order_commercial_mode_closed',
      sql.raw(
        `"order"."commercial_mode" IS NULL OR "order"."commercial_mode" IN (${quoted(COMMERCIAL_MODES)})`,
      ),
    ),
    check(
      'order_size_class_closed',
      sql.raw(`"order"."size_class" IN (${quoted(ORDER_SIZE_CLASSES)})`),
    ),
    check(
      'order_zone_resolution_closed',
      sql.raw(`"order"."destination_zone_resolution" IN (${quoted(DESTINATION_ZONE_RESOLUTIONS)})`),
    ),
    check('order_service_level_closed', sql`${table.serviceLevel} = 'STANDARD'`),
    check('order_initial_sequence', sql`${table.initialSequence} = 1`),
    // `commercial_mode` is non-null exactly when the lane is the third-party hand-off (domain-model.md §6.7).
    check(
      'order_lane_mode',
      sql`(${table.lane} = 'DOORSTEP' AND ${table.commercialMode} IS NULL) OR (${table.lane} = 'THIRD_PARTY_HANDOFF' AND ${table.commercialMode} IS NOT NULL)`,
    ),
    // The carrier's cost is an observation, present exactly in the covered third-party mode and with its waybill: "a carrier cost on a doorstep order is a data error" (domain-model.md §6.7).
    check(
      'order_carrier_cost_facts',
      sql`((${table.commercialMode} IS NOT DISTINCT FROM 'MELARC_COVERED_THIRD_PARTY_DELIVERY') = (${table.carrierCostMinor} IS NOT NULL)) AND ((${table.carrierCostMinor} IS NOT NULL) = (${table.carrierWaybillEvidenceId} IS NOT NULL)) AND (${table.carrierCostMinor} IS NULL OR ${table.carrierCostMinor} > 0)`,
    ),
    // Serialized goods carry their serial or IMEI (§23.2, §23.4).
    check(
      'order_serial_required',
      sql`NOT ${table.isSerializedGoods} OR (${table.serialImei} IS NOT NULL AND btrim(${table.serialImei}) <> '')`,
    ),
    // A high-value parcel carries the evidence that verified it (§23.4). Evidence named for a parcel that is not high value is allowed: the guard has judged it stored and the intake's own.
    check(
      'order_high_value_evidence',
      sql`NOT ${table.isHighValue} OR cardinality(${table.highValueEvidenceIds}) >= 1`,
    ),
    check(
      'order_declared_value_nonnegative',
      sql`${table.declaredValueMinor} IS NULL OR ${table.declaredValueMinor} >= 0`,
    ),
    // The sender is the request's: a registered vendor or a walk-in, exactly one.
    check(
      'order_one_sender',
      sql`(${table.vendorOrganizationId} IS NULL) <> (${table.adHocSenderId} IS NULL)`,
    ),
    check('order_attempts_nonnegative', sql`${table.deliveryAttemptCount} >= 0`),
    // The freeze is one fact with four marks: the locked price, its moment, the resolved portions and the commercial state exist together (domain-model.md §6.7: `locked_price_minor` is immutable once set).
    check(
      'order_freeze_facts',
      sql`((${table.lockedPriceMinor} IS NULL) = (${table.lockedAt} IS NULL)) AND ((${table.lockedPriceMinor} IS NULL) = (${table.payerAllocation} IS NULL)) AND ((${table.lockedPriceMinor} IS NULL) = (${table.commercialState} IS NULL)) AND (${table.lockedPriceMinor} IS NULL OR ${table.lockedPriceMinor} >= 0)`,
    ),
    check(
      'order_snapshots_are_objects',
      sql`jsonb_typeof(${table.recipient}) = 'object' AND jsonb_typeof(${table.originZoneSnapshot}) = 'object' AND jsonb_typeof(${table.destinationZoneSnapshot}) = 'object' AND jsonb_typeof(${table.priceComponentsSnapshot}) = 'object'`,
    ),
  ],
);

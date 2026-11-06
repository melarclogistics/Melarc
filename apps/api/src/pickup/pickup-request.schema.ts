import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { hub } from '../platform/database/schema/reference-data.js';
import { vendorOrganization } from '../vendor/vendor-organization.schema.js';
import { vendorPickupLocation } from '../vendor/vendor-pickup-location.schema.js';
import { adHocSender } from './ad-hoc-sender.schema.js';

export const PICKUP_REQUEST_STATES = ['PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED'] as const;
export const PICKUP_INTENTS = ['OWN_PACKAGES', 'COLLECT_FOR_VENDOR', 'ADHOC_SENDER'] as const;
export const PAYER_INTENTS = ['RECIPIENT_PAYS', 'SENDER_PAYS_FULL', 'SPLIT'] as const;
export const SPLIT_BASES = ['FIXED_AMOUNT', 'PERCENTAGE'] as const;
export const CUTOFF_EXCEPTION_STATES = [
  'PENDING_OPS_REVIEW',
  'SAME_DAY_APPROVED',
  'RESCHEDULED',
] as const;
export const CANCELLATION_CHARGE_OUTCOMES = [
  'APPLIED',
  'WAIVED',
  'NOT_APPLIED',
  'UNAVAILABLE',
  'EXEMPT',
] as const;
export const CANCELLING_ACTORS = ['VENDOR', 'OPS'] as const;
export const ONE_PACKAGE_EXCEPTION_STATES = ['REQUESTED', 'APPROVED', 'REJECTED'] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The pickup request (S1.13, `SLICE-001`; domain-model.md section 6.2; state-machines.md section 3; data-scope-registry.md
 * `PickupRequest`; features/pickup/pickup-request.md). The booking: one origin and one scheduled pickup event.
 *
 * - **Scoped by hub for staff, by organisation for a vendor, and never by hub for a vendor.** A staff member reads the requests of the
 *   hubs of the operation's grant; a vendor reads its own organisation's; a rider and a recipient read none. Another vendor's request is
 *   answered as one that does not exist (`AC-SLICE-001-79`).
 * - **Everything the rider is sent to and everything priced is server-derived.** `resolved_pickup_location` is non-null on every row and
 *   is derived from the intent; the client sends an address and never a price. **No price is stored here**: `estimate_snapshot` holds the
 *   *inputs* of the booking estimate (`MSC-DEC-211`) and nothing reads it as a price, and the payer columns are intent only.
 * - **The charge of a cancellation is a recorded outcome, never a null**: `UNAVAILABLE` for a missing amount, `EXEMPT` for a reason
 *   attributed to Melarc, `NOT_APPLIED` for Ops electing none, `APPLIED` with its snapshot, and `WAIVED` after a Senior Ops waiver (the
 *   snapshot stays readable).
 * - **A replacement is a new row**, never an edit: `replaces_request_id` and `replacement_request_id` link the chain, `attempt_number`
 *   counts it, and the cap is `MELARC_MAX_PICKUP_ATTEMPTS` unless a Senior Ops extension (`attempt_extension_id`) lifts it.
 * - **`version` is the record's ETag source**, moved by the database on every change a read returns and by nothing else.
 *
 * This file is the *shape*. The migration (`0045_pickup_requests.sql`) adds by hand, in the same change: the owner, `ENABLE` and `FORCE
 * ROW LEVEL SECURITY`, the policies (a staff context by hub and operation key; a vendor by its organisation; the scope probe), the
 * grants, the version trigger and the guard that refuses what a request may not change.
 */
export const pickupRequest = pgTable(
  'pickup_request',
  {
    id: uuid('id').primaryKey(),
    code: text('code').notNull(),
    vendorOrganizationId: uuid('vendor_organization_id'),
    adHocSenderId: uuid('ad_hoc_sender_id'),
    // The sender's name as it was when booked (a label for a person to read, like the label of a reason): a vendor or an ad-hoc sender
    // renamed later does not rewrite a booking.
    senderName: text('sender_name').notNull(),
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    pickupIntent: text('pickup_intent').notNull(),
    state: text('state').notNull().default('PENDING'),
    declaredPackageCount: integer('declared_package_count').notNull(),
    onePackageExceptionId: uuid('one_package_exception_id'),
    pickupLocation: jsonb('pickup_location'),
    resolvedPickupLocation: jsonb('resolved_pickup_location').notNull(),
    collectionPoint: jsonb('collection_point'),
    collectionReference: jsonb('collection_reference'),
    collectionItem: jsonb('collection_item'),
    destinationLocationId: uuid('destination_location_id'),
    vendorPickupLocationId: uuid('vendor_pickup_location_id'),
    primaryPhone: text('primary_phone').notNull(),
    secondaryPhone: text('secondary_phone'),
    currentItemDescription: text('current_item_description'),
    scheduledServiceDate: date('scheduled_service_date', { mode: 'string' }).notNull(),
    locationOverrides: jsonb('location_overrides'),
    defaultPayerIntent: text('default_payer_intent').notNull(),
    splitBasis: text('split_basis'),
    splitSenderAmountMinor: integer('split_sender_amount_minor'),
    splitSenderPercentage: numeric('split_sender_percentage', { precision: 5, scale: 2 }),
    declaredValueMinor: integer('declared_value_minor'),
    liabilityCapAcknowledgedAt: timestamp('liability_cap_acknowledged_at', {
      withTimezone: true,
    }),
    liabilityCapSnapshot: jsonb('liability_cap_snapshot'),
    estimateSnapshot: jsonb('estimate_snapshot'),
    cutoffExceptionState: text('cutoff_exception_state'),
    attemptNumber: integer('attempt_number').notNull().default(1),
    attemptExtensionId: uuid('attempt_extension_id'),
    replacesRequestId: uuid('replaces_request_id'),
    replacementRequestId: uuid('replacement_request_id'),
    cancellationReasonCode: text('cancellation_reason_code'),
    cancellationReasonLabel: text('cancellation_reason_label'),
    cancelledByActorType: text('cancelled_by_actor_type'),
    cancellationChargeOutcome: text('cancellation_charge_outcome'),
    cancellationChargeSnapshot: jsonb('cancellation_charge_snapshot'),
    cancellationChargeReasonCode: text('cancellation_charge_reason_code'),
    cancellationChargeReasonLabel: text('cancellation_charge_reason_label'),
    cancellationChargeWaivedBy: uuid('cancellation_charge_waived_by'),
    cancellationChargeWaiverNote: text('cancellation_charge_waiver_note'),
    riderAssigned: boolean('rider_assigned').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  },
  // (The annotation breaks the cycle between the two tables: each names the other, and the compiler may not infer one from the other.)
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_request_vendor_fkey',
      columns: [table.vendorOrganizationId],
      foreignColumns: [vendorOrganization.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_sender_fkey',
      columns: [table.adHocSenderId],
      foreignColumns: [adHocSender.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_destination_fkey',
      columns: [table.destinationLocationId],
      foreignColumns: [vendorPickupLocation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_location_fkey',
      columns: [table.vendorPickupLocationId],
      foreignColumns: [vendorPickupLocation.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_replaces_fkey',
      columns: [table.replacesRequestId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'pickup_request_replacement_fkey',
      columns: [table.replacementRequestId],
      foreignColumns: [table.id],
    }).onDelete('restrict'),
    // The exception an approval gave this booking, null until it is approved. It travels with the booking: a clone carries it, so it is a
    // plain key; that it is the request's own or its predecessor's and no other's is the trigger's (0051).
    foreignKey({
      name: 'pickup_request_exception_fkey',
      columns: [table.onePackageExceptionId],
      foreignColumns: [onePackageException.id],
    }).onDelete('restrict'),
    // The extension that lifts the cap of this booking's next attempt, null until a Senior Ops member grants one. It travels with the booking
    // as the exception does (a clone carries it so that its one further attempt can be confirmed): a plain key, and that it is the request's
    // own or its predecessor's and no other's is the trigger's (0053).
    foreignKey({
      name: 'pickup_request_extension_fkey',
      columns: [table.attemptExtensionId],
      foreignColumns: [pickupAttemptExtension.id],
    }).onDelete('restrict'),
    uniqueIndex('pickup_request_code_key').on(table.code),
    // A request is replaced at most once, and replaces at most one: the chain is a line, never a tree.
    uniqueIndex('pickup_request_replaces_once')
      .on(table.replacesRequestId)
      .where(sql`${table.replacesRequestId} IS NOT NULL`),
    index('pickup_request_hub_idx').on(
      table.responsibleHubId,
      table.state,
      table.scheduledServiceDate,
    ),
    index('pickup_request_vendor_idx').on(table.vendorOrganizationId, table.createdAt),
    // The late bookings waiting for the cutoff decision (`getQueueSummary`, `PICKUP_CUTOFF_REVIEW`): a few rows among every confirmed request there
    // has ever been, so the count reads this index and not the table (a sequential scan of 400,000 requests took 98 ms).
    index('pickup_request_cutoff_review_idx')
      .on(table.responsibleHubId, table.confirmedAt)
      .where(
        sql`${table.state} = 'CONFIRMED' AND ${table.cutoffExceptionState} = 'PENDING_OPS_REVIEW'`,
      ),
    // The requests that carry an exception (an approval travels with the booking into its clones): where a filter on the state of the exception
    // starts from the exceptions in that state and finds the requests that carry them.
    index('pickup_request_carried_exception_idx')
      .on(table.onePackageExceptionId)
      .where(sql`${table.onePackageExceptionId} IS NOT NULL`),
    // The search by a phone number typed in full (`lookupRecords`, task C2): an equality on either contact phone. An equality is leakproof, so it
    // runs, and an index on it is used, before the row-level security policy (a scan of 400,000 requests took 0.1 s, the index 0.2 ms). The second
    // is partial: most requests have no second number.
    index('pickup_request_primary_phone_idx').on(table.primaryPhone),
    index('pickup_request_secondary_phone_idx')
      .on(table.secondaryPhone)
      .where(sql`${table.secondaryPhone} IS NOT NULL`),
    check(
      'pickup_request_code_format',
      sql`${table.code} ~ '^[A-Z]{3}-PR-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$'`,
    ),
    check(
      'pickup_request_state_closed',
      sql.raw(`"pickup_request"."state" IN (${quoted(PICKUP_REQUEST_STATES)})`),
    ),
    check(
      'pickup_request_intent_closed',
      sql.raw(`"pickup_request"."pickup_intent" IN (${quoted(PICKUP_INTENTS)})`),
    ),
    // Exactly one sender reference, and the intent decides which.
    check(
      'pickup_request_one_sender',
      sql`(${table.pickupIntent} = 'ADHOC_SENDER' AND ${table.adHocSenderId} IS NOT NULL AND ${table.vendorOrganizationId} IS NULL) OR (${table.pickupIntent} <> 'ADHOC_SENDER' AND ${table.vendorOrganizationId} IS NOT NULL AND ${table.adHocSenderId} IS NULL)`,
    ),
    // The minimum is two packages; one is allowed only with an approved exception, and a one-package request waits as PENDING (or ends
    // CANCELLED) until it has one.
    check(
      'pickup_request_minimum_packages',
      sql`${table.declaredPackageCount} >= 2 OR ${table.onePackageExceptionId} IS NOT NULL OR ${table.state} IN ('PENDING', 'CANCELLED', 'DECLINED')`,
    ),
    check('pickup_request_package_count_positive', sql`${table.declaredPackageCount} >= 1`),
    check('pickup_request_attempt_positive', sql`${table.attemptNumber} >= 1`),
    // A rider is sent to the collection point of a collection for a vendor, and the destination is mandatory there.
    check(
      'pickup_request_collection_shape',
      sql`(${table.pickupIntent} = 'COLLECT_FOR_VENDOR') = (${table.collectionPoint} IS NOT NULL) AND (${table.pickupIntent} = 'COLLECT_FOR_VENDOR') = (${table.destinationLocationId} IS NOT NULL)`,
    ),
    check(
      'pickup_request_payer_intent_closed',
      sql.raw(`"pickup_request"."default_payer_intent" IN (${quoted(PAYER_INTENTS)})`),
    ),
    check(
      'pickup_request_split_consistent',
      sql`(${table.defaultPayerIntent} = 'SPLIT') = (${table.splitBasis} IS NOT NULL) AND (${table.splitBasis} = 'FIXED_AMOUNT') = (${table.splitSenderAmountMinor} IS NOT NULL) AND (${table.splitBasis} = 'PERCENTAGE') = (${table.splitSenderPercentage} IS NOT NULL)`,
    ),
    check(
      'pickup_request_split_basis_closed',
      sql.raw(
        `"pickup_request"."split_basis" IS NULL OR "pickup_request"."split_basis" IN (${quoted(SPLIT_BASES)})`,
      ),
    ),
    // The declared value is never a price; the acknowledgement and the snapshot of the cap come together.
    check(
      'pickup_request_cap_acknowledgement',
      sql`(${table.liabilityCapAcknowledgedAt} IS NULL) = (${table.liabilityCapSnapshot} IS NULL)`,
    ),
    check(
      'pickup_request_cutoff_state_closed',
      sql.raw(
        `"pickup_request"."cutoff_exception_state" IS NULL OR "pickup_request"."cutoff_exception_state" IN (${quoted(CUTOFF_EXCEPTION_STATES)})`,
      ),
    ),
    check(
      'pickup_request_charge_outcome_closed',
      sql.raw(
        `"pickup_request"."cancellation_charge_outcome" IS NULL OR "pickup_request"."cancellation_charge_outcome" IN (${quoted(CANCELLATION_CHARGE_OUTCOMES)})`,
      ),
    ),
    check(
      'pickup_request_cancelling_actor_closed',
      sql.raw(
        `"pickup_request"."cancelled_by_actor_type" IS NULL OR "pickup_request"."cancelled_by_actor_type" IN (${quoted(CANCELLING_ACTORS)})`,
      ),
    ),
    // The facts of a confirmation and of a cancellation come with the state that carries them.
    check(
      'pickup_request_confirmation_facts',
      sql`(${table.confirmedAt} IS NULL) = (${table.confirmedBy} IS NULL) AND (${table.state} <> 'CONFIRMED' OR ${table.confirmedAt} IS NOT NULL)`,
    ),
    check(
      'pickup_request_cancellation_facts',
      sql`(${table.state} = 'CANCELLED') = (${table.cancelledAt} IS NOT NULL) AND (${table.cancelledAt} IS NULL) = (${table.cancelledBy} IS NULL) AND (${table.state} = 'CANCELLED' OR (${table.cancellationReasonCode} IS NULL AND ${table.cancelledByActorType} IS NULL AND ${table.cancellationChargeOutcome} IS NULL))`,
    ),
    // A waiver names the actor and only a waived charge has one; a charge snapshot goes with an applied or waived outcome.
    check(
      'pickup_request_waiver_facts',
      sql`coalesce(${table.cancellationChargeOutcome} = 'WAIVED', false) = (${table.cancellationChargeWaivedBy} IS NOT NULL) AND (${table.cancellationChargeSnapshot} IS NOT NULL) = coalesce(${table.cancellationChargeOutcome} IN ('APPLIED', 'WAIVED'), false)`,
    ),
    check('pickup_request_phone_not_blank', sql`length(btrim(${table.primaryPhone})) > 0`),
    // Only a request that was confirmed can have failed, and so be escalated; a cancellation that follows keeps the moment.
    check(
      'pickup_request_escalation_facts',
      sql`${table.escalatedAt} IS NULL OR ${table.confirmedAt} IS NOT NULL`,
    ),
  ],
);

/**
 * The one-package exception (S1.16, `SLICE-001`; domain-model.md section 6.2; state-machines.md section 3; permissions.md section 6;
 * pickup-request.md sections 5.1 and 5.2; `AC-SLICE-001-03`): the maker-checker record that lets a request of one package be confirmed.
 * Ops asks for it with the **recipient** (name, phone, delivery address: mandatory for a single package, section 21.1) and a note;
 * **any holder of `pickup.exception.approve`** decides it, and never the requester unless the approver holds the approval at the
 * Platform Admin tier. An approval snapshots the `single_package_pickup_fee` as **due, not collected**: the amount, the setting key and the
 * version it was read from, so that a later change of the setting does not reprice it (domain-model.md section 3.7).
 *
 * - **At most one live exception per request** (a requested or an approved one); a refused one does not block a new request.
 * - **A decided exception is frozen**; `REJECTED` is in the machine and no operation of the slice produces it.
 * - **Scoped through its request**: whoever can read the request reads its exception, and the hub of the grant is the request's.
 *
 * This file is the *shape*. The migration (`0051_one_package_exception.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies, the column grants (the maker writes the request and nothing of the decision; the checker
 * writes the decision and nothing of the request), the guard that refuses what a request for an exception may not change, and the trigger
 * that is the backstop of the rule that the checker is not the maker.
 */
export const onePackageException = pgTable(
  'one_package_exception',
  {
    id: uuid('id').primaryKey(),
    pickupRequestId: uuid('pickup_request_id').notNull(),
    state: text('state').notNull().default('REQUESTED'),
    requestedBy: uuid('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    note: text('note').notNull(),
    recipientName: text('recipient_name').notNull(),
    recipientPhone: text('recipient_phone').notNull(),
    recipientLocation: jsonb('recipient_location').notNull(),
    singlePackageFeeSnapshot: jsonb('single_package_fee_snapshot'),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'one_package_exception_request_fkey',
      columns: [table.pickupRequestId],
      foreignColumns: [pickupRequest.id],
    }).onDelete('restrict'),
    // One live exception per request: a requested or an approved one. A refused one is history.
    uniqueIndex('one_package_exception_one_live')
      .on(table.pickupRequestId)
      .where(sql`${table.state} IN ('REQUESTED', 'APPROVED')`),
    // The exceptions in a state, oldest first: the approver's queue and its count start here (`getQueueSummary`, `PICKUP_EXCEPTION_APPROVAL`; the
    // filter `one_package_exception_state` of `listPickupRequests`), instead of asking every request what exception it shows.
    index('one_package_exception_state_idx').on(table.state, table.requestedAt),
    // Every exception of a request, newest first, refused ones included (the live index above holds only the requested and the approved): what
    // a request shows is the one it carries or else the latest raised for it, and that is read here.
    index('one_package_exception_request_idx').on(
      table.pickupRequestId,
      table.requestedAt.desc(),
      table.id.desc(),
    ),
    check(
      'one_package_exception_state_closed',
      sql.raw(`"one_package_exception"."state" IN (${quoted(ONE_PACKAGE_EXCEPTION_STATES)})`),
    ),
    // A requested exception has no checker and no moment of decision; a decided one has both.
    check(
      'one_package_exception_decision_facts',
      sql`(${table.state} = 'REQUESTED') = (${table.approvedBy} IS NULL) AND (${table.state} = 'REQUESTED') = (${table.decidedAt} IS NULL)`,
    ),
    // The fee is due on approval and on nothing else.
    check(
      'one_package_exception_fee_only_when_approved',
      sql`${table.singlePackageFeeSnapshot} IS NULL OR ${table.state} = 'APPROVED'`,
    ),
    check('one_package_exception_note_not_blank', sql`length(btrim(${table.note})) > 0`),
    check(
      'one_package_exception_recipient_not_blank',
      sql`length(btrim(${table.recipientName})) > 0`,
    ),
    check(
      'one_package_exception_phone_e164',
      sql`${table.recipientPhone} ~ '^\\+[1-9][0-9]{6,14}$'`,
    ),
    check(
      'one_package_exception_location_has_address',
      sql`jsonb_typeof(${table.recipientLocation}) = 'object' AND coalesce(length(btrim(${table.recipientLocation}->>'address')), 0) > 0`,
    ),
  ],
);

/**
 * The attempt extension (S1.18, `SLICE-001`; domain-model.md section 6.2; state-machines.md section 3, "force-extension"; pickup-request.md
 * section 5.2, "Attempt cap reached"; `AC-SLICE-001-07`): a hub Senior Ops member's direct, reasoned authority for **one further attempt**
 * of a booking that has reached `MELARC_MAX_PICKUP_ATTEMPTS` (section 21.6, `MSC-DEC-116`). It records the actor, the reason, the moment and
 * the ceiling before and after, and is **never changed or removed**: an immutable audit record that is also a row the cap reads.
 *
 * - **Raised for one request, once.** The ceiling it sets is the attempt after the request's own; the clone that attempt makes carries the
 *   extension so that it can be confirmed, and a further reschedule needs a further extension. The contract leaves the extension's reach
 *   open ("exact extension ceilings remain domain-design follow-up", section 21.6): this is the narrowest reading of "permits a further
 *   attempt", and it is the Product Owner's to widen.
 * - **Scoped through its request**: whoever can read the request reads its extension, and the hub of the grant is the request's.
 *
 * This file is the *shape*. The migration (`0053_pickup_attempt_extension.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies, the column grants, the guard that refuses any change or removal, the trigger that holds what a
 * request may name, and the rule that a replacement and its source are never active together.
 */
export const pickupAttemptExtension = pgTable(
  'pickup_attempt_extension',
  {
    id: uuid('id').primaryKey(),
    pickupRequestId: uuid('pickup_request_id').notNull(),
    /**
     * The attempt ceiling in force before, and the one this extension set (the attempt after the request's own): **both set when the extension lifted the ceiling, and both null when
     * it did not** (a refused collection below the cap, which a ceiling never stopped). Never the request's own attempt dressed as a ceiling.
     */
    ceilingBefore: integer('ceiling_before'),
    ceilingAfter: integer('ceiling_after'),
    /**
     * Whether this extension released the request from the restriction that a **refused collection** puts on it (`AC-SLICE-001-33`; pickup-failure.md section 5.2): that it
     * is never rescheduled by ordinary action. The release is for the request's one next attempt, and for this request only (a clone that carries the extension is not released
     * by it). Recorded as what it is, a release of a restriction, whatever the ceiling was.
     */
    releasesRefusedCollection: boolean('releases_refused_collection').notNull().default(false),
    extendedBy: uuid('extended_by').notNull(),
    extendedAt: timestamp('extended_at', { withTimezone: true }).notNull().defaultNow(),
    reason: text('reason').notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'pickup_attempt_extension_request_fkey',
      columns: [table.pickupRequestId],
      foreignColumns: [pickupRequest.id],
    }).onDelete('restrict'),
    // The ceiling of a request is raised for it once.
    uniqueIndex('pickup_attempt_extension_one_per_request').on(table.pickupRequestId),
    check('pickup_attempt_extension_ceiling_positive', sql`${table.ceilingBefore} >= 1`),
    check(
      'pickup_attempt_extension_ceiling_rises',
      sql`${table.ceilingAfter} > ${table.ceilingBefore}`,
    ),
    check('pickup_attempt_extension_reason_not_blank', sql`length(btrim(${table.reason})) > 0`),
    // The two ceilings go together, and an extension does something: it lifts the ceiling, or it releases a refused collection, or both.
    check(
      'pickup_attempt_extension_does_something',
      sql`(${table.ceilingBefore} IS NULL) = (${table.ceilingAfter} IS NULL) AND (${table.ceilingBefore} IS NOT NULL OR ${table.releasesRefusedCollection})`,
    ),
  ],
);

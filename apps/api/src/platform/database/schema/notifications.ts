import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  NOTIFICATION_AUDIENCES,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_OUTCOME_CLASSES,
  NOTIFICATION_STATES,
  NOTIFICATION_SUBJECT_TYPES,
  OUTBOX_AGGREGATE_TYPES,
  OUTBOX_OUTCOMES,
  OUTBOX_PRINCIPAL_TYPES,
  OUTBOX_RELAY_STATES,
  SUPPRESSION_REASONS,
} from '../../notifications/notification-vocabulary.js';
import { hub } from './reference-data.js';

/** `'A', 'B', 'C'`: a closed set as the text of an `IN (...)` list. The values are this module's own constants, never input. */
const list = (values: readonly string[]): ReturnType<typeof sql.raw> =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * The outbox: the trusted security envelope of a business event (S1.12a; BACKGROUND_JOBS_AND_EVENTS.md §3.7; SECURITY_DESIGN.md
 * §14.7; data-scope-registry.md `Outbox`). One row is written **inside the transaction of the act it describes**, so that a rolled-back
 * act leaves no notification and a committed one cannot lose its notification; the lane of the delivery worker reads it afterwards.
 *
 * **What the row holds.** The envelope: what happened (`event_type`), to what (`aggregate_type`, `aggregate_id`), under whose scope
 * (the responsible hub, the vendor organisation and the rider, each derived from the authoritative row **inside that transaction** and
 * never from input), by whom (the originating principal), by which operation and request (`operation_id`, `correlation_id`), and the
 * minimum payload (an object that holds no address, no code, no credential and no destination). **None of it ever changes.** And the
 * relay's bookkeeping: its state, the schedule, the lease and how the last attempt ended: the only columns the lane may update.
 *
 * **What it does not hold.** A person's phone number, a message, a code. The lane reloads the aggregate under the envelope's scope
 * when it sends (§14.7 steps 6 and 7), so a number corrected or a request cancelled between the act and the send is seen.
 *
 * This file is the *shape*. The migration (`0055_notification_outbox.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (a staff, vendor or rider context inserts its own envelope; a `SYSTEM` context under
 * `notification` reads and leases; everything else reads and writes nothing), the grants, the insert guard that checks the envelope
 * against the aggregate, and the guard that keeps the envelope immutable and the relay's state machine true whoever writes.
 */
export const outbox = pgTable(
  'outbox',
  {
    /** A UUIDv7 made before the insert. */
    id: uuid('id').primaryKey().notNull(),
    /** What happened, spelled as an audit event code (`pickup.request.confirmed`). The message list of the lane answers it. */
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    /** The hub the aggregate was responsible to, read from the aggregate in the transaction of the act. */
    responsibleHubId: uuid('responsible_hub_id')
      .notNull()
      .references(() => hub.id),
    vendorOrganizationId: uuid('vendor_organization_id'),
    riderId: uuid('rider_id'),
    originatingPrincipalType: text('originating_principal_type').notNull(),
    originatingPrincipalId: uuid('originating_principal_id').notNull(),
    operationId: text('operation_id').notNull(),
    correlationId: text('correlation_id').notNull(),
    /** The minimum payload: an object, small, and free of anything personal or secret. */
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    // The relay's bookkeeping: everything below may change, and nothing above.
    relayState: text('relay_state').notNull().default('PENDING'),
    /** Claims so far. The relay's schedule is BACKGROUND_JOBS_AND_EVENTS.md §3.2: six, then the dead letter. */
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    leaseOwner: text('lease_owner'),
    /** Rises by one at every claim. An outcome is written only against the version it was leased under (the fence). */
    leaseVersion: integer('lease_version').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    relayedAt: timestamp('relayed_at', { withTimezone: true }),
    lastOutcome: text('last_outcome'),
  },
  (table) => [
    // One act raises one event once: a redelivery of the same act finds its envelope already written.
    unique('outbox_event_key').on(table.eventType, table.aggregateId, table.correlationId),
    index('outbox_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.relayState} = 'PENDING'`),
    index('outbox_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.relayState} = 'LEASED'`),
    index('outbox_aggregate_idx').on(table.aggregateType, table.aggregateId),
    check(
      'outbox_aggregate_type_closed',
      sql`${table.aggregateType} IN (${list(OUTBOX_AGGREGATE_TYPES)})`,
    ),
    check(
      'outbox_event_type_shape',
      sql`${table.eventType} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$' AND length(${table.eventType}) <= 64`,
    ),
    check(
      'outbox_principal_closed',
      sql`${table.originatingPrincipalType} IN (${list(OUTBOX_PRINCIPAL_TYPES)})`,
    ),
    check(
      'outbox_operation_and_correlation_bounded',
      sql`length(${table.operationId}) BETWEEN 1 AND 96 AND length(${table.correlationId}) BETWEEN 1 AND 128`,
    ),
    check(
      'outbox_payload_is_a_small_object',
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 2048`,
    ),
    check('outbox_state_closed', sql`${table.relayState} IN (${list(OUTBOX_RELAY_STATES)})`),
    check(
      'outbox_outcome_closed',
      sql`${table.lastOutcome} IS NULL OR ${table.lastOutcome} IN (${list(OUTBOX_OUTCOMES)})`,
    ),
    check(
      'outbox_counters_nonnegative',
      sql`${table.attemptCount} >= 0 AND ${table.leaseVersion} >= 0`,
    ),
    // A row that is waiting holds no lease (the last holder's name stays) and has not been relayed.
    check(
      'outbox_pending_holds_no_lease',
      sql`${table.relayState} <> 'PENDING' OR (${table.leaseExpiresAt} IS NULL AND ${table.relayedAt} IS NULL)`,
    ),
    check(
      'outbox_lease_when_leased',
      sql`${table.relayState} <> 'LEASED' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.leaseVersion} >= 1 AND ${table.attemptCount} >= 1)`,
    ),
    check(
      'outbox_lease_owner_bounded',
      sql`${table.leaseOwner} IS NULL OR length(${table.leaseOwner}) BETWEEN 1 AND 128`,
    ),
    check(
      'outbox_relayed_when_relayed',
      sql`(${table.relayState} = 'RELAYED') = (${table.relayedAt} IS NOT NULL)`,
    ),
  ],
);

/**
 * A notification: one message to one audience over one channel, raised by one outbox envelope (S1.12a; data-scope-registry.md
 * `Notification`). It is written by the lane of the delivery worker and by nothing else, in the transaction that relays the envelope,
 * and it is **the record of what became of the message**: queued, sent, delivered, failed, or held back and why.
 *
 * **What the row holds.** The envelope it came from (the business anchor), the message of the list it is (`message_kind` and the
 * `template_version` of its wording), who it is for and over what channel, its scope (copied from the envelope and never changed), its
 * state and schedule, the lease, the provider's reference, and how it ended as a closed word.
 *
 * **What it does not hold.** The destination, in clear: the number is read from the aggregate at the moment of the send, and the row
 * keeps only a masked hint for the Ops log and a digest that the per-number limit counts on. And not the text, and never a code:
 * the wording is rendered from the template at the send and handed to the provider, so no read of this table, no log of it and no
 * export of it can show a message or a handshake code.
 *
 * The migration adds by hand: the owner, forced row-level security (staff read by hub; the lane reads, inserts and updates under
 * `notification`; nothing else), the grants and the guard that keeps the state machine and the lease fence true.
 */
export const notification = pgTable(
  'notification',
  {
    id: uuid('id').primaryKey().notNull(),
    outboxId: uuid('outbox_id')
      .notNull()
      .references(() => outbox.id),
    /** The message of the list (S1.12b) this is: `PICKUP_CONFIRMED_SENDER`. */
    messageKind: text('message_kind').notNull(),
    /** The version of the wording it was (or will be) rendered from, so that a later edit never rewrites what was said. */
    templateVersion: integer('template_version').notNull(),
    audience: text('audience').notNull(),
    channel: text('channel').notNull(),
    responsibleHubId: uuid('responsible_hub_id')
      .notNull()
      .references(() => hub.id),
    vendorOrganizationId: uuid('vendor_organization_id'),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    state: text('state').notNull().default('QUEUED'),
    /** Why a `SUPPRESSED` message was held back. Present exactly when the state is `SUPPRESSED`. */
    suppressionReason: text('suppression_reason'),
    /** How the last attempt or the message ended. A closed word, never a provider's text. */
    outcomeClass: text('outcome_class'),
    /** The provider's own closed, non-secret word for a refusal (`REQUEST_INVALID`), kept for the Ops log. */
    providerOutcomeClass: text('provider_outcome_class'),
    /**
     * What a message says beyond the code and the day of the record it is about, as **closed tokens and never text** (S1.23): the reason of
     * a skipped stop, which the Vendor's feed entry names. The lane copies it from the envelope's payload, for the keys the message of the
     * list declares and no others; the table holds four members at most, each a lower-case name with an upper-case token for its value, so
     * that no note, name, number or address can be kept here. The Ops log does not read it.
     */
    parameters: jsonb('parameters')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** `+233******111`: the country part and the last three digits, enough to tell two numbers apart in the log and no more. */
    destinationHint: text('destination_hint'),
    /** SHA-256 of the namespaced number, which the per-number daily limit counts on. A key to count by and not a protection. */
    destinationDigest: text('destination_digest'),
    /**
     * The first moment a place in the day's limits was reserved for the message: just before the provider was first asked. A message that
     * reserved a place may have left even when no answer says so (the answer was lost, the lane stopped in the middle of the send), so the
     * limits count it from then, unless it is known not to have left (held back, or refused). Written once, by the holder of the lease.
     */
    reservedAt: timestamp('reserved_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    /** After this a message is not sent: a confirmation that arrives after an outage of hours is noise. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    leaseOwner: text('lease_owner'),
    leaseVersion: integer('lease_version').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    providerMessageRef: text('provider_message_ref'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    /** Status checks made against the provider, and when the next is due. The network's word is polled, not pushed. */
    receiptChecks: integer('receipt_checks').notNull().default(0),
    nextReceiptCheckAt: timestamp('next_receipt_check_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    // One message of the list, to one audience, from one event: a relay that runs twice writes it once.
    unique('notification_message_key').on(table.outboxId, table.messageKind, table.audience),
    index('notification_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} IN ('QUEUED', 'RETRYABLE')`),
    index('notification_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'LEASED'`),
    index('notification_receipt_idx')
      .on(table.nextReceiptCheckAt)
      .where(sql`${table.state} = 'SENT'`),
    index('notification_hub_recent_idx').on(table.responsibleHubId, table.createdAt),
    // The Ops log filtered to the messages about one record.
    index('notification_subject_idx').on(table.subjectId, table.createdAt),
    // The daily limits count what was sent to one number, and what was sent in all.
    index('notification_number_day_idx')
      .on(table.destinationDigest, table.sentAt)
      .where(sql`${table.sentAt} IS NOT NULL`),
    index('notification_sent_idx')
      .on(table.sentAt)
      .where(sql`${table.sentAt} IS NOT NULL`),
    // ...and what was reserved and may have left without an answer that says so.
    index('notification_reserved_idx')
      .on(table.destinationDigest, table.reservedAt)
      .where(sql`${table.reservedAt} IS NOT NULL`),
    check(
      'notification_audience_closed',
      sql`${table.audience} IN (${list(NOTIFICATION_AUDIENCES)})`,
    ),
    check('notification_channel_closed', sql`${table.channel} IN (${list(NOTIFICATION_CHANNELS)})`),
    // `strict`: in the default (lax) mode a path unwraps an array, so a list of tokens would pass for a token.
    check(
      'notification_parameters_closed',
      sql`jsonb_typeof(${table.parameters}) = 'object' AND jsonb_array_length(jsonb_path_query_array(${table.parameters}, 'strict $.keyvalue()')) <= 4 AND NOT jsonb_path_exists(${table.parameters}, 'strict $.keyvalue() ? (!(@.key like_regex "^[a-z][a-z0-9_]{0,31}$"))') AND NOT jsonb_path_exists(${table.parameters}, 'strict $.* ? (@.type() != "string" || !(@ like_regex "^[A-Z][A-Z0-9_]{0,63}$"))')`,
    ),
    check('notification_state_closed', sql`${table.state} IN (${list(NOTIFICATION_STATES)})`),
    check(
      'notification_subject_closed',
      sql`${table.subjectType} IN (${list(NOTIFICATION_SUBJECT_TYPES)})`,
    ),
    check(
      'notification_suppression_closed',
      sql`${table.suppressionReason} IS NULL OR ${table.suppressionReason} IN (${list(SUPPRESSION_REASONS)})`,
    ),
    check(
      'notification_outcome_closed',
      sql`${table.outcomeClass} IS NULL OR ${table.outcomeClass} IN (${list(NOTIFICATION_OUTCOME_CLASSES)})`,
    ),
    check(
      'notification_suppressed_has_its_reason',
      sql`(${table.state} = 'SUPPRESSED') = (${table.suppressionReason} IS NOT NULL)`,
    ),
    check(
      'notification_kind_and_version',
      sql`${table.messageKind} ~ '^[A-Z][A-Z0-9_]{2,63}$' AND ${table.templateVersion} >= 1`,
    ),
    check(
      'notification_counters_nonnegative',
      sql`${table.attemptCount} >= 0 AND ${table.leaseVersion} >= 0 AND ${table.receiptChecks} >= 0`,
    ),
    check(
      'notification_lease_when_leased',
      sql`${table.state} <> 'LEASED' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.leaseVersion} >= 1 AND ${table.attemptCount} >= 1)`,
    ),
    check(
      'notification_lease_owner_bounded',
      sql`${table.leaseOwner} IS NULL OR length(${table.leaseOwner}) BETWEEN 1 AND 128`,
    ),
    // A text message has a moment it left (the provider said yes) exactly when it is sent, delivered, or failed after the provider's
    // yes; a message that never left (queued, refused, held back, expired) has none. A feed entry is not sent at all.
    check(
      'notification_sent_follows_state',
      sql`CASE WHEN ${table.channel} = 'SMS' THEN (${table.sentAt} IS NOT NULL) = (${table.state} IN ('SENT', 'DELIVERED') OR (${table.state} = 'FAILED' AND ${table.outcomeClass} = 'DELIVERY_FAILED')) ELSE ${table.sentAt} IS NULL END`,
    ),
    check(
      'notification_provider_fields_bounded',
      sql`(${table.providerMessageRef} IS NULL OR length(${table.providerMessageRef}) BETWEEN 1 AND 256) AND (${table.providerOutcomeClass} IS NULL OR ${table.providerOutcomeClass} ~ '^[A-Z][A-Z0-9_]{0,47}$') AND (${table.destinationHint} IS NULL OR length(${table.destinationHint}) <= 24) AND (${table.destinationDigest} IS NULL OR ${table.destinationDigest} ~ '^[0-9a-f]{64}$')`,
    ),
    // The network's word on a text message is its delivery time, present exactly when the state is DELIVERED; a feed entry has none.
    check(
      'notification_delivered_when_delivered',
      sql`CASE WHEN ${table.channel} = 'SMS' THEN (${table.state} = 'DELIVERED') = (${table.deliveredAt} IS NOT NULL) ELSE ${table.deliveredAt} IS NULL END`,
    ),
    check('notification_expires_after_created', sql`${table.expiresAt} > ${table.createdAt}`),
    // A place is reserved for a number: the count that reads it reads the digest beside it.
    check(
      'notification_reserved_has_its_digest',
      sql`${table.reservedAt} IS NULL OR ${table.destinationDigest} IS NOT NULL`,
    ),
  ],
);

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  DELIVERY_CHANNELS,
  DELIVERY_KINDS,
  DELIVERY_PRINCIPAL_TYPES,
  JOB_STATES,
  OUTCOME_CLASSES,
  REDEMPTION_RECORD_TYPES,
  RETRY_CLASSES,
  TERMINAL_FAILURE_CLASSES,
} from '../../delivery/delivery-vocabulary.js';
import { bytea } from './types.js';

/** `'A', 'B', 'C'`: a closed set as the text of an `IN (...)` list. The values are this module's own constants, never input. */
const list = (values: readonly string[]): ReturnType<typeof sql.raw> =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * The durable credential-delivery job (S0.17; SECURITY_DESIGN.md §13.9a; state-machines.md §22; data-scope-registry.md
 * `CredentialDeliveryJob`). One row per message a credential-issuing operation queued beside its hash-only redemption record, unique
 * on that record ("one queued message per redemption record"). The job is **delivery bookkeeping and nothing more**: the validity
 * of the credential it carries is the redemption record's alone, and no column here points at it by key, so a job's state can
 * never change that record.
 *
 * **What the row holds.** Its identity and the record it serves (kind, redemption record type and id, principal, channel); its
 * state and the schedule (attempt count, `next_attempt_at`, `expires_at`, which equals the redemption record's expiry); the lease
 * (`lease_owner`, `lease_version`, `lease_expires_at`); the provider's deduplication identity, stable across every attempt, and its
 * non-secret message reference; a closed, non-secret `outcome_class`; and the **sealed payload**: the destination and the link,
 * the only place among Melarc's stores that the raw token of a queued message lives (authenticated encryption under the
 * `credential_delivery` purpose, with the job id, kind, principal and redemption record as associated data). The destination and
 * the token exist only inside that ciphertext.
 *
 * **The payload is erased when the job ends.** A job that is `ACCEPTED`, `FAILED`, `EXPIRED` or `CANCELLED` holds no ciphertext and
 * says when it was erased, and one that is still live holds it: the database holds the two together as a CHECK, so no write of
 * any login can end a job and keep its secret, or erase the secret of a job that is still to be sent.
 *
 * This file is the *shape*. The migration (`0009_credential_delivery_job.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a `SYSTEM` context under `authentication` inserts and
 * cancels; one under `credential_delivery` reads, leases and records outcomes; everything else reads and writes nothing), the
 * grants (the API runtime inserts, updates the columns a cancellation changes and reads the columns that find a row, never the
 * payload; the worker's capability role reads the row and updates the columns a lease and an outcome change), and the guard
 * trigger that keeps the state machine and the lease fence true whoever writes.
 */
export const credentialDeliveryJob = pgTable(
  'credential_delivery_job',
  {
    /** A UUIDv7 made before the insert, because the sealed payload is bound to it. */
    id: uuid('id').primaryKey().notNull(),
    kind: text('kind').notNull(),
    redemptionRecordType: text('redemption_record_type').notNull(),
    redemptionRecordId: uuid('redemption_record_id').notNull(),
    principalType: text('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    channel: text('channel').notNull(),
    state: text('state').notNull().default('QUEUED'),
    /** Claims so far: a takeover of an expired lease counts as one. The Class 1 schedule ends at six sends (see `deferredClaims`). */
    attemptCount: integer('attempt_count').notNull().default(0),
    /**
     * Claims that ended before any provider was asked, because the worker could not open the payload or confirm the record, and said
     * so (G2-03). Those claims are not sends: the sends so far are `attempt_count - deferred_claims`, and it is those the schedule
     * counts. A claim whose worker crashes before it says anything is not here, so it still counts: it may have sent.
     */
    deferredClaims: integer('deferred_claims').notNull().default(0),
    /** When the job is next due, on the database's clock. A job that is queued is due at once. */
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    /** The end of the redemption record: a job is never leased, retried or sent past it. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    /** A worker's own name for itself, non-secret. Kept after the lease ends, as the last holder. */
    leaseOwner: text('lease_owner'),
    /** Rises by one at every claim. An outcome is written only against the version it was leased under (the fence). */
    leaseVersion: integer('lease_version').notNull().default(0),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** What the provider is asked to deduplicate on: the same for every attempt, so a retry is the same message. */
    providerDedupeId: text('provider_dedupe_id').notNull(),
    /** The provider's reference to an accepted message. Never content. */
    providerMessageRef: text('provider_message_ref'),
    outcomeClass: text('outcome_class'),
    payloadCiphertext: bytea('payload_ciphertext'),
    payloadNonce: bytea('payload_nonce'),
    payloadKeyVersion: integer('payload_key_version'),
    payloadEnvelopeVersion: smallint('payload_envelope_version'),
    /** Set when the payload was erased. */
    payloadErasedAt: timestamp('payload_erased_at', { withTimezone: true }),
    /** The statement's own time, so that `expires_at > created_at` means the message was queued before its credential ended. */
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    unique('credential_delivery_job_redemption_key').on(
      table.redemptionRecordType,
      table.redemptionRecordId,
    ),
    unique('credential_delivery_job_dedupe_key').on(table.providerDedupeId),
    // The worker claims what is due, and what has lost its lease; both are read in order, so each has its own partial index.
    index('credential_delivery_job_due_idx')
      .on(table.nextAttemptAt)
      .where(sql`${table.state} IN ('QUEUED', 'RETRYABLE')`),
    index('credential_delivery_job_lease_idx')
      .on(table.leaseExpiresAt)
      .where(sql`${table.state} = 'LEASED'`),
    // The expiry sweep and the cancellation of a principal's messages look only at jobs that can still change.
    index('credential_delivery_job_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.state} IN ('QUEUED', 'LEASED', 'RETRYABLE')`),
    index('credential_delivery_job_principal_idx')
      .on(table.principalType, table.principalId)
      .where(sql`${table.state} IN ('QUEUED', 'LEASED', 'RETRYABLE')`),
    check('credential_delivery_job_kind_closed', sql`${table.kind} IN (${list(DELIVERY_KINDS)})`),
    check(
      'credential_delivery_job_redemption_type_closed',
      sql`${table.redemptionRecordType} IN (${list(REDEMPTION_RECORD_TYPES)})`,
    ),
    // A recovery link serves a recovery request; every other kind serves a setup grant.
    check(
      'credential_delivery_job_kind_serves_its_record',
      sql`(${table.kind} = 'RECOVERY_LINK') = (${table.redemptionRecordType} = 'RECOVERY_REQUEST')`,
    ),
    check(
      'credential_delivery_job_principal_closed',
      sql`${table.principalType} IN (${list(DELIVERY_PRINCIPAL_TYPES)})`,
    ),
    check(
      'credential_delivery_job_channel_closed',
      sql`${table.channel} IN (${list(DELIVERY_CHANNELS)})`,
    ),
    check('credential_delivery_job_state_closed', sql`${table.state} IN (${list(JOB_STATES)})`),
    check(
      'credential_delivery_job_counters_nonnegative',
      sql`${table.attemptCount} >= 0 AND ${table.leaseVersion} >= 0`,
    ),
    check(
      'credential_delivery_job_deferrals_bounded',
      sql`${table.deferredClaims} >= 0 AND ${table.deferredClaims} <= ${table.attemptCount}`,
    ),
    // A job that has not been claimed has no lease, no attempt, no deferral credit and no outcome yet. The deferral credit is named
    // here (G2 follow-up, P-6) and not left to follow from `deferrals_bounded` and the attempt count: the sends the schedule allows
    // are `attempt_count - deferred_claims`, and a job that started with a credit would be sent fewer times than the schedule says.
    check(
      'credential_delivery_job_queued_is_untouched',
      sql`${table.state} <> 'QUEUED' OR (${table.attemptCount} = 0 AND ${table.deferredClaims} = 0 AND ${table.leaseVersion} = 0 AND ${table.leaseOwner} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.outcomeClass} IS NULL AND ${table.acceptedAt} IS NULL)`,
    ),
    // A leased job names its holder, a version, an attempt and when the lease ends. One that is not leased may still carry the end of
    // its last lease as history: the issuing side cancels a job that is leased without touching the lease, and nothing reads it.
    check(
      'credential_delivery_job_lease_when_leased',
      sql`${table.state} <> 'LEASED' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.leaseVersion} >= 1 AND ${table.attemptCount} >= 1)`,
    ),
    check(
      'credential_delivery_job_lease_owner_bounded',
      sql`${table.leaseOwner} IS NULL OR length(${table.leaseOwner}) BETWEEN 1 AND 128`,
    ),
    check(
      'credential_delivery_job_accepted_when_accepted',
      sql`(${table.state} = 'ACCEPTED') = (${table.acceptedAt} IS NOT NULL) AND (${table.providerMessageRef} IS NULL OR ${table.state} = 'ACCEPTED')`,
    ),
    check(
      'credential_delivery_job_provider_fields_bounded',
      sql`length(${table.providerDedupeId}) BETWEEN 16 AND 128 AND (${table.providerMessageRef} IS NULL OR length(${table.providerMessageRef}) BETWEEN 1 AND 256)`,
    ),
    // The sealed envelope is whole or absent.
    check(
      'credential_delivery_job_payload_is_whole',
      sql`(${table.payloadCiphertext} IS NULL) = (${table.payloadNonce} IS NULL) AND (${table.payloadCiphertext} IS NULL) = (${table.payloadKeyVersion} IS NULL) AND (${table.payloadCiphertext} IS NULL) = (${table.payloadEnvelopeVersion} IS NULL)`,
    ),
    // A job that can still be sent holds its payload, and one that has ended holds none and says when it was erased.
    check(
      'credential_delivery_job_payload_follows_state',
      sql`(${table.state} IN ('QUEUED', 'LEASED', 'RETRYABLE') AND ${table.payloadCiphertext} IS NOT NULL AND ${table.payloadErasedAt} IS NULL) OR (${table.state} IN ('ACCEPTED', 'FAILED', 'EXPIRED', 'CANCELLED') AND ${table.payloadCiphertext} IS NULL AND ${table.payloadErasedAt} IS NOT NULL)`,
    ),
    check(
      'credential_delivery_job_outcome_class_closed',
      sql`${table.outcomeClass} IS NULL OR ${table.outcomeClass} IN (${list(OUTCOME_CLASSES)})`,
    ),
    // The class says why the job is where it is, so each state admits only the classes that can explain it.
    check(
      'credential_delivery_job_outcome_follows_state',
      sql`(${table.state} = 'QUEUED' AND ${table.outcomeClass} IS NULL)
        OR (${table.state} = 'LEASED')
        OR (${table.state} = 'RETRYABLE' AND ${table.outcomeClass} IN (${list(RETRY_CLASSES)}))
        OR (${table.state} = 'ACCEPTED' AND ${table.outcomeClass} = 'ACCEPTED')
        OR (${table.state} = 'FAILED' AND ${table.outcomeClass} IN (${list(TERMINAL_FAILURE_CLASSES)}))
        OR (${table.state} = 'EXPIRED' AND ${table.outcomeClass} = 'EXPIRED')
        OR (${table.state} = 'CANCELLED' AND ${table.outcomeClass} = 'CANCELLED')`,
    ),
    check(
      'credential_delivery_job_expires_after_created',
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

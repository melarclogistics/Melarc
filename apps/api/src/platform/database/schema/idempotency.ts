import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from './types.js';

/**
 * The idempotency record (S0.12; SECURITY_DESIGN.md §14.16; data-scope-registry.md `IdempotencyRecord`). One row per command a
 * principal sent under an `Idempotency-Key`, unique on **principal type, principal id, operation id and key**, so one principal
 * never receives another's saved answer and one key means a different command on a different operation. The fingerprint of the
 * request is compared *inside* that identity: the same fingerprint replays the saved answer, another is a conflict.
 *
 * This file is the *shape*. The migration (`0007_idempotency_record.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a human principal reaches the records it owns and
 * no others; a `SYSTEM` context under the `authentication` capability reaches any record, to erase the sealed fields of a
 * grant it consumes), the grants (`SELECT`, `INSERT` and `UPDATE` to the API runtime; no `DELETE` for any identity: who reclaims a
 * record after its time to live is the Product Owner's decision, plan section 7.14) and a guard trigger that keeps a saved answer
 * stable and lets the sealed fields only be erased. The delivery worker's retention cleanup (S0.19, migration 0010) erases the
 * sealed fields of a record whose window has closed, under the `credential_delivery` capability.
 *
 * **The sealed columns are for one operation, `registerRiderDevice`, and no other** (§14.16): its response carries a one-time
 * enrolment payload that the hash-only rule forbids storing in the clear, so those fields alone are stored sealed
 * (authenticated encryption under the `idempotent_replay` purpose, with the principal, the operation, the record and the envelope
 * version as associated data). `sealed_expires_at` ends the window in which they may be disclosed and is judged on the database's
 * clock on every read; the transaction that consumes, supersedes or revokes the grant erases them, and the tombstone
 * (`replay_unavailable_at`) says they were there, so the command never runs twice while the record lives.
 */
export const idempotencyRecord = pgTable(
  'idempotency_record',
  {
    /** The record's own id (a UUIDv7): what the sealed envelope is bound to, and what a grant keeps to erase its replay. */
    id: uuid('id').notNull(),
    principalType: text('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    operationId: text('operation_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /** The fingerprint of the request (64 hex characters): the body itself is never stored. */
    fingerprint: text('fingerprint').notNull(),
    state: text('state').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    responseStatus: smallint('response_status'),
    /** The original response body, byte for byte, so that a replay is identical to the first answer. */
    responseBody: bytea('response_body'),
    sealedCiphertext: bytea('sealed_ciphertext'),
    sealedNonce: bytea('sealed_nonce'),
    sealedKeyVersion: integer('sealed_key_version'),
    sealedEnvelopeVersion: smallint('sealed_envelope_version'),
    sealedExpiresAt: timestamp('sealed_expires_at', { withTimezone: true }),
    /** Set when the sealed fields were erased: the secret is gone and the command still ran. */
    replayUnavailableAt: timestamp('replay_unavailable_at', { withTimezone: true }),
  },
  (table) => [
    primaryKey({
      name: 'idempotency_record_pkey',
      columns: [table.principalType, table.principalId, table.operationId, table.idempotencyKey],
    }),
    unique('idempotency_record_id_key').on(table.id),
    // The retention cleanup finds the sealed replays whose window has closed, oldest first (S0.19; G2-07, migration 0013). Partial: only
    // a record that still holds a sealed replay has an expiry, so the index holds those and no others, and an erased record leaves it.
    // The predicate is a fixed condition, never a clock: a changing predicate cannot be indexed.
    index('idempotency_record_sealed_expiry_idx')
      .on(table.sealedExpiresAt, table.id)
      .where(sql`${table.sealedExpiresAt} IS NOT NULL`),
    check(
      'idempotency_record_principal_closed',
      sql`${table.principalType} IN ('STAFF', 'RIDER', 'VENDOR')`,
    ),
    check(
      'idempotency_record_operation_grammar',
      sql`${table.operationId} ~ '^[A-Za-z][A-Za-z0-9]{0,63}$'`,
    ),
    check('idempotency_record_key_bounded', sql`length(${table.idempotencyKey}) BETWEEN 1 AND 128`),
    check('idempotency_record_fingerprint_hex', sql`${table.fingerprint} ~ '^[0-9a-f]{64}$'`),
    check('idempotency_record_state_closed', sql`${table.state} IN ('IN_PROGRESS', 'COMPLETED')`),
    // An answer exists exactly when the command is complete: all of it, or none of it.
    check(
      'idempotency_record_answer_when_completed',
      sql`(${table.state} = 'COMPLETED' AND ${table.responseStatus} IS NOT NULL AND ${table.responseBody} IS NOT NULL AND ${table.completedAt} IS NOT NULL)
        OR (${table.state} = 'IN_PROGRESS' AND ${table.responseStatus} IS NULL AND ${table.responseBody} IS NULL AND ${table.completedAt} IS NULL)`,
    ),
    check(
      'idempotency_record_status_range',
      sql`${table.responseStatus} IS NULL OR ${table.responseStatus} BETWEEN 100 AND 599`,
    ),
    // The sealed envelope is whole or absent, and a record is either sealed or tombstoned, never both.
    check(
      'idempotency_record_sealed_is_whole',
      sql`(${table.sealedCiphertext} IS NULL) = (${table.sealedNonce} IS NULL)
        AND (${table.sealedCiphertext} IS NULL) = (${table.sealedKeyVersion} IS NULL)
        AND (${table.sealedCiphertext} IS NULL) = (${table.sealedEnvelopeVersion} IS NULL)
        AND (${table.sealedCiphertext} IS NULL) = (${table.sealedExpiresAt} IS NULL)`,
    ),
    check(
      'idempotency_record_sealed_xor_tombstone',
      sql`${table.sealedCiphertext} IS NULL OR ${table.replayUnavailableAt} IS NULL`,
    ),
    check(
      'idempotency_record_sealed_only_when_completed',
      sql`${table.sealedCiphertext} IS NULL OR ${table.state} = 'COMPLETED'`,
    ),
  ],
);

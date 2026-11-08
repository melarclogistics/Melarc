import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  type PgTableExtraConfigValue,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { bytea } from '../platform/database/schema/types.js';
import { HANDSHAKE_CHANNELS, HANDSHAKE_TYPES } from './collection-record.schema.js';
import { pickupStop } from './pickup-stop.schema.js';

/** The states of `CollectionHandshake` (state-machines.md section 6). `PENDING` is the machine's name for "no code yet": no row is ever kept in it. */
export const HANDSHAKE_STATES = [
  'PENDING',
  'CODE_GENERATED',
  'CODE_DELIVERED',
  'VERIFIED',
  'EXPIRED',
  'EXHAUSTED',
  'DISPUTED',
  'MANUALLY_RESOLVED',
] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The collection handshake (S1.27, `SLICE-001`; state-machines.md section 6; `AC-SLICE-001-23`, `-24`, `-26`, `-73`): the two-party proof that the sender took
 * part in the collection, **one per stop that has been counted** (a unique key), made when the rider asks for the code (or when Ops establishes the
 * collection without one) and kept after it closes the stop, because the channel that closed it is what a fallback ratio is read from.
 *
 * - **Nothing here is a code.** `code_digest` is the keyed digest of the live code (`platform/auth/crypto/handshake-codes.ts`), which the database compares with the digest of
 *   a submitted code and no statement of the application's reads; the code itself is made again from the stop, `code_generation` and the key version
 *   `code_key_version` whenever it must be shown or texted. A code that ends (spent, superseded, expired, exhausted) leaves no digest behind.
 * - **The counters are the database's.** `attempts` counts the wrong codes of the handshake (not of one code: a fallback does not give a vendor five more
 *   guesses) and ends it at `handshake_max_wrong_attempts`; `fallback_sends` and `last_fallback_at` hold the cap and the cooldown of the SMS fallback for
 *   every caller (`SMS_FALLBACK_LIMIT_REACHED`), so a second process or a direct statement meets the same count.
 * - **The channel is always recorded when the handshake ends well** (`PORTAL`, `SMS_FALLBACK` or `OPS_OVERRIDE`, with the instant and who confirmed): a
 *   verified, overridden or manually resolved handshake with no channel is a defect the table's check refuses.
 * - **Written only by the operations of migration `0070`** (`SECURITY DEFINER` functions of the owner that the API's runtime login alone executes): the
 *   login holds `SELECT` on the columns that say where the handshake stands and none on the digest, and no `INSERT`, `UPDATE` or `DELETE` at all.
 */
export const collectionHandshake = pgTable(
  'collection_handshake',
  {
    id: uuid('id').primaryKey(),
    pickupStopId: uuid('pickup_stop_id').notNull(),
    /** The request the stop holds, carried so that the notification lane can find the one handshake of the request its envelope names. */
    pickupRequestId: uuid('pickup_request_id').notNull(),
    /** The stop's hub, carried by a composite key so that a handshake can never name another hub than its stop's. */
    responsibleHubId: uuid('responsible_hub_id').notNull(),
    /** The direction the sender's kind fixes (copied from the collection record, which holds it for the count): never configurable, never changed. */
    direction: text('direction').notNull(),
    state: text('state').notNull(),
    /** 0 until a code exists; then the number of the code: 1 for the first, one more for each fallback. */
    codeGeneration: integer('code_generation').notNull(),
    /** The keyed digest of the live code; null whenever no code is live. */
    codeDigest: bytea('code_digest'),
    codeKeyVersion: integer('code_key_version'),
    /**
     * The number of digits of the codes of this handshake: the platform's `handshake_code_length` **as it stood when the code was made**, kept so that whoever must make the
     * code again (the notification lane, the rider's retry) makes it with the length it was made with, whatever the setting says by then. It is set with the
     * code and never changes with it: a new code (a fallback) records its own. A handshake established with no code records the length the platform held then.
     */
    codeLength: smallint('code_length').notNull(),
    codeGeneratedAt: timestamp('code_generated_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    fallbackSends: integer('fallback_sends').notNull().default(0),
    lastFallbackAt: timestamp('last_fallback_at', { withTimezone: true }),
    channel: text('channel'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Who confirmed: `VENDOR_ACCOUNT`, `RIDER` or `STAFF`, and the identifier (the officer for an override or a hand resolution). */
    confirmedByType: text('confirmed_by_type'),
    confirmedById: uuid('confirmed_by_id'),
    /** The officer who authorised an override or resolved by hand (the same as `confirmed_by_id` then), and null for any other channel. */
    authorisedBy: uuid('authorised_by'),
    /** The verification note of an override, or the note of a hand resolution: Ops's own, read by no rider and no vendor. */
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The ETag source, moved by the database on every change and by nothing else. */
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      name: 'collection_handshake_stop_fkey',
      columns: [table.pickupStopId, table.responsibleHubId],
      foreignColumns: [pickupStop.id, pickupStop.responsibleHubId],
    }).onDelete('restrict'),
    // No foreign key to the request (migration 0073). The request is the stop's, which the guard checks on every insert and forbids changing, and the stop is held by the
    // request by a key of its own. A key here made every insert of a handshake take a key-share lock on the request row while it held the stop, and the cancellation of a
    // request takes the request and then its stops: a deadlock the database ended by aborting one of the two (the review of 5 November 2026).
    uniqueIndex('collection_handshake_stop_key').on(table.pickupStopId),
    index('collection_handshake_hub_state_idx').on(table.responsibleHubId, table.state),
    check(
      'collection_handshake_state_closed',
      sql.raw(`"collection_handshake"."state" IN (${quoted(HANDSHAKE_STATES)})`),
    ),
    check(
      'collection_handshake_direction_closed',
      sql.raw(`"collection_handshake"."direction" IN (${quoted(HANDSHAKE_TYPES)})`),
    ),
    check(
      'collection_handshake_channel_closed',
      sql.raw(
        `"collection_handshake"."channel" IS NULL OR "collection_handshake"."channel" IN (${quoted(HANDSHAKE_CHANNELS)})`,
      ),
    ),
    check(
      'collection_handshake_confirmer_closed',
      sql.raw(
        `"collection_handshake"."confirmed_by_type" IS NULL OR "collection_handshake"."confirmed_by_type" IN ('VENDOR_ACCOUNT', 'RIDER', 'STAFF')`,
      ),
    ),
    check('collection_handshake_code_length_range', sql`${table.codeLength} BETWEEN 4 AND 8`),
    check(
      'collection_handshake_counters',
      sql`${table.codeGeneration} >= 0 AND ${table.attempts} >= 0 AND ${table.fallbackSends} >= 0`,
    ),
    // A live code has its digest, its key version, its moment and its end; no other state has a digest (a code that ends leaves none behind).
    check(
      'collection_handshake_code_facts',
      sql`(${table.state} IN ('CODE_GENERATED', 'CODE_DELIVERED')
            AND ${table.codeDigest} IS NOT NULL AND octet_length(${table.codeDigest}) = 32 AND ${table.codeKeyVersion} >= 1
            AND ${table.codeGeneratedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.codeGeneration} >= 1)
          OR (${table.state} NOT IN ('CODE_GENERATED', 'CODE_DELIVERED') AND ${table.codeDigest} IS NULL)`,
    ),
    // A handshake that has ended well names the channel and the moment; one that has not ended has neither, and an override or a hand resolution
    // names the officer, who is the only one the other channels never name.
    check(
      'collection_handshake_confirmed_facts',
      sql`(${table.state} IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED')
            AND ${table.channel} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL
            AND ${table.confirmedByType} IS NOT NULL AND ${table.confirmedById} IS NOT NULL
            AND ((${table.channel} = 'OPS_OVERRIDE') = (${table.authorisedBy} IS NOT NULL)))
          OR (${table.state} NOT IN ('VERIFIED', 'MANUALLY_RESOLVED', 'DISPUTED')
            AND ${table.channel} IS NULL AND ${table.confirmedAt} IS NULL
            AND ${table.confirmedByType} IS NULL AND ${table.confirmedById} IS NULL AND ${table.authorisedBy} IS NULL)`,
    ),
  ],
);

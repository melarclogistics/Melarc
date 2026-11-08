import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { RIDER_PHONE_PATTERN, RIDER_STATUSES } from '../platform/auth/rider/rider-vocabulary.js';
import { hub } from '../platform/database/schema/reference-data.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The rider identity, **minimal** (S0.53; domain-model.md section 6.8 `RiderIdentity`; data-scope-registry.md `RiderIdentity`): who the
 * rider is, where the rider belongs, and the PIN the rider sets privately at enrolment. It is the second use of the `staff` domain folder
 * for an identity (staff and rider identities and devices are that domain's, plan section 3, placement). **Nothing in this slice creates,
 * renames, moves, suspends or offboards a rider**: that is SLICE-009's (OQ-089), and the rows of a demonstration come from the non-production
 * fixture (MIGRATION_AND_SEEDING.md section 4a, `db:seed --rider-fixture`, which is refused in production).
 *
 * - **The phone is unique and E.164** (section 3.4): what the rider types at sign-in and what the challenge is bound to. It is a number
 *   no real person holds in the fixture. The collision with an ad-hoc sender (section 30) is enforced where a rider is created.
 * - **The status is manually set** (`ACTIVE`, `INACTIVE`, `TEMPORARILY_UNAVAILABLE`, `SUSPENDED`, `OFFBOARDED`; section 30.6). Authentication
 *   readiness is derived and never stored: `ACTIVE`, an established PIN and an `ACTIVE` device that carries a public key.
 * - **The hub is the primary hub** and is stable: a temporary assignment is another entity and never overwrites it (section 34.9).
 * - **The PIN is a hash, the moment it was established and its generation**, null (and zero) until the rider sets it at enrolment, and together.
 *   The generation says which PIN a sign-in verified: it rises by one when the PIN is set or replaced (a first enrolment, a replacement
 *   handset), and a rehash at a new cost keeps it, exactly as the staff credential's does. **The registering officer never sees or chooses it.**
 * - **The lockout** (`failed_attempt_count`, `locked_until`) lives on the PIN record, is never returned by any operation and is no part of the
 *   record's version, so an identifier that does not exist has no counter. It counts only a wrong PIN after a valid signature
 *   (SECURITY_DESIGN.md section 13.4b).
 * - **The hash is not readable through the table by the API runtime**: that login holds `SELECT` on every column but `pin_hash`, so no
 *   statement under it, in any context, can select it; the authentication capability reads it through `melarc.rider_pin_hash`.
 *
 * This file is the *shape*. The migration (`0040_rider_identity_and_devices.sql`) adds by hand, in the same change: the owner (`melarc_owner`),
 * `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies, the grants, the guard, the functions and the fixture's entry point.
 */
export const riderIdentity = pgTable(
  'rider_identity',
  {
    id: uuid('id').primaryKey(),
    /** E.164, unique. */
    phone: text('phone').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').notNull(),
    /** Stable: a temporary assignment never overwrites it. */
    primaryHubId: uuid('primary_hub_id').notNull(),
    /** The Argon2id hash string of the PIN: null until the rider establishes it at enrolment. */
    pinHash: text('pin_hash'),
    pinEstablishedAt: timestamp('pin_established_at', { withTimezone: true }),
    /** 0 while there is no PIN; 1 or more once there is, raised by one on every replacement and unchanged by a rehash. */
    credentialGeneration: bigint('credential_generation', { mode: 'number' }).notNull().default(0),
    failedAttemptCount: integer('failed_attempt_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No cascade: a hub that a rider belongs to is never removed under it.
    foreignKey({
      name: 'rider_identity_primary_hub_fkey',
      columns: [table.primaryHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    uniqueIndex('rider_identity_phone_key').on(table.phone),
    check(
      'rider_identity_status_closed',
      sql.raw(`"rider_identity"."status" IN (${quoted(RIDER_STATUSES)})`),
    ),
    check(
      'rider_identity_phone_shape',
      sql.raw(`"rider_identity"."phone" ~ '${RIDER_PHONE_PATTERN}'`),
    ),
    check('rider_identity_name_not_empty', sql`length(btrim(${table.fullName})) > 0`),
    check(
      'rider_identity_pin_whole',
      sql`(${table.pinHash} IS NULL) = (${table.pinEstablishedAt} IS NULL)
        AND (${table.pinHash} IS NULL) = (${table.credentialGeneration} = 0)`,
    ),
    check('rider_identity_generation_non_negative', sql`${table.credentialGeneration} >= 0`),
    check(
      'rider_identity_pin_bounded',
      sql`${table.pinHash} IS NULL OR length(${table.pinHash}) BETWEEN 1 AND 1024`,
    ),
    check('rider_identity_failed_attempts_non_negative', sql`${table.failedAttemptCount} >= 0`),
    // A lock is a consequence of failures: it exists only while the count is above zero, and only for a rider who holds a PIN to lock.
    check(
      'rider_identity_lock_has_failures',
      sql`${table.lockedUntil} IS NULL OR (${table.failedAttemptCount} > 0 AND ${table.credentialGeneration} > 0)`,
    ),
  ],
);

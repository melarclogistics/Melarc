import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { hub, roleBundle } from '../platform/database/schema/reference-data.js';

/** The five statuses of a staff identity (domain-model.md §6.8; state-machines.md §13.3). */
export const STAFF_STATUSES = [
  'PENDING_APPROVAL',
  'ACTIVE',
  'REJECTED',
  'SUSPENDED',
  'OFFBOARDED',
] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/** How an identity came to exist: the seed that creates the two bootstrap administrators, or a maker's request (domain-model.md §6.8). */
export const STAFF_ORIGINS = ['BOOTSTRAP', 'MAKER_CHECKER'] as const;
export type StaffOrigin = (typeof STAFF_ORIGINS)[number];

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The staff identity, **minimal** (S0.24; domain-model.md §6.8 `StaffIdentity`; data-scope-registry.md `StaffIdentity`): the columns
 * that authentication and the session-issue protocol read, and the ones whose absence would make a later task rewrite the table.
 * It is the first use of the `staff` domain folder, an existing permission domain. What later tasks add is theirs to say in their
 * own migrations: the failed-attempt count and lock time of the credential (S0.32), `phone`, the record version and the permission
 * review history (the staff operations from S0.35 on). Nothing writes a row in this task: the bootstrap seed (S0.30) and
 * `createStaffIdentity` do, and the tests arrange identities as the administrator.
 *
 * - **`origin` is immutable** (`BOOTSTRAP` or `MAKER_CHECKER`, set once at creation and never inferred). The API runtime holds no
 *   `UPDATE` on it and a trigger refuses a change by any login.
 * - **A work email has one canonical form** (trimmed, NFKC, lower-cased as a whole; the credential rules of S0.3 compute it). The
 *   address is stored as entered beside it, and the canonical form decides uniqueness among identities that are not `REJECTED`: a
 *   rejected profile releases its address.
 * - **The credential is a hash, the moment it was established and its generation**, null (and zero) until the employee establishes
 *   it through a setup grant, and together. The **generation** is what says which credential a sign-in verified: it goes up by one
 *   when a credential is replaced (a setup, a recovery, a reset, a change) and stays when the same credential is rehashed at a new
 *   cost. A trigger refuses a jump of the generation, a rollback of it, and a change of the moment without a new generation; the moment
 *   may equal the previous one. The database cannot tell a replacement from a rehash by the hash string, so the writers keep the two
 *   apart (OB-128). The moment is for reading (chronology) and is not an identifier: a
 *   clock repeats, steps back, and a timestamp read into a JavaScript date loses its microseconds. Being approved and being able to
 *   authenticate are different conditions: an `ACTIVE` identity with no established credential grants nothing.
 * - **The hash is not readable through the table by the API runtime.** That login holds `SELECT` on every column but
 *   `credential_hash`, so no statement under it, in any context (a staff member reading their own row included), can select it; the
 *   authentication capability reads it through `melarc.staff_credential_hash`, which refuses any other context. The runtime holds
 *   `UPDATE` on the credential columns (which is also what lets the identity lock be taken) and on nothing else. This is a boundary
 *   between application roles, not a claim about the owner role or the migration login.
 * - **`created_by` and `approved_by`** are the maker and the checker of §30.8: the checker is null exactly while the profile is
 *   `PENDING_APPROVAL`, and is never the maker, but for the two seeded bootstrap identities, where both are the reserved system actor.
 *
 * This file is the *shape*. The migration (`0016_staff_identity_and_session.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a staff member reads their own row; a `SYSTEM` context
 * under the `authentication` capability alone reads and updates), the grants (`SELECT` on every column but the hash, and an `UPDATE`
 * of the three credential columns only, to the API runtime, which is also what lets the identity lock be taken), the function that
 * reads the hash for the authentication capability, and the guard trigger.
 */
export const staffIdentity = pgTable(
  'staff_identity',
  {
    id: uuid('id').primaryKey(),
    /** As entered. */
    workEmail: text('work_email').notNull(),
    /** Trimmed, NFKC, lower-cased: the form that is unique and that the sign-in rate limit is keyed on. */
    workEmailCanonical: text('work_email_canonical').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').notNull(),
    /** The one bundle whose permissions the identity holds; authorization tests the permission, never this id. */
    roleBundleId: uuid('role_bundle_id').notNull(),
    /** Null for the HQ roles that have cross-hub authority. */
    primaryHubId: uuid('primary_hub_id'),
    /** The Argon2id hash string of the password: null until it is established. */
    credentialHash: text('credential_hash'),
    credentialEstablishedAt: timestamp('credential_established_at', { withTimezone: true }),
    /** 0 while there is no credential; 1 or more once there is, raised by one on every replacement and unchanged by a rehash. */
    credentialGeneration: bigint('credential_generation', { mode: 'number' }).notNull().default(0),
    createdBy: uuid('created_by').notNull(),
    approvedBy: uuid('approved_by'),
    origin: text('origin').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No cascade: a bundle or a hub that an identity refers to is never removed under it.
    foreignKey({
      name: 'staff_identity_bundle_fkey',
      columns: [table.roleBundleId],
      foreignColumns: [roleBundle.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'staff_identity_primary_hub_fkey',
      columns: [table.primaryHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    // The canonical address is unique among the identities that still hold theirs: a REJECTED profile releases it.
    uniqueIndex('staff_identity_work_email_live_key')
      .on(table.workEmailCanonical)
      .where(sql`${table.status} <> 'REJECTED'`),
    check(
      'staff_identity_status_closed',
      sql.raw(`"staff_identity"."status" IN (${quoted(STAFF_STATUSES)})`),
    ),
    check(
      'staff_identity_origin_closed',
      sql.raw(`"staff_identity"."origin" IN (${quoted(STAFF_ORIGINS)})`),
    ),
    check(
      'staff_identity_email_shape',
      sql`length(${table.workEmail}) BETWEEN 3 AND 320
        AND length(${table.workEmailCanonical}) BETWEEN 3 AND 320
        AND ${table.workEmailCanonical} = btrim(${table.workEmailCanonical})`,
    ),
    check('staff_identity_name_not_empty', sql`length(btrim(${table.fullName})) > 0`),
    // The checker is set exactly when the profile has left PENDING_APPROVAL (§30.8, §30.9).
    check(
      'staff_identity_checker_by_status',
      sql`(${table.status} = 'PENDING_APPROVAL') = (${table.approvedBy} IS NULL)`,
    ),
    // The creator cannot approve their own profile: the two seeded bootstrap records are the exception that holds both actors.
    check(
      'staff_identity_checker_is_not_maker',
      sql`${table.origin} = 'BOOTSTRAP' OR ${table.approvedBy} IS NULL OR ${table.approvedBy} <> ${table.createdBy}`,
    ),
    check(
      'staff_identity_credential_whole',
      sql`(${table.credentialHash} IS NULL) = (${table.credentialEstablishedAt} IS NULL)
        AND (${table.credentialHash} IS NULL) = (${table.credentialGeneration} = 0)`,
    ),
    check(
      'staff_identity_credential_generation_non_negative',
      sql`${table.credentialGeneration} >= 0`,
    ),
    check(
      'staff_identity_credential_bounded',
      sql`${table.credentialHash} IS NULL OR length(${table.credentialHash}) BETWEEN 1 AND 1024`,
    ),
  ],
);

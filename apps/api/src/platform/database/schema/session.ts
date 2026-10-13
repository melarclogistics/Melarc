import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  CLIENT_ROOT_SIGNALS,
  SESSION_PRINCIPAL_TYPES,
  SESSION_TERMINATION_REASONS,
} from '../../auth/ports/session-store.port.js';
import { roleBundle } from './reference-data.js';
import { bytea } from './types.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The session (S0.24; domain-model.md §6.8 `Session`; SECURITY_DESIGN.md §13; data-scope-registry.md `Session`). **The row is the
 * whole mechanism of authentication and of revocation** (§15.3): every request looks the session up by the hash of its token, and
 * ending it is a state change on this row and nothing else. There is no blocklist, no cache and no second store.
 *
 * - **The state is derived.** A session is `ACTIVE` exactly while `terminated_at` is null; `termination_reason` is set with it and
 *   never alone. There is no `state` column to disagree with the two that carry it.
 * - **The authority is a copy.** `bundle_snapshot` is the bundle as held at issue (the format is `BUNDLE_SNAPSHOT_FORMAT`);
 *   `bundle_id` and `bundle_revision` are its lineage, which is how a reduction finds the sessions it ends (`bundle_revision`
 *   against the bundle's `reduction_floor`). `policy_revision` is the compiled fixed-policy revision of the instance that issued a
 *   Vendor or Rider session, and null for staff.
 * - **Only a hash of the token is stored** (`token_hash`, the SHA-256 of the 32 decoded bytes, `TokenService.hash`), unique.
 * - **Time is the database's.** `issued_at` and `last_activity_at` are the fresh database time of the issue decision, and `expires_at`
 *   is `issued_at` plus the lifetime of the session's tier; whether a session has expired is judged at request time on a fresh
 *   database time (`now >= expires_at`, equality is expired; for a browser session also `now - last_activity_at >= idle`).
 *
 * This file is the *shape*. The migration (`0016_staff_identity_and_session.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (a principal reads its own sessions; a `SYSTEM` context
 * under the `authentication` capability alone reads, inserts and updates), the grants (`SELECT`, `INSERT` and an `UPDATE` of the
 * three columns a session's life changes, to the API runtime; no `DELETE` for any identity), the guard trigger that keeps everything
 * else immutable and an ended session ended, and the partial index that keeps a vendor account and a rider to one live session.
 */
export const session = pgTable(
  'session',
  {
    /** The session's own id (a UUIDv7). */
    id: uuid('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    /** A `StaffIdentity`, `RiderIdentity` or `VendorAccount` id: which table is `principal_type`'s to say, so there is no foreign key. */
    principalId: uuid('principal_id').notNull(),
    bundleSnapshot: jsonb('bundle_snapshot').notNull(),
    bundleId: uuid('bundle_id').notNull(),
    bundleRevision: integer('bundle_revision').notNull(),
    policyRevision: integer('policy_revision'),
    authorizedHubIds: uuid('authorized_hub_ids').array().notNull(),
    /** Non-null for `RIDER` and `VENDOR`, null for `STAFF`. The registered-device tables come with the tasks that sign those in. */
    registeredDeviceId: uuid('registered_device_id'),
    clientRootSignal: text('client_root_signal'),
    /** The SHA-256 of the session token: 32 bytes. */
    tokenHash: bytea('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull(),
    /** The hash of the synchronizer token of a browser session (32 bytes). Null for a rider. */
    csrfTokenHash: bytea('csrf_token_hash'),
    terminatedAt: timestamp('terminated_at', { withTimezone: true }),
    terminationReason: text('termination_reason'),
  },
  (table) => [
    foreignKey({
      name: 'session_bundle_fkey',
      columns: [table.bundleId],
      foreignColumns: [roleBundle.id],
    }).onDelete('restrict'),
    // The lookup of every request: by the hash of the token, and nothing else finds a session by what it presents.
    uniqueIndex('session_token_hash_key').on(table.tokenHash),
    // Ending a principal's sessions, and the live ones of a principal in lock order (by id).
    index('session_principal_live_idx')
      .on(table.principalType, table.principalId, table.id)
      .where(sql`${table.terminatedAt} IS NULL`),
    // Ending the sessions a reduction of a bundle reaches: the live ones of a bundle, below a revision.
    index('session_bundle_live_idx')
      .on(table.bundleId, table.bundleRevision, table.id)
      .where(sql`${table.terminatedAt} IS NULL`),
    // A vendor account has at most one live session and a rider one: a new login ends the earlier before it inserts its own, and the
    // database refuses a second live session whatever the application does (domain-model.md §6.8 invariants).
    uniqueIndex('session_one_live_vendor_or_rider_key')
      .on(table.principalType, table.principalId)
      .where(sql`${table.terminatedAt} IS NULL AND ${table.principalType} IN ('VENDOR', 'RIDER')`),
    check(
      'session_principal_closed',
      sql.raw(`"session"."principal_type" IN (${quoted(SESSION_PRINCIPAL_TYPES)})`),
    ),
    check('session_token_hash_is_sha256', sql`octet_length(${table.tokenHash}) = 32`),
    check(
      'session_csrf_token_hash_is_sha256',
      sql`${table.csrfTokenHash} IS NULL OR octet_length(${table.csrfTokenHash}) = 32`,
    ),
    // A browser session (staff, vendor) holds the hash of its synchronizer token, which the CSRF check compares the echoed token with;
    // a rider's bearer credential is not attached by a browser, so it has none.
    check(
      'session_csrf_by_principal',
      sql`(${table.principalType} = 'RIDER') = (${table.csrfTokenHash} IS NULL)`,
    ),
    check('session_bundle_revision_positive', sql`${table.bundleRevision} >= 1`),
    // The compiled fixed-policy revision belongs to the two audiences that have a fixed policy, and to no staff session.
    check(
      'session_policy_revision_by_principal',
      sql`(${table.principalType} = 'STAFF' AND ${table.policyRevision} IS NULL)
        OR (${table.principalType} IN ('VENDOR', 'RIDER') AND ${table.policyRevision} IS NOT NULL AND ${table.policyRevision} >= 1)`,
    ),
    check(
      'session_device_by_principal',
      sql`(${table.principalType} = 'STAFF') = (${table.registeredDeviceId} IS NULL)`,
    ),
    check(
      'session_root_signal_rider_only',
      sql.raw(
        `"session"."client_root_signal" IS NULL OR ("session"."principal_type" = 'RIDER' AND "session"."client_root_signal" IN (${quoted(CLIENT_ROOT_SIGNALS)}))`,
      ),
    ),
    check('session_snapshot_is_object', sql`jsonb_typeof(${table.bundleSnapshot}) = 'object'`),
    check('session_hub_ids_not_null', sql`array_position(${table.authorizedHubIds}, NULL) IS NULL`),
    check('session_expires_after_issue', sql`${table.expiresAt} > ${table.issuedAt}`),
    check('session_activity_not_before_issue', sql`${table.lastActivityAt} >= ${table.issuedAt}`),
    // An ended session says when and why, together; the reason is one of the contract's thirteen.
    check(
      'session_termination_whole',
      sql`(${table.terminatedAt} IS NULL) = (${table.terminationReason} IS NULL)`,
    ),
    check(
      'session_termination_reason_closed',
      sql.raw(
        `"session"."termination_reason" IS NULL OR "session"."termination_reason" IN (${quoted(SESSION_TERMINATION_REASONS)})`,
      ),
    ),
    check(
      'session_terminated_not_before_issue',
      sql`${table.terminatedAt} IS NULL OR ${table.terminatedAt} >= ${table.issuedAt}`,
    ),
  ],
);

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  CONTINUATION_PURPOSE,
  EPISODE_PURPOSES,
  GRANT_PRINCIPAL_TYPES,
  GRANT_TOKEN_HASH_BYTES,
  NO_EXPIRY_PURPOSE,
  PURPOSES_OF_PRINCIPAL,
  RIDER_DEVICE_PURPOSES,
  SETUP_GRANT_PURPOSES,
  SETUP_GRANT_STATES,
} from '../../auth/setup-grants/setup-grant-vocabulary.js';
import { bytea } from './types.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/** `column` is one of `values`, as the text of a CHECK: the closed set of the code, written into the table. */
const oneOf = (column: string, values: readonly string[]): string =>
  `"setup_grant"."${column}" IN (${quoted(values)})`;

/**
 * The setup grant (S0.29; domain-model.md §6.8 `SetupGrant`; state-machines.md §19; SECURITY_DESIGN.md §13.9; data-scope-registry.md
 * `SetupGrant`). **The record that makes the first credential executable**: a single-use, principal-bound, purpose-bound grant, stored
 * as a hash. It confers no authority and is not a session. Nothing issues one to a person in this task: the bootstrap seed (S0.30), the
 * credential operations (S0.31, S0.36) and the vendor and rider tasks do, and the store of `platform/auth/setup-grants/` is what they use.
 *
 * - **Only a hash of the token is stored** (`token_hash`, the SHA-256 of the 32 decoded bytes, `TokenService.hash`), unique. The
 *   raw token exists, sealed, in the payload of the delivery job of the grants that travel as a message, until the provider accepts it.
 * - **The state is the machine's** (`PENDING`, then one terminal state). A `BEFORE UPDATE` trigger holds every login to it: only a
 *   `PENDING` grant changes, a consumption is judged on the database's clock (a grant is consumed only before it expires), an expiry
 *   only once it has passed (`BOOTSTRAP_SETUP` has none and so never expires), and nothing but `state` and `consumed_at` ever changes.
 * - **One `PENDING` grant of a purpose for a principal** (`setup_grant_one_pending_key`): a new grant of the purpose supersedes the
 *   live one first, so there is never a second token that works.
 * - **The lineage is explicit and written once.** `episode_id` (a reset episode: only on the two MFA purposes),
 *   `supersedes_grant_id` (the earlier `PENDING` grant of the same purpose, principal and episode that this one replaced) and
 *   `continued_from_grant_id` (the `CONSUMED` grant whose consumption produced this continuation) are set at insert and never
 *   updated: the API holds no `UPDATE` on them and the trigger refuses a change by any login. A grant carries at most one of the two
 *   references. Each is a **composite foreign key that includes the principal**, so a grant can only name a grant of the same
 *   `principal_type` and `principal_id`; a trigger on insert holds the rest (the target's state, purpose and episode).
 * - **No separate ledger.** An episode is a `uuid` carried by the records that belong to it; the relationships are the columns. A
 *   factor's episode is checked against this table at commit (`mfa_factor`).
 *
 * This file is the *shape*. The migration (`0018_setup_grant_and_mfa_factor.sql`) adds by hand, in the same change: the owner
 * (`melarc_owner`), `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability reads, inserts and
 * updates; the delivery worker's `credential_delivery` capability reads state and expiry only), the grants (no `DELETE` for any
 * identity, and an `UPDATE` of the two columns a grant's life changes), and the two guard triggers.
 */
export const setupGrant = pgTable(
  'setup_grant',
  {
    /** The grant's own id (a UUIDv7). */
    id: uuid('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    /** A `StaffIdentity`, `RiderIdentity` or `VendorAccount` id: which table is `principal_type`'s to say, so there is no foreign key. */
    principalId: uuid('principal_id').notNull(),
    purpose: text('purpose').notNull(),
    /** The SHA-256 of the token: 32 bytes. */
    tokenHash: bytea('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    /** Null for `BOOTSTRAP_SETUP` alone. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    state: text('state').notNull(),
    /** The authorising actor of an administrative issue; null for a grant the system issued. */
    issuedBy: uuid('issued_by'),
    /** The reset episode an `MFA_REENROLMENT` or `MFA_ENROLMENT` grant was issued in; null for any other grant. Written once. */
    episodeId: uuid('episode_id'),
    /** The earlier `PENDING` grant of the same purpose, principal and episode that this one replaced. Written once. */
    supersedesGrantId: uuid('supersedes_grant_id'),
    /** The `CONSUMED` grant whose consumption produced this continuation. Written once. */
    continuedFromGrantId: uuid('continued_from_grant_id'),
    /** The hash of the single-use attestation challenge issued beside a rider's device grant: 32 bytes, for those two purposes alone. */
    attestationChallengeHash: bytea('attestation_challenge_hash'),
    /**
     * The idempotency record of the `registerRiderDevice` call that issued this grant, whose response held the grant's token and challenge
     * sealed for a bounded replay (S0.53, migration 0040; SECURITY_DESIGN.md section 14.16): for a `RIDER_DEVICE_ENROLMENT` grant alone, and
     * written once. **The window of that replay ends when the grant leaves `PENDING`** (consumed, superseded or expired): a trigger erases
     * the sealed fields in the same statement, so no writer can end a grant and leave a secret behind. A reference and not a foreign key:
     * a record is reclaimable after `idempotency_record_ttl_hours` and a grant is kept for good.
     */
    idempotencyRecordId: uuid('idempotency_record_id'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    // The target of the two composite references: a grant is named together with its principal.
    unique('setup_grant_principal_key').on(table.id, table.principalType, table.principalId),
    foreignKey({
      name: 'setup_grant_supersedes_fkey',
      columns: [table.supersedesGrantId, table.principalType, table.principalId],
      foreignColumns: [table.id, table.principalType, table.principalId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'setup_grant_continued_from_fkey',
      columns: [table.continuedFromGrantId, table.principalType, table.principalId],
      foreignColumns: [table.id, table.principalType, table.principalId],
    }).onDelete('restrict'),
    // A presented token is found by its hash and by nothing else.
    uniqueIndex('setup_grant_token_hash_key').on(table.tokenHash),
    // At most one live grant of a purpose for a principal.
    uniqueIndex('setup_grant_one_pending_key')
      .on(table.principalType, table.principalId, table.purpose)
      .where(sql`${table.state} = 'PENDING'`),
    // A predecessor is named by at most one successor.
    uniqueIndex('setup_grant_supersedes_key')
      .on(table.supersedesGrantId)
      .where(sql`${table.supersedesGrantId} IS NOT NULL`),
    // The episodes of a principal: what a factor's episode is checked against at commit.
    index('setup_grant_episode_idx')
      .on(table.principalType, table.principalId, table.episodeId)
      .where(sql`${table.episodeId} IS NOT NULL`),
    check('setup_grant_principal_closed', sql.raw(oneOf('principal_type', GRANT_PRINCIPAL_TYPES))),
    check('setup_grant_purpose_closed', sql.raw(oneOf('purpose', SETUP_GRANT_PURPOSES))),
    check('setup_grant_state_closed', sql.raw(oneOf('state', SETUP_GRANT_STATES))),
    check(
      'setup_grant_purpose_by_principal',
      sql.raw(
        GRANT_PRINCIPAL_TYPES.map(
          (type) =>
            `("setup_grant"."principal_type" = '${type}' AND ${oneOf('purpose', PURPOSES_OF_PRINCIPAL[type])})`,
        ).join('\n        OR '),
      ),
    ),
    check(
      'setup_grant_token_hash_is_sha256',
      sql.raw(`octet_length("setup_grant"."token_hash") = ${String(GRANT_TOKEN_HASH_BYTES)}`),
    ),
    // No expiry for the bootstrap secret and an expiry after the issue for every other purpose.
    check(
      'setup_grant_expiry_by_purpose',
      sql.raw(
        `("setup_grant"."expires_at" IS NULL) = ("setup_grant"."purpose" = '${NO_EXPIRY_PURPOSE}')
        AND ("setup_grant"."expires_at" IS NULL OR "setup_grant"."expires_at" > "setup_grant"."issued_at")`,
      ),
    ),
    // A grant says when it was consumed exactly when it has been, and not before it was issued.
    check(
      'setup_grant_consumed_whole',
      sql`(${table.state} = 'CONSUMED') = (${table.consumedAt} IS NOT NULL)
        AND (${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.issuedAt})`,
    ),
    check(
      'setup_grant_episode_by_purpose',
      sql.raw(`"setup_grant"."episode_id" IS NULL OR ${oneOf('purpose', EPISODE_PURPOSES)}`),
    ),
    check(
      'setup_grant_attestation_by_purpose',
      sql.raw(
        `(${oneOf('purpose', RIDER_DEVICE_PURPOSES)}) = ("setup_grant"."attestation_challenge_hash" IS NOT NULL)
        AND ("setup_grant"."attestation_challenge_hash" IS NULL OR octet_length("setup_grant"."attestation_challenge_hash") = ${String(GRANT_TOKEN_HASH_BYTES)})`,
      ),
    ),
    check(
      'setup_grant_replay_by_purpose',
      sql.raw(
        `"setup_grant"."idempotency_record_id" IS NULL OR "setup_grant"."purpose" = 'RIDER_DEVICE_ENROLMENT'`,
      ),
    ),
    check(
      'setup_grant_one_lineage',
      sql`NOT (${table.supersedesGrantId} IS NOT NULL AND ${table.continuedFromGrantId} IS NOT NULL)`,
    ),
    check(
      'setup_grant_no_self_lineage',
      sql`${table.supersedesGrantId} IS DISTINCT FROM ${table.id} AND ${table.continuedFromGrantId} IS DISTINCT FROM ${table.id}`,
    ),
    check(
      'setup_grant_continuation_is_enrolment',
      sql.raw(
        `"setup_grant"."continued_from_grant_id" IS NULL OR "setup_grant"."purpose" = '${CONTINUATION_PURPOSE}'`,
      ),
    ),
  ],
);

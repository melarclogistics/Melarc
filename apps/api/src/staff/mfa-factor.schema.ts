import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  FACTOR_COUNTER_PATTERN,
  FACTOR_CREATED_BY_PURPOSES,
  FACTOR_STATUSES,
  FACTOR_TYPES,
  SEALED_NONCE_BYTES,
  SEALED_TAG_BYTES,
} from '../platform/auth/mfa/mfa-vocabulary.js';
import { bytea } from '../platform/database/schema/types.js';
import { staffIdentity } from './staff-identity.schema.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

const oneOf = (column: string, values: readonly string[]): string =>
  `"mfa_factor"."${column}" IN (${quoted(values)})`;

/**
 * The MFA factor (S0.29; domain-model.md §6.8 `MfaFactor`; state-machines.md §18; SECURITY_DESIGN.md §13; data-scope-registry.md
 * `MfaFactor`). **This record, not a boolean, is the authority on whether a privileged identity has a second factor**: an identity is
 * authentication-ready for a privileged bundle only while an `ACTIVE` factor exists, and `PENDING` grants nothing. It sits in `src/staff/`
 * beside the identity it is bound to, so that the foreign key can name the identity's table (the platform may not import a domain);
 * the code that reads and writes it is `platform/auth/mfa/`.
 *
 * - **The secret is sealed, never hashed** (the server must recompute codes from it): `secret_ciphertext`, `secret_nonce`,
 *   `secret_key_version` and `secret_envelope_version`, as `SecretCipher` makes them, with the context derived from this row (OB-39).
 * - **At most one `ACTIVE` factor per identity** (`mfa_factor_one_active_key`). A factor is created `PENDING` and in no other state
 *   (a trigger), becomes `ACTIVE` when a code has been proven (`enrolled_at` is set then), and ends `REVOKED`, which is terminal.
 * - **The lineage is in two classes** (domain-model.md §6.8, "Which columns are written when"). *Immutable after insert:*
 *   `staff_identity_id`, `created_by_purpose` and `created_episode_id` (the API holds no `UPDATE` on them and a trigger refuses a change
 *   by any login). *Assigned once, later:* `revocation_episode_id`, whose one legal write is null to a reset episode of the same
 *   identity, in the statement that sets `status` to `REVOKED` and `revoked_by`; a `BEFORE UPDATE` trigger refuses any other change
 *   of it, and a constraint trigger deferred to commit requires a setup grant of the same identity and episode to exist (for the
 *   created episode as well). The API holds `UPDATE` only on the columns a factor's life changes, never table-wide.
 * - **An administrative revocation is three facts together:** `revoked_by` (never the identity itself), `revocation_reason_code` and
 *   `revocation_episode_id`. A revocation by the system (an abandoned enrolment, a replacement) has none of them.
 * - **`last_verified_counter`** is the time step of the last accepted code, decimal text, which only moves forward: a code may not be
 *   accepted twice within its window.
 *
 * This file is the *shape*. The migration (`0018_setup_grant_and_mfa_factor.sql`) adds by hand, in the same change: the owner, `ENABLE`
 * and `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability alone), the column-level grants, the two guard
 * triggers and the deferred constraint trigger.
 */
export const mfaFactor = pgTable(
  'mfa_factor',
  {
    /** The factor's own id (a UUIDv7). **It is not an order**: two made in one millisecond are not ordered, and nothing orders them across a clock that steps back (`ordinal` is). */
    id: uuid('id').primaryKey(),
    staffIdentityId: uuid('staff_identity_id').notNull(),
    /**
     * The place of the factor among the identity's factors, from one, **allocated by the database** under the identity's lock when the
     * factor is created (migration 0025) and never changed. It is the only order of an identity's factors: "the most recent" is the
     * greatest ordinal, never the greatest id.
     */
    ordinal: integer('ordinal').notNull(),
    factorType: text('factor_type').notNull(),
    status: text('status').notNull(),
    secretCiphertext: bytea('secret_ciphertext').notNull(),
    secretNonce: bytea('secret_nonce').notNull(),
    secretKeyVersion: integer('secret_key_version').notNull(),
    secretEnvelopeVersion: integer('secret_envelope_version').notNull(),
    /** Non-null from `ACTIVE`: when a generated code was proven. */
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** The time step of the last accepted code, as decimal text that only moves forward. */
    lastVerifiedCounter: text('last_verified_counter'),
    /** The purpose of the grant whose consumption created the factor. Immutable. */
    createdByPurpose: text('created_by_purpose').notNull(),
    /** The administrator who revoked the factor; null when the system did. Never the identity itself. */
    revokedBy: uuid('revoked_by'),
    revocationReasonCode: text('revocation_reason_code'),
    /** The reset episode a re-enrolment created the factor in; null for onboarding and bootstrap. Immutable. */
    createdEpisodeId: uuid('created_episode_id'),
    /** The reset episode of an administrative revocation. Assigned once, with the revocation. */
    revocationEpisodeId: uuid('revocation_episode_id'),
  },
  (table) => [
    foreignKey({
      name: 'mfa_factor_staff_identity_fkey',
      columns: [table.staffIdentityId],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mfa_factor_revoked_by_fkey',
      columns: [table.revokedBy],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    // At most one proven factor per identity.
    uniqueIndex('mfa_factor_one_active_key')
      .on(table.staffIdentityId)
      .where(sql`${table.status} = 'ACTIVE'`),
    // An identity's factors by id: the order their rows are locked in (not their chronology).
    index('mfa_factor_identity_idx').on(table.staffIdentityId, table.id),
    // One place for each factor of an identity, and the order the sign-in and the reset read the most recent by.
    uniqueIndex('mfa_factor_identity_ordinal_key').on(table.staffIdentityId, table.ordinal),
    check('mfa_factor_type_closed', sql.raw(oneOf('factor_type', FACTOR_TYPES))),
    check('mfa_factor_status_closed', sql.raw(oneOf('status', FACTOR_STATUSES))),
    check(
      'mfa_factor_purpose_closed',
      sql.raw(oneOf('created_by_purpose', FACTOR_CREATED_BY_PURPOSES)),
    ),
    check(
      'mfa_factor_secret_whole',
      sql.raw(
        `octet_length("mfa_factor"."secret_nonce") = ${String(SEALED_NONCE_BYTES)}
        AND octet_length("mfa_factor"."secret_ciphertext") > ${String(SEALED_TAG_BYTES)}
        AND "mfa_factor"."secret_key_version" >= 1
        AND "mfa_factor"."secret_envelope_version" >= 1`,
      ),
    ),
    // Enrolled exactly from ACTIVE on (a REVOKED factor keeps the moment if it had one), and revoked exactly when REVOKED.
    check(
      'mfa_factor_enrolment_follows_status',
      sql`(${table.status} <> 'PENDING' OR ${table.enrolledAt} IS NULL)
        AND (${table.status} <> 'ACTIVE' OR ${table.enrolledAt} IS NOT NULL)`,
    ),
    check(
      'mfa_factor_revocation_follows_status',
      sql`(${table.status} = 'REVOKED') = (${table.revokedAt} IS NOT NULL)`,
    ),
    // An administrative revocation is the administrator, the reason and the episode together, on a revoked factor, and the reason says
    // something. A revocation by the system has none of the three.
    check(
      'mfa_factor_administrative_revocation_whole',
      sql`(${table.revokedBy} IS NULL) = (${table.revocationReasonCode} IS NULL)
        AND (${table.revokedBy} IS NULL) = (${table.revocationEpisodeId} IS NULL)
        AND (${table.revocationReasonCode} IS NULL OR length(btrim(${table.revocationReasonCode})) > 0)
        AND (${table.revokedBy} IS NULL OR ${table.status} = 'REVOKED')`,
    ),
    check(
      'mfa_factor_actor_is_not_target',
      sql`${table.revokedBy} IS DISTINCT FROM ${table.staffIdentityId}`,
    ),
    // A factor carries the episode it was created in only when a re-enrolment created it.
    check(
      'mfa_factor_episode_by_purpose',
      sql`${table.createdEpisodeId} IS NULL OR ${table.createdByPurpose} = 'MFA_REENROLMENT'`,
    ),
    check(
      'mfa_factor_counter_shape',
      sql.raw(
        `"mfa_factor"."last_verified_counter" IS NULL OR "mfa_factor"."last_verified_counter" ~ '${FACTOR_COUNTER_PATTERN.source}'`,
      ),
    ),
  ],
);

import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { TRUSTED_BROWSER_REVOCATION_CAUSES } from '../platform/auth/trusted-browsers/trusted-browser-policy.js';
import { bytea } from '../platform/database/schema/types.js';
import { mfaFactor } from './mfa-factor.schema.js';
import { staffIdentity } from './staff-identity.schema.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The trusted browser (domain-model.md §6.8 `TrustedBrowser`; SECURITY_DESIGN.md §13.5a; staff-authentication.md §5.8): a browser that
 * proved the second factor and was asked to be remembered. **It stands in for the code of the second step, for that browser, for seven
 * days, and for nothing else.** It sits in `src/staff/` beside the identity and the factor it is bound to, so the foreign keys can name
 * those tables; the code that reads and writes it is `platform/auth/trusted-browsers/`.
 *
 * - **Only a hash of the credential is stored** (`token_hash`, `TokenService.hash` of the 32 random bytes the cookie carries), unique,
 *   and **the runtime cannot select the column** (migration `0033`): the sign-in finds a row by it through `melarc.use_trusted_browser`,
 *   which answers the `authentication` capability alone.
 * - **It is bound to what was proved.** `factor_id` is the `ACTIVE` factor whose code was accepted and `credential_generation` the
 *   identity's generation at that moment; the trust is valid only while the identity's `ACTIVE` factor is that factor and its generation
 *   that generation, so a reset, a replaced authenticator or a new password ends it without a further act.
 * - **The expiry is absolute.** `expires_at` is `created_at` plus seven days, written once; using the browser writes `last_used_at` and
 *   nothing else.
 * - **A removed row stays.** `revoked_at`, `revocation_cause` and `revoked_by` are written together, once, and a removed row never comes
 *   back; the table holds history and no identity may delete from it.
 *
 * This file is the *shape*. The migration (`0033_trusted_browser.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability; a staff context for its own rows; an administrator's context
 * for the one identity it has locked), the column-level grants, the two guard triggers and the two definer functions.
 */
export const trustedBrowser = pgTable(
  'trusted_browser',
  {
    id: uuid('id').primaryKey(),
    staffIdentityId: uuid('staff_identity_id').notNull(),
    tokenHash: bytea('token_hash').notNull(),
    factorId: uuid('factor_id').notNull(),
    credentialGeneration: bigint('credential_generation', { mode: 'number' }).notNull(),
    label: text('label').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revocationCause: text('revocation_cause'),
    revokedBy: uuid('revoked_by'),
  },
  (table) => [
    // No cascade: an identity is offboarded and never removed, and its trusted browsers are history of its sign-ins.
    foreignKey({
      name: 'trusted_browser_identity_fkey',
      columns: [table.staffIdentityId],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'trusted_browser_factor_fkey',
      columns: [table.factorId],
      foreignColumns: [mfaFactor.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'trusted_browser_revoked_by_fkey',
      columns: [table.revokedBy],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    uniqueIndex('trusted_browser_token_hash_key').on(table.tokenHash),
    // The valid ones of an identity, newest first: the list, the cap of five and the sign-in all ask for these.
    index('trusted_browser_identity_live_idx')
      .on(table.staffIdentityId, table.createdAt)
      .where(sql`${table.revokedAt} IS NULL`),
    check('trusted_browser_token_hash_is_sha256', sql`octet_length(${table.tokenHash}) = 32`),
    check(
      'trusted_browser_credential_generation_positive',
      sql`${table.credentialGeneration} >= 1`,
    ),
    check(
      'trusted_browser_label_bounded',
      sql`char_length(${table.label}) BETWEEN 1 AND 80 AND ${table.label} !~ '[[:cntrl:]]'`,
    ),
    check('trusted_browser_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'trusted_browser_last_use_not_before_creation',
      sql`${table.lastUsedAt} IS NULL OR ${table.lastUsedAt} >= ${table.createdAt}`,
    ),
    check(
      'trusted_browser_revocation_is_whole',
      sql`(${table.revokedAt} IS NULL) = (${table.revocationCause} IS NULL) AND (${table.revokedAt} IS NOT NULL OR ${table.revokedBy} IS NULL) AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt})`,
    ),
    check(
      'trusted_browser_revocation_cause_closed',
      sql.raw(
        `"trusted_browser"."revocation_cause" IS NULL OR "trusted_browser"."revocation_cause" IN (${quoted(TRUSTED_BROWSER_REVOCATION_CAUSES)})`,
      ),
    ),
    // A person or an administrator who removes a browser is named; the system, replacing the oldest, names nobody.
    check(
      'trusted_browser_revoker_follows_cause',
      sql`(${table.revocationCause} IN ('SELF', 'ADMINISTRATOR') AND ${table.revokedBy} IS NOT NULL) OR (${table.revocationCause} = 'REPLACED' AND ${table.revokedBy} IS NULL) OR ${table.revocationCause} IN ('FACTOR_RESET', 'FACTOR_REPLACED', 'CREDENTIAL_CHANGED') OR ${table.revocationCause} IS NULL`,
    ),
  ],
);

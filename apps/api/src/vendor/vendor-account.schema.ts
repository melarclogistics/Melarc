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

import {
  ACCOUNT_IDENTIFIER_PATTERN,
  VENDOR_ACCOUNT_STATUSES,
  VENDOR_DELIVERY_CHANNELS,
} from '../platform/auth/vendor/vendor-vocabulary.js';
import { vendorOrganization } from './vendor-organization.schema.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The vendor account (S0.47; domain-model.md section 6.8 `VendorAccount`): the one shared portal account of an organisation (section 37.5),
 * a **global master record** whose staff reads are narrowed to the hubs of the reader's grant through the organisation's responsible hub.
 * Its credential is the next table, which no staff or vendor context reads.
 *
 * - **The account identifier** is eight characters of the alphabet of SECURITY_DESIGN.md section 13.7a, upper case, unique and immutable.
 *   It is what the vendor types at sign-in beside the secret, it is shown to Ops, and **it is not a secret and not a control**.
 * - **The status is credential and session standing** (`ACTIVE`, `SUSPENDED`), distinct from the organisation's operational approval. No
 *   operation of this slice changes it.
 */
export const vendorAccount = pgTable(
  'vendor_account',
  {
    id: uuid('id').primaryKey(),
    vendorOrganizationId: uuid('vendor_organization_id').notNull(),
    accountIdentifier: text('account_identifier').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // No cascade: an organisation and its account are terminated, never removed.
    foreignKey({
      name: 'vendor_account_organization_fkey',
      columns: [table.vendorOrganizationId],
      foreignColumns: [vendorOrganization.id],
    }).onDelete('restrict'),
    // One account per organisation in Version 1.
    uniqueIndex('vendor_account_organization_key').on(table.vendorOrganizationId),
    uniqueIndex('vendor_account_identifier_key').on(table.accountIdentifier),
    check(
      'vendor_account_status_closed',
      sql.raw(`"vendor_account"."status" IN (${quoted(VENDOR_ACCOUNT_STATUSES)})`),
    ),
    check(
      'vendor_account_identifier_shape',
      sql.raw(`"vendor_account"."account_identifier" ~ '${ACCOUNT_IDENTIFIER_PATTERN}'`),
    ),
  ],
);

/**
 * The vendor's shared credential (S0.47; domain-model.md section 6.8 `VendorCredential`; SECURITY_DESIGN.md sections 13.4, 13.4b): one row
 * per account. **No staff and no vendor context reads it** (data-scope-registry.md: Staff and Vendor `DENY`): the `authentication`
 * capability does, for the sign-in, the setup and the recovery, and the two reads of an account are given booleans derived from it by a
 * definer function, never a value.
 *
 * - **The shared secret** is an Argon2id hash, null until the vendor establishes it through a setup grant (the administrator never learns
 *   it), and the runtime cannot select the column. Its generation says which secret a sign-in verified: it rises by one when the secret is
 *   set or replaced and never moves back, and the moment of establishment changes only with it (the guard holds both).
 * - **The lockout** (`failed_attempt_count`, `locked_until`) is shared by everyone who uses the credential, is never returned and is no
 *   part of the account's version.
 * - **The recovery channel**: at least one of a phone and an email, and the `delivery_channel` the approver chose, which names one of them
 *   (or is null until approval). Every vendor message goes by it, and changing it is its own authorised workflow, so the API never writes
 *   these three columns.
 */
export const vendorCredential = pgTable(
  'vendor_credential',
  {
    vendorAccountId: uuid('vendor_account_id').primaryKey(),
    secretHash: text('secret_hash'),
    credentialEstablishedAt: timestamp('credential_established_at', { withTimezone: true }),
    credentialGeneration: bigint('credential_generation', { mode: 'number' }).notNull().default(0),
    failedAttemptCount: integer('failed_attempt_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    recoveryPhone: text('recovery_phone'),
    recoveryEmail: text('recovery_email'),
    deliveryChannel: text('delivery_channel'),
  },
  (table) => [
    foreignKey({
      name: 'vendor_credential_account_fkey',
      columns: [table.vendorAccountId],
      foreignColumns: [vendorAccount.id],
    }).onDelete('restrict'),
    check(
      'vendor_credential_whole',
      sql`(${table.secretHash} IS NULL) = (${table.credentialEstablishedAt} IS NULL) AND (${table.secretHash} IS NULL) = (${table.credentialGeneration} = 0)`,
    ),
    check('vendor_credential_generation_non_negative', sql`${table.credentialGeneration} >= 0`),
    check(
      'vendor_credential_secret_bounded',
      sql`${table.secretHash} IS NULL OR length(${table.secretHash}) BETWEEN 1 AND 1024`,
    ),
    check('vendor_credential_failures_non_negative', sql`${table.failedAttemptCount} >= 0`),
    check(
      'vendor_credential_channel_present',
      sql`${table.recoveryPhone} IS NOT NULL OR ${table.recoveryEmail} IS NOT NULL`,
    ),
    check(
      'vendor_credential_phone_shape',
      sql`${table.recoveryPhone} IS NULL OR ${table.recoveryPhone} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      'vendor_credential_email_shape',
      sql`${table.recoveryEmail} IS NULL OR (length(${table.recoveryEmail}) BETWEEN 3 AND 320 AND ${table.recoveryEmail} !~ '[[:space:][:cntrl:]]' AND position('@' in ${table.recoveryEmail}) > 1)`,
    ),
    check(
      'vendor_credential_delivery_channel_closed',
      sql.raw(
        `"vendor_credential"."delivery_channel" IS NULL OR "vendor_credential"."delivery_channel" IN (${quoted(VENDOR_DELIVERY_CHANNELS)})`,
      ),
    ),
    check(
      'vendor_credential_delivery_channel_held',
      sql`(${table.deliveryChannel} IS DISTINCT FROM 'PHONE' OR ${table.recoveryPhone} IS NOT NULL) AND (${table.deliveryChannel} IS DISTINCT FROM 'EMAIL' OR ${table.recoveryEmail} IS NOT NULL)`,
    ),
  ],
);

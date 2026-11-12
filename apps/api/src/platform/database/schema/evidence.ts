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
  EVIDENCE_ACCESS_RULES,
  EVIDENCE_CAPTURE_PRINCIPALS,
  EVIDENCE_OWNER_TYPES,
  EVIDENCE_PURPOSES,
  EVIDENCE_RETENTION_POLICIES,
  EVIDENCE_STATES,
} from '../../evidence/evidence-vocabulary.js';
import { hub } from './reference-data.js';

/** `'A', 'B'`: a closed set as the text of an `IN (...)` list. The values are this module's own constants, never input. */
const list = (values: readonly string[]): ReturnType<typeof sql.raw> =>
  sql.raw(values.map((value) => `'${value}'`).join(', '));

/**
 * The evidence record (S1.11; domain-model.md section 3.6; state-machines.md section 17; SECURITY_DESIGN.md sections 14.10, 14.18): a controlled object a rider, an officer or
 * a vendor captured in the course of another act. **One entity for every owner**, scoped by the two columns derived from its owner at creation and immutable, so that a policy
 * never has to follow `owner_type`/`owner_id` into nine parent tables.
 *
 * - **A storage lifecycle, not a business one**: `PENDING_UPLOAD` (declared; it may not be referenced by anything), `STORED` (the bytes arrived and match what was declared) and
 *   `EXPIRED` (the upload window passed; kept, never deleted). Both ends are terminal.
 * - **Owner-aware scope**: a record about a hub-scoped record carries that record's hub (and its vendor organisation where it has one); a record about a vendor organisation carries
 *   the organisation and **no hub** (an invented hub is a real access grant). The checks below are the constraints of the security matrix's Family M.
 * - **The storage reference is the server's**, opaque (`ev/` and 32 hex digits: no personal data), never client-supplied and never returned.
 * - **The database's clock**: `created_at` and the upload window's end are taken by the guard (migration 0080) from the database's clock, never from the writer; `upload_ttl_seconds` is
 *   the lifetime granted (the setting `evidence_upload_authorization_ttl_minutes` at that moment), kept so that the upload instruction can be made again, identically, for a retry.
 * - **Written by the act it evidences**: the INSERT and the move to `STORED` by the rider under the key of the act (S1.11's first owner is a pickup failure, `pickup.failure.report`),
 *   the move to `EXPIRED` by the `evidence_validation` lane of the delivery worker; nothing deletes a row.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey(),
    ownerType: text('owner_type').notNull(),
    ownerId: uuid('owner_id').notNull(),
    purpose: text('purpose').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    capturedByActor: uuid('captured_by_actor').notNull(),
    capturedByPrincipalType: text('captured_by_principal_type').notNull(),
    deviceContext: jsonb('device_context'),
    storageRef: text('storage_ref').notNull(),
    /** Derived from the owner at creation, immutable; null exactly when the owner is a vendor organisation. */
    responsibleHubId: uuid('responsible_hub_id'),
    /** Derived from the owner at creation, immutable; null where the owner is vendor-neutral. A plain column: the vendor domain's table is not named from the platform. */
    vendorOrganizationId: uuid('vendor_organization_id'),
    accessRule: text('access_rule').notNull(),
    retentionPolicy: text('retention_policy').notNull(),
    state: text('state').notNull().default('PENDING_UPLOAD'),
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    checksumSha256: text('checksum_sha256').notNull(),
    uploadTtlSeconds: integer('upload_ttl_seconds').notNull(),
    uploadExpiresAt: timestamp('upload_expires_at', { withTimezone: true }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }),
    /** The kind of file the stored bytes were recognised as; set with `STORED`, and it names the declared type. */
    validatedSignature: text('validated_signature'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The ETag source, moved by the database on every change and by nothing else. */
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'evidence_hub_fkey',
      columns: [table.responsibleHubId],
      foreignColumns: [hub.id],
    }).onDelete('restrict'),
    uniqueIndex('evidence_storage_ref_key').on(table.storageRef),
    index('evidence_owner_idx').on(table.ownerType, table.ownerId),
    index('evidence_hub_idx').on(table.responsibleHubId, table.createdAt),
    // The sweep reads the pending and the expired records (three columns of each) and nothing else.
    index('evidence_pending_expiry_idx')
      .on(table.uploadExpiresAt)
      .where(sql`${table.state} = 'PENDING_UPLOAD'`),
    check('evidence_state_closed', sql`${table.state} IN (${list(EVIDENCE_STATES)})`),
    check('evidence_owner_type_closed', sql`${table.ownerType} IN (${list(EVIDENCE_OWNER_TYPES)})`),
    check('evidence_purpose_closed', sql`${table.purpose} IN (${list(EVIDENCE_PURPOSES)})`),
    check(
      'evidence_capture_principal_closed',
      sql`${table.capturedByPrincipalType} IN (${list(EVIDENCE_CAPTURE_PRINCIPALS)})`,
    ),
    check(
      'evidence_access_rule_closed',
      sql`${table.accessRule} IN (${list(EVIDENCE_ACCESS_RULES)})`,
    ),
    check(
      'evidence_retention_policy_closed',
      sql`${table.retentionPolicy} IN (${list(EVIDENCE_RETENTION_POLICIES)})`,
    ),
    check('evidence_checksum_shape', sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check('evidence_storage_ref_shape', sql`${table.storageRef} ~ '^ev/[0-9a-f]{32}$'`),
    check(
      'evidence_content_type_shape',
      sql`${table.contentType} ~ '^[a-z]+/[a-z0-9][a-z0-9.+-]*$' AND char_length(${table.contentType}) <= 127`,
    ),
    check('evidence_byte_size_positive', sql`${table.byteSize} >= 1`),
    check('evidence_upload_ttl_positive', sql`${table.uploadTtlSeconds} >= 1`),
    // Family M of the security matrix (GBT-M6 to M8): the owner decides the scope, and neither column is a default to be filled in.
    check(
      'evidence_scope_owner_aware',
      sql`(${table.ownerType} = 'VENDOR_ORGANIZATION' AND ${table.responsibleHubId} IS NULL AND ${table.vendorOrganizationId} IS NOT NULL AND ${table.vendorOrganizationId} = ${table.ownerId}) OR (${table.ownerType} <> 'VENDOR_ORGANIZATION' AND ${table.responsibleHubId} IS NOT NULL)`,
    ),
    check(
      'evidence_scope_vendor_neutral',
      sql`${table.ownerType} NOT IN ('MOTORCYCLE', 'FUEL_RECORD', 'APPROVED_AGENT') OR ${table.vendorOrganizationId} IS NULL`,
    ),
    // Stored means the bytes arrived (a moment) and were recognised as the kind of file the declared type stands for.
    check(
      'evidence_stored_facts',
      sql`(${table.state} = 'STORED' AND ${table.uploadedAt} IS NOT NULL AND ${table.validatedSignature} IS NOT NULL) OR (${table.state} <> 'STORED' AND ${table.uploadedAt} IS NULL AND ${table.validatedSignature} IS NULL)`,
    ),
    check(
      'evidence_signature_matches_type',
      sql`${table.validatedSignature} IS NULL OR (${table.contentType} = 'image/jpeg' AND ${table.validatedSignature} = 'JPEG') OR (${table.contentType} = 'image/png' AND ${table.validatedSignature} = 'PNG') OR (${table.contentType} = 'application/pdf' AND ${table.validatedSignature} = 'PDF')`,
    ),
  ],
);

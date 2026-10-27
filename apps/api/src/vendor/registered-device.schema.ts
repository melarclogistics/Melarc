import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  DEVICE_PUBLIC_KEY_PATTERN,
  RIDER_DEVICE_KIND,
} from '../platform/auth/rider/rider-vocabulary.js';
import {
  BUILT_DEVICE_KINDS,
  BUILT_DEVICE_PRINCIPAL_TYPES,
  DEVICE_CREDENTIAL_HASH_BYTES,
  DEVICE_STATUSES,
} from '../platform/auth/vendor/vendor-vocabulary.js';
import { bytea } from '../platform/database/schema/types.js';
import { riderIdentity } from '../staff/rider-identity.schema.js';
import { vendorAccount } from './vendor-account.schema.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The registered device (S0.47, S0.53; domain-model.md section 6.8 `RegisteredDevice`; SECURITY_DESIGN.md sections 13.6, 13.7, 13.8a): **one
 * table for both audiences, two mechanisms, deliberately** (the surfaces are not alike).
 *
 * - **A vendor's browser** (S0.47): a browser the vendor registered at setup, at recovery or with an additional-browser grant, which proves
 *   itself at sign-in with a server-generated credential in an `HttpOnly` cookie. **Only the SHA-256 of the credential is stored**
 *   (`TokenService.hash` of its 32 decoded bytes), unique, and the runtime cannot select the column: the sign-in finds a device by it through
 *   `melarc.vendor_device_by_credential`. Nobody types it, and nothing a client sends selects a device but that cookie.
 * - **A rider's key pair** (S0.53): the public half of a non-exportable ECDSA P-256 key generated in Android secure hardware, as the canonical
 *   standard base64 of its DER SubjectPublicKeyInfo (exactly 91 bytes, 124 characters). **The binding is the public key**: sign-in proves
 *   possession of the private key by a signature over a fresh challenge, and no identifier the client submits selects the device (a rider has
 *   at most one `ACTIVE` one, so the server resolves it). The key is not a secret, but nothing outside the server needs it, so no read returns it.
 *   **A rider has at most one `ACTIVE` device, and the database refuses a second** (`registered_device_one_active_rider_key`), so a stale grant
 *   or a race can never produce two. A device becomes `ACTIVE` only through `completeRiderDeviceEnrolment`, which verifies the attestation
 *   before it writes anything, so no flag records that it did.
 * - **The record is identified by its id** and bound to its principal for good. `ACTIVE` ends once, in `REVOKED` or `REPLACED`, with the
 *   moment; a device is never restored, and a new device is a new registration. `REPLACED` and `REVOKED` are kept, never deleted: a device
 *   that once held a rider's session is part of the custody record of every collection made from it.
 */
export const registeredDevice = pgTable(
  'registered_device',
  {
    id: uuid('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    principalId: uuid('principal_id').notNull(),
    vendorAccountId: uuid('vendor_account_id'),
    /** The rider this device is bound to (S0.53); equal to `principal_id` for a rider's device and null for a vendor's. */
    riderIdentityId: uuid('rider_identity_id'),
    deviceKind: text('device_kind').notNull(),
    deviceCredentialHash: bytea('device_credential_hash'),
    /** The canonical standard base64 of the 91-byte DER SPKI of a P-256 key: a rider's device alone. */
    publicKey: text('public_key'),
    status: text('status').notNull(),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    registeredBy: uuid('registered_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'registered_device_vendor_account_fkey',
      columns: [table.vendorAccountId],
      foreignColumns: [vendorAccount.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'registered_device_rider_identity_fkey',
      columns: [table.riderIdentityId],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    uniqueIndex('registered_device_credential_hash_key').on(table.deviceCredentialHash),
    // A rider has at most one live device: the database refuses a second `ACTIVE` one, whatever raced to make it.
    uniqueIndex('registered_device_one_active_rider_key')
      .on(table.riderIdentityId)
      .where(sql`${table.status} = 'ACTIVE' AND ${table.principalType} = 'RIDER'`),
    // A principal's devices, newest first: the vendor's list, the account read, the rider's detail and the recovery that revokes them.
    index('registered_device_principal_idx').on(
      table.principalType,
      table.principalId,
      table.registeredAt,
    ),
    check(
      'registered_device_principal_closed',
      sql.raw(`"registered_device"."principal_type" IN (${quoted(BUILT_DEVICE_PRINCIPAL_TYPES)})`),
    ),
    check(
      'registered_device_kind_closed',
      sql.raw(`"registered_device"."device_kind" IN (${quoted(BUILT_DEVICE_KINDS)})`),
    ),
    check(
      'registered_device_status_closed',
      sql.raw(`"registered_device"."status" IN (${quoted(DEVICE_STATUSES)})`),
    ),
    check(
      'registered_device_vendor_shape',
      sql.raw(
        `"registered_device"."principal_type" <> 'VENDOR' OR ("registered_device"."vendor_account_id" = "registered_device"."principal_id"
          AND "registered_device"."rider_identity_id" IS NULL
          AND "registered_device"."public_key" IS NULL
          AND "registered_device"."device_kind" = 'VENDOR_BROWSER_CREDENTIAL'
          AND "registered_device"."device_credential_hash" IS NOT NULL
          AND octet_length("registered_device"."device_credential_hash") = ${String(DEVICE_CREDENTIAL_HASH_BYTES)})`,
      ),
    ),
    check(
      'registered_device_rider_shape',
      sql.raw(
        `"registered_device"."principal_type" <> 'RIDER' OR ("registered_device"."rider_identity_id" = "registered_device"."principal_id"
          AND "registered_device"."vendor_account_id" IS NULL
          AND "registered_device"."device_credential_hash" IS NULL
          AND "registered_device"."device_kind" = '${RIDER_DEVICE_KIND}'
          AND "registered_device"."public_key" IS NOT NULL
          AND "registered_device"."public_key" ~ '${DEVICE_PUBLIC_KEY_PATTERN}')`,
      ),
    ),
    check(
      'registered_device_end_follows_status',
      sql`(${table.status} = 'ACTIVE') = (${table.endedAt} IS NULL) AND (${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.registeredAt})`,
    ),
  ],
);

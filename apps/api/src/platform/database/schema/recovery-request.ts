import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import {
  CHANNELS_OF_PRINCIPAL,
  RECOVERY_CHANNELS,
  RECOVERY_PRINCIPAL_TYPES,
  RECOVERY_REQUEST_STATES,
  RECOVERY_TOKEN_HASH_BYTES,
} from '../../auth/recovery/recovery-vocabulary.js';
import { bytea } from './types.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/** `column` is one of `values`, as the text of a CHECK: the closed set of the code, written into the table. */
const oneOf = (column: string, values: readonly string[]): string =>
  `"recovery_request"."${column}" IN (${quoted(values)})`;

/**
 * The recovery request (S0.50; domain-model.md section 6.8 `RecoveryRequest`; credential-recovery.md; data-scope-registry.md
 * `RecoveryRequest`). **The record that repairs an existing credential**, whoever asked for it: the principal through
 * `requestCredentialRecovery`, or a Platform Admin through `recoverStaffCredential` or `recoverVendorCredential` (`initiated_by`). Its one
 * consumer is `completeCredentialRecovery` (S0.51). It confers no authority and issues no session.
 *
 * - **Only a hash of the token is stored** (`token_hash`, the SHA-256 of the 32 decoded bytes), unique. The raw token exists, sealed, in the
 *   payload of the request's delivery job until the provider accepts it, and nowhere else.
 * - **The state is the machine's** (`PENDING`, then one terminal state). A `BEFORE UPDATE` trigger holds every login to it: only a
 *   `PENDING` request changes, a consumption is judged on the database's clock (only before it expires), an expiry only once it has passed,
 *   and nothing but `state` and `consumed_at` ever changes.
 * - **Links coexist, in a bounded number**: at most two live ones per credential, and a new one never invalidates a usable one. The bound
 *   is the issuing operation's to keep, under the identity's lock (the order of SECURITY_DESIGN.md section 13.10a); the insert guard holds
 *   it again for any writer, so no defect of a caller can make a third.
 * - **The principal and the channel are written once.** Which table `principal_id` names is `principal_type`'s to say, so there is no
 *   foreign key; the channel is the registered one, resolved from that record and never from a request.
 *
 * This file is the *shape*. The migration (`0037_recovery_request.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability reads, inserts and updates; the delivery worker's
 * `credential_delivery` capability reads state and expiry only), the grants (no `DELETE` for any identity) and the guard triggers.
 */
export const recoveryRequest = pgTable(
  'recovery_request',
  {
    /** The request's own id (a UUIDv7). */
    id: uuid('id').primaryKey(),
    principalType: text('principal_type').notNull(),
    /** A `StaffIdentity` or a `VendorAccount` id. */
    principalId: uuid('principal_id').notNull(),
    /** Where the link travels: the registered channel's kind, never its address. */
    channel: text('channel').notNull(),
    /** The SHA-256 of the token: 32 bytes. */
    tokenHash: bytea('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    state: text('state').notNull(),
    /** Null for self-service; the acting Platform Admin when one initiated it. */
    initiatedBy: uuid('initiated_by'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (table) => [
    // A presented token is found by its hash and by nothing else.
    uniqueIndex('recovery_request_token_hash_key').on(table.tokenHash),
    // The live links of a principal: what the cap, the guard and a completion read, under the identity's lock.
    index('recovery_request_pending_idx')
      .on(table.principalType, table.principalId, table.issuedAt)
      .where(sql`${table.state} = 'PENDING'`),
    check(
      'recovery_request_principal_closed',
      sql.raw(oneOf('principal_type', RECOVERY_PRINCIPAL_TYPES)),
    ),
    check('recovery_request_channel_closed', sql.raw(oneOf('channel', RECOVERY_CHANNELS))),
    check(
      'recovery_request_channel_by_principal',
      sql.raw(
        RECOVERY_PRINCIPAL_TYPES.map(
          (type) =>
            `("recovery_request"."principal_type" = '${type}' AND ${oneOf('channel', CHANNELS_OF_PRINCIPAL[type])})`,
        ).join('\n        OR '),
      ),
    ),
    check('recovery_request_state_closed', sql.raw(oneOf('state', RECOVERY_REQUEST_STATES))),
    check(
      'recovery_request_token_hash_is_sha256',
      sql.raw(
        `octet_length("recovery_request"."token_hash") = ${String(RECOVERY_TOKEN_HASH_BYTES)}`,
      ),
    ),
    check('recovery_request_expiry_after_issue', sql`${table.expiresAt} > ${table.issuedAt}`),
    // A request says when it was consumed exactly when it has been, and not before it was issued.
    check(
      'recovery_request_consumed_whole',
      sql.raw(
        `("recovery_request"."state" = 'CONSUMED') = ("recovery_request"."consumed_at" IS NOT NULL)
        AND ("recovery_request"."consumed_at" IS NULL OR "recovery_request"."consumed_at" >= "recovery_request"."issued_at")`,
      ),
    ),
  ],
);

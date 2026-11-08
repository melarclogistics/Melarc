import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  RIDER_CHALLENGE_PURPOSE,
  RIDER_CHALLENGE_STATES,
} from '../platform/auth/rider/rider-vocabulary.js';
import { bytea } from '../platform/database/schema/types.js';
import { riderIdentity } from './rider-identity.schema.js';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The rider's sign-in challenge (S0.59; domain-model.md section 6.8 `RiderSignInChallenge`; SECURITY_DESIGN.md sections 13.4b and 13.6;
 * data-scope-registry.md `RiderSignInChallenge`): the single-use nonce the handset signs with its registered key, which grants nothing and
 * carries no authority. It lives `authentication_challenge_ttl_minutes` (5) and any presentation of it ends it, a failed signature as well
 * as a successful one, so a nonce that survives a bad signature is no oracle to hammer. It sits in `src/staff/` beside the rider it may be
 * bound to, so the foreign key can name that table; the code that reads and writes it is `platform/auth/rider/`.
 *
 * - **Issuance discloses nothing.** A challenge is made the same way for a number that matched no rider (`rider_identity_id` null, and no
 *   device context), and behaves like any other, failing at the same step as a wrong signature. The row says which, to the server alone.
 * - **It is bound to what it was issued for**, so it cannot be carried to another place: the canonical phone number it was requested for
 *   (`phone_hash`, a number that matched no rider included), its purpose (`RIDER_SIGN_IN` only: an enrolment challenge is another namespace,
 *   `setup_grant.attestation_challenge_hash`, and is never accepted here nor this one there), the environment and service that issued it
 *   (`audience`) and the rider's `ACTIVE` device at the time (`device_context_hash`). Presented anywhere else it is `CHALLENGE_UNUSABLE`.
 * - **Only hashes are kept.** The nonce is 32 random bytes shown once to the handset that asked (`TokenService.issue`); `nonce_hash` is its
 *   SHA-256, unique, and the only way a presented nonce is found. The phone number and the device are never stored in this table in clear:
 *   `phone_hash` and `device_context_hash` are namespaced SHA-256 digests (`platform/auth/rider/rider-challenge-binding.ts`), which a row
 *   can be compared with and a person cannot read a number out of. Every hash is exactly 32 bytes.
 * - **`EXPIRED` and `UNUSABLE` are different terminal states** because they tell the client different things: start again, versus this one
 *   is finished (a binding that does not hold). `CONSUMED` is the correct presentation, pass or fail. The three are terminal and never
 *   rewritten. There is no attempt count: a challenge has one presentation.
 *
 * This file is the *shape*. The migration (`0041_rider_sign_in_challenge.sql`) adds by hand, in the same change: the owner, `ENABLE` and
 * `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability alone), the column-level grants and the two guard triggers.
 */
export const riderSignInChallenge = pgTable(
  'rider_sign_in_challenge',
  {
    id: uuid('id').primaryKey(),
    /** The rider the number belongs to, or null for a number that matched no rider: the row that keeps issuance from disclosing either. */
    riderIdentityId: uuid('rider_identity_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    state: text('state').notNull().default('PENDING'),
    /** The SHA-256 of the 32 bytes of the nonce: the only form kept. */
    nonceHash: bytea('nonce_hash').notNull(),
    /** The namespaced SHA-256 of the canonical phone number the challenge was requested for. */
    phoneHash: bytea('phone_hash').notNull(),
    purpose: text('purpose').notNull(),
    /** The environment and service that issued it (`melarc-api/<APP_ENV>`). */
    audience: text('audience').notNull(),
    /** The namespaced SHA-256 of the rider's `ACTIVE` device at issue; null for a number that matched no rider or no `ACTIVE` device. */
    deviceContextHash: bytea('device_context_hash'),
  },
  (table) => [
    // No cascade: a rider is never removed, and the challenges are history of its sign-ins.
    foreignKey({
      name: 'rider_sign_in_challenge_rider_fkey',
      columns: [table.riderIdentityId],
      foreignColumns: [riderIdentity.id],
    }).onDelete('restrict'),
    uniqueIndex('rider_sign_in_challenge_nonce_key').on(table.nonceHash),
    check(
      'rider_sign_in_challenge_state_closed',
      sql.raw(`"rider_sign_in_challenge"."state" IN (${quoted(RIDER_CHALLENGE_STATES)})`),
    ),
    check(
      'rider_sign_in_challenge_purpose_closed',
      sql.raw(`"rider_sign_in_challenge"."purpose" = '${RIDER_CHALLENGE_PURPOSE}'`),
    ),
    check(
      'rider_sign_in_challenge_expiry_after_issue',
      sql`${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      'rider_sign_in_challenge_hashes_whole',
      sql`octet_length(${table.nonceHash}) = 32 AND octet_length(${table.phoneHash}) = 32
        AND (${table.deviceContextHash} IS NULL OR octet_length(${table.deviceContextHash}) = 32)`,
    ),
    check(
      'rider_sign_in_challenge_audience_bounded',
      sql`length(${table.audience}) BETWEEN 1 AND 128`,
    ),
    // A device context belongs to a rider: a number that matched no rider has none.
    check(
      'rider_sign_in_challenge_context_needs_rider',
      sql`${table.deviceContextHash} IS NULL OR ${table.riderIdentityId} IS NOT NULL`,
    ),
  ],
);

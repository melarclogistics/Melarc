import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { staffIdentity } from './staff-identity.schema.js';

/** The four states of an MFA challenge (domain-model.md §6.8 `MfaChallenge`; state-machines.md). `PENDING` is the one it leaves. */
export const MFA_CHALLENGE_STATES = ['PENDING', 'CONSUMED', 'EXPIRED', 'UNUSABLE'] as const;
export type MfaChallengeState = (typeof MFA_CHALLENGE_STATES)[number];

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

/**
 * The MFA challenge (S0.32; domain-model.md §6.8 `MfaChallenge`; SECURITY_DESIGN.md §13.4b; data-scope-registry.md `MfaChallenge`): what
 * a privileged sign-in returns **instead of a session** once the password is proved, and what the second step presents with a code. It
 * grants nothing and carries no authority; it is short-lived (`authentication_challenge_ttl_minutes`, 5), single-use, and survives only
 * `mfa_max_attempts` (3) wrong codes. It sits in `src/staff/` beside the identity it is bound to, so the foreign key can name that table;
 * the code that reads and writes it is `platform/auth/mfa/`.
 *
 * - **It is bound to one staff identity and to the credential that was proved** (`credential_generation`): a password replaced between
 *   the two steps ends the challenge's meaning, because the session is issued on the generation the challenge recorded and refused
 *   when the identity holds another (`CREDENTIAL_CHANGED`). An MFA challenge always names its principal; there is no anonymous one.
 *   (The rider's sign-in challenge is a different record with a null principal, and is not this table.)
 * - **`EXPIRED` and `UNUSABLE` are different terminal states** because they tell the client different things: start again, versus this
 *   one is finished. `CONSUMED` is the correct code; the three are terminal and are never rewritten.
 * - **`attempt_count`** counts the wrong codes presented on this challenge, and only rises. The identity's own count is kept on the
 *   identity (`failed_attempt_count`), shared with the password.
 * - **The id is the reference the client holds**: a UUIDv7 (74 random bits), and the one thing a request needs to name the challenge. It
 *   is never a credential by itself, because the code is the proof.
 *
 * This file is the *shape*. The migration (`0020_mfa_challenge_and_lockout.sql`) adds by hand, in the same change: the owner,
 * `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policies (the `authentication` capability alone), the column-level grants and the two
 * guard triggers, and the two grants the lockout columns of `staff_identity` need. **Those columns have two checks (never negative; a
 * lock needs failures and a credential) and no trigger**: the writers keep the count and the lock, and `establishCredential` clears
 * them with the credential it sets. That a replacement of the credential always clears them is not held by the database (the plan,
 * section 7.27, recommends the guard and leaves it to the owner).
 */
export const mfaChallenge = pgTable(
  'mfa_challenge',
  {
    id: uuid('id').primaryKey(),
    staffIdentityId: uuid('staff_identity_id').notNull(),
    /** The credential the password step proved, by its generation (`staff_identity.credential_generation`), always one or more. */
    credentialGeneration: bigint('credential_generation', { mode: 'number' }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    state: text('state').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
  },
  (table) => [
    // No cascade: an identity is offboarded and never removed, and its challenges are history of its sign-ins.
    foreignKey({
      name: 'mfa_challenge_identity_fkey',
      columns: [table.staffIdentityId],
      foreignColumns: [staffIdentity.id],
    }).onDelete('restrict'),
    index('mfa_challenge_identity_idx').on(table.staffIdentityId, table.id),
    check(
      'mfa_challenge_state_closed',
      sql.raw(`"mfa_challenge"."state" IN (${quoted(MFA_CHALLENGE_STATES)})`),
    ),
    check('mfa_challenge_credential_generation_positive', sql`${table.credentialGeneration} >= 1`),
    check('mfa_challenge_expiry_after_issue', sql`${table.expiresAt} > ${table.issuedAt}`),
    check('mfa_challenge_attempts_non_negative', sql`${table.attemptCount} >= 0`),
  ],
);

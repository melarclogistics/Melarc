import { sql } from 'drizzle-orm';

import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { transactionOf } from '../database/transaction-handle.js';
import { ApiException } from '../http/api-exception.js';
import { ErrorCode } from '../http/error-codes.js';

/**
 * The tier of a grant (permissions.md section 5; errors-and-enums.md section 4; `AC-SLICE-000-114`). The grant in a bundle carries
 * the holder's letter of the catalogue: `A`, `S` or `P`, from the least to the most authority, and `null` where the catalogue gives
 * the holder no tier (Finance, the Rider, the Vendor). Tier is a property of the **grant** that authorizes an operation, read from
 * the session's snapshot of the bundle and never from a bundle's name or a role.
 *
 * A target-sensitive rule compares the acting grant's tier with a requirement **derived from the target's authoritative record** (a
 * privileged bundle needs a `P` approver; a rider's sessions are revoked at `S`), never from a value the client sends. The operation
 * that knows the target states the requirement; this module only answers whether a grant meets it:
 *
 * - a grant of a higher tier meets a lower requirement (a `P` meets `S`), and a lower does not meet a higher;
 * - **a grant with no tier meets no tier requirement**: "no tier" is not the lowest tier, it is the absence of one, so an operation
 *   with a requirement is refused to a holder who has none;
 * - the refusal is `403 INSUFFICIENT_AUTHORITY`, which means the key is held and the tier is too low (`PERMISSION_DENIED` is a key
 *   that is not held at all), never both.
 */
export type Tier = 'A' | 'S' | 'P';

const RANK: Readonly<Record<Tier, number>> = { A: 1, S: 2, P: 3 };

export const isTier = (value: unknown): value is Tier =>
  value === 'A' || value === 'S' || value === 'P';

/** Whether a grant of tier `held` (null for none) meets a requirement of tier `required`. */
export function meetsTier(held: Tier | null, required: Tier): boolean {
  if (!isTier(required)) throw new RangeError('A tier requirement is one of A, S or P');
  return held !== null && isTier(held) && RANK[held] >= RANK[required];
}

/** Refuses with `403 INSUFFICIENT_AUTHORITY` unless the grant meets the requirement. */
export function requireTier(held: Tier | null, required: Tier): void {
  if (!meetsTier(held, required)) {
    throw ApiException.of(ErrorCode.InsufficientAuthority, 'Insufficient authority');
  }
}

/**
 * What a target needs, derived from facts of **its own authoritative record** and never from a value the client sends (a privileged
 * bundle needs a P approver; a vendor's session is revoked at S). A rule reads through the transaction it is given, which is the
 * operation's own and so under the caller's row-level security: it can only be asked about a record the caller may see, and it
 * answers `null` where the target puts no requirement of its own. A rule that needs a fact the caller's context may not read asks a
 * narrow function made for that one fact; it is never a blanket privileged read.
 *
 * The rules are registered by name (`TIER_RULES`, empty until a slice adds one), and a route names the one it uses beside the record it
 * addresses (`tier: { rule }` with `record`): the authorization guard asks it at step 6, once it has found the record visible, and
 * `OperationRunner.requireTargetTier` asks it again inside the transaction that acts.
 */
export type TierRule = (transaction: TransactionHandle, id: string) => Promise<Tier | null>;
export type TierRules = Readonly<Record<string, TierRule>>;

/**
 * What an approval, a rejection or a re-issue needs of the staff identity it acts on (S0.36; state-machines.md §13.3; `AC-SLICE-000-85`,
 * `-89`, `-122`): **a Platform Admin where the bundle the profile names is privileged** (Senior Ops and Platform Admin), and nothing beyond
 * the key where it is not. The requirement is read from the target's own record, never from the request, and the caller's own row-level
 * security decides whether it can be asked at all (the rule reads the staff identity under the key of the operation: a profile outside the
 * caller's scope is invisible, and the guard answers it by the scope before this is asked). It reads two columns and a flag; it returns no
 * row.
 */
export const staffIdentityBundleTier: TierRule = async (transaction, id) => {
  const result = await transactionOf(transaction).execute(sql`
    select b.privileged from staff_identity i join role_bundle b on b.id = i.role_bundle_id where i.id = ${id}::uuid`);
  const row = result.rows[0] as { privileged: boolean } | undefined;
  return row?.privileged === true ? 'P' : null;
};

export type SessionPrincipalKind = 'STAFF' | 'RIDER' | 'VENDOR';

/**
 * What the sessions of each principal type are administered at (permissions.md `staff.session.revoke`; SECURITY_DESIGN.md section 13.10):
 * the one table the guard (before the request is validated) and the services (on the value they parsed) both ask.
 */
export const SESSION_PRINCIPAL_TIERS: Readonly<Record<SessionPrincipalKind, Tier>> = Object.freeze({
  STAFF: 'P',
  VENDOR: 'P',
  RIDER: 'S',
});

/**
 * What the sessions of a principal are administered at (permissions.md `staff.session.revoke`; SECURITY_DESIGN.md section 13.10; `AC-SLICE-000-29`,
 * `-114`): a Platform Admin for a staff member's and a vendor's, Senior Ops for a rider's (at its own hub, which the scope decides).
 */
export const tierForSessionPrincipal = (type: SessionPrincipalKind): Tier =>
  SESSION_PRINCIPAL_TIERS[type];

/**
 * What the revocation of a session needs, read from **the session's own principal type** and from nothing the request says (S0.37). The
 * rule reads the session under the caller's row-level security, so it can only be asked about a session the caller's scope reaches; one it
 * does not reach is answered `NOT_FOUND` by the guard before this is asked.
 */
export const sessionPrincipalTier: TierRule = async (transaction, id) => {
  const result = await transactionOf(transaction).execute(
    sql`select principal_type from session where id = ${id}::uuid`,
  );
  const row = result.rows[0] as { principal_type: SessionPrincipalKind } | undefined;
  return row === undefined ? null : tierForSessionPrincipal(row.principal_type);
};

/** The discriminator of the query and the tier each of its values needs (see `queryTierRequirement`). */
export interface QueryTierDeclaration {
  readonly param: string;
  readonly tiers: Readonly<Record<string, Tier>>;
}

/**
 * A requirement that depends on a discriminator the request carries in its query (`listSessions`: the type of principal whose sessions
 * are listed), decided in the guard **before the request is validated** (permission-enforcement.md section 5.1, step 6), so that a caller
 * who holds the key at too low a tier is refused `INSUFFICIENT_AUTHORITY` whatever else is wrong with the request.
 *
 * Only a value the declaration lists, given once and as the one string it is, is read. **Anything else grants nothing and reads as no
 * particular value**: it is asked the least tier any listed value asks, so that a caller who could be served by no value at all is
 * refused here, and a caller who could be served by one gets the validation answer to their own malformed input afterwards. The use
 * case asks again, on the value it parsed, with the same table.
 */
export function queryTierRequirement(
  declaration: QueryTierDeclaration,
  query: Readonly<Record<string, unknown>>,
): Tier {
  const value = query[declaration.param];
  if (typeof value === 'string' && Object.hasOwn(declaration.tiers, value)) {
    const tier = declaration.tiers[value];
    if (tier !== undefined && isTier(tier)) return tier;
  }
  const least = Object.values(declaration.tiers)
    .filter(isTier)
    .toSorted((a, b) => RANK[a] - RANK[b])[0];
  if (least === undefined) throw new RangeError('A query tier declaration lists at least one tier');
  return least;
}

export const TIER_RULES: TierRules = Object.freeze({
  staff_identity_bundle: staffIdentityBundleTier,
  session_principal: sessionPrincipalTier,
});
export const TIER_RULES_TOKEN = Symbol('TIER_RULES');

export const TIER_RULE_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * Asks a rule what the target needs and refuses (`403 INSUFFICIENT_AUTHORITY`) unless the grant meets it. A rule that answers anything
 * but a tier or `null` is a defect of the rule and is not read as "no requirement": the request fails closed.
 */
export async function requireTargetTier(
  rule: TierRule,
  grantTier: Tier | null,
  transaction: TransactionHandle,
  id: string,
): Promise<void> {
  const required: unknown = await rule(transaction, id);
  if (required === null) return;
  if (!isTier(required)) throw new TypeError('A tier rule answers a tier, or null for none');
  requireTier(grantTier, required);
}

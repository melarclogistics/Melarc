import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
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

export const TIER_RULES: TierRules = Object.freeze({});
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

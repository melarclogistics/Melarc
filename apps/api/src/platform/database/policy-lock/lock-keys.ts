import { createHash } from 'node:crypto';

/**
 * The lock-keys module (S0.7; SECURITY_DESIGN.md §13.10a). The one place that defines an advisory lock class and how a key is
 * made, so that the numbers are written once and `lock-keys.test.ts` can assert that no two classes share a value.
 *
 * **Advisory locks are the policy protocol's only coordination.** The runtime logins hold `SELECT` only on `RoleBundle`,
 * `RoleBundleGrant` and `FixedPermissionPolicy`, and a row lock (`SELECT ... FOR SHARE`) needs `UPDATE`, which they are never
 * given. The transaction-scoped advisory functions need no table privilege and release at `COMMIT` or `ROLLBACK` (never the
 * session-level ones: a pooled connection would carry a lock past the transaction). `architecture.test.ts` refuses the
 * session-level and `pg_try_` functions in application code, and any advisory call outside `policy-lock/`.
 *
 * The classes and the digest below are **engineering constants, not contract values**, and **persisted in effect**: two
 * instances of the application that disagree on them would not exclude each other, and a rolling release runs both. They are
 * pinned by tests and never changed in place.
 */

/** The advisory classes of the application: the first integer of a two-integer advisory lock. One value each, never shared. */
export const ADVISORY_CLASSES = Object.freeze({
  /** `RoleBundle`, its grants, `revision` and `reduction_floor`, and the sessions issued from it (0x4D4C4231, "MLB1"). */
  AUTH_POLICY_BUNDLE: 1296843313,
  /** One `FixedPermissionPolicy` row per Vendor and Rider (0x4D4C4631, "MLF1"). */
  AUTH_POLICY_FIXED: 1296844337,
});

export const AUTH_POLICY_BUNDLE = ADVISORY_CLASSES.AUTH_POLICY_BUNDLE;
export const AUTH_POLICY_FIXED = ADVISORY_CLASSES.AUTH_POLICY_FIXED;

/** The principal types that have a fixed policy, and the key of each: its ordinal, written down so that it never moves. */
export const FIXED_POLICY_ORDINAL = Object.freeze({ VENDOR: 1, RIDER: 2 });

/** A request for a lock was malformed, or the protocol was broken (a second acquisition, a lock after a data statement). */
export class PolicyLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyLockError';
  }
}

export const isInt32 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stable 32-bit digest of the bundle's `id`: the first four bytes of the SHA-256 of the canonical (lower-case) id, read as a
 * signed big-endian integer. Two ids may share a digest; that costs contention and never admits an interleaving the exact key
 * would have excluded (the plan merges them into one request).
 */
export function bundleLockKey(bundleId: string): number {
  if (typeof bundleId !== 'string' || !UUID.test(bundleId)) {
    throw new PolicyLockError('A bundle lock is taken on a bundle id (a UUID)');
  }
  return createHash('sha256').update(bundleId.toLowerCase()).digest().readInt32BE(0);
}

/** The key of the fixed-policy lock for a principal type. Only Vendor and Rider have a fixed policy. */
export function fixedLockKey(principalType: keyof typeof FIXED_POLICY_ORDINAL): number {
  if (
    typeof principalType !== 'string' ||
    !Object.prototype.hasOwnProperty.call(FIXED_POLICY_ORDINAL, principalType)
  ) {
    throw new PolicyLockError('Only a Vendor and a Rider have a fixed permission policy to lock');
  }
  return FIXED_POLICY_ORDINAL[principalType];
}

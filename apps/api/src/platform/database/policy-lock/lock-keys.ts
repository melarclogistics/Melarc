import { createHash } from 'node:crypto';

/**
 * The lock-keys module (S0.7; SECURITY_DESIGN.md §13.10a). The one place that defines an advisory lock class and how a key is
 * made, so that the numbers are written once and `lock-keys.test.ts` can assert that no two classes share a value.
 *
 * **Advisory locks are the policy protocol's only coordination.** The runtime logins hold `SELECT` only on `RoleBundle`,
 * `RoleBundleGrant` and `FixedPermissionPolicy`, and a row lock (`SELECT ... FOR SHARE`) needs `UPDATE`, which they are never
 * given. The transaction-scoped advisory functions need no table privilege and release at `COMMIT` or `ROLLBACK` (never the
 * session-level ones: a pooled connection would carry a lock past the transaction). `architecture.test.ts` refuses the
 * session-level and `pg_try_` functions in application code (but for the limiter's one cleanup election), and any advisory call
 * outside `policy-lock/` and the limiter.
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
  /**
   * The rate limiter's per-key serialisation (S0.14; 0x4D4C5231, "MLR1"): one lock per keyed digest of a bucket's key, taken in the
   * limiter's own short transaction and never together with a policy lock. It is a class of its own so that a bucket's admission
   * never queues behind a bundle change, and the other way round.
   */
  RATE_LIMIT_KEY: 1296847409,
  /**
   * The rate limiter's capacity lock (G2-05; 0x4D4C5233, "MLR3"): one lock, key zero, that every admission which writes takes after
   * its key locks and holds to the end of its transaction. Under it the admission removes a bounded batch of expired rows, counts
   * every row the table holds and inserts, so the table never holds more rows than its capacity however many instances admit
   * at once. It is the last lock of the transaction and nothing is taken after it, so it takes part in no cycle. Refusals at a
   * bucket's ceiling never take it. (0x4D4C5232, "MLR2", the cleanup election of 10 October 2026, is retired: the capacity lock puts
   * every delete under one lock, which makes an election redundant. The number is never reused.)
   */
  RATE_LIMIT_CAPACITY: 1296847411,
});

export const AUTH_POLICY_BUNDLE = ADVISORY_CLASSES.AUTH_POLICY_BUNDLE;
export const AUTH_POLICY_FIXED = ADVISORY_CLASSES.AUTH_POLICY_FIXED;
export const RATE_LIMIT_KEY = ADVISORY_CLASSES.RATE_LIMIT_KEY;
export const RATE_LIMIT_CAPACITY = ADVISORY_CLASSES.RATE_LIMIT_CAPACITY;

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

/**
 * The limiter's lock key for a keyed digest: its first four bytes as a signed big-endian integer. Two digests may share a key;
 * that costs contention and never admits an interleaving the exact key would have excluded. The digest is a pseudonym (an HMAC),
 * and a lock key shows in `pg_locks`, so no identifier is derivable from it without the limiter's key.
 */
export function rateLimitLockKey(digest: Buffer): number {
  if (!Buffer.isBuffer(digest) || digest.length < 4) {
    throw new PolicyLockError('A limiter lock is taken on a keyed digest of at least four bytes');
  }
  return digest.readInt32BE(0);
}

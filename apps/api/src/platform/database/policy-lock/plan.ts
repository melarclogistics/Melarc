import {
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  FIXED_POLICY_ORDINAL,
  PolicyLockError,
  bundleLockKey,
  fixedLockKey,
  isInt32,
} from './lock-keys.js';

/**
 * The planner (S0.7; SECURITY_DESIGN.md §13.10a, "Discovery, the planned set and restart"). It turns every lock a transaction will
 * need into one canonical list: duplicates and digest collisions merged into one entry per `(class, key)` in the strongest
 * mode, sorted by class and then key. Two operations whose sets overlap therefore take the shared keys in the same order and
 * cannot wait for each other in a cycle. It never decides what to lock: the caller does, from what it discovered.
 */

export type PolicyLockMode = 'shared' | 'exclusive';

export interface PolicyLockRequest {
  readonly class: number;
  readonly key: number;
  readonly mode: PolicyLockMode;
}

/** A plan: frozen, one entry per `(class, key)`, in the order the locks are taken. */
export type PolicyLockPlan = readonly PolicyLockRequest[];

const POLICY_CLASSES: readonly number[] = [AUTH_POLICY_BUNDLE, AUTH_POLICY_FIXED];

/** The lock of a bundle, shared (it relies on the content staying put) or exclusive (it changes the content or a floor). */
export function bundleLock(bundleId: string, mode: PolicyLockMode): PolicyLockRequest {
  return { class: AUTH_POLICY_BUNDLE, key: bundleLockKey(bundleId), mode };
}

/** The lock of the fixed policy of a Vendor or a Rider. */
export function fixedLock(
  principalType: keyof typeof FIXED_POLICY_ORDINAL,
  mode: PolicyLockMode,
): PolicyLockRequest {
  return { class: AUTH_POLICY_FIXED, key: fixedLockKey(principalType), mode };
}

function checked(request: PolicyLockRequest): PolicyLockRequest {
  const given = request as unknown as Record<string, unknown>;
  if (typeof given.class !== 'number' || !POLICY_CLASSES.includes(given.class)) {
    throw new PolicyLockError('A policy lock names one of the policy classes');
  }
  if (!isInt32(given.key)) throw new PolicyLockError('A policy lock key is a 32-bit integer');
  if (given.mode !== 'shared' && given.mode !== 'exclusive') {
    throw new PolicyLockError('A policy lock is shared or exclusive');
  }
  return Object.freeze({ class: given.class, key: given.key, mode: given.mode });
}

/**
 * The canonical plan for `requests`. **Merging keeps the strongest mode**, so a key wanted shared by one part of an operation and
 * exclusive by another is taken exclusive, once, from the start: there is no shared-to-exclusive upgrade on any path.
 */
export function planPolicyLocks(requests: readonly PolicyLockRequest[]): PolicyLockPlan {
  const merged = new Map<string, PolicyLockRequest>();
  for (const request of requests.map(checked)) {
    const id = `${String(request.class)}:${String(request.key)}`;
    const existing = merged.get(id);
    if (existing === undefined || (existing.mode === 'shared' && request.mode === 'exclusive')) {
      merged.set(id, request);
    }
  }
  return Object.freeze(
    [...merged.values()].toSorted(
      (left, right) => left.class - right.class || left.key - right.key,
    ),
  );
}

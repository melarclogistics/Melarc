import { describe, expect, it } from 'vitest';

import {
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  PolicyLockError,
  bundleLockKey,
} from './lock-keys.js';
import { bundleLock, fixedLock, planPolicyLocks, type PolicyLockRequest } from './plan.js';

const bundle = (key: number, mode: 'shared' | 'exclusive'): PolicyLockRequest => ({
  class: AUTH_POLICY_BUNDLE,
  key,
  mode,
});
const fixed = (key: number, mode: 'shared' | 'exclusive'): PolicyLockRequest => ({
  class: AUTH_POLICY_FIXED,
  key,
  mode,
});

describe('planPolicyLocks: merge, order, collisions (SECURITY_DESIGN.md §13.10a, "The planned set")', () => {
  // Break caught: a key asked for twice acquired twice (or, worse, once shared and once exclusive: two holders that both try
  // to upgrade wait for each other for ever).
  it('merges a duplicate into one entry', () => {
    expect(planPolicyLocks([bundle(5, 'shared'), bundle(5, 'shared')])).toEqual([
      bundle(5, 'shared'),
    ]);
  });

  // Break caught: the weaker mode kept when both are asked for: an exclusion the operation needed is lost.
  it.each([
    [['shared', 'exclusive'], 'exclusive'],
    [['exclusive', 'shared'], 'exclusive'],
    [['exclusive', 'exclusive'], 'exclusive'],
    [['shared', 'shared'], 'shared'],
  ] as const)('keeps the strongest mode of %j: %s', (modes, expected) => {
    const plan = planPolicyLocks(modes.map((mode) => bundle(7, mode)));
    expect(plan).toEqual([bundle(7, expected)]);
  });

  // Break caught: two bundle ids whose digests collide treated as two locks (one taken shared, one exclusive: the same upgrade
  // trap), or as a missed exclusion. They are one `(class, key)`.
  it('merges two bundles whose digests collide into one request, in the strongest mode', () => {
    // The digests of two different ids may be equal: the plan sees only the key.
    const idA = '11111111-1111-4111-8111-111111111111';
    const keyA = bundleLockKey(idA);
    const plan = planPolicyLocks([
      bundleLock(idA, 'shared'),
      { class: AUTH_POLICY_BUNDLE, key: keyA, mode: 'exclusive' },
    ]);
    expect(plan).toEqual([bundle(keyA, 'exclusive')]);
  });

  it('does not merge the same key in different classes', () => {
    expect(planPolicyLocks([fixed(1, 'shared'), bundle(1, 'exclusive')])).toEqual([
      bundle(1, 'exclusive'),
      fixed(1, 'shared'),
    ]);
  });

  // Break caught: an order that depends on how the caller listed them, so two operations with overlapping sets in opposite
  // orders deadlock.
  it('sorts by class ascending, then by key ascending, negative keys first', () => {
    const plan = planPolicyLocks([
      fixed(2, 'shared'),
      bundle(900, 'shared'),
      bundle(-5, 'exclusive'),
      fixed(1, 'shared'),
      bundle(3, 'shared'),
    ]);
    expect(plan).toEqual([
      bundle(-5, 'exclusive'),
      bundle(3, 'shared'),
      bundle(900, 'shared'),
      fixed(1, 'shared'),
      fixed(2, 'shared'),
    ]);
  });

  it('gives the same plan for every ordering of the same requests', () => {
    const requests = [
      bundle(10, 'shared'),
      bundle(-3, 'exclusive'),
      fixed(2, 'shared'),
      fixed(1, 'exclusive'),
      bundle(10, 'exclusive'),
    ];
    const reference = planPolicyLocks(requests);
    const permutations = (items: PolicyLockRequest[]): PolicyLockRequest[][] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, at) =>
            permutations([...items.slice(0, at), ...items.slice(at + 1)]).map((rest) => [
              item,
              ...rest,
            ]),
          );
    for (const order of permutations(requests)) expect(planPolicyLocks(order)).toEqual(reference);
  });

  it('plans nothing for nothing', () => {
    expect(planPolicyLocks([])).toEqual([]);
  });

  it('returns a plan that cannot be changed afterwards', () => {
    const plan = planPolicyLocks([bundle(1, 'shared')]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan[0])).toBe(true);
  });

  it('does not change the requests it was given', () => {
    const requests = [bundle(2, 'shared'), bundle(1, 'shared')];
    planPolicyLocks(requests);
    expect(requests.map((request) => request.key)).toEqual([2, 1]);
  });

  // Break caught: a request for a class the protocol does not define (a typo, another use of advisory locks) being taken.
  it.each([
    ['an unknown class', { class: 7, key: 1, mode: 'shared' }],
    ['a class that is not an integer', { class: 1.5, key: 1, mode: 'shared' }],
    ['a key above 32 bits', { class: AUTH_POLICY_BUNDLE, key: 2 ** 31, mode: 'shared' }],
    ['a key below 32 bits', { class: AUTH_POLICY_BUNDLE, key: -(2 ** 31) - 1, mode: 'shared' }],
    ['a key that is not an integer', { class: AUTH_POLICY_BUNDLE, key: 0.5, mode: 'shared' }],
    ['a key that is not a number', { class: AUTH_POLICY_BUNDLE, key: '1', mode: 'shared' }],
    ['a mode that is neither', { class: AUTH_POLICY_BUNDLE, key: 1, mode: 'try' }],
    ['no mode', { class: AUTH_POLICY_BUNDLE, key: 1 }],
  ])('refuses %s', (_label, request) => {
    expect(() => planPolicyLocks([request as unknown as PolicyLockRequest])).toThrow(
      PolicyLockError,
    );
  });
});

describe('bundleLock and fixedLock', () => {
  it('build requests in the right class and key', () => {
    const id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
    expect(bundleLock(id, 'shared')).toEqual({
      class: AUTH_POLICY_BUNDLE,
      key: bundleLockKey(id),
      mode: 'shared',
    });
    expect(fixedLock('VENDOR', 'exclusive')).toEqual({
      class: AUTH_POLICY_FIXED,
      key: 1,
      mode: 'exclusive',
    });
    expect(fixedLock('RIDER', 'shared')).toEqual({
      class: AUTH_POLICY_FIXED,
      key: 2,
      mode: 'shared',
    });
  });
});

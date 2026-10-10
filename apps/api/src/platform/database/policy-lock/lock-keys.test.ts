import { describe, expect, it } from 'vitest';

import {
  ADVISORY_CLASSES,
  AUTH_POLICY_BUNDLE,
  AUTH_POLICY_FIXED,
  FIXED_POLICY_ORDINAL,
  PolicyLockError,
  bundleLockKey,
  fixedLockKey,
  isInt32,
} from './lock-keys.js';

describe('the advisory lock classes (SECURITY_DESIGN.md §13.10a)', () => {
  // Break caught: two uses of advisory locks sharing a class, so unrelated work blocks each other, or one protocol's
  // exclusion is satisfied by another's lock. The numbers are engineering constants and this is the one place that holds them.
  it('gives every class a different value', () => {
    const values = Object.values(ADVISORY_CLASSES);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps every class a 32-bit integer, which the two-integer advisory functions take', () => {
    for (const value of Object.values(ADVISORY_CLASSES)) expect(isInt32(value)).toBe(true);
  });

  // Break caught: a class number changed in a later edit. Two instances of the application that disagree on it would not
  // exclude each other, and a rolling release runs both. The values are pinned.
  it('pins the two policy classes', () => {
    expect(AUTH_POLICY_BUNDLE).toBe(1296843313);
    expect(AUTH_POLICY_FIXED).toBe(1296844337);
    expect(Object.keys(ADVISORY_CLASSES).toSorted()).toEqual([
      'AUTH_POLICY_BUNDLE',
      'AUTH_POLICY_FIXED',
    ]);
  });

  it('is frozen: a class cannot be added or changed at run time', () => {
    expect(Object.isFrozen(ADVISORY_CLASSES)).toBe(true);
  });
});

describe('the bundle key: a stable 32-bit digest of the bundle id', () => {
  // Break caught: a digest that differs between instances or releases (a different hash, a different byte order, a case-sensitive
  // read), so two instances take different keys for one bundle and exclude nothing. The vectors are pinned.
  it.each([
    ['11111111-1111-4111-8111-111111111111', -1116314971],
    ['00000000-0000-4000-8000-000000000000', -612346400],
    ['ffffffff-ffff-4fff-8fff-ffffffffffff', 766187870],
    ['a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1', -1521291319],
  ])('maps %s to %i', (id, key) => {
    expect(bundleLockKey(id)).toBe(key);
  });

  it('reads an id in upper case as the same id', () => {
    expect(bundleLockKey('A1A1A1A1-A1A1-4A1A-8A1A-A1A1A1A1A1A1')).toBe(
      bundleLockKey('a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1'),
    );
  });

  it('always yields a 32-bit integer', () => {
    for (let each = 0; each < 200; each += 1) {
      const id = `${each.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      expect(isInt32(bundleLockKey(id))).toBe(true);
    }
  });

  // Break caught: a key made from text that is not an id (an empty string, a name), which would lock a key nobody else computes.
  it.each(['', 'bundle', '11111111-1111-4111-8111-11111111111', 42, undefined, null])(
    'refuses %j as a bundle id',
    (value) => {
      expect(() => bundleLockKey(value as string)).toThrow(PolicyLockError);
    },
  );
});

describe('the fixed-policy key: the principal type’s ordinal', () => {
  it('pins the ordinals, one for each type that has a fixed policy', () => {
    expect(FIXED_POLICY_ORDINAL).toEqual({ VENDOR: 1, RIDER: 2 });
    expect(fixedLockKey('VENDOR')).toBe(1);
    expect(fixedLockKey('RIDER')).toBe(2);
  });

  // Break caught: a fixed key taken for a type that has no fixed policy (staff has bundles, SYSTEM has a capability).
  it.each(['STAFF', 'SYSTEM', 'ADMIN', '', undefined])('refuses %j', (value) => {
    expect(() => fixedLockKey(value as 'VENDOR')).toThrow(PolicyLockError);
  });
});

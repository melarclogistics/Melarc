import { describe, expect, it } from 'vitest';

import { ApiException } from '../http/api-exception.js';
import { effectiveScope } from './effective-scope.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import { meetsTier, requireTargetTier, requireTier, type TierRule } from './tier-policy.js';

describe('tier (permissions.md section 5; AC-SLICE-000-114)', () => {
  // Break caught: a lower tier meeting a higher requirement (a Senior Ops approving a privileged bundle), or a higher tier not
  // meeting a lower one (a Platform Admin refused what a Senior Ops may do).
  it.each([
    ['A', 'A', true],
    ['A', 'S', false],
    ['A', 'P', false],
    ['S', 'A', true],
    ['S', 'S', true],
    ['S', 'P', false],
    ['P', 'A', true],
    ['P', 'S', true],
    ['P', 'P', true],
  ] as const)('a grant of tier %s against a requirement of %s: %s', (held, required, expected) => {
    expect(meetsTier(held, required)).toBe(expected);
  });

  // Break caught: "no tier" read as the lowest tier, which would let a holder with none meet the lowest requirement, or as the
  // highest. A grant with no tier meets no tier requirement.
  it.each(['A', 'S', 'P'] as const)(
    'a grant with no tier meets no requirement, not even %s',
    (required) => {
      expect(meetsTier(null, required)).toBe(false);
    },
  );

  it('refuses a requirement that is not a tier, and a held value that is not one', () => {
    expect(() => meetsTier('S', 'Z' as never)).toThrow(RangeError);
    expect(meetsTier('Z' as never, 'A')).toBe(false);
    expect(meetsTier(undefined as never, 'A')).toBe(false);
  });

  // Break caught: INSUFFICIENT_AUTHORITY for a key that is not held, or PERMISSION_DENIED for a held key at too low a tier: the two
  // answers tell a different thing and neither carries both.
  it('refuses with 403 INSUFFICIENT_AUTHORITY, and never with the code of a missing key', () => {
    let refusal: unknown;
    try {
      requireTier('S', 'P');
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(ApiException);
    expect(refusal).toMatchObject({ code: 'INSUFFICIENT_AUTHORITY' });
    expect((refusal as ApiException).getStatus()).toBe(403);
    expect(() => {
      requireTier('P', 'P');
    }).not.toThrow();
    expect(() => {
      requireTier(null, 'A');
    }).toThrow(/Insufficient authority/);
  });
});

describe('what a target needs, asked of its rule (the review of 12 October 2026, F01)', () => {
  const HANDLE = {} as TransactionHandle;
  const ID = '11111111-1111-4111-8111-111111111111';
  const answering =
    (answer: unknown): TierRule =>
    () =>
      Promise.resolve(answer as never);
  const refusalOf = (promise: Promise<void>): Promise<unknown> =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );

  // Break caught: a requirement the target makes ignored, or applied to a grant that meets it.
  it.each([
    ['S', 'P', false],
    ['P', 'P', true],
    ['P', 'S', true],
    ['A', 'S', false],
    [null, 'A', false],
  ] as const)(
    'a grant of tier %s against a target that needs %s: served is %s',
    async (held, needed, served) => {
      const refusal = await refusalOf(requireTargetTier(answering(needed), held, HANDLE, ID));

      if (served) {
        expect(refusal).toBeUndefined();
      } else {
        expect(refusal).toBeInstanceOf(ApiException);
        expect(refusal).toMatchObject({ code: 'INSUFFICIENT_AUTHORITY' });
      }
    },
  );

  // Break caught: a target that puts no requirement of its own refusing anyone, or a grant with no tier refused where nothing is needed.
  it('asks nothing of a grant when the target needs nothing, even a grant with no tier', async () => {
    expect(await refusalOf(requireTargetTier(answering(null), null, HANDLE, ID))).toBeUndefined();
    expect(await refusalOf(requireTargetTier(answering(null), 'A', HANDLE, ID))).toBeUndefined();
  });

  // Break caught: a rule that answers something else read as "no requirement", which would open an operation by a defect of its rule.
  it.each([undefined, 'Z', 's', 3, {}, true])(
    'fails closed on a rule that answers %j: a defect of the rule is not "no requirement"',
    async (answer) => {
      const refusal = await refusalOf(requireTargetTier(answering(answer), 'P', HANDLE, ID));

      expect(refusal).toBeInstanceOf(TypeError);
    },
  );

  // Break caught: the rule given another id or another transaction than the target's and the operation's.
  it('hands the rule the transaction it was given and the id of the target', async () => {
    const seen: unknown[] = [];
    await requireTargetTier(
      (transaction, id) => {
        seen.push(transaction, id);
        return Promise.resolve(null);
      },
      'S',
      HANDLE,
      ID,
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(HANDLE);
    expect(seen[1]).toBe(ID);
  });
});

describe('the hub scope an operation runs under (SECURITY_DESIGN.md sections 14.1a and 14.2; GBT-GS)', () => {
  const HUB_A = '11111111-1111-4111-8111-111111111111';
  const HUB_C = '33333333-3333-4333-8333-333333333333';

  // Break caught (GBT-GS1): an all-hub grant held beside the one being exercised widening this operation: the scope is the scope
  // of the grant of this operation, read from it and from nothing else.
  it('gives a grant scoped own the session’s own hubs, as a set, whatever other grants the session holds', () => {
    expect(effectiveScope({ hubScope: 'own' }, [HUB_A, HUB_C])).toEqual({
      hubScopeMode: 'SET',
      authorizedHubIds: [HUB_A, HUB_C],
    });
  });

  // Break caught (GBT-B5): an empty set read as "all hubs".
  it('gives a grant scoped own and a session with no hub an empty set, never all', () => {
    expect(effectiveScope({ hubScope: 'own' }, [])).toEqual({
      hubScopeMode: 'SET',
      authorizedHubIds: [],
    });
  });

  // Break caught (GBT-GS3): all-hub authority lost for the grant that carries it, or taken from the session's reach.
  it('gives a grant scoped all the explicit all mode, whatever hubs the session reaches', () => {
    expect(effectiveScope({ hubScope: 'all' }, [HUB_A])).toEqual({
      hubScopeMode: 'ALL',
      authorizedHubIds: [],
    });
    expect(effectiveScope({ hubScope: 'all' }, [])).toEqual({
      hubScopeMode: 'ALL',
      authorizedHubIds: [],
    });
  });

  // Break caught (GBT-GS11, GBT-GS12): a grant with no hub dimension given the session’s hubs, or all of them.
  it('gives a grant scoped none, an operation with no grant and a scope this build does not know no hub at all', () => {
    for (const grant of [
      { hubScope: 'none' as const },
      undefined,
      { hubScope: 'region' as never },
    ]) {
      expect(effectiveScope(grant, [HUB_A])).toEqual({ hubScopeMode: 'SET', authorizedHubIds: [] });
    }
  });

  // Break caught: the scope sharing the session's list, so that a change to one reaches the other; or the result being writable.
  it('does not share the session’s list and cannot be changed', () => {
    const reach = [HUB_A];
    const scope = effectiveScope({ hubScope: 'own' }, reach);
    reach.push(HUB_C);

    expect(scope.authorizedHubIds).toEqual([HUB_A]);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.authorizedHubIds)).toBe(true);
  });
});

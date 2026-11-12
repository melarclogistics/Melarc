import { describe, expect, it } from 'vitest';

import { ApiException } from '../http/api-exception.js';
import { hubOutsideStaffGrant, type AuthorizedRequest } from './authorized-request.js';
import { effectiveScope, scopeExcludesHub } from './effective-scope.js';
import type { TransactionHandle } from '../auth/ports/unit-of-work.port.js';
import {
  meetsTier,
  queryTierRequirement,
  requireTargetTier,
  requireTier,
  SESSION_PRINCIPAL_TIERS,
  tierForSessionPrincipal,
  type TierRule,
} from './tier-policy.js';

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

describe('a hub that a grant does not reach (task A1; AC-HUBF-05; GBT-GS14)', () => {
  const HUB_A = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e01';
  const HUB_B = '0191a4f8-6c2e-7a3e-8f10-5d6c7b8a9e0b';
  const own = effectiveScope({ hubScope: 'own' }, [HUB_A]);
  const everywhere = effectiveScope({ hubScope: 'all' }, []);
  const nowhere = effectiveScope({ hubScope: 'none' }, [HUB_A]);

  // Break caught: a hub inside the set taken for one outside it (a read of the officer's own hub answered empty), one outside it taken for inside
  // (the statement runs and the time tells a caller the hub exists), or the comparison made on text that differs in case (a UUID in capitals is the
  // same hub, and the context writes the set in lower case).
  it('excludes a hub that is not in the set, in either case, and no hub that is', () => {
    expect(scopeExcludesHub(own, HUB_B)).toBe(true);
    expect(scopeExcludesHub(own, HUB_B.toUpperCase())).toBe(true);
    expect(scopeExcludesHub(own, HUB_A)).toBe(false);
    expect(scopeExcludesHub(own, HUB_A.toUpperCase())).toBe(false);
    const upper = effectiveScope({ hubScope: 'own' }, [HUB_A.toUpperCase()]);
    expect(scopeExcludesHub(upper, HUB_A)).toBe(false);
  });

  // Break caught: an empty set read as "all hubs" (GBT-B5) or an all-hub grant read as a set: the first would run a statement for a hub nothing
  // can reach; the second would answer a Platform Admin empty for a hub it may read.
  it('excludes every hub from a set that is empty and none from the all-hub mode', () => {
    expect(scopeExcludesHub(effectiveScope({ hubScope: 'own' }, []), HUB_A)).toBe(true);
    expect(scopeExcludesHub(nowhere, HUB_A)).toBe(true);
    expect(scopeExcludesHub(everywhere, HUB_A)).toBe(false);
    expect(scopeExcludesHub(everywhere, HUB_B)).toBe(false);
  });

  const asked = (principalType: 'STAFF' | 'VENDOR' | 'RIDER', scope = own): AuthorizedRequest =>
    ({
      session: { principalType, principalId: '11111111-1111-4111-8111-111111111111' },
      scope,
    }) as unknown as AuthorizedRequest;

  // Break caught: the shortcut taken for a Vendor or a Rider, whose rows are scoped by what they own and not by a hub: their `scope` is the set of
  // hubs of their grant (often empty), which says nothing about the rows they may read, so a read answered empty on it would hide their own
  // requests and runs.
  it('is true for a staff session alone: a vendor and a rider are scoped by what they own', () => {
    expect(hubOutsideStaffGrant(asked('STAFF'), HUB_B)).toBe(true);
    expect(hubOutsideStaffGrant(asked('VENDOR'), HUB_B)).toBe(false);
    expect(hubOutsideStaffGrant(asked('RIDER'), HUB_B)).toBe(false);
    expect(hubOutsideStaffGrant(asked('VENDOR', nowhere), HUB_B)).toBe(false);
    expect(hubOutsideStaffGrant(asked('RIDER', nowhere), HUB_B)).toBe(false);
  });

  // Break caught: the grant of the wrong key (the session's widest, or its first) judged instead of the grant of the decision's own key.
  it('judges the scope of the decision it is given, whatever else the session holds', () => {
    expect(hubOutsideStaffGrant(asked('STAFF', own), HUB_B)).toBe(true);
    expect(hubOutsideStaffGrant(asked('STAFF', everywhere), HUB_B)).toBe(false);
    expect(hubOutsideStaffGrant(asked('STAFF', own), HUB_A)).toBe(false);
  });
});

describe('a tier decided from a discriminator in the query, before the request is validated (F03 of 23 October 2026)', () => {
  const declaration = {
    param: 'principal_type',
    tiers: { STAFF: 'P', VENDOR: 'P', RIDER: 'S' },
  } as const;

  // Break caught: a requirement read from the wrong value: Senior Ops asking for a staff member's sessions served because the rider
  // value was read, or a rider's sessions refused at the staff tier.
  it.each([
    ['STAFF', 'P'],
    ['VENDOR', 'P'],
    ['RIDER', 'S'],
  ] as const)('needs %s for the discriminator %s', (value, expected) => {
    expect(queryTierRequirement(declaration, { principal_type: value })).toBe(expected);
  });

  // Break caught: a discriminator the guard cannot read granting authority, or being read as "no requirement". It asks the least
  // tier any supported value asks, so that a caller who could never be served by any value is refused before the body is looked at,
  // and a caller who could be served by one gets the validation answer for their own input.
  it.each([
    ['missing', {}],
    ['empty', { principal_type: '' }],
    ['unknown', { principal_type: 'ADMIN' }],
    ['in lower case', { principal_type: 'staff' }],
    ['padded', { principal_type: ' STAFF' }],
    ['repeated', { principal_type: ['RIDER', 'STAFF'] }],
    ['an object', { principal_type: { a: 'STAFF' } }],
    ['a number', { principal_type: 1 }],
    ['an inherited name', { principal_type: '__proto__' }],
    ['a name of Object.prototype', { principal_type: 'constructor' }],
    ['a name of Object.prototype (toString)', { principal_type: 'toString' }],
  ])(
    'needs the least tier of the supported values when the discriminator is %s',
    (_label, query) => {
      expect(queryTierRequirement(declaration, query)).toBe('S');
    },
  );

  // Break caught: the least tier computed as the first listed, or as the highest.
  it('takes the least tier whatever the order the values are declared in', () => {
    expect(queryTierRequirement({ param: 'k', tiers: { A: 'P', B: 'A', C: 'S' } }, {})).toBe('A');
    expect(queryTierRequirement({ param: 'k', tiers: { C: 'S', B: 'A', A: 'P' } }, {})).toBe('A');
  });

  it('does not look at any other parameter', () => {
    expect(queryTierRequirement(declaration, { type: 'RIDER', principal_id: 'x' })).toBe('S');
  });

  // Break caught: the table the service and the guard read being two tables, so the guard and the service disagree.
  it('is the table the service asks as well', () => {
    expect(SESSION_PRINCIPAL_TIERS).toEqual({ STAFF: 'P', VENDOR: 'P', RIDER: 'S' });
    for (const kind of ['STAFF', 'VENDOR', 'RIDER'] as const) {
      expect(tierForSessionPrincipal(kind)).toBe(SESSION_PRINCIPAL_TIERS[kind]);
    }
  });
});

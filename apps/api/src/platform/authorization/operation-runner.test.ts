import { describe, expect, it } from 'vitest';

import type { StoredSession } from '../auth/ports/session-store.port.js';
import type { TransactionHandle, UnitOfWork } from '../auth/ports/unit-of-work.port.js';
import type { PolicyCoordinator } from '../database/policy-lock/coordinate.js';
import { bundleLock, fixedLock } from '../database/policy-lock/plan.js';
import type { SecurityContext } from '../database/transaction-context.js';
import type { AuthorizedRequest } from './authorized-request.js';
import type { OperationContexts } from './operation-contexts.js';
import { OperationRunner } from './operation-runner.js';
import type { Tier, TierRule } from './tier-policy.js';

/**
 * The lock-free path of the runner (S0.26; SECURITY_DESIGN.md section 13.10a, "Who takes which mode"), on fakes: a request that
 * changes nothing is served in one transaction under its context, and a request that changes state is refused at the first call,
 * before a context is built or a transaction opened. The locked path, and both on a real database in both orders of a race, are
 * `policy-change-races.db.test.ts`.
 */
const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  principalType: 'STAFF',
  principalId: '22222222-2222-4222-8222-222222222222',
} as unknown as StoredSession;

function authorized(stateChanging: boolean): AuthorizedRequest {
  return {
    session: SESSION,
    credential: 'COOKIE',
    idleMinutes: 30,
    judgedAt: new Date('2026-10-12T09:00:00.000Z'),
    permission: undefined,
    grant: undefined,
    scope: { hubScopeMode: 'SET', authorizedHubIds: [] },
    activity: 'qualifying',
    stateChanging,
  };
}

const TARGET = '33333333-3333-4333-8333-333333333333';

/** A request that acts on a record, with a grant of the tier given and the tier rule the route names (none, or one). */
function targeting(
  tierRule: string | undefined,
  grantTier: Tier | null = 'S',
  id: string = TARGET,
): AuthorizedRequest {
  return {
    ...authorized(true),
    grant: {
      permission: 'staff.identity.approve',
      hubScope: 'own',
      ownershipScope: 'any',
      tier: grantTier,
    },
    target: { entity: 'fixture_order', id, ...(tierRule === undefined ? {} : { tierRule }) },
  };
}

function runner(tierRules: Record<string, TierRule> = {}) {
  const events: string[] = [];
  const contexts = {
    of: () => {
      events.push('context');
      return Promise.resolve({} as SecurityContext);
    },
  } as unknown as OperationContexts;
  const unitOfWork: Pick<UnitOfWork, 'run'> = {
    run: (_context, work) => {
      events.push('transaction');
      return work({} as never);
    },
  };
  const coordinator = {
    run: () => {
      events.push('coordinator');
      return Promise.reject(new Error('not used here'));
    },
  } as unknown as Pick<PolicyCoordinator, 'run'>;
  return {
    events,
    runner: new OperationRunner({ coordinator, unitOfWork, contexts, tierRules }),
  };
}

describe('OperationRunner.read', () => {
  it('serves a request that changes nothing in one transaction under its context', async () => {
    const { events, runner: subject } = runner();

    const answer = await subject.read(authorized(false), 'correlation', () => {
      events.push('work');
      return Promise.resolve('served');
    });

    expect(answer).toBe('served');
    expect(events).toEqual(['context', 'transaction', 'work']);
  });

  // Break caught (a deliberate break of the guard's flag): a state-changing request on the path that takes no policy lock, which
  // would let an authorized mutation outlive a reduction that ended the authority it relied on. It is refused at once: no context is
  // built, no transaction is opened, the work does not run, and the lock path is not entered either (the use case chose wrongly).
  it('refuses a state-changing request before it builds a context, opens a transaction or runs the work', async () => {
    const { events, runner: subject } = runner();

    const failure = await subject
      .read(authorized(true), 'correlation', () => {
        events.push('work');
        return Promise.resolve('served');
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as Error).message).toMatch(/runs through OperationRunner\.mutate/);
    expect(events).toEqual([]);
  });
});

describe('OperationRunner.actAsAuthentication (S0.49)', () => {
  const AUTHENTICATION = {
    principalType: 'SYSTEM',
    principalId: '61757468-0000-4000-8000-000000000001',
    surface: 'SYSTEM',
    taskCapability: 'authentication',
    correlationId: 'correlation',
  } as SecurityContext;
  const vendor = (): AuthorizedRequest => ({
    ...authorized(true),
    session: {
      ...SESSION,
      principalType: 'VENDOR',
      authority: { bundleId: '44444444-4444-4444-8444-444444444444' },
    } as unknown as StoredSession,
  });

  function recording() {
    const seen: { context?: SecurityContext; plan?: unknown } = {};
    const coordinator = {
      run: (context: SecurityContext, steps: { plan: () => unknown }) => {
        seen.context = context;
        seen.plan = steps.plan();
        return Promise.resolve('acted');
      },
    } as unknown as Pick<PolicyCoordinator, 'run'>;
    const contexts = {
      of: () => Promise.reject(new Error('no session context is built')),
    } as unknown as OperationContexts;
    const unitOfWork: Pick<UnitOfWork, 'run'> = {
      run: () => Promise.reject(new Error('not used')),
    };
    return { seen, subject: new OperationRunner({ coordinator, unitOfWork, contexts }) };
  }

  // Break caught: a vendor's own credential act run with none of its session's policy locks, or in the session's own context, where row-level
  // security gives a vendor no write on the grant, the message or the browser (data-scope-registry.md: Vendor DENY).
  it('takes the session’s shared policy locks and runs the work under the authentication capability it is given', async () => {
    const { seen, subject } = recording();

    expect(
      await subject.actAsAuthentication(vendor(), AUTHENTICATION, () => Promise.resolve('x')),
    ).toBe('acted');

    expect(seen.context).toBe(AUTHENTICATION);
    expect(seen.plan).toEqual([
      bundleLock('44444444-4444-4444-8444-444444444444', 'shared'),
      fixedLock('VENDOR', 'shared'),
    ]);
  });

  // Break caught: the path used to widen any context: another capability, a principal's own context, or a staff session.
  it('refuses a context that is not the authentication capability, and a session that is not a vendor’s', async () => {
    const { seen, subject } = recording();
    for (const context of [
      { ...AUTHENTICATION, taskCapability: 'credential_delivery' },
      { ...AUTHENTICATION, principalType: 'VENDOR' },
    ] as SecurityContext[]) {
      await expect(
        subject.actAsAuthentication(vendor(), context, () => Promise.resolve('x')),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      subject.actAsAuthentication(authorized(true), AUTHENTICATION, () => Promise.resolve('x')),
    ).rejects.toBeInstanceOf(TypeError);
    expect(seen).toEqual({});
  });
});

describe('OperationRunner.requireTargetTier (the review of 12 October 2026, F01)', () => {
  const HANDLE = {} as TransactionHandle;
  const rules = (answer: Tier | null) => {
    const asked: [unknown, string][] = [];
    const rule: TierRule = (transaction, id) => {
      asked.push([transaction, id]);
      return Promise.resolve(answer);
    };
    return { asked, tierRules: { order_tier: rule } };
  };

  // Break caught: the transaction that acts trusting the answer the guard got before it waited for its locks.
  it('asks the route’s rule about the target, with the transaction that acts', async () => {
    const { asked, tierRules } = rules('P');
    const { runner: subject } = runner(tierRules);

    await expect(
      subject.requireTargetTier(targeting('order_tier', 'S'), HANDLE),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_AUTHORITY',
    });
    await expect(
      subject.requireTargetTier(targeting('order_tier', 'P'), HANDLE),
    ).resolves.toBeUndefined();

    expect(asked).toHaveLength(2);
    expect(asked[0]?.[0]).toBe(HANDLE);
    expect(asked[0]?.[1]).toBe(TARGET);
  });

  // Break caught: a rule asked of a route that declared none, or a route that names no record.
  it('asks nothing of a route that declares no rule, or names no record', async () => {
    const { asked, tierRules } = rules('P');
    const { runner: subject } = runner(tierRules);

    await subject.requireTargetTier(targeting(undefined, 'A'), HANDLE);
    await subject.requireTargetTier(authorized(true), HANDLE);

    expect(asked).toEqual([]);
  });

  // Break caught: an id that names no record looked up: the validation step answers it (the guard does not look it up either).
  it('does not ask about an id that is not a UUID', async () => {
    const { asked, tierRules } = rules('P');
    const { runner: subject } = runner(tierRules);

    await subject.requireTargetTier(targeting('order_tier', 'A', 'not-an-id'), HANDLE);

    expect(asked).toEqual([]);
  });

  // Break caught: a rule the application does not have read as "no requirement".
  it('fails on a rule the application does not have', async () => {
    const { runner: subject } = runner({});

    await expect(subject.requireTargetTier(targeting('order_tier'), HANDLE)).rejects.toThrow(
      /not one of the application/,
    );
  });
});

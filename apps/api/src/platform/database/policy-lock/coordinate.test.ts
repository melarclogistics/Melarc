import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../../test-support/captured-logs.js';
import {
  FakeConnection,
  FakePool,
  serverError,
  testRuntime,
} from '../../../test-support/fake-pg.js';
import { ManualClock } from '../../../test-support/manual-clock.js';
import {
  BudgetClosedError,
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../execution/execution-budget.js';
import { ReadinessRegistry } from '../../health/readiness.registry.js';
import { ShutdownRegistry } from '../../lifecycle/shutdown.registry.js';
import { DatabaseDeadlineError } from '../database-failures.js';
import { DatabaseService, type DatabaseTransaction } from '../database.service.js';
import type { SecurityContext } from '../transaction-context.js';
import {
  POLICY_MAX_ATTEMPTS,
  PolicyCoordinationError,
  PolicyCoordinator,
  PolicyRestartRequired,
  type PolicyCoordination,
} from './coordinate.js';
import { AUTH_POLICY_BUNDLE } from './lock-keys.js';
import { bundleLock } from './plan.js';

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'unit-test',
};
const BUNDLE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BUNDLE_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';

let clock: ManualClock;

beforeEach(() => {
  vi.useFakeTimers();
  clock = new ManualClock();
});

afterEach(() => {
  vi.useRealTimers();
});

async function pass(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  clock.advance(milliseconds);
  await vi.advanceTimersByTimeAsync(milliseconds);
}

/** A real database service over connections that answer at once, a new one for each transaction. */
function build(
  options: {
    totalDeadlineMs?: number;
    maxAttempts?: number;
    onConnection?: (connection: FakeConnection, index: number) => void;
  } = {},
) {
  const pool = new FakePool();
  const connections: FakeConnection[] = [];
  pool.connect.mockImplementation(() => {
    const connection = new FakeConnection({ processID: 1000 + connections.length }).answer(
      /transaction_isolation/,
      [{ level: 'read committed' }],
    );
    options.onConnection?.(connection, connections.length);
    connections.push(connection);
    return Promise.resolve(connection);
  });
  const service = new DatabaseService(
    pool as unknown as Pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    testRuntime({ clock }),
  );
  const coordinator = new PolicyCoordinator(service, {
    clock,
    totalDeadlineMs: options.totalDeadlineMs ?? 5_000,
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return { coordinator, connections };
}

interface Facts {
  readonly bundle: string;
}

/** An operation whose facts the test controls: `current` is what a locked read returns, `calls` what ran. */
function operation(
  overrides: Partial<PolicyCoordination<Facts, string>> & { current: () => Facts },
) {
  const calls: string[] = [];
  const spec: PolicyCoordination<Facts, string> = {
    discover: () => {
      calls.push('discover');
      return Promise.resolve({ bundle: BUNDLE_A });
    },
    plan: (discovered) => [bundleLock(discovered.bundle, 'shared')],
    revalidate: () => {
      calls.push('revalidate');
      return Promise.resolve(overrides.current());
    },
    unchanged: (before, after) => before.bundle === after.bundle,
    work: () => {
      calls.push('work');
      return Promise.resolve('done');
    },
    ...overrides,
  };
  return { spec, calls };
}

/** The nth item, which the test knows is there. */
function at<T>(items: readonly (T | undefined)[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`there is no item ${String(index)}`);
  return item;
}

const lockStatements = (connection: FakeConnection): string[] =>
  connection.statements.filter((text) => text.includes('pg_advisory_xact_lock'));

describe('PolicyCoordinator: discover, plan, lock, revalidate, act (SECURITY_DESIGN.md §13.10a)', () => {
  // Break caught: the locks taken in the discovery transaction (so they are released before the act), or the act run in it.
  it('discovers in a transaction of its own, then locks, revalidates and acts in a second', async () => {
    const { coordinator, connections } = build();
    const { spec, calls } = operation({ current: () => ({ bundle: BUNDLE_A }) });

    await expect(coordinator.run(STAFF, spec)).resolves.toBe('done');

    expect(calls).toEqual(['discover', 'revalidate', 'work']);
    expect(connections).toHaveLength(2);
    expect(lockStatements(at(connections, 0))).toEqual([]);
    expect(lockStatements(at(connections, 1))).toHaveLength(1);
    expect(connections[1]?.statements.at(-1)).toBe('commit');
  });

  // Break caught: the revalidation read before the locks, so it is not a read under them.
  it('revalidates only after every lock is held, and acts only after the revalidation passed', async () => {
    const { coordinator, connections } = build();
    const { spec } = operation({
      current: () => ({ bundle: BUNDLE_A }),
      revalidate: async (tx: DatabaseTransaction) => {
        await tx.execute(sql`select 1 as revalidation`);
        return { bundle: BUNDLE_A };
      },
      work: async (tx: DatabaseTransaction) => {
        await tx.execute(sql`select 1 as the_act`);
        return 'done';
      },
    });

    await coordinator.run(STAFF, spec);

    const statements = connections[1]?.workStatements ?? [];
    const lock = statements.findIndex((text) => text.includes('pg_advisory_xact_lock'));
    const revalidation = statements.findIndex((text) => text.includes('revalidation'));
    const act = statements.findIndex((text) => text.includes('the_act'));
    expect(lock).toBeGreaterThan(0);
    expect(revalidation).toBeGreaterThan(lock);
    expect(act).toBeGreaterThan(revalidation);
  });

  // Break caught: a changed fact acted on anyway, or a restart that keeps the transaction (and the stale locks) it started in.
  it('rolls the whole transaction back and starts again when the facts changed, doing nothing meanwhile', async () => {
    const { coordinator, connections } = build();
    const answers = [{ bundle: BUNDLE_B }, { bundle: BUNDLE_A }];
    const { spec, calls } = operation({ current: () => answers.shift() ?? { bundle: BUNDLE_A } });

    await expect(coordinator.run(STAFF, spec)).resolves.toBe('done');

    // discover, (lock, revalidate: changed, rolled back), discover, (lock, revalidate, work)
    expect(calls).toEqual(['discover', 'revalidate', 'discover', 'revalidate', 'work']);
    expect(connections).toHaveLength(4);
    expect(connections[1]?.statements.at(-1)).toBe('rollback');
    expect(connections[1]?.statements).not.toContain('commit');
    expect(connections[3]?.statements.at(-1)).toBe('commit');
  });

  // Break caught: unbounded restarts, or a bound that is not the one the specification names ("a small bounded number").
  it('restarts a bounded number of times and then fails with a generic coordination error, never acting', async () => {
    const { coordinator, connections } = build();
    const { spec, calls } = operation({ current: () => ({ bundle: BUNDLE_B }) });

    const failure = await coordinator.run(STAFF, spec).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PolicyCoordinationError);
    expect((failure as PolicyCoordinationError).attempts).toBe(POLICY_MAX_ATTEMPTS);
    expect((failure as PolicyCoordinationError).kind).toBe('restarts-exhausted');
    expect(calls.filter((call) => call === 'work')).toEqual([]);
    expect(calls.filter((call) => call === 'discover')).toHaveLength(POLICY_MAX_ATTEMPTS);
    expect(connections).toHaveLength(2 * POLICY_MAX_ATTEMPTS);
    expect(connections.every((connection) => !connection.statements.includes('commit'))).toBe(
      false,
    );
    expect(
      connections
        .filter((_connection, at) => at % 2 === 1)
        .every((connection) => connection.statements.at(-1) === 'rollback'),
    ).toBe(true);
  });

  it('pins the restart bound at three attempts: the first and two restarts', () => {
    expect(POLICY_MAX_ATTEMPTS).toBe(3);
  });

  it('can be given another bound', async () => {
    const { coordinator } = build({ maxAttempts: 1 });
    const { spec, calls } = operation({ current: () => ({ bundle: BUNDLE_B }) });

    await expect(coordinator.run(STAFF, spec)).rejects.toBeInstanceOf(PolicyCoordinationError);
    expect(calls.filter((call) => call === 'discover')).toHaveLength(1);
  });

  // Break caught (a restart granting a fresh deadline): three slow attempts that each fit a deadline of their own would run
  // for ever in sum; they share one.
  it('gives every attempt, restarts included, the one total deadline: a restart never grants a fresh one', async () => {
    const { coordinator } = build({ totalDeadlineMs: 1_000 });
    let discoveries = 0;
    const { spec } = operation({
      current: () => ({ bundle: BUNDLE_B }),
      discover: async () => {
        discoveries += 1;
        // 450 ms of work outside the database per attempt: two fit the deadline, three do not.
        await new Promise<void>((resolve) => setTimeout(resolve, 450));
        return { bundle: BUNDLE_A };
      },
    });

    const outcome = coordinator.run(STAFF, spec).catch((error: unknown) => error);
    await pass(450);
    await pass(450);
    await pass(450);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(BudgetExpiredError);
    expect((failure as BudgetExpiredError).label).toBe('policy-coordination');
    expect(discoveries).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Break caught: a restart loop that ignores the request it serves.
  it('is capped by what the request has left, and names the request', async () => {
    const { coordinator } = build({ totalDeadlineMs: 5_000 });
    const request = new ExecutionBudget(clock, 'request', 600);
    const { spec } = operation({
      current: () => ({ bundle: BUNDLE_B }),
      discover: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        return { bundle: BUNDLE_A };
      },
    });

    const outcome = runWithBudget(request, () => coordinator.run(STAFF, spec)).catch(
      (error: unknown) => error,
    );
    await pass(400);
    await pass(400);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(BudgetExpiredError);
    expect((failure as BudgetExpiredError).label).toBe('request');
    request.finish();
  });

  // Break caught (F05): a coordinator started by a continuation of a request that was answered, which would make a deadline of
  // its own and go on to lock and write.
  it('refuses to start under a request that has finished, before it discovers anything', async () => {
    const { coordinator, connections } = build();
    const request = new ExecutionBudget(clock, 'request', 600);
    request.finish();
    const { spec, calls } = operation({ current: () => ({ bundle: BUNDLE_A }) });

    const failure = await runWithBudget(request, () => coordinator.run(STAFF, spec)).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(BudgetClosedError);
    expect(calls).toEqual([]);
    expect(connections).toHaveLength(0);
  });

  // Break caught (rule 5, no upgrades): a path that needs exclusive on a key it holds shared asking for it in the same
  // transaction, which two such holders would wait on for ever.
  it('restarts with the stronger plan from the start when the act needs a key exclusive, never upgrading', async () => {
    const { coordinator, connections } = build();
    let attempt = 0;
    const { spec } = operation({
      current: () => ({ bundle: BUNDLE_A }),
      work: () => {
        attempt += 1;
        if (attempt === 1) {
          throw new PolicyRestartRequired([bundleLock(BUNDLE_A, 'exclusive')]);
        }
        return Promise.resolve('done');
      },
    });

    await expect(coordinator.run(STAFF, spec)).resolves.toBe('done');

    // The first main transaction took the key shared and was rolled back; the second took it exclusive, once, and no other way.
    expect(lockStatements(at(connections, 1))).toEqual([
      'select pg_advisory_xact_lock_shared($1::int4, $2::int4)',
    ]);
    expect(connections[1]?.statements.at(-1)).toBe('rollback');
    expect(lockStatements(at(connections, 3))).toEqual([
      'select pg_advisory_xact_lock($1::int4, $2::int4)',
    ]);
    expect(connections[3]?.statements.at(-1)).toBe('commit');
  });

  // Break caught: an act that failed being run again, or the failure turned into a restart.
  it('does not restart for an error of the act', async () => {
    const { coordinator, connections } = build();
    const failure = new Error('the act failed');
    const { spec, calls } = operation({
      current: () => ({ bundle: BUNDLE_A }),
      work: () => Promise.reject(failure),
    });

    await expect(coordinator.run(STAFF, spec)).rejects.toBe(failure);

    expect(calls.filter((call) => call === 'discover')).toHaveLength(1);
    expect(connections).toHaveLength(2);
    expect(connections[1]?.statements.at(-1)).toBe('rollback');
  });

  // Break caught: a lock timeout retried until the deadline, hammering a lock that is held, instead of the generic failure.
  it('does not restart for a lock timeout: the database’s deadline error goes to the caller', async () => {
    const { coordinator, connections } = build({
      // The second connection is the locked transaction: its lock wait times out.
      onConnection: (connection, index) => {
        if (index === 1) {
          connection.fail(/pg_advisory_xact_lock_shared/, serverError('55P03', 'lock timeout'));
        }
      },
    });
    const { spec, calls } = operation({ current: () => ({ bundle: BUNDLE_A }) });

    const failure = await coordinator.run(STAFF, spec).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DatabaseDeadlineError);
    expect((failure as DatabaseDeadlineError).kind).toBe('lock');
    expect(connections).toHaveLength(2);
    expect(calls).toEqual(['discover']);
    expect(connections[1]?.destroyed).toBe(true);
  });

  it('plans from the discovery and merges what it plans into one canonical list', async () => {
    const { coordinator, connections } = build();
    const { spec } = operation({
      current: () => ({ bundle: BUNDLE_A }),
      plan: () => [
        bundleLock(BUNDLE_B, 'shared'),
        bundleLock(BUNDLE_A, 'shared'),
        bundleLock(BUNDLE_A, 'exclusive'),
      ],
    });

    await coordinator.run(STAFF, spec);

    const main = connections[1];
    const kinds = lockStatements(at([main], 0)).map((text) =>
      text.includes('_shared') ? 'shared' : 'exclusive',
    );
    expect(kinds).toHaveLength(2);
    // The class is the same for both; the order is by key, the strongest mode of A wins.
    const keys = main?.values.filter((_values, at) => main.statements[at]?.includes('pg_advisory'));
    expect(keys?.map((pair) => pair[0])).toEqual([AUTH_POLICY_BUNDLE, AUTH_POLICY_BUNDLE]);
    expect([...(keys ?? [])].map((pair) => pair[1])).toEqual(
      [...(keys ?? [])].map((pair) => pair[1]).toSorted((a, b) => Number(a) - Number(b)),
    );
    expect(kinds.filter((kind) => kind === 'exclusive')).toHaveLength(1);
  });
});

describe('PolicyCoordinator: its bounds', () => {
  it.each([0, -1, 1.5, Number.NaN, 11])('refuses %s attempts', (maxAttempts) => {
    expect(() => build({ maxAttempts })).toThrow(RangeError);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a total deadline of %s milliseconds',
    (totalDeadlineMs) => {
      expect(() => build({ totalDeadlineMs })).toThrow(RangeError);
    },
  );
});

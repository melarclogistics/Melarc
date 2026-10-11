import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { API_RUNTIME_ROLE, type DatabaseDeadlines } from '../../src/platform/config/load-config.js';
import { DatabaseDeadlineError } from '../../src/platform/database/database-failures.js';
import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import {
  PolicyIsolationError,
  acquirePolicyLocks,
} from '../../src/platform/database/policy-lock/acquire.js';
import {
  POLICY_MAX_ATTEMPTS,
  PolicyCoordinationError,
  PolicyCoordinator,
} from '../../src/platform/database/policy-lock/coordinate.js';
import { AUTH_POLICY_BUNDLE } from '../../src/platform/database/policy-lock/lock-keys.js';
import { bundleLock, planPolicyLocks } from '../../src/platform/database/policy-lock/plan.js';
import {
  BudgetExpiredError,
  ExecutionBudget,
  runWithBudget,
} from '../../src/platform/execution/execution-budget.js';
import { DISPOSAL_BOUND_MS } from '../../src/platform/execution/execution-parameters.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { HUB_A, staffContext } from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import {
  createTestDatabase,
  scalar,
  sqlState,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

/**
 * S0.7 against a real PostgreSQL, as `melarc_api_runtime`: the advisory-lock toolkit of SECURITY_DESIGN.md §13.10a on a pool, with
 * the policy tables as the fixtures they will be until S0.8 builds them (a table the runtime can read and cannot lock or change).
 * What the locks do is observed from the administrator's connection, in `pg_locks` and `pg_stat_activity`.
 */

const FIXTURE_SQL = `
CREATE SCHEMA policy_fixture AUTHORIZATION melarc_owner;
GRANT USAGE ON SCHEMA policy_fixture TO melarc_api_runtime;
CREATE TABLE policy_fixture.bundle (id uuid PRIMARY KEY, revision integer NOT NULL, reduction_floor integer NOT NULL);
CREATE TABLE policy_fixture.identity (id uuid PRIMARY KEY, bundle_id uuid NOT NULL);
CREATE TABLE policy_fixture.effects (id serial PRIMARY KEY, note text NOT NULL);
ALTER TABLE policy_fixture.bundle OWNER TO melarc_owner;
ALTER TABLE policy_fixture.identity OWNER TO melarc_owner;
ALTER TABLE policy_fixture.effects OWNER TO melarc_owner;
GRANT SELECT ON policy_fixture.bundle, policy_fixture.identity TO melarc_api_runtime;
GRANT SELECT, INSERT ON policy_fixture.effects TO melarc_api_runtime;
GRANT USAGE ON SEQUENCE policy_fixture.effects_id_seq TO melarc_api_runtime;
`;

const BUNDLE_A = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const BUNDLE_B = 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2';
const BUNDLE_C = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const IDENTITY = 'd4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4';
const STAFF = staffContext([HUB_A]);

/** Small bounds, so that a lock wait and a deadline can be reached. The relations hold. */
const FAST: DatabaseDeadlines = {
  acquireTimeoutMs: 2_000,
  lockTimeoutMs: 400,
  statementTimeoutMs: 1_500,
  idleInTransactionTimeoutMs: 3_000,
  transactionTimeoutMs: 4_000,
  maxWaiters: 10,
};

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
  await withClient(database.urlFor(MIGRATION_ROLE), (client) => client.query(FIXTURE_SQL));
  await withClient(database.urlFor('postgres'), async (admin) => {
    await admin.query(
      'insert into policy_fixture.bundle values ($1, 1, 1), ($2, 1, 1), ($3, 1, 1)',
      [BUNDLE_A, BUNDLE_B, BUNDLE_C],
    );
    await admin.query('insert into policy_fixture.identity values ($1, $2)', [IDENTITY, BUNDLE_A]);
  });
});

afterAll(async () => {
  await database.drop();
});

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(40);
  }
}

interface AdvisoryLock {
  readonly pid: number;
  readonly class: number;
  /** As the key was given: pg_locks shows the second integer unsigned. */
  readonly key: number;
  readonly mode: string;
  readonly granted: boolean;
}

/** The advisory locks of the database, as the administrator sees them: held, or waited for. */
async function advisoryLocks(pid?: number): Promise<AdvisoryLock[]> {
  return withClient(database.urlFor('postgres'), async (admin) => {
    const { rows } = await admin.query(
      `select pid, classid::bigint as class, objid::bigint as key, mode, granted
         from pg_locks l join pg_database d on d.oid = l.database
        where l.locktype = 'advisory' and d.datname = $1 ${pid === undefined ? '' : 'and l.pid = $2'}`,
      pid === undefined ? [database.name] : [database.name, pid],
    );
    return rows.map((row: Record<string, unknown>) => ({
      pid: Number(row.pid),
      class: Number(row.class),
      key: Number(row.key) | 0,
      mode: String(row.mode),
      granted: row.granted === true,
    }));
  });
}

async function isGone(pid: number): Promise<boolean> {
  return withClient(
    database.urlFor('postgres'),
    async (admin) =>
      (await scalar<number>(admin, 'select count(*)::int from pg_stat_activity where pid = $1', [
        pid,
      ])) === 0,
  );
}

const backendPid = async (tx: DatabaseTransaction): Promise<number> => {
  const result = await tx.execute(sql`select pg_backend_pid() as pid`);
  return Number((result.rows[0] as { pid: number | string }).pid);
};

/** The process id of the API's backend that is waiting for an advisory lock, or 0. */
const waitingForAdvisoryLock = (): Promise<number> =>
  withClient(database.urlFor('postgres'), async (admin) => {
    const { rows } = await admin.query(
      `select pid from pg_stat_activity
        where datname = $1 and application_name = 'melarc-api' and wait_event_type = 'Lock' and wait_event = 'advisory'`,
      [database.name],
    );
    return (rows[0] as { pid?: number } | undefined)?.pid ?? 0;
  });

const effects = (): Promise<number> =>
  withClient(database.urlFor('postgres'), (admin) =>
    scalar<number>(admin, 'select count(*)::int from policy_fixture.effects'),
  );

const settled = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const latch = () => {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

describe('the privilege the policy tables allow the runtime login (SECURITY_DESIGN.md §13.10a, obligation 1)', () => {
  // Break caught: a grant that would let a runtime login lock a policy row. PostgreSQL requires UPDATE for FOR SHARE, so the
  // protocol uses advisory locks, which need no table privilege. Both facts, as the runtime login.
  it('refuses UPDATE and a row-locking SELECT on a table it can read, and runs the advisory functions', async () => {
    await withClient(database.urlFor(API_RUNTIME_ROLE), async (client) => {
      expect(
        await sqlState(client, 'update policy_fixture.bundle set revision = revision + 1'),
      ).toBe('42501');
      expect(await sqlState(client, 'select * from policy_fixture.bundle for share')).toBe('42501');
      expect(await sqlState(client, 'select * from policy_fixture.bundle for key share')).toBe(
        '42501',
      );
      expect(await sqlState(client, 'select * from policy_fixture.bundle')).toBeUndefined();
      await client.query('begin');
      expect(await sqlState(client, 'select pg_advisory_xact_lock(1, 2)')).toBeUndefined();
      expect(await sqlState(client, 'select pg_advisory_xact_lock_shared(1, 3)')).toBeUndefined();
      await client.query('rollback');
    });
  });

  it('holds no UPDATE grant on the fixture tables, in the catalogue', async () => {
    await withClient(database.urlFor('postgres'), async (admin) => {
      for (const table of ['bundle', 'identity']) {
        expect(
          await scalar<boolean>(
            admin,
            `select has_table_privilege('${API_RUNTIME_ROLE}', 'policy_fixture.${table}', 'UPDATE')`,
          ),
        ).toBe(false);
      }
    });
  });
});

describe('no advisory lock survives its transaction (Family A)', () => {
  const plan = planPolicyLocks([bundleLock(BUNDLE_A, 'exclusive'), bundleLock(BUNDLE_B, 'shared')]);

  // Break caught: a session-level lock, or a lock held past COMMIT or ROLLBACK on a pooled connection, which the next request
  // would inherit. A pool of one makes the same connection serve every request: its backend id is the same, and its locks none.
  it.each([
    ['commits', () => Promise.resolve()],
    ['rolls back (the work fails)', () => Promise.reject(new Error('the work failed'))],
    [
      'is aborted by a statement error',
      async (tx: DatabaseTransaction) => {
        await tx.execute(sql`select 1 / 0`);
      },
    ],
  ])('on a connection reused after a transaction that %s', async (_label, afterLocks) => {
    const { service, close } = buildService(database, { deadlines: FAST });
    try {
      let pid = 0;
      let heldInside = 0;
      await service
        .transactionWithContext(STAFF, async (tx) => {
          await acquirePolicyLocks(tx, plan);
          pid = await backendPid(tx);
          heldInside = (await advisoryLocks(pid)).filter((lock) => lock.granted).length;
          await afterLocks(tx);
        })
        .catch(() => undefined);

      expect(heldInside).toBe(2);
      // The transaction has ended; its connection is back in the pool and holds nothing.
      expect(await advisoryLocks(pid)).toEqual([]);

      const next = await service.transactionWithContext(STAFF, async (tx) => ({
        pid: await backendPid(tx),
        held: (await advisoryLocks(await backendPid(tx))).length,
      }));
      expect(next.pid).toBe(pid);
      expect(next.held).toBe(0);
    } finally {
      await close();
    }
  });

  it('on a connection that is destroyed because its budget ran out', async () => {
    const { service, close } = buildService(database, { deadlines: FAST });
    const request = new ExecutionBudget(new SystemClock(), 'request', 300);
    try {
      let pid = 0;
      const outcome = await settled(
        runWithBudget(request, () =>
          service.transactionWithContext(STAFF, async (tx) => {
            await acquirePolicyLocks(tx, plan);
            pid = await backendPid(tx);
            await tx.execute(sql`select pg_sleep(10)`);
          }),
        ),
      );

      expect(outcome).toMatchObject({ error: expect.any(BudgetExpiredError) as unknown });
      await eventually(() => isGone(pid), 'the backend to be gone');
      expect(await advisoryLocks()).toEqual([]);
    } finally {
      request.finish();
      await close();
    }
  });
});

describe('the lock timeout (obligation 6)', () => {
  // Break caught: an acquisition that waits for a lock as long as its holder keeps it. The database's lock_timeout ends it, the
  // caller is told which bound it was, nothing was written, and the connection that waited is destroyed.
  it('ends a wait for a held lock at lock_timeout: the lock deadline error, no effect, the connection destroyed', async () => {
    const { service, close } = buildService(database, { deadlines: FAST });
    const { Client } = await import('pg');
    const { postgresConnectionSettings } =
      await import('../../src/platform/database/postgres-url.js');
    const holder = new Client({ ...postgresConnectionSettings(database.urlFor('postgres')) });
    holder.on('error', () => undefined);
    await holder.connect();
    const plan = planPolicyLocks([bundleLock(BUNDLE_A, 'shared')]);
    const [lock] = plan;
    // The administrator holds the key exclusively, at session level (a test may; the application may not).
    await holder.query('select pg_advisory_lock($1::int4, $2::int4)', [lock?.class, lock?.key]);
    try {
      const started = Date.now();
      const running = settled(
        service.transactionWithContext(STAFF, async (tx) => {
          await acquirePolicyLocks(tx, plan);
          await tx.execute(
            sql`insert into policy_fixture.effects (note) values ('after the locks')`,
          );
        }),
      );
      // The backend that waits for the lock, seen from outside.
      let pid = 0;
      await eventually(async () => {
        pid = await waitingForAdvisoryLock();
        return pid !== 0;
      }, 'a backend waiting for the advisory lock');
      const outcome = await running;

      expect(outcome).toMatchObject({ error: expect.any(DatabaseDeadlineError) as unknown });
      expect((outcome as { error: DatabaseDeadlineError }).error.kind).toBe('lock');
      expect(Date.now() - started).toBeGreaterThanOrEqual(350);
      expect(Date.now() - started).toBeLessThan(2_000);
      await eventually(() => isGone(pid), 'the waiting backend to be gone');
      expect(await effects()).toBe(0);
      // Nothing of the runtime's remains in the lock table; the holder's lock is untouched.
      expect((await advisoryLocks()).every((each) => each.granted)).toBe(true);
    } finally {
      await holder.end();
      await close();
    }
  });
});

describe('the modes: shared with shared, exclusive against shared, distinct keys apart (obligations 5 and 12, at the toolkit)', () => {
  // Break caught: a shared lock that excludes another shared one (contention that serialises every sign-in), an exclusive that
  // admits a reader, or a key that blocks an unrelated one.
  it('lets two holders share a key, makes a writer wait for them, and leaves a distinct key alone', async () => {
    const { service, close } = buildService(database, {
      poolMax: 6,
      deadlines: { ...FAST, lockTimeoutMs: 8_000 },
    });
    try {
      const release = latch();
      const keyA = bundleLock(BUNDLE_A, 'shared').key;
      const keyB = bundleLock(BUNDLE_B, 'shared').key;
      const hold = (...requests: ReturnType<typeof bundleLock>[]) =>
        service.transactionWithContext(STAFF, async (tx) => {
          await acquirePolicyLocks(tx, planPolicyLocks(requests));
          await release.opened;
        });

      // Two readers of A hold it together.
      const readers = [hold(bundleLock(BUNDLE_A, 'shared')), hold(bundleLock(BUNDLE_A, 'shared'))];
      await eventually(
        async () =>
          (await advisoryLocks()).filter(
            (lock) => lock.key === keyA && lock.granted && lock.mode === 'ShareLock',
          ).length === 2,
        'two shared holders',
      );

      // A writer of A waits behind them; a holder of B, a distinct key, is not blocked by any of it.
      const writer = hold(bundleLock(BUNDLE_A, 'exclusive'));
      await eventually(
        async () => (await advisoryLocks()).some((lock) => lock.key === keyA && !lock.granted),
        'the writer waiting',
      );
      const other = await settled(
        service.transactionWithContext(STAFF, async (tx) => {
          await acquirePolicyLocks(tx, planPolicyLocks([bundleLock(BUNDLE_B, 'exclusive')]));
          return 'B was free';
        }),
      );
      expect(other).toEqual({ value: 'B was free' });
      expect((await advisoryLocks()).some((lock) => lock.key === keyB)).toBe(false);

      // Releasing the readers lets the writer in, and its commit frees the key.
      release.open();
      await Promise.all(readers);
      await writer;
      expect(await advisoryLocks()).toEqual([]);
    } finally {
      await close();
    }
  });
});

describe('the isolation guard (obligation 9)', () => {
  // Break caught: a transaction at REPEATABLE READ or SERIALIZABLE reading a snapshot older than its locks. The level is set here
  // on the role the way a misconfigured database would set it; the service's transaction inherits it.
  it.each(['repeatable read', 'serializable'])(
    'refuses a transaction at %s, as the runtime login, and takes no lock',
    async (level) => {
      await withClient(database.urlFor('postgres'), (admin) =>
        admin.query(
          `alter role ${API_RUNTIME_ROLE} in database ${database.name} set default_transaction_isolation = '${level}'`,
        ),
      );
      const { service, close } = buildService(database, { deadlines: FAST });
      try {
        const outcome = await settled(
          service.transactionWithContext(STAFF, async (tx) => {
            await acquirePolicyLocks(tx, planPolicyLocks([bundleLock(BUNDLE_A, 'shared')]));
          }),
        );

        expect(outcome).toMatchObject({ error: expect.any(PolicyIsolationError) as unknown });
        expect((outcome as { error: PolicyIsolationError }).error.level).toBe(level);
        expect(await advisoryLocks()).toEqual([]);
      } finally {
        await close();
        await withClient(database.urlFor('postgres'), (admin) =>
          admin.query(
            `alter role ${API_RUNTIME_ROLE} in database ${database.name} reset default_transaction_isolation`,
          ),
        );
      }
    },
  );

  it('accepts the default level: the same transaction takes its locks', async () => {
    const { service, close } = buildService(database, { deadlines: FAST });
    try {
      await expect(
        service.transactionWithContext(STAFF, (tx) =>
          acquirePolicyLocks(tx, planPolicyLocks([bundleLock(BUNDLE_A, 'shared')])),
        ),
      ).resolves.toBeUndefined();
    } finally {
      await close();
    }
  });
});

describe('discovery, revalidation and the bounded restart, on a real database (obligations 11 and 12)', () => {
  /** An operation on the fixture identity: discover its bundle, lock it, read it again under the lock, then act. */
  function onIdentity(options: {
    afterDiscovery?: (attempt: number) => Promise<void>;
    discoveryDelayMs?: number;
    calls: { discover: number; revalidate: number; work: number };
    seenUnderLock?: { effects: number; locks: AdvisoryLock[] }[];
  }) {
    return {
      discover: async (tx: DatabaseTransaction) => {
        options.calls.discover += 1;
        const result = await tx.execute(
          sql`select bundle_id from policy_fixture.identity where id = ${IDENTITY}`,
        );
        if (options.discoveryDelayMs !== undefined) {
          await tx.execute(sql`select pg_sleep(${options.discoveryDelayMs / 1_000})`);
        }
        return { bundleId: (result.rows[0] as { bundle_id: string }).bundle_id };
      },
      plan: (discovered: { bundleId: string }) => [bundleLock(discovered.bundleId, 'shared')],
      revalidate: async (tx: DatabaseTransaction) => {
        options.calls.revalidate += 1;
        const pid = await backendPid(tx);
        const result = await tx.execute(
          sql`select bundle_id from policy_fixture.identity where id = ${IDENTITY}`,
        );
        options.seenUnderLock?.push({
          effects: await effectsIn(tx),
          locks: await advisoryLocks(pid),
        });
        return { bundleId: (result.rows[0] as { bundle_id: string }).bundle_id };
      },
      unchanged: (before: { bundleId: string }, after: { bundleId: string }) =>
        before.bundleId === after.bundleId,
      work: async (tx: DatabaseTransaction) => {
        options.calls.work += 1;
        await tx.execute(sql`insert into policy_fixture.effects (note) values ('the act')`);
        return 'acted';
      },
    };
  }

  const effectsIn = async (tx: DatabaseTransaction): Promise<number> =>
    Number(
      (await tx.execute(sql`select count(*)::int as n from policy_fixture.effects`)).rows[0]?.n,
    );

  const reassign = (bundleId: string) =>
    withClient(database.urlFor('postgres'), (admin) =>
      admin.query('update policy_fixture.identity set bundle_id = $1 where id = $2', [
        bundleId,
        IDENTITY,
      ]),
    );

  // Break caught: an act done on a bundle the identity no longer has. The identity is reassigned after the discovery and before
  // the locks; the revalidation under the lock sees it, nothing was written, and the restart finds the new bundle.
  it('restarts when the identity was reassigned between the discovery and the locks, and acts only on the second attempt', async () => {
    await reassign(BUNDLE_A);
    const { service, close } = buildService(database, { deadlines: FAST });
    const coordinator = new PolicyCoordinator(service, {
      clock: new SystemClock(),
      totalDeadlineMs: 5_000,
    });
    const calls = { discover: 0, revalidate: 0, work: 0 };
    const seenUnderLock: { effects: number; locks: AdvisoryLock[] }[] = [];
    const operation = onIdentity({
      calls,
      seenUnderLock,
      afterDiscovery: undefined,
    });
    const discover = operation.discover;
    operation.discover = async (tx) => {
      const discovered = await discover(tx);
      // After the first discovery, before its locks: another transaction reassigns the identity.
      if (calls.discover === 1) await reassign(BUNDLE_B);
      return discovered;
    };
    try {
      const before = await effects();

      await expect(coordinator.run(STAFF, operation)).resolves.toBe('acted');

      expect(calls).toEqual({ discover: 2, revalidate: 2, work: 1 });
      // Under the lock of the first attempt: A held shared, and no effect yet; under the second: B, and no effect yet.
      expect(seenUnderLock.map((seen) => seen.effects)).toEqual([before, before]);
      expect(seenUnderLock[0]?.locks.map((lock) => [lock.key, lock.mode, lock.granted])).toEqual([
        [bundleLock(BUNDLE_A, 'shared').key, 'ShareLock', true],
      ]);
      expect(seenUnderLock[1]?.locks.map((lock) => lock.key)).toEqual([
        bundleLock(BUNDLE_B, 'shared').key,
      ]);
      expect(await effects()).toBe(before + 1);
      expect(await advisoryLocks()).toEqual([]);
    } finally {
      await close();
      await reassign(BUNDLE_A);
    }
  });

  // Break caught: unbounded restarts. The identity is reassigned after every discovery, so the plan never holds; the operation
  // fails after the bound, having done nothing, and holds no lock.
  it(`fails after ${String(POLICY_MAX_ATTEMPTS)} attempts when the facts keep changing, having acted never`, async () => {
    await reassign(BUNDLE_A);
    const { service, close } = buildService(database, { deadlines: FAST });
    const coordinator = new PolicyCoordinator(service, {
      clock: new SystemClock(),
      totalDeadlineMs: 5_000,
    });
    const calls = { discover: 0, revalidate: 0, work: 0 };
    const operation = onIdentity({ calls });
    const discover = operation.discover;
    const bundles = [BUNDLE_B, BUNDLE_C, BUNDLE_A];
    operation.discover = async (tx) => {
      const discovered = await discover(tx);
      await reassign(bundles[(calls.discover - 1) % bundles.length] ?? BUNDLE_A);
      return discovered;
    };
    try {
      const before = await effects();

      const failure = await coordinator.run(STAFF, operation).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PolicyCoordinationError);
      expect((failure as PolicyCoordinationError).attempts).toBe(POLICY_MAX_ATTEMPTS);
      expect(calls).toEqual({
        discover: POLICY_MAX_ATTEMPTS,
        revalidate: POLICY_MAX_ATTEMPTS,
        work: 0,
      });
      expect(await effects()).toBe(before);
      expect(await advisoryLocks()).toEqual([]);
    } finally {
      await close();
      await reassign(BUNDLE_A);
    }
  });

  // Break caught: a restart that grants a fresh deadline. Each discovery here takes 300 ms and the facts always change: with a
  // deadline of 500 ms, one attempt fits and the second does not, however many attempts remain.
  it('gives all the attempts one total deadline: the operation ends when it passes, not after the last attempt', async () => {
    await reassign(BUNDLE_A);
    const { service, close } = buildService(database, {
      deadlines: { ...FAST, statementTimeoutMs: 3_000, transactionTimeoutMs: 6_000 },
    });
    const coordinator = new PolicyCoordinator(service, {
      clock: new SystemClock(),
      totalDeadlineMs: 500,
    });
    const calls = { discover: 0, revalidate: 0, work: 0 };
    const operation = onIdentity({ calls, discoveryDelayMs: 300 });
    const discover = operation.discover;
    operation.discover = async (tx) => {
      const discovered = await discover(tx);
      await reassign(BUNDLE_B);
      return discovered;
    };
    try {
      const started = Date.now();

      const failure = await coordinator.run(STAFF, operation).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(BudgetExpiredError);
      expect((failure as BudgetExpiredError).label).toBe('policy-coordination');
      expect(calls.work).toBe(0);
      expect(calls.discover).toBeLessThan(POLICY_MAX_ATTEMPTS + 1);
      expect(Date.now() - started).toBeLessThan(500 + DISPOSAL_BOUND_MS + 500);
      await eventually(async () => (await advisoryLocks()).length === 0, 'no lock to remain');
    } finally {
      await close();
      await reassign(BUNDLE_A);
    }
  });

  it('keys the locks it takes on the bundle class of the toolkit', async () => {
    const { service, close } = buildService(database, { deadlines: FAST });
    try {
      let seen: AdvisoryLock[] = [];
      await service.transactionWithContext(STAFF, async (tx) => {
        await acquirePolicyLocks(tx, planPolicyLocks([bundleLock(BUNDLE_C, 'shared')]));
        seen = await advisoryLocks(await backendPid(tx));
      });
      expect(seen.map((lock) => lock.class)).toEqual([AUTH_POLICY_BUNDLE]);
    } finally {
      await close();
    }
  });
});

import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { SecurityContextError } from '../../src/platform/database/transaction-context.js';
import {
  securityContextOf,
  transactionOf,
} from '../../src/platform/database/transaction-handle.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { hashOf } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.24: the real `UnitOfWork` (plan obligation OB-99, the first consumer of the port) against a real PostgreSQL. It opens the
 * transaction of `DatabaseService` under the context it is given and nothing else, hands the work the handle that port operations
 * take, commits when the work returns and rolls back when it throws, and reads the database's clock afresh each time it is asked.
 */
let database: TestDatabase;
let built: BuiltService;
let observer: Observer;
let unitOfWork: PostgresUnitOfWork;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  observer = await observe(database);
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await observer.close();
  await built.close();
  await database.drop();
});

/** Inserts a session as the authentication capability, which is a write the table lets that context make, and then fails or not. */
const insertSession = (id: string, fail: boolean): Promise<string> =>
  unitOfWork.run(systemContext('authentication'), async (handle) => {
    await transactionOf(handle).execute(sql`
      insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                           token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
      values (${id}, 'STAFF', ${randomUUID()}, '{"format":1}'::jsonb, ${BUNDLE_IDS.opsStaff}, 1, '{}',
              ${hashOf(id)}, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`);
    if (fail) throw new Error('the work failed');
    return id;
  });

describe('run', () => {
  // Break caught: a handle over some other context than the one the transaction was opened under, which would let an adapter act
  // as a principal the transaction does not run as (the audit's actor is read from it).
  it('gives the work a handle of the transaction under exactly the context it asked for', async () => {
    const seen = await unitOfWork.run(systemContext('authentication'), (handle) => {
      const applied = securityContextOf(handle);
      return Promise.resolve({
        principalType: applied.principalType,
        taskCapability: applied.taskCapability,
      });
    });

    expect(seen).toEqual({ principalType: 'SYSTEM', taskCapability: 'authentication' });
  });

  // Break caught: the work run outside a transaction, or committed before it ends: what a failure then leaves behind.
  it('commits what the work wrote when it returns, and rolls everything back when it throws', async () => {
    const kept = randomUUID();
    const lost = randomUUID();

    await expect(insertSession(kept, false)).resolves.toBe(kept);
    await expect(insertSession(lost, true)).rejects.toThrow('the work failed');

    expect(await observer.count('session', { id: kept })).toBe(1);
    expect(await observer.count('session', { id: lost })).toBe(0);
  });

  // Break caught: a context that fails validation opening a transaction anyway.
  it('refuses a context that is not valid, before it sends anything', async () => {
    await expect(
      unitOfWork.run({ ...staffContext([]), principalId: 'not-a-uuid' }, () =>
        Promise.resolve('never'),
      ),
    ).rejects.toBeInstanceOf(SecurityContextError);
  });

  // Break caught: a transaction opened inside another, which the database service refuses.
  it('refuses to open a transaction inside the work of another', async () => {
    await expect(
      unitOfWork.run(systemContext('authentication'), () =>
        unitOfWork.run(systemContext('authentication'), () => Promise.resolve('never')),
      ),
    ).rejects.toThrow();
  });
});

describe('databaseNow', () => {
  // Break caught: the transaction's start (`now()`) or the application's own clock standing in for the database's wall clock,
  // which a persisted expiry must be judged on afresh after any wait (SECURITY_DESIGN.md §13.3a).
  it('is the database’s wall clock, read afresh each time, and not the transaction’s start', async () => {
    const [first, second] = await unitOfWork.run(
      systemContext('authentication'),
      async (handle) => {
        const early = await unitOfWork.databaseNow(handle);
        await transactionOf(handle).execute(sql`select pg_sleep(0.2)`);
        return [early, await unitOfWork.databaseNow(handle)] as const;
      },
    );
    const databaseTime = await observer.one<{ now: Date }>(`select clock_timestamp() as now`);

    expect(first).toBeInstanceOf(Date);
    expect(second.getTime() - first.getTime()).toBeGreaterThanOrEqual(190);
    expect(Math.abs((databaseTime?.now.getTime() ?? 0) - second.getTime())).toBeLessThan(2_000);
  });
});

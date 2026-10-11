import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { CapturedLogs } from '../../../test-support/captured-logs.js';
import {
  FakeConnection,
  FakePool,
  serverError,
  testRuntime,
} from '../../../test-support/fake-pg.js';
import { ReadinessRegistry } from '../../health/readiness.registry.js';
import { ShutdownRegistry } from '../../lifecycle/shutdown.registry.js';
import { DatabaseService } from '../database.service.js';
import { bundleLock, fixedLock } from '../policy-lock/plan.js';
import { PROVISIONING_ROLE } from '../technical-roles.js';
import {
  SEED_PRINCIPAL_ID,
  SeedIncompleteError,
  SeedRefusedError,
  runSeed,
  type SeedPlan,
} from './seed-helper.js';

/** What the database function answers: the rows it inserted into each table. */
function build(options: { role?: string; report?: Record<string, number>; fail?: unknown } = {}) {
  const pool = new FakePool();
  const connection = new FakeConnection({ role: options.role ?? PROVISIONING_ROLE }).answer(
    /transaction_isolation/,
    [{ level: 'read committed' }],
  );
  if (options.report !== undefined) {
    connection.answer(/melarc\.(initialize_reference_data|add_reason_fixtures)/, [
      { report: options.report },
    ]);
  }
  if (options.fail !== undefined) {
    connection.fail(/melarc\.(initialize_reference_data|add_reason_fixtures)/, options.fail);
  }
  pool.hand(connection);
  const service = new DatabaseService(
    pool as unknown as Pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    testRuntime(),
  );
  return { service, connection };
}

const LOCKS = [
  bundleLock('5eed0001-0000-4000-8000-000000000001', 'exclusive'),
  fixedLock('VENDOR', 'exclusive'),
];

const PLAN: SeedPlan = {
  locks: LOCKS,
  entryPoint: 'initialize_reference_data',
  payload: {
    hub: [{ id: '5eed0100-0000-4000-8000-000000000001', name: 'Accra' }],
    permission: [
      { key: 'pickup.request.create', domain: 'pickup' },
      { key: 'pickup.request.read', domain: 'pickup' },
    ],
  },
};

const REPORT = { hub: 1, permission: 2 };

/** The statement that calls a seed function, with its parameters. */
function callOf(connection: FakeConnection) {
  const at = connection.statements.findIndex((text) =>
    /melarc\.(initialize_reference_data|add_reason_fixtures)/.test(text),
  );
  return { at, text: connection.statements[at], values: connection.values[at] };
}

describe('runSeed: one transaction, as SYSTEM under the seed capability, applied by a database function (F02; MIGRATION_AND_SEEDING.md section 5.1)', () => {
  // Break caught: a seed that opens another capability, or none, or runs outside a transaction; it is a label, and the provisioning
  // login's EXECUTE on the functions is the barrier.
  it('opens the seed capability over the provisioning login and reports what the function inserted', async () => {
    const { service, connection } = build({ report: REPORT });

    const report = await runSeed(service, PLAN);

    expect(report).toEqual(REPORT);
    const context = connection.statements.find(
      (text) => text.includes('set_config') && !text.startsWith('begin'),
    );
    expect(context).toBeDefined();
    const values = connection.values[connection.statements.indexOf(context ?? '')];
    expect(values).toContain('seed');
    expect(values).toContain(SEED_PRINCIPAL_ID);
    expect(values).toContain('SYSTEM');
    expect(connection.statements.at(-1)).toBe('commit');
  });

  // Break caught: a plan applied by anything but the function it names, or its rows put into the statement text. The statement is
  // fixed, and the rows travel as the one parameter, a JSON document.
  it('calls the function it names with a fixed statement and the rows as one JSON parameter', async () => {
    const { service, connection } = build({ report: REPORT });

    await runSeed(service, PLAN);

    const call = callOf(connection);
    expect(call.text).toMatch(/^select melarc\.initialize_reference_data\(\$1::jsonb\) as report$/);
    expect(call.values).toHaveLength(1);
    expect(JSON.parse(String(call.values?.[0]))).toEqual(PLAN.payload);
    expect(connection.statements.some((text) => text.includes('Accra'))).toBe(false);
  });

  it('calls the fixtures function for a plan that names it, and reports by the label the plan gives', async () => {
    const { service, connection } = build({ report: { reason_code: 2 } });

    const report = await runSeed(service, {
      locks: [],
      entryPoint: 'add_reason_fixtures',
      payload: { reason_code: [{ code: 'FIXTURE_ONE' }, { code: 'FIXTURE_TWO' }] },
      labels: { reason_code: 'reason_code (fixtures)' },
    });

    expect(report).toEqual({ 'reason_code (fixtures)': 2 });
    expect(callOf(connection).text).toMatch(/melarc\.add_reason_fixtures/);
    expect(callOf(connection).text).not.toMatch(/initialize_reference_data/);
  });

  // Break caught: a plan that is data naming a function of its own. Only the two seed functions are ever called.
  it('refuses a plan that names a function it does not know, and calls nothing', async () => {
    const { service, connection } = build({ report: REPORT });

    const failure = await runSeed(service, {
      ...PLAN,
      entryPoint: 'drop_everything' as unknown as SeedPlan['entryPoint'],
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RangeError);
    expect(callOf(connection).at).toBe(-1);
    expect(connection.statements.at(-1)).toBe('rollback');
  });

  // Break caught: the seed's keys taken shared, or after the function has run (SECURITY_DESIGN.md section 13.10a: "the seed that inserts
  // the first bundles ... exclusive on each key it creates; one protocol has no special case").
  it('takes every policy key exclusively, first, before it calls the function', async () => {
    const { service, connection } = build({ report: REPORT });

    await runSeed(service, PLAN);

    const statements = connection.workStatements;
    const firstLock = statements.findIndex((text) => text.includes('pg_advisory_xact_lock'));
    const call = statements.findIndex((text) => text.includes('melarc.initialize_reference_data'));
    expect(firstLock).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(firstLock);
    const locks = statements.filter((text) => text.includes('pg_advisory_xact_lock'));
    expect(locks).toHaveLength(LOCKS.length);
    expect(locks.every((text) => text.startsWith('select pg_advisory_xact_lock('))).toBe(true);
    expect(statements.some((text) => text.includes('_shared'))).toBe(false);
  });

  // Break caught: a plan that names a key shared, which the seed would then hold in the weaker mode beside a sign-in that also
  // holds it shared (SECURITY_DESIGN.md section 13.10a: the seed is exclusive on every key it creates).
  it('takes a key a plan asked for shared exclusively all the same', async () => {
    const { service, connection } = build({ report: REPORT });

    await runSeed(service, {
      ...PLAN,
      locks: [
        bundleLock('5eed0001-0000-4000-8000-000000000001', 'shared'),
        fixedLock('RIDER', 'shared'),
      ],
    });

    const locks = connection.workStatements.filter((text) => text.includes('pg_advisory'));
    expect(locks).toHaveLength(2);
    expect(locks.every((text) => !text.includes('_shared'))).toBe(true);
  });

  // Break caught: a seed that adds to a table that already has rows, or that keeps what it wrote. The database refuses (55000, naming
  // the table and what it holds); the helper makes it a SeedRefusedError and the transaction is rolled back.
  it('makes the database’s refusal of a table that has rows a SeedRefusedError, and rolls back', async () => {
    const refusal = serverError(
      '55000',
      'reference data is already initialized: table permission holds 3 rows',
    );
    refusal.table = 'permission';
    refusal.detail = 'rows=3';
    const { service, connection } = build({ fail: refusal });

    const failure = await runSeed(service, PLAN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeedRefusedError);
    expect((failure as SeedRefusedError).table).toBe('permission');
    expect((failure as SeedRefusedError).rows).toBe(3);
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.statements).not.toContain('commit');
  });

  // Break caught: every failure of the function read as a refusal, so that a constraint or a lock timeout is reported as "not empty".
  it('passes any other failure of the database on unchanged, and rolls back', async () => {
    const other = serverError('23514', 'new row violates check constraint');
    const { service, connection } = build({ fail: other });

    const failure = await runSeed(service, PLAN).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(SeedRefusedError);
    expect(failure).toMatchObject({ cause: other });
    expect(connection.statements.at(-1)).toBe('rollback');
  });

  // Break caught: a function that reports fewer rows than the plan holds (a row dropped), and a seed that commits anyway: a catalogue
  // with a hole in it is worse than none.
  it('rolls back when the function reports fewer rows than the plan holds', async () => {
    const { service, connection } = build({ report: { hub: 1, permission: 1 } });

    const failure = await runSeed(service, PLAN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeedIncompleteError);
    expect(failure).toMatchObject({ table: 'permission', planned: 2, inserted: 1 });
    expect(connection.statements.at(-1)).toBe('rollback');
    expect(connection.statements).not.toContain('commit');
  });

  it('rolls back when the function reports a table the plan has rows for and says nothing of it', async () => {
    const { service } = build({ report: { hub: 1 } });

    const failure = await runSeed(service, PLAN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SeedIncompleteError);
    expect(failure).toMatchObject({ table: 'permission', planned: 2, inserted: 0 });
  });

  // Break caught: the seed run by the API runtime, which would make the label an identity. The service refuses to open the capability
  // over a connection that is not the provisioning login, before anything is locked or called.
  it('is refused over any login but the provisioning one, and calls nothing', async () => {
    const { service, connection } = build({ role: 'melarc_api_runtime', report: REPORT });

    await expect(runSeed(service, PLAN)).rejects.toThrow(/taskCapability/);

    expect(callOf(connection).at).toBe(-1);
    expect(connection.statements.some((text) => text.includes('pg_advisory'))).toBe(false);
  });

  it('refuses a plan with no table: a seed that seeds nothing is a mistake', async () => {
    const { service } = build();
    await expect(
      runSeed(service, { locks: [], entryPoint: 'initialize_reference_data', payload: {} }),
    ).rejects.toThrow(/nothing to seed/);
  });

  // The function refuses an array with no row, so a plan is refused here with a message that names the table.
  it('refuses a plan with a table that has no row', async () => {
    const { service } = build();
    await expect(
      runSeed(service, {
        locks: [],
        entryPoint: 'initialize_reference_data',
        payload: { hub: [] },
      }),
    ).rejects.toThrow(/hub has none/);
  });
});

describe('SeedRefusedError', () => {
  it('says which table was not empty and how many rows it held, and nothing of their content', () => {
    const error = new SeedRefusedError('hub', 2);
    expect(error.message).toMatch(/table hub is not empty \(2 rows\)/);
    expect(error.table).toBe('hub');
  });
});

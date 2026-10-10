import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { CapturedLogs } from '../../test-support/captured-logs.js';
import { ReadinessRegistry } from '../health/readiness.registry.js';
import { ShutdownRegistry } from '../lifecycle/shutdown.registry.js';
import { DatabaseService, type DatabaseTransaction } from './database.service.js';
import { createScopeProbe, existingRecordHub } from './scope-probe.js';
import { runExclusively } from './transaction-gate.js';
import { SecurityContextError, type SecurityContext } from './transaction-context.js';

const RECORD = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1b1';
const HUB = '22222222-2222-4222-8222-222222222222';
const ENTITIES = { hub_record: { schema: 'rls_fixture', table: 'hub_records' } };

const STAFF: SecurityContext = {
  principalType: 'STAFF',
  principalId: 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0',
  surface: 'OPS_PORTAL',
  hubScopeMode: 'SET',
  authorizedHubIds: [],
  correlationId: 'unit-test',
};

interface Sent {
  readonly text: string;
  readonly values: unknown[];
}

/** What the fake connection answers to a statement of the probe: the rows, or an error to fail with. */
type Answer = unknown[] | Error;

/**
 * A real `DatabaseService` over a connection that records the statements it is sent, so that the transaction the probe
 * runs in is the real one, with its real gate. `answer` says what each statement returns; the default answers as a staff
 * context would: the probe id is set, nothing is found, and the setting is cleared.
 */
function harness(answer?: (statement: Sent) => Answer | undefined) {
  const sent: Sent[] = [];
  const client = {
    // The driver adapter sends the configuration and the bound values as two arguments.
    query: vi.fn((query: string | { text: string }, values?: unknown[]) => {
      const statement: Sent = {
        text: typeof query === 'string' ? query : query.text,
        values: values ?? [],
      };
      sent.push(statement);
      let rows: Answer = [];
      if (/^(begin|commit|rollback)$/i.test(statement.text)) rows = [];
      else if (statement.text.includes('current_user')) rows = [{ database_role: 'x' }];
      else if (statement.text.includes("set_config('melarc.scope_probe_id', case"))
        rows = [{ probe: statement.values[0] }];
      else if (statement.text.includes("set_config('melarc.scope_probe_id', ''"))
        rows = [{ probe: '' }];
      const given = answer?.(statement);
      if (given !== undefined) rows = given;
      return rows instanceof Error
        ? Promise.reject(rows)
        : Promise.resolve({ rows, rowCount: rows.length, fields: [] });
    }),
    release: vi.fn(),
  };
  const pool = Object.assign(new EventEmitter(), {
    query: vi.fn(),
    connect: vi.fn(() => Promise.resolve(client)),
    end: vi.fn(() => Promise.resolve()),
  });
  const service = new DatabaseService(
    pool as unknown as Pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
  );
  const run = <T>(work: (tx: DatabaseTransaction) => Promise<T>) =>
    service.transactionWithContext(STAFF, work);
  /** The statements of the probe and anything else that was sent inside the transaction, without its own set-up. */
  const inside = () =>
    sent.filter((statement) => !/^(begin|commit|rollback)$/i.test(statement.text)).slice(1);
  return { run, sent, inside, client };
}

const probe = createScopeProbe(ENTITIES);

describe('createScopeProbe: what is sent for one probe (SECURITY_DESIGN.md §14.4b)', () => {
  // Break caught: the probe reading more than one id and two columns, or loading the row it probes. The statement
  // names one id, selects the id and the hub and nothing else, and its answer is the hub id alone.
  it('sets the probe id, reads one id and two columns, then clears the probe id', async () => {
    const { run, inside } = harness((statement) =>
      statement.text.startsWith('select id, responsible_hub_id')
        ? [{ id: RECORD, responsible_hub_id: HUB }]
        : undefined,
    );

    const hub = await run((tx) => probe(tx, 'hub_record', RECORD));

    expect(hub).toBe(HUB);
    const sent = inside();
    expect(sent).toHaveLength(3);
    expect(sent[0]?.text).toMatch(/set_config\('melarc\.scope_probe_id'.*, true\)/);
    expect(sent[0]?.values).toEqual([RECORD]);
    expect(sent[1]?.text).toBe(
      'select id, responsible_hub_id from "rls_fixture"."hub_records" where id = $1::uuid',
    );
    expect(sent[1]?.values).toEqual([RECORD]);
    expect(sent[2]?.text).toMatch(/set_config\('melarc\.scope_probe_id', '', true\)/);
  });

  // Break caught: the third argument of set_config being false, which would keep the probe id on the connection
  // after the transaction (the leak that §14.1 exists to prevent), for both the set and the clear.
  it('makes both settings transaction-local', async () => {
    const { run, inside } = harness();

    await run((tx) => probe(tx, 'hub_record', RECORD));

    const sent = inside();
    for (const index of [0, 2]) expect(sent[index]?.text).toMatch(/, true\)/);
  });

  // Break caught: a probe that runs for a principal who is not staff. The setting is made only when the context
  // is a STAFF one; otherwise the answer is that nothing was found, and the table is never read.
  it('reads nothing, and answers nothing, when the principal is not staff', async () => {
    const { run, inside } = harness((statement) =>
      statement.text.includes("set_config('melarc.scope_probe_id', case")
        ? [{ probe: '' }]
        : undefined,
    );

    const hub = await run((tx) => probe(tx, 'hub_record', RECORD));

    expect(hub).toBeUndefined();
    expect(inside()).toHaveLength(1);
    expect(inside()[0]?.text).toMatch(/melarc\.principal_type\(\) = 'STAFF'/);
  });

  it('answers nothing for a record that does not exist, and still clears the probe id', async () => {
    const { run, inside } = harness();

    expect(await run((tx) => probe(tx, 'hub_record', RECORD))).toBeUndefined();
    expect(inside()).toHaveLength(3);
  });

  // Break caught: the probe id staying set when the read fails, so that a handler that catches the error and goes on
  // in the same transaction can still see the one record. (An aborted transaction cannot run the clear, and the
  // setting dies with it; the failure that reaches the caller is the read's.)
  it('reports the read failure and not the failure to clear after it', async () => {
    const failure = new Error('read failed');
    const { run, inside } = harness((statement) => {
      if (statement.text.startsWith('select id, responsible_hub_id')) return failure;
      if (statement.text.includes("set_config('melarc.scope_probe_id', ''")) {
        return new Error('current transaction is aborted');
      }
      return undefined;
    });

    await expect(run((tx) => probe(tx, 'hub_record', RECORD))).rejects.toMatchObject({
      cause: failure,
    });
    expect(inside()).toHaveLength(3);
  });

  it('reports a failure to clear the probe id when the read succeeded', async () => {
    const failure = new Error('clear failed');
    const { run } = harness((statement) =>
      statement.text.includes("set_config('melarc.scope_probe_id', ''") ? failure : undefined,
    );

    await expect(run((tx) => probe(tx, 'hub_record', RECORD))).rejects.toMatchObject({
      cause: failure,
    });
  });
});

/**
 * The probe's authority is exclusive within the transaction (review of S0.4 and S0.5). The record is visible only to the
 * probe's own statement, so while the probe id is set no other statement of the transaction may run, and a second probe may
 * not start. A caller that overlaps them (`Promise.all`) is refused loudly, and no statement is sent for what was refused. The
 * tests are deterministic: the probe holds the transaction from the moment it is called, before it awaits anything, so the
 * overlapping statement is always issued while it is held.
 */
describe('the probe holds the transaction while it runs', () => {
  const READ = sql`select body from rls_fixture.hub_records where id = ${RECORD}::uuid`;

  const refusedBy = (pattern: RegExp) => ({
    cause: expect.objectContaining({
      message: expect.stringMatching(pattern) as unknown,
    }) as unknown,
  });

  // Break caught: a normal statement queued between the probe's three, which would read the full record while the probe id
  // is set. It is refused, and what the connection is sent never includes it.
  it('refuses a statement of the transaction issued while the probe runs, and sends nothing for it', async () => {
    const { run, sent } = harness();

    const outcome = await run(async (tx) => {
      const hub = probe(tx, 'hub_record', RECORD);
      const other = tx.execute(READ).then(
        () => 'ran',
        (error: unknown) => error,
      );
      return { hub: await hub, other: await other };
    });

    expect(outcome.hub).toBeUndefined();
    expect(outcome.other).toMatchObject(refusedBy(/scope probe is running/));
    expect(sent.some((statement) => statement.text.includes('select body'))).toBe(false);
  });

  // Break caught: a second probe starting inside the first, whose clear would end the window of the first early, or whose
  // set would replace the first's identifier.
  it('refuses a second probe while one runs, and the first is not disturbed', async () => {
    const { run, inside } = harness((statement) =>
      statement.text.startsWith('select id, responsible_hub_id')
        ? [{ id: RECORD, responsible_hub_id: HUB }]
        : undefined,
    );

    const [first, second] = await run((tx) =>
      Promise.allSettled([
        probe(tx, 'hub_record', RECORD),
        probe(tx, 'hub_record', 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1ff'),
      ]),
    );

    expect(first).toEqual({ status: 'fulfilled', value: HUB });
    expect(second.status).toBe('rejected');
    expect(String((second as PromiseRejectedResult).reason)).toMatch(/already running/);
    expect(inside()).toHaveLength(3);
  });

  // Whichever of the two is issued first, a statement of the transaction is never sent between the probe's set and its
  // clear: it reaches the connection before the set, or it is refused. (The driver adapter sends a statement a few
  // microtasks after `execute` is called, so "issued first" does not decide the order on the connection, and the hold
  // refuses what arrives while it is held.)
  it.each([
    ['the statement first', true],
    ['the probe first', false],
  ])(
    'never sends a statement between the set and the clear of the probe: %s',
    async (_label, statementFirst) => {
      const { run, sent } = harness();

      await run(async (tx) => {
        const read = () =>
          tx.execute(READ).then(
            () => 'ran',
            () => 'refused',
          );
        const settled = statementFirst
          ? [read(), probe(tx, 'hub_record', RECORD)]
          : [probe(tx, 'hub_record', RECORD), read()];
        await Promise.allSettled(settled);
      });

      const at = (needle: string) => sent.findIndex((statement) => statement.text.includes(needle));
      const set = at("set_config('melarc.scope_probe_id', case");
      const clear = at("set_config('melarc.scope_probe_id', ''");
      const read = at('select body');
      expect(set).toBeGreaterThan(-1);
      expect(clear).toBeGreaterThan(set);
      expect(read === -1 || read < set || read > clear).toBe(true);
    },
  );

  // Break caught: the hold outliving the probe, so that the transaction is unusable after a probe, or kept after a failure.
  it('lets the transaction go on, and another probe run, once the probe has ended', async () => {
    const { run } = harness();

    const outcome = await run(async (tx) => {
      await probe(tx, 'hub_record', RECORD);
      const after = await tx.execute(READ);
      const again = await probe(tx, 'hub_record', RECORD);
      return { after: after.rows, again };
    });

    expect(outcome).toEqual({ after: [], again: undefined });
  });

  it('lets the transaction go on after a probe that failed', async () => {
    const { run } = harness((statement) =>
      statement.text.startsWith('select id, responsible_hub_id')
        ? new Error('read failed')
        : undefined,
    );

    const outcome = await run(async (tx) => {
      await probe(tx, 'hub_record', RECORD).catch(() => undefined);
      return (await tx.execute(READ)).rows;
    });

    expect(outcome).toEqual([]);
  });

  // Break caught: the probe's own handle being kept and used later, outside the hold, to read as the probe does.
  it('makes the probe handle useless once the probe has ended', async () => {
    const { run, sent } = harness();

    const outcome = await run(async (tx) => {
      let kept: DatabaseTransaction | undefined;
      await runExclusively(tx, (exclusive) => {
        kept = exclusive;
        return Promise.resolve();
      });
      return kept?.execute(READ).then(
        () => 'ran',
        (error: unknown) => error,
      );
    });

    expect(outcome).toMatchObject(refusedBy(/no longer|has ended|not running/));
    expect(sent.some((statement) => statement.text.includes('select body'))).toBe(false);
  });

  // Break caught: the gate granting its hold to a transaction handle it did not make.
  it('refuses to hold a transaction that is not the database service’s', async () => {
    const foreign = { execute: vi.fn() } as unknown as DatabaseTransaction;

    await expect(runExclusively(foreign, () => Promise.resolve())).rejects.toThrow(
      /not a transaction of the database service/,
    );
  });
});

/** A transaction that records the statements it is sent, for the cases that are refused before any statement. */
function fakeTransaction(answers: readonly { rows: unknown[] }[]) {
  const dialect = new PgDialect();
  const sent: { text: string; params: unknown[] }[] = [];
  let at = 0;
  const execute = vi.fn((statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    sent.push({ text: query.sql, params: query.params });
    const answer = answers[at] ?? { rows: [] };
    at += 1;
    return Promise.resolve(answer);
  });
  return { tx: { execute } as unknown as DatabaseTransaction, sent, execute };
}

describe('createScopeProbe: what it refuses before it sends anything', () => {
  // Break caught: an identifier that is not a well-formed UUID reaching a setting or a statement.
  it.each([['not-a-uuid'], [''], [`${RECORD} `], ["x'; drop table y; --"]])(
    'refuses the record id %j, with no statement sent',
    async (id) => {
      const { tx, execute } = fakeTransaction([]);

      await expect(createScopeProbe(ENTITIES)(tx, 'hub_record', id)).rejects.toBeInstanceOf(
        SecurityContextError,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('lower-cases the record id as every identifier is', async () => {
    const { run, inside } = harness();
    await run((tx) => probe(tx, 'hub_record', RECORD.toUpperCase()));
    expect(inside()[0]?.values).toEqual([RECORD]);
  });

  // Break caught: an entity name that is not in the registry reaching SQL, which would make the table name a value
  // taken from the caller.
  it.each([['order'], ['hub_record; drop table x'], ['__proto__'], ['toString'], ['']])(
    'refuses the entity %j, with no statement sent',
    async (entity) => {
      const { tx, execute } = fakeTransaction([]);

      await expect(createScopeProbe(ENTITIES)(tx, entity, RECORD)).rejects.toThrow(
        /not a hub-scoped entity/,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );

  // Break caught: a registry row whose names would be spliced into SQL as they stand. The names are identifiers of
  // the schema and the table, lower case with digits and underscores, and are quoted when used.
  it.each([
    [{ schema: 'rls_fixture', table: 'hub records' }],
    [{ schema: 'rls_fixture', table: 'hub_records"; drop table x; --' }],
    [{ schema: 'Rls', table: 'hub_records' }],
    [{ schema: '', table: 'hub_records' }],
    [{ schema: 'rls_fixture', table: '' }],
    [{ schema: 'a.b', table: 'c' }],
  ])('refuses to be built from the registry row %j', (entity) => {
    expect(() => createScopeProbe({ hub_record: entity })).toThrow(/identifier/);
  });
});

describe('existingRecordHub, the one the application uses', () => {
  // Break caught: a hub-scoped entity being probed before the slice that owns its table registered it. Every
  // slice that adds a hub-scoped table adds its row to the registry in the same change.
  it('knows no entity until a slice registers one', async () => {
    const { tx, execute } = fakeTransaction([]);

    await expect(existingRecordHub(tx, 'order', RECORD)).rejects.toThrow(/not a hub-scoped entity/);
    expect(execute).not.toHaveBeenCalled();
  });
});

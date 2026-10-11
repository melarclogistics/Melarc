import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { createPool } from '../../src/platform/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../src/platform/database/database.service.js';
import { createScopeProbe } from '../../src/platform/database/scope-probe.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import {
  applyContextFixture,
  applyFixture,
  HUB_A,
  HUB_B,
  HUB_C,
  NO_SUCH_RECORD,
  RECORD_IN_HUB_A,
  RECORD_IN_HUB_B,
  riderContext,
  RIDER_1,
  seedContextRecords,
  seedNotes,
  staffContext,
  systemContext,
  vendorContext,
  VENDOR_1,
} from './support/rls-fixture.js';
import { databaseRuntime } from './support/runtime.js';
import {
  clientFor,
  createTestDatabase,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

let database: TestDatabase;
let pool: pg.Pool;
let service: DatabaseService;

const existingRecordHub = createScopeProbe({
  hub_record: { schema: 'rls_fixture', table: 'hub_records' },
});

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await applyContextFixture(database);
  await seedNotes(database);
  await seedContextRecords(database);
  // One connection and no more: every transaction below is on the same physical connection, so a probe id left set
  // by one would be there for the next.
  pool = createPool({
    url: database.urlFor(API_RUNTIME_ROLE),
    poolMax: 1,
    deadlines: INERT_DEADLINES,
  });
  service = new DatabaseService(
    pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
    databaseRuntime(database.urlFor(API_RUNTIME_ROLE), 1),
  );
});

afterAll(async () => {
  await service.close();
  await database.drop();
});

const probeAs = (context: SecurityContext, entity: string, id: string) =>
  service.transactionWithContext(context, (tx) => existingRecordHub(tx, entity, id));

const visibleBodies = async (tx: DatabaseTransaction) =>
  (await tx.execute(sql`select body from rls_fixture.hub_records order by body`)).rows.map((row) =>
    String(row.body),
  );

describe('the scope probe as staff (SECURITY_DESIGN.md §14.4b)', () => {
  // Control: row-level security does hide the record, so that the probe's answer below is the probe's and not a
  // read that was never hidden.
  it('is needed: a read of a record in another hub finds nothing', async () => {
    const seen = await service.transactionWithContext(staffContext([HUB_A]), visibleBodies);
    expect(seen).toEqual(['record in hub A']);
  });

  it('names the hub of a record that exists outside the hubs the staff holds', async () => {
    expect(await probeAs(staffContext([HUB_A]), 'hub_record', RECORD_IN_HUB_B)).toBe(HUB_B);
  });

  // Break caught: the probe refusing the staff who hold no hub at all, whose answer is the one the refusal exists
  // for ("it exists, and it is not yours").
  it('names it for staff whose hub set is empty', async () => {
    expect(await probeAs(staffContext([]), 'hub_record', RECORD_IN_HUB_A)).toBe(HUB_A);
  });

  it('names the hub of a record the staff can read', async () => {
    expect(await probeAs(staffContext([HUB_A]), 'hub_record', RECORD_IN_HUB_A)).toBe(HUB_A);
  });

  it('answers nothing for an identifier that matches no record', async () => {
    expect(await probeAs(staffContext([HUB_A]), 'hub_record', NO_SUCH_RECORD)).toBeUndefined();
  });

  // Break caught: the probe id staying set, so that the record stays visible to the rest of the transaction. After
  // the probe, the same transaction reads only what its hubs allow, and the setting is empty.
  it('makes the record visible to the probe alone, and to nothing after it', async () => {
    const result = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      const hub = await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B);
      const after = await visibleBodies(tx);
      const setting = (
        await tx.execute(sql`select current_setting('melarc.scope_probe_id', true) as value`)
      ).rows[0]?.value;
      return { hub, after, setting };
    });

    expect(result.hub).toBe(HUB_B);
    expect(result.after).toEqual(['record in hub A']);
    expect([null, '']).toContain(result.setting);
  });

  // Break caught: a probe for one id widening to others. Each probe sees its own record and no more.
  it('sees only the record it was given, probe after probe', async () => {
    const hubs = await service.transactionWithContext(staffContext([HUB_C]), async (tx) => [
      await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_A),
      await existingRecordHub(tx, 'hub_record', NO_SUCH_RECORD),
      await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B),
    ]);
    expect(hubs).toEqual([HUB_A, undefined, HUB_B]);
  });

  // Break caught: the probe returning the row, or more of it. Its answer is a hub identifier and nothing else.
  it('answers with the hub identifier, a string, and not the record', async () => {
    const hub = await probeAs(staffContext([HUB_A]), 'hub_record', RECORD_IN_HUB_B);
    expect(typeof hub).toBe('string');
  });

  // Break caught: the record being readable to a statement that is not the probe's. A caller that overlaps a normal read with
  // the probe (`Promise.all`) must never get the full record: the read is refused while the probe holds the transaction, or
  // it reaches the connection before the probe id is set and finds nothing. Deterministic: the hold is taken before the probe
  // awaits anything, whichever of the two is called first.
  it.each([
    ['the probe first', true],
    ['the read first', false],
  ])('never lets an overlapping read see the probed record: %s', async (_label, probeFirst) => {
    const read = (tx: DatabaseTransaction) =>
      tx
        .execute(sql`select body from rls_fixture.hub_records where id = ${RECORD_IN_HUB_B}::uuid`)
        .then(
          (result) => ({ rows: result.rows }),
          (error: unknown) => ({ refused: String((error as { cause?: Error }).cause?.message) }),
        );

    const outcome = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      // Both are called before either is awaited. Which of them reaches the connection first is not decided by the order
      // of the calls, and the result must not depend on it.
      const [hub, overlapping] = probeFirst
        ? [existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B), read(tx)]
        : (() => {
            const early = read(tx);
            return [existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B), early] as const;
          })();
      return { hub: await hub, overlapping: await overlapping };
    });

    expect(outcome.hub).toBe(HUB_B);
    // Never the record: the read is refused while the probe holds the transaction, or it finds nothing.
    expect('rows' in outcome.overlapping ? outcome.overlapping.rows : []).toEqual([]);
    if ('refused' in outcome.overlapping) {
      expect(outcome.overlapping.refused).toMatch(/scope probe is running/);
    }
  });

  // Break caught: the hold being absent, which the tests above cannot see because the driver adapter sends a statement a few
  // microtasks after it is called, and which of two statements called together reaches the connection first is not theirs to
  // decide. Here the interleaving is deliberate and deterministic: a normal read is issued while the probe id is known to be
  // set (the probe's own statement has completed, and its read is waiting on a table lock held by another connection).
  it('refuses a normal read and another probe issued while the probe id is set and the probe is waiting', async () => {
    const admin = clientFor(database.urlFor('postgres'));
    await admin.connect();
    try {
      await admin.query('begin');
      await admin.query('lock table rls_fixture.hub_records in access exclusive mode');

      const waitUntilBlocked = async () => {
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const { rows } = await admin.query(
            `select 1 from pg_stat_activity
              where datname = $1 and usename = $2 and wait_event_type = 'Lock'
                and query like 'select id, responsible_hub_id%'`,
            [database.name, API_RUNTIME_ROLE],
          );
          if (rows.length > 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('the probe never reached the lock it was to wait on');
      };

      const outcome = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
        const hub = existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B);
        await waitUntilBlocked();
        // Issued while the probe id is set. Neither is awaited before the lock is released: a statement the hold did not
        // refuse would queue behind the probe's read on the connection, and would deadlock the test instead of failing it.
        const normal = tx
          .execute(
            sql`select body from rls_fixture.hub_records where id = ${RECORD_IN_HUB_B}::uuid`,
          )
          .then(
            (result) => ({ rows: result.rows }),
            (error: unknown) => ({ refused: String((error as { cause?: Error }).cause?.message) }),
          );
        const another = existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_A).then(
          (value) => ({ value }),
          (error: unknown) => ({ refused: (error as Error).message }),
        );
        await admin.query('commit');
        return { hub: await hub, normal: await normal, another: await another };
      });

      expect(outcome.hub).toBe(HUB_B);
      expect(outcome.normal).toEqual({
        refused: expect.stringMatching(/scope probe is running/) as unknown,
      });
      expect(outcome.another).toEqual({
        refused: expect.stringMatching(/already running/) as unknown,
      });
    } finally {
      await admin.query('rollback').catch(() => undefined);
      await admin.end();
    }
  });

  it('refuses a second probe that overlaps the first, and leaves the first its answer', async () => {
    const [first, second] = await service.transactionWithContext(staffContext([HUB_A]), (tx) =>
      Promise.allSettled([
        existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B),
        existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_A),
      ]),
    );

    expect(first).toEqual({ status: 'fulfilled', value: HUB_B });
    expect(second.status).toBe('rejected');
    expect(String((second as PromiseRejectedResult).reason)).toMatch(/already running/);
  });

  // Break caught: the hold not being released after a probe, so the transaction is unusable or the next probe refused.
  it('lets the transaction read and probe again once a probe has ended', async () => {
    const outcome = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      const first = await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B);
      const bodies = await visibleBodies(tx);
      const second = await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_A);
      return { first, bodies, second };
    });

    expect(outcome).toEqual({ first: HUB_B, bodies: ['record in hub A'], second: HUB_A });
  });

  // Break caught: a probe id that outlives its transaction on the pooled connection. The next transaction, with a
  // staff context of another hub and no probe of its own, sees only its own hub.
  it('leaves nothing on the connection for the next transaction', async () => {
    await probeAs(staffContext([HUB_A]), 'hub_record', RECORD_IN_HUB_B);

    const next = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => ({
      bodies: await visibleBodies(tx),
      setting: (
        await tx.execute(sql`select current_setting('melarc.scope_probe_id', true) as value`)
      ).rows[0]?.value,
    }));

    expect(next.bodies).toEqual(['record in hub A']);
    expect([null, '']).toContain(next.setting);
    expect(pool.totalCount).toBe(1);
  });
});

describe('the scope probe for everyone else', () => {
  // Break caught: a vendor, a rider or a SYSTEM context taking the probe. Each is answered "nothing found", which is
  // exactly what a record that does not exist gets, whether or not the record exists and whether or not it is theirs.
  it.each([
    ['a vendor', vendorContext(VENDOR_1)],
    ['a rider', riderContext(RIDER_1)],
    ['a SYSTEM context', systemContext('authentication')],
  ])(
    'answers %s nothing, for a record that exists and for one that does not',
    async (_label, context) => {
      const existing = await probeAs(context, 'hub_record', RECORD_IN_HUB_B);
      const own = await probeAs(context, 'hub_record', RECORD_IN_HUB_A);
      const missing = await probeAs(context, 'hub_record', NO_SUCH_RECORD);

      expect(existing).toBeUndefined();
      expect(own).toBeUndefined();
      expect(missing).toBeUndefined();
      expect(existing).toStrictEqual(missing);
    },
  );

  // Break caught: the setting being made for a non-staff context and left for a later statement of the transaction.
  it('sets no probe id for a vendor', async () => {
    const setting = await service.transactionWithContext(vendorContext(VENDOR_1), async (tx) => {
      await existingRecordHub(tx, 'hub_record', RECORD_IN_HUB_B);
      return (await tx.execute(sql`select current_setting('melarc.scope_probe_id', true) as value`))
        .rows[0]?.value;
    });
    expect([null, '']).toContain(setting);
  });
});

/**
 * The probe makes one record readable, and nothing else about it changes (SECURITY_DESIGN.md §14.4b). The window is opened
 * here by hand with `set_config`, as code that already runs as the API could open it, so that these tests do not depend on
 * `existingRecordHub` being the only writer: row-level security itself must refuse every other command. A command other than
 * SELECT is judged by the ordinary predicates alone, of the old row (USING) and of the new row (WITH CHECK).
 */
describe('while the probe id is set, only SELECT sees the probed record (review of S0.4 and S0.5)', () => {
  const asAdmin = <T>(work: (client: pg.Client) => Promise<T>) =>
    withClient(database.urlFor('postgres'), work);

  /** A record in `hub`, made by the administrator, with a fresh id. */
  async function recordIn(hub: string, body: string): Promise<string> {
    const id = randomUUID();
    await asAdmin((client) =>
      client.query(
        'insert into rls_fixture.hub_records (id, responsible_hub_id, body) values ($1, $2, $3)',
        [id, hub, body],
      ),
    );
    return id;
  }

  const stored = (id: string) =>
    asAdmin(async (client) => {
      const { rows } = await client.query<{ responsible_hub_id: string; body: string }>(
        'select responsible_hub_id, body from rls_fixture.hub_records where id = $1',
        [id],
      );
      return rows[0];
    });

  /** Runs `statement` as staff of Hub A in a transaction in which the probe id of `id` is set by hand. */
  const underProbe = <T>(id: string, statement: (tx: DatabaseTransaction) => Promise<T>) =>
    service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      await tx.execute(sql`select set_config('melarc.scope_probe_id', ${id}, true)`);
      return statement(tx);
    });

  // Control: the window really does open the record to a read, so that the refusals below are not a record that nothing
  // can see. This is the one thing the probe is for.
  it('lets a read see the probed record, and only that one', async () => {
    const probed = await recordIn(HUB_B, 'probed');
    const other = await recordIn(HUB_B, 'other');

    const seen = await underProbe(probed, async (tx) =>
      (
        await tx.execute(
          sql`select id from rls_fixture.hub_records where responsible_hub_id = ${HUB_B}`,
        )
      ).rows.map((row) => String(row.id)),
    );

    expect(seen).toContain(probed);
    expect(seen).not.toContain(other);
  });

  // Break caught: the probe exception being in a policy that also governs UPDATE. The old row would pass USING through the
  // probe and the new row would pass WITH CHECK through Hub A, so a record of another hub could be moved into one's own.
  it('does not let an UPDATE move the probed record into an authorized hub', async () => {
    const id = await recordIn(HUB_B, 'to be moved');

    const result = await underProbe(id, (tx) =>
      tx.execute(
        sql`update rls_fixture.hub_records set responsible_hub_id = ${HUB_A}::uuid where id = ${id}::uuid`,
      ),
    );

    expect(result.rowCount).toBe(0);
    expect(await stored(id)).toMatchObject({ responsible_hub_id: HUB_B, body: 'to be moved' });
  });

  it('does not let an UPDATE change the probed record, with or without a RETURNING', async () => {
    const id = await recordIn(HUB_B, 'untouched');

    const result = await underProbe(id, async (tx) => ({
      plain: await tx.execute(
        sql`update rls_fixture.hub_records set body = 'tampered' where id = ${id}::uuid`,
      ),
      returning: await tx.execute(
        sql`update rls_fixture.hub_records set body = 'tampered' where id = ${id}::uuid returning body`,
      ),
    }));

    expect(result.plain.rowCount).toBe(0);
    expect(result.returning.rows).toEqual([]);
    expect(await stored(id)).toMatchObject({ body: 'untouched' });
  });

  // Break caught: DELETE judged by the probe. The runtime login holds DELETE on this fixture, so the row-level policy is
  // the only thing between the statement and the row: without the grant the test would pass for the wrong reason.
  it('does not let a DELETE remove the probed record, though the login holds DELETE', async () => {
    const id = await recordIn(HUB_B, 'to keep');
    const grants = await asAdmin(
      async (client) =>
        (
          await client.query<{ can: boolean }>(
            `select has_table_privilege($1, 'rls_fixture.hub_records', 'DELETE') as can`,
            [API_RUNTIME_ROLE],
          )
        ).rows[0]?.can,
    );
    expect(grants).toBe(true);

    const result = await underProbe(id, (tx) =>
      tx.execute(sql`delete from rls_fixture.hub_records where id = ${id}::uuid`),
    );

    expect(result.rowCount).toBe(0);
    expect(await stored(id)).toMatchObject({ body: 'to keep' });
  });

  // Break caught: the row lock. SELECT ... FOR UPDATE needs the UPDATE policy as well as the SELECT policy.
  it('does not let a locking read take the probed record', async () => {
    const id = await recordIn(HUB_B, 'to lock');

    const result = await underProbe(id, (tx) =>
      tx.execute(sql`select id from rls_fixture.hub_records where id = ${id}::uuid for update`),
    );

    expect(result.rows).toEqual([]);
  });

  // Break caught: ON CONFLICT DO UPDATE, the third way to change an existing row, reaching the probed one.
  it('does not let an upsert update the probed record', async () => {
    const id = await recordIn(HUB_B, 'to upsert');

    const failure = await underProbe(id, (tx) =>
      tx.execute(
        sql`insert into rls_fixture.hub_records (id, responsible_hub_id, body)
            values (${id}::uuid, ${HUB_A}::uuid, 'upserted')
            on conflict (id) do update set body = excluded.body, responsible_hub_id = excluded.responsible_hub_id`,
      ),
    ).catch((error: unknown) => error as { cause?: { code?: string } });

    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('42501');
    expect(await stored(id)).toMatchObject({ responsible_hub_id: HUB_B, body: 'to upsert' });
  });

  // Break caught: a write checked against the probe. A row with the probed id, in a hub the staff does not hold, is refused.
  it('does not let an INSERT write the probed identifier into another hub', async () => {
    const id = randomUUID();

    const failure = await underProbe(id, (tx) =>
      tx.execute(
        sql`insert into rls_fixture.hub_records (id, responsible_hub_id, body)
            values (${id}::uuid, ${HUB_B}::uuid, 'written during a probe')`,
      ),
    ).catch((error: unknown) => error as { cause?: { code?: string } });

    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('42501');
    expect(await stored(id)).toBeUndefined();
  });

  // Control: the ordinary authorization is unchanged, with the probe id set for another record and without any.
  it.each([
    ['with no probe id', undefined],
    ['with the probe id of a record of another hub', 'other-hub'],
  ])('still lets staff insert, update and delete in their own hub %s', async (_label, probe) => {
    const elsewhere = probe === undefined ? undefined : await recordIn(HUB_B, 'elsewhere');

    const outcome = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      if (elsewhere !== undefined) {
        await tx.execute(sql`select set_config('melarc.scope_probe_id', ${elsewhere}, true)`);
      }
      const id = randomUUID();
      const inserted = await tx.execute(
        sql`insert into rls_fixture.hub_records (id, responsible_hub_id, body)
            values (${id}::uuid, ${HUB_A}::uuid, 'mine')`,
      );
      const updated = await tx.execute(
        sql`update rls_fixture.hub_records set body = 'mine, changed' where id = ${id}::uuid returning body`,
      );
      const deleted = await tx.execute(
        sql`delete from rls_fixture.hub_records where id = ${id}::uuid`,
      );
      return { inserted: inserted.rowCount, updated: updated.rows, deleted: deleted.rowCount };
    });

    expect(outcome).toEqual({ inserted: 1, updated: [{ body: 'mine, changed' }], deleted: 1 });
  });

  it('still lets staff move a record of their own hub within the hubs they hold', async () => {
    const id = await recordIn(HUB_A, 'mine');

    const result = await service.transactionWithContext(staffContext([HUB_A, HUB_B]), (tx) =>
      tx.execute(
        sql`update rls_fixture.hub_records set responsible_hub_id = ${HUB_B}::uuid where id = ${id}::uuid`,
      ),
    );

    expect(result.rowCount).toBe(1);
    expect(await stored(id)).toMatchObject({ responsible_hub_id: HUB_B });
  });
});

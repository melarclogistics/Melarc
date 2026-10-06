import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import { ReadinessRegistry } from '../../src/platform/health/readiness.registry.js';
import { ShutdownRegistry } from '../../src/platform/lifecycle/shutdown.registry.js';
import { createPool } from '../../src/platform/database/database.module.js';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../src/platform/database/database.service.js';
import {
  SecurityContextError,
  type SecurityContext,
} from '../../src/platform/database/transaction-context.js';
import { CapturedLogs } from '../../src/test-support/captured-logs.js';
import {
  applyFixture,
  HUB_A,
  HUB_B,
  HUB_C,
  RIDER_1,
  riderContext,
  seedNotes,
  SEEDED_NOTES,
  staffContext,
  VENDOR_1,
  vendorContext,
} from './support/rls-fixture.js';
import {
  createTestDatabase,
  scalar,
  withClient,
  type TestDatabase,
} from './support/test-database.js';

let database: TestDatabase;
let pool: pg.Pool;
let service: DatabaseService;

beforeAll(async () => {
  database = await createTestDatabase();
  await applyFixture(database);
  await seedNotes(database);
  // One connection and no more, so that every transaction below is on the same physical connection. A test
  // that gets a fresh connection each time proves nothing, and would pass against a session-wide setting.
  pool = createPool({ url: database.urlFor(API_RUNTIME_ROLE), poolMax: 1 });
  service = new DatabaseService(
    pool,
    new CapturedLogs().logger,
    new ShutdownRegistry(),
    new ReadinessRegistry(),
  );
});

afterAll(async () => {
  await service.close();
  await database.drop();
});

interface Observation {
  /** The server process that ran the transaction. Equal pids are the proof of a reused connection. */
  readonly backend: number;
  readonly bodies: string[];
  readonly settings: Record<string, string | null>;
}

const GUCS = [
  'principal_type',
  'hub_scope_mode',
  'authorized_hub_ids',
  'vendor_organization_id',
  'rider_id',
] as const;

/** What a transaction sees: which connection it ran on, which rows it can read, what context it holds. */
async function observe(tx: DatabaseTransaction): Promise<Observation> {
  const backend = (await tx.execute(sql`select pg_backend_pid() as pid`)).rows;
  const notes = (await tx.execute(sql`select body from rls_fixture.notes order by body`)).rows;
  const settings: Observation['settings'] = {};
  for (const name of GUCS) {
    const row = (await tx.execute(sql`select current_setting(${`melarc.${name}`}, true) as value`))
      .rows;
    settings[name] = (row[0]?.value as string | null | undefined) ?? null;
  }
  return {
    backend: Number(backend[0]?.pid),
    bodies: notes.map((row) => String(row.body)),
    settings,
  };
}

const withContext = (context: SecurityContext) => service.transactionWithContext(context, observe);
const withoutContext = () => service.transaction(observe);

const bodiesOf = (hub: string, vendors: readonly string[] = []) =>
  SEEDED_NOTES.filter((n) => n.hub === hub && (vendors.length === 0 || vendors.includes(n.vendor)))
    .map((n) => n.body)
    .sort();

/** No context survives when the setting is absent or empty: PostgreSQL reports either, after a reverted one. */
const isUnset = (value: string | null | undefined) =>
  value === null || value === undefined || value === '';

function codeOf(error: unknown): string | undefined {
  const failure = error as { code?: string; cause?: { code?: string } };
  return failure.cause?.code ?? failure.code;
}

describe('the test technique itself', () => {
  // Control: a setting made for the whole session does survive on a reused connection, and this suite sees
  // it. If this did not hold, the leak tests below could not fail, whatever the service did.
  it('detects a session-wide setting surviving on the same connection', async () => {
    const client = await pool.connect();
    try {
      await client.query("select set_config('melarc.principal_type', 'STAFF', false)");
    } finally {
      client.release();
    }

    try {
      const leaked = await withoutContext();
      expect(leaked.settings.principal_type).toBe('STAFF');
    } finally {
      // Whatever the assertion said, the connection is cleaned: the tests that follow rely on it.
      const cleaner = await pool.connect();
      try {
        await cleaner.query('reset melarc.principal_type');
      } finally {
        cleaner.release();
      }
    }
    expect(isUnset((await withoutContext()).settings.principal_type)).toBe(true);
    expect(pool.totalCount).toBe(1);
  });
});

describe('a pooled connection reused across requests', () => {
  // GBT-A1. Break caught: the hub a request was scoped to still applying to the next request on the same
  // connection, which is a session-wide SET in place of a transaction-local one.
  it('shows Hub B staff no Hub A row after a Hub A transaction commits (GBT-A1)', async () => {
    const hubA = await withContext(staffContext([HUB_A]));
    const hubB = await withContext(staffContext([HUB_B]));

    expect(hubA.bodies).toEqual(bodiesOf(HUB_A));
    expect(hubB.bodies).toEqual(bodiesOf(HUB_B));
    expect(hubB.backend).toBe(hubA.backend);
  });

  // GBT-A2. Break caught: a rolled-back transaction leaving its context behind, so the next caller, with
  // no principal at all, reads the previous one's rows.
  it('shows no row to a request without context after a Hub A transaction rolls back (GBT-A2)', async () => {
    let inside: Observation | undefined;
    const failed = await service
      .transactionWithContext(staffContext([HUB_A]), async (tx) => {
        inside = await observe(tx);
        throw new Error('roll back');
      })
      .catch((error: unknown) => error as Error);

    const after = await withoutContext();

    expect(failed.message).toBe('roll back');
    expect(inside?.bodies).toEqual(bodiesOf(HUB_A));
    expect(after.bodies).toEqual([]);
    expect(Object.values(after.settings).every(isUnset)).toBe(true);
    expect(after.backend).toBe(inside?.backend);
  });

  // GBT-A3. Break caught: all-hub authority outliving the transaction that was granted it.
  it('gives no all-hub authority to a one-hub request that follows an all-hub one (GBT-A3)', async () => {
    const all = await withContext(staffContext([], 'ALL'));
    const one = await withContext(staffContext([HUB_A]));

    expect(all.bodies).toEqual([...SEEDED_NOTES.map((n) => n.body)].sort());
    expect(one.bodies).toEqual(bodiesOf(HUB_A));
    expect(one.settings.hub_scope_mode).toBe('SET');
    expect(one.backend).toBe(all.backend);
  });

  // An empty hub set means no hub-scoped rows, never all of them (SECURITY_DESIGN.md section 14.1).
  // Break caught: an empty list being read as "no restriction".
  it('treats a staff context with no hubs as seeing nothing, and an unlisted hub as invisible', async () => {
    expect((await withContext(staffContext([]))).bodies).toEqual([]);
    expect((await withContext(staffContext([HUB_C]))).bodies).toEqual([]);
  });

  // GBT-A4. Break caught: a vendor's context, or any part of it, surviving into a staff request.
  it('leaves no vendor context for the staff request that follows a vendor one (GBT-A4)', async () => {
    const vendor = await withContext(vendorContext(VENDOR_1));
    const staff = await withContext(staffContext([HUB_A]));
    const nobody = await withoutContext();

    expect(vendor.bodies).toEqual(
      SEEDED_NOTES.filter((n) => n.vendor === VENDOR_1)
        .map((n) => n.body)
        .sort(),
    );
    expect(staff.bodies).toEqual(bodiesOf(HUB_A));
    expect(isUnset(staff.settings.vendor_organization_id)).toBe(true);
    expect(nobody.bodies).toEqual([]);
    expect(Object.values(nobody.settings).every(isUnset)).toBe(true);
    expect(nobody.backend).toBe(vendor.backend);
  });

  // GBT-A5. Break caught: a rider's assignment surviving into a vendor request.
  it('leaves no rider assignment for the vendor request that follows a rider one (GBT-A5)', async () => {
    const rider = await withContext(riderContext(RIDER_1));
    const vendor = await withContext(vendorContext(VENDOR_1));

    expect(rider.bodies).toEqual(
      SEEDED_NOTES.filter((n) => n.rider === RIDER_1)
        .map((n) => n.body)
        .sort(),
    );
    expect(vendor.bodies).toEqual(
      SEEDED_NOTES.filter((n) => n.vendor === VENDOR_1)
        .map((n) => n.body)
        .sort(),
    );
    expect(isUnset(vendor.settings.rider_id)).toBe(true);
    expect(vendor.backend).toBe(rider.backend);
  });

  // Break caught: a context made current for the connection when the transaction work is a statement that
  // is not part of it, such as a query run on the pool directly between two requests.
  it('holds no context between transactions, for a query that is not in one', async () => {
    await withContext(staffContext([], 'ALL'));

    const { rows } = await pool.query(
      "select current_setting('melarc.principal_type', true) as value",
    );

    expect(isUnset((rows[0] as { value: string | null }).value)).toBe(true);
  });

  it('has used one physical connection for everything above', () => {
    expect(pool.totalCount).toBe(1);
  });
});

describe('two requests at the same time', () => {
  // Break caught: contexts shared between concurrent requests, so one reads with the other's authority.
  // Each sets its context, and neither reads until both have set theirs.
  it('each see their own rows, on different connections', async () => {
    const wide = createPool({ url: database.urlFor(API_RUNTIME_ROLE), poolMax: 2 });
    const concurrent = new DatabaseService(
      wide,
      new CapturedLogs().logger,
      new ShutdownRegistry(),
      new ReadinessRegistry(),
    );
    try {
      let arrived = 0;
      let release!: () => void;
      const bothSet = new Promise<void>((resolve) => {
        release = resolve;
      });
      const request = (context: SecurityContext) =>
        concurrent.transactionWithContext(context, async (tx) => {
          arrived += 1;
          if (arrived === 2) release();
          await bothSet;
          return observe(tx);
        });

      const [a, b] = await Promise.all([
        request(staffContext([HUB_A])),
        request(vendorContext(VENDOR_1)),
      ]);

      expect(a.bodies).toEqual(bodiesOf(HUB_A));
      expect(b.bodies).toEqual(
        SEEDED_NOTES.filter((n) => n.vendor === VENDOR_1)
          .map((n) => n.body)
          .sort(),
      );
      expect(a.backend).not.toBe(b.backend);
    } finally {
      await concurrent.close();
    }
  });
});

describe('writing under a context', () => {
  // No RETURNING, on purpose: returning the new row also checks it against the policy that governs reads,
  // so a write that WITH CHECK should have refused would be refused for that other reason, and a
  // missing or weakened WITH CHECK would go unnoticed.
  const note = (hub: string, body: string) =>
    sql`insert into rls_fixture.notes (hub_id, vendor_organization_id, body)
        values (${hub}, ${VENDOR_1}, ${body})`;

  const countAsAdmin = (body: string) =>
    withClient(database.urlFor('postgres'), async (client) =>
      Number(
        await scalar<string>(client, 'select count(*) from rls_fixture.notes where body = $1', [
          body,
        ]),
      ),
    );

  // GBT-A (write side). Break caught: a policy that filters reads and not writes. The row's hub is outside
  // the context's hubs, so the write is refused with the row-level-security error, and nothing is stored.
  it('refuses a row outside the context, with the row-level-security error, and stores nothing', async () => {
    const failure = await service
      .transactionWithContext(staffContext([HUB_A]), (tx) => tx.execute(note(HUB_B, 'outside')))
      .catch((error: unknown) => error);

    expect(codeOf(failure)).toBe('42501');
    expect(await countAsAdmin('outside')).toBe(0);
  });

  // Break caught: a no-context write succeeding, which would let a request that failed to establish its
  // principal write anywhere.
  it('refuses any write without a context', async () => {
    const failure = await service
      .transaction((tx) => tx.execute(note(HUB_A, 'no-context')))
      .catch((error: unknown) => error);

    expect(codeOf(failure)).toBe('42501');
    expect(await countAsAdmin('no-context')).toBe(0);
  });

  // Break caught: a transaction that does not roll back, or one that does not commit. The same insert is
  // thrown away when the work fails and kept when it succeeds.
  it('rolls back what a failed transaction wrote, and keeps what a successful one wrote', async () => {
    await service
      .transactionWithContext(staffContext([HUB_A]), async (tx) => {
        await tx.execute(note(HUB_A, 'rolled-back'));
        throw new Error('fail after writing');
      })
      .catch(() => undefined);
    expect(await countAsAdmin('rolled-back')).toBe(0);

    await service.transactionWithContext(staffContext([HUB_A]), (tx) =>
      tx.execute(note(HUB_A, 'committed')),
    );
    expect(await countAsAdmin('committed')).toBe(1);

    const visibleToA = await withContext(staffContext([HUB_A]));
    const visibleToB = await withContext(staffContext([HUB_B]));
    expect(visibleToA.bodies).toContain('committed');
    expect(visibleToB.bodies).not.toContain('committed');

    await withClient(database.urlFor('postgres'), (client) =>
      client.query("delete from rls_fixture.notes where body = 'committed'"),
    );
  });

  // Break caught: a row the context may see being moved, by an update, into a hub it may not write to. The
  // old row passes the read check, so only WITH CHECK on the new row can refuse this.
  it('refuses an update that moves a visible row into a hub outside the context', async () => {
    await withClient(database.urlFor('postgres'), (client) =>
      client.query(
        'insert into rls_fixture.notes (hub_id, vendor_organization_id, body) values ($1, $2, $3)',
        [HUB_A, VENDOR_1, 'movable'],
      ),
    );
    try {
      const failure = await service
        .transactionWithContext(staffContext([HUB_A]), (tx) =>
          tx.execute(sql`update rls_fixture.notes set hub_id = ${HUB_B} where body = 'movable'`),
        )
        .catch((error: unknown) => error);

      expect(codeOf(failure)).toBe('42501');
      const hub = await withClient(database.urlFor('postgres'), (client) =>
        scalar<string>(client, "select hub_id from rls_fixture.notes where body = 'movable'"),
      );
      expect(hub).toBe(HUB_A);
    } finally {
      await withClient(database.urlFor('postgres'), (client) =>
        client.query("delete from rls_fixture.notes where body = 'movable'"),
      );
    }
  });

  // Break caught: an update or delete reaching a row the context cannot see. Row-level security makes the
  // row invisible to the statement, so it affects nothing and says so.
  it('changes nothing in a hub outside the context when updating or deleting', async () => {
    const result = await service.transactionWithContext(staffContext([HUB_A]), async (tx) => {
      const updated = await tx.execute(
        sql`update rls_fixture.notes set body = 'tampered' where hub_id = ${HUB_B}`,
      );
      const deleted = await tx.execute(sql`delete from rls_fixture.notes where hub_id = ${HUB_B}`);
      return { updated: updated.rowCount, deleted: deleted.rowCount };
    });

    expect(result).toEqual({ updated: 0, deleted: 0 });
    expect(await countAsAdmin('tampered')).toBe(0);
    expect((await withContext(staffContext([HUB_B]))).bodies).toEqual(bodiesOf(HUB_B));
  });
});

describe('an invalid context', () => {
  // Break caught: a context that fails validation still taking a connection and opening a transaction, or
  // reaching the database at all.
  it.each([
    ['an unknown principal type', { ...staffContext([HUB_A]), principalType: 'ADMIN' }],
    ['a malformed principal id', { ...staffContext([HUB_A]), principalId: 'x' }],
    [
      'a hub id that is not a UUID',
      { ...staffContext([HUB_A]), authorizedHubIds: ["a'); drop table x; --"] },
    ],
    [
      'a vendor with no organization',
      { ...vendorContext(VENDOR_1), vendorOrganizationId: undefined },
    ],
    ['an empty context', {}],
  ])('is refused before any connection is taken: %s', async (_label, context) => {
    const connect = vi.spyOn(pool, 'connect');
    const query = vi.spyOn(pool, 'query');
    try {
      await expect(
        service.transactionWithContext(context as unknown as SecurityContext, observe),
      ).rejects.toBeInstanceOf(SecurityContextError);
      expect(connect).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
      query.mockRestore();
    }
  });

  it('does not repeat a rejected value in its message', async () => {
    const failure = await service
      .transactionWithContext(
        { ...staffContext([HUB_A]), principalId: 'SECRET-LOOKING-VALUE' },
        observe,
      )
      .catch((error: unknown) => error as Error);

    expect(failure).toBeInstanceOf(SecurityContextError);
    expect((failure as Error).message).not.toContain('SECRET-LOOKING-VALUE');
  });
});

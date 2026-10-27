import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHubSetProbe } from '../../src/platform/database/scope-probe.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { insertSessionRow, sessionRow, type SessionRow } from './support/identities.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * F06 of the audit of 23 October 2026 (migration 0031): the hub-set probe, which tells a session the caller's scope hides from one that does
 * not exist. A session carries several hubs, which the one-hub probe cannot compare; the hub-set probe holds the transaction, names the one id
 * in `melarc.scope_probe_id`, reads the id and the array of hubs under a `SELECT`-only policy and clears the setting. It runs for a staff
 * context alone. What it returns is what the guard of `revokeSession` decides on (`record-scope.ts`); the response never carries a hub.
 * Everything here runs as the real runtime login through `DatabaseService`.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const HUB_C = 'c0c0c0c0-0000-4000-8000-00000000000c';

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;

const probe = createHubSetProbe({
  session: { schema: 'public', table: 'session', hubsColumn: 'authorized_hub_ids' },
});

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const staffContext = (): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'hub-set-probe-test',
  hubScopeMode: 'SET',
  authorizedHubIds: [HUB_A],
});
const systemContext = (): SecurityContext => ({
  principalType: 'SYSTEM',
  principalId: randomUUID(),
  surface: 'SYSTEM',
  correlationId: 'hub-set-probe-test',
  taskCapability: 'authentication',
});
const vendorContext = (): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: randomUUID(),
  surface: 'VENDOR_PWA',
  correlationId: 'hub-set-probe-test',
  vendorOrganizationId: randomUUID(),
});
const riderContext = (): SecurityContext => {
  const principalId = randomUUID();
  return {
    principalType: 'RIDER',
    principalId,
    surface: 'RIDER_ANDROID',
    correlationId: 'hub-set-probe-test',
    riderId: principalId,
  };
};

type Tx = Parameters<Parameters<BuiltService['service']['transactionWithContext']>[1]>[0];
const run = <T>(context: SecurityContext, work: (tx: Tx) => Promise<T>): Promise<T> =>
  built.service.transactionWithContext(context, work);

const session = (hubs: readonly string[]): Promise<SessionRow> =>
  insertSessionRow(admin, sessionRow({ authorizedHubIds: hubs }));

describe('the hub-set probe', () => {
  // Break caught: a probe that returns one hub, or only the caller's, or that sorts its answer into something the guard cannot compare.
  it('returns every hub of a session, including those the caller’s scope does not reach, and an empty list for a session with none', async () => {
    const several = await session([HUB_A, HUB_B]);
    const elsewhere = await session([HUB_B, HUB_C]);
    const none = await session([]);

    expect(
      (await run(staffContext(), (tx) => probe(tx, 'session', several.id)))?.toSorted(),
    ).toEqual([HUB_A, HUB_B].toSorted());
    expect(
      (await run(staffContext(), (tx) => probe(tx, 'session', elsewhere.id)))?.toSorted(),
    ).toEqual([HUB_B, HUB_C].toSorted());
    expect(await run(staffContext(), (tx) => probe(tx, 'session', none.id))).toEqual([]);
  });

  // Break caught: an id that names nothing answered as a session, which would tell a caller which ids exist by what the guard says.
  it('returns nothing for an id that names no session', async () => {
    expect(await run(staffContext(), (tx) => probe(tx, 'session', randomUUID()))).toBeUndefined();
  });

  // Break caught: the gate on the principal type dropped, so that any context could learn the hubs of any session by id.
  it.each([
    ['a vendor', vendorContext],
    ['a rider', riderContext],
    ['the authentication capability', systemContext],
  ])('is not admitted for %s: an existing session reads as no session', async (_label, context) => {
    const existing = await session([HUB_A]);

    expect(await run(context(), (tx) => probe(tx, 'session', existing.id))).toBeUndefined();
  });

  // Break caught: the setting left in place after the probe, so that a later statement of the same transaction reads the row without a key.
  it('releases the hold: the same transaction reads no session by that id once the probe has answered', async () => {
    const existing = await session([HUB_A]);

    const afterwards = await run(staffContext(), async (tx) => {
      const hubs = await probe(tx, 'session', existing.id);
      const rows = (await tx.execute(sql`select id from session where id = ${existing.id}::uuid`))
        .rows;
      const setting = (
        await tx.execute(sql`select current_setting('melarc.scope_probe_id', true) as held`)
      ).rows[0] as { held: string | null };
      return { hubs, rows, held: setting.held };
    });

    expect(afterwards.hubs).toEqual([HUB_A]);
    expect(afterwards.rows).toEqual([]);
    expect(afterwards.held === null || afterwards.held === '').toBe(true);
  });

  // Break caught: a probe that reads more than the one id, so that a statement under the hold names every row of the table.
  it('reads the one id it names: the policy admits no other row while the hold lasts', async () => {
    const named = await session([HUB_A]);
    const other = await session([HUB_A]);

    const seen = await run(staffContext(), async (tx) => {
      await probe(tx, 'session', named.id);
      return (await tx.execute(sql`select id from session where id = ${other.id}::uuid`)).rows;
    });

    expect(seen).toEqual([]);
  });
});

describe('the policy of the probe, as the catalogue holds it', () => {
  // Break caught: the probe predicate in a policy for another command (an UPDATE or a locking read would then run under it), or a second
  // predicate on the table that reads the setting.
  it('is one policy for SELECT alone, naming the staff principal and the id the probe has named, with no write check', async () => {
    const policies = await admin.query<{
      policyname: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `select policyname, cmd, qual, with_check from pg_policies
        where schemaname = 'public' and tablename = 'session'
          and (coalesce(qual, '') like '%scope_probe_id%' or coalesce(with_check, '') like '%scope_probe_id%')`,
    );

    expect(policies.rows).toHaveLength(1);
    expect(policies.rows[0]).toMatchObject({
      policyname: 'session_probe',
      cmd: 'SELECT',
      with_check: null,
    });
    expect(policies.rows[0]?.qual).toContain('STAFF');
    expect(policies.rows[0]?.qual).toContain('scope_probe_id');
  });
});

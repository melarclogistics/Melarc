import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseTransaction } from '../../src/platform/database/database.service.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import {
  HUB_A,
  RIDER_1,
  riderContext,
  staffContext,
  systemContext,
  vendorContext,
} from './support/rls-fixture.js';
import { buildService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * S1.17 against a real PostgreSQL: the one way a vendor reads the reason catalogue (migration 0052; data-scope-registry.md `ReasonCode`).
 * A vendor cancels its own pending request under a reason of the cancellation domain, and the reason is read to be validated and
 * snapshotted; the catalogue is the office's otherwise. So the vendor reads the reasons of **that domain** while it runs **that operation**,
 * and no other domain, no other operation, and no other principal gains anything.
 */
let database: TestDatabase;
let admin: pg.Client;
const vendor = vendorRow({ hubId: HUB_A });

beforeAll(async () => {
  database = await createTestDatabase();
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ('${HUB_A}', 'Hub A')`);
  await insertVendor(admin, vendor);
  for (const [code, domain] of [
    ['FIXTURE_CANCEL_ONE', 'PICKUP_CANCELLATION'],
    ['FIXTURE_CANCEL_TWO', 'PICKUP_CANCELLATION'],
    ['FIXTURE_FAILURE_ONE', 'PICKUP_FAILURE'],
    ['FIXTURE_SHORT_ONE', 'PICKUP_SHORT_COUNT'],
  ] as const) {
    await admin.query(
      `insert into reason_code (code, domain, label, attribution) values ($1, $2, $3, 'CUSTOMER')`,
      [code, domain, `Fixture ${code}`],
    );
  }
});

afterAll(async () => {
  await admin.end();
  await database.drop();
});

async function codesRead(context: SecurityContext): Promise<string[]> {
  const { service, close } = buildService(database);
  try {
    return await service.transactionWithContext(context, async (tx: DatabaseTransaction) => {
      const result = await tx.execute(
        sql.raw(`select code from reason_code where code like 'FIXTURE_%' order by code`),
      );
      return (result.rows as { code: string }[]).map((row) => row.code);
    });
  } finally {
    await close();
  }
}

const vendorUnder = (key: string | undefined): SecurityContext => ({
  ...vendorContext(vendor.organizationId),
  ...(key === undefined ? {} : { authorizationKey: key }),
});

describe('the reasons a vendor reads', () => {
  // Break caught: the catalogue closed to the vendor that has to cancel under one of its reasons (its cancellation would fail as a reason that
  // does not exist), or opened to a domain it has no business reading.
  it('reads the cancellation reasons while it cancels, and nothing else', async () => {
    expect(await codesRead(vendorUnder('pickup.request.cancel'))).toEqual([
      'FIXTURE_CANCEL_ONE',
      'FIXTURE_CANCEL_TWO',
    ]);
  });

  // Break caught: the reasons read under any key a vendor holds, or with no operation at all.
  it('reads none under any other operation’s key, or under none', async () => {
    for (const key of [
      'pickup.read',
      'pickup.request.create',
      'pricing.read',
      'vendor.pickup_location.manage',
    ]) {
      expect(await codesRead(vendorUnder(key)), key).toEqual([]);
    }
    expect(await codesRead(vendorUnder(undefined))).toEqual([]);
  });

  // Break caught: the policy widened to a rider or a SYSTEM context, or the office's own reading narrowed by it.
  it('gives a rider and a SYSTEM context nothing, and leaves the office’s reading as it was', async () => {
    const key = { authorizationKey: 'pickup.request.cancel' };
    expect(await codesRead({ ...riderContext(RIDER_1), ...key })).toEqual([]);
    for (const capability of ['configuration', 'rate_limit'] as const) {
      expect(await codesRead(systemContext(capability)), capability).toEqual([]);
    }
    expect(await codesRead({ ...staffContext([HUB_A]), ...key })).toEqual([
      'FIXTURE_CANCEL_ONE',
      'FIXTURE_CANCEL_TWO',
      'FIXTURE_FAILURE_ONE',
      'FIXTURE_SHORT_ONE',
    ]);
  });
});

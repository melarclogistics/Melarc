import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import {
  runSeed,
  SeedRefusedError,
  type SeedPlan,
} from '../../src/platform/database/seed/seed-helper.js';
import { PROVISIONING_ROLE } from '../../src/platform/database/technical-roles.js';
import { RESERVED_SYSTEM_ACTOR_ID } from '../../src/staff/reserved-system-actor.js';
import { vendorFixturePlan } from '../../src/tools/fixtures/vendor-fixture.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * The demonstration vendor (S0.47; MIGRATION_AND_SEEDING.md section 4b) as the seed command applies it: the provisioning login, the seed
 * helper, `melarc.add_vendor_fixture`. The function is the only way in: the login holds no privilege on the vendor tables, and the API's
 * login cannot execute it. What it leaves is one vendor where an approval leaves it, less the setup grant.
 */
let database: TestDatabase;
let admin: pg.Client;
let provisioning: BuiltService;
let runtime: BuiltService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  provisioning = buildService(database, { login: PROVISIONING_ROLE, poolMax: 1 });
  runtime = buildService(database, { poolMax: 1 });
});

afterAll(async () => {
  await admin.end();
  await provisioning.close();
  await runtime.close();
  await database.drop();
});

/** The plan with one row of one table changed: what a payload the function must refuse looks like. */
function changed(
  table: 'vendor_organization' | 'vendor_account' | 'vendor_credential',
  change: Record<string, unknown>,
): SeedPlan {
  const plan = vendorFixturePlan();
  return {
    ...plan,
    payload: { ...plan.payload, [table]: [{ ...plan.payload[table]?.[0], ...change }] },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code ?? (error instanceof Error ? error.name : 'other');
  }
}

describe('melarc.add_vendor_fixture', () => {
  // Break caught (section 4b's second constraint): a fixture that hands over a secret, a browser or a grant, or a phone a person holds.
  it.each([
    ['a phone', 'vendor_credential', { recovery_phone: '+233200000009' }],
    ['an address of a real domain', 'vendor_credential', { recovery_email: 'someone@example.com' }],
    [
      'a secret',
      'vendor_credential',
      { secret_hash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA' },
    ],
    [
      'an account of another organisation',
      'vendor_account',
      { vendor_organization_id: randomUUID() },
    ],
  ] as const)('refuses a payload with %s, and writes nothing', async (_name, table, change) => {
    expect(await codeOf(runSeed(provisioning.service, changed(table, change)))).toBe('22023');
    expect(
      (await admin.query(`select count(*)::int as n from vendor_organization`)).rows[0],
    ).toEqual({ n: 0 });
  });

  it('leaves one approved vendor of the seeded hub, with no secret, no browser and no grant, and refuses a second', async () => {
    const plan = vendorFixturePlan();
    const report = await runSeed(provisioning.service, plan);
    expect(report).toEqual({
      'vendor_organization (fixture)': 1,
      'vendor_account (fixture)': 1,
      'vendor_credential (fixture)': 1,
    });

    const organization = (await admin.query(`select * from vendor_organization`)).rows;
    expect(organization).toEqual([
      expect.objectContaining({
        id: plan.payload.vendor_organization?.[0]?.id,
        responsible_hub_id: HUBS[0]?.id,
        operational_status: 'ACTIVE',
        created_by: RESERVED_SYSTEM_ACTOR_ID,
        decided_by: RESERVED_SYSTEM_ACTOR_ID,
        decision_reason: null,
        contact_phone: null,
      }),
    ]);
    const account = (await admin.query(`select id, account_identifier, status from vendor_account`))
      .rows;
    expect(account).toEqual([
      {
        id: plan.payload.vendor_account?.[0]?.id,
        account_identifier: plan.payload.vendor_account?.[0]?.account_identifier,
        status: 'ACTIVE',
      },
    ]);
    const credential = (await admin.query(`select * from vendor_credential`)).rows;
    expect(credential).toEqual([
      expect.objectContaining({
        secret_hash: null,
        credential_established_at: null,
        credential_generation: '0',
        recovery_phone: null,
        recovery_email: 'vendor-recovery@melarc.invalid',
        delivery_channel: 'EMAIL',
      }),
    ]);
    expect((await admin.query(`select count(*)::int as n from registered_device`)).rows[0]).toEqual(
      { n: 0 },
    );
    expect(
      (
        await admin.query(
          `select count(*)::int as n from setup_grant where principal_type = 'VENDOR'`,
        )
      ).rows[0],
    ).toEqual({
      n: 0,
    });

    const again = await runSeed(provisioning.service, vendorFixturePlan()).catch(
      (error: unknown) => error,
    );
    expect(again).toBeInstanceOf(SeedRefusedError);
    expect(again).toMatchObject({ table: 'vendor_organization', rows: 1 });
  });

  // Break caught: a second way in. The provisioning login writes nothing but through the function, and the API's login cannot call it.
  it('is the only way in: the provisioning login holds no privilege on the tables, and the API cannot execute it', async () => {
    const plan = vendorFixturePlan();
    const asProvisioning = await codeOf(
      provisioning.service.transactionWithContext(
        {
          principalType: 'SYSTEM',
          principalId: '5eed0000-0000-4000-8000-000000000001',
          surface: 'SYSTEM',
          taskCapability: 'seed',
          correlationId: 'vendor-fixture-test',
        },
        (tx) =>
          tx.execute(
            sql`insert into vendor_organization (id, responsible_hub_id, legal_name, contact_email, operational_status, created_by, decided_by, decided_at)
                values (${randomUUID()}::uuid, ${HUBS[0]?.id ?? ''}::uuid, 'x', 'x@melarc.invalid', 'ACTIVE', ${RESERVED_SYSTEM_ACTOR_ID}::uuid,
                        ${RESERVED_SYSTEM_ACTOR_ID}::uuid, now())`,
          ),
      ),
    );
    expect(asProvisioning).toBe('42501');
    const asRuntime = await codeOf(
      runtime.service.transactionWithContext(
        {
          principalType: 'SYSTEM',
          principalId: '61757468-0000-4000-8000-000000000001',
          surface: 'SYSTEM',
          taskCapability: 'authentication',
          correlationId: 'vendor-fixture-test',
        },
        (tx) =>
          tx.execute(sql`select melarc.add_vendor_fixture(${JSON.stringify(plan.payload)}::jsonb)`),
      ),
    );
    expect(asRuntime).toBe('42501');
  });
});

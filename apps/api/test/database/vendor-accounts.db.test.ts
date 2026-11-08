import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { createScopeProbe } from '../../src/platform/database/scope-probe.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';
import {
  SOME_SECRET_HASH,
  deviceCredential,
  insertDevice,
  insertVendor,
  vendorRow,
  type DeviceRow,
  type VendorRow,
} from './support/vendors.js';

/**
 * S0.47 (migration 0034): the vendor organisation, account, credential and registered browser, against a real PostgreSQL, as the API's
 * login (`melarc_api_runtime`). What each principal reads is row-level security and nothing else: a staff context under one of the three
 * vendor keys reaches the accounts whose organisation's responsible hub is in its scope (or all of them under the explicit all-hub scope),
 * a vendor reaches its own account and its own browsers, and the credential is the `authentication` capability's alone. Neither secret
 * (the shared secret's hash, the browser credential's hash) can be selected by the runtime in any context: each is reached through a
 * definer function that answers the authentication capability.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const PROBE = createScopeProbe({
  vendor_account: {
    schema: 'public',
    table: 'vendor_account',
    hubVia: {
      table: 'vendor_organization',
      key: 'vendor_organization_id',
      hubColumn: 'responsible_hub_id',
    },
  },
});

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;
let inA: VendorRow;
let inB: VendorRow;
let established: VendorRow;
let deviceOfA: DeviceRow;
let deviceOfB: DeviceRow;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  inA = await insertVendor(admin, vendorRow({ hubId: HUB_A }));
  inB = await insertVendor(admin, vendorRow({ hubId: HUB_B }));
  established = await insertVendor(
    admin,
    vendorRow({ hubId: HUB_A, secretHash: SOME_SECRET_HASH, recoveryPhone: '+233200000001' }),
  );
  deviceOfA = await insertDevice(admin, inA.accountId);
  deviceOfB = await insertDevice(admin, inB.accountId);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const staff = (
  scope: { mode: 'SET' | 'ALL'; hubs?: readonly string[] },
  key: string | null = 'vendor.read',
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'vendor-accounts-test',
  hubScopeMode: scope.mode,
  authorizedHubIds: scope.hubs ?? [],
  ...(key === null ? {} : { authorizationKey: key }),
});

const vendorOf = (row: VendorRow): SecurityContext => ({
  principalType: 'VENDOR',
  principalId: row.accountId,
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  vendorOrganizationId: row.organizationId,
  correlationId: 'vendor-accounts-test',
});

const authentication: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '61757468-0000-4000-8000-000000000001',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'vendor-accounts-test',
};

const ours = (): string[] => [inA.accountId, inB.accountId, established.accountId];

async function accountsVisibleTo(context: SecurityContext): Promise<string[]> {
  return built.service.transactionWithContext(context, async (tx) => {
    const result = await tx.execute(
      sql`select id from vendor_account where id = any(${`{${ours().join(',')}}`}::uuid[]) order by id`,
    );
    return (result.rows as { id: string }[]).map((row) => row.id);
  });
}

async function devicesVisibleTo(context: SecurityContext): Promise<string[]> {
  return built.service.transactionWithContext(context, async (tx) => {
    const result = await tx.execute(
      sql`select id from registered_device where id = any(${`{${[deviceOfA.id, deviceOfB.id].join(',')}}`}::uuid[]) order by id`,
    );
    return (result.rows as { id: string }[]).map((row) => row.id);
  });
}

const ids = (...rows: readonly VendorRow[]): string[] =>
  rows.map((row) => row.accountId).toSorted();

async function failureOf(
  context: SecurityContext,
  statement: ReturnType<typeof sql>,
): Promise<string | undefined> {
  try {
    await built.service.transactionWithContext(context, (tx) => tx.execute(statement));
    return undefined;
  } catch (error) {
    return serverErrorIn(error)?.code ?? 'other';
  }
}

describe('who reads a vendor account (AC-SLICE-000-102)', () => {
  // Break caught: a vendor account read across every hub by a hub-scoped holder of vendor.read (the narrowing left to the operations).
  it('shows a holder of vendor.read in a set of hubs the accounts whose organisation is in those hubs, and no other', async () => {
    expect(await accountsVisibleTo(staff({ mode: 'SET', hubs: [HUB_A] }))).toEqual(
      ids(inA, established),
    );
    expect(await accountsVisibleTo(staff({ mode: 'SET', hubs: [HUB_B] }))).toEqual(ids(inB));
  });

  // Break caught: the all-hub grant not reaching every account, or an empty set read as all.
  it('shows the explicit all-hub scope every account, and an empty set of hubs none', async () => {
    expect(await accountsVisibleTo(staff({ mode: 'ALL' }))).toEqual(ids(inA, inB, established));
    expect(await accountsVisibleTo(staff({ mode: 'SET', hubs: [] }))).toEqual([]);
  });

  // Break caught: the arm reached under a key that is not a vendor key, or with no key at all.
  it.each([
    ['staff.read', 'staff.read'],
    ['no key', null],
  ] as const)('shows a staff context under %s no account', async (_name, key) => {
    expect(await accountsVisibleTo(staff({ mode: 'ALL' }, key))).toEqual([]);
  });

  // Break caught: the two administrative keys reaching an account outside their hubs.
  it.each(['vendor.organization.approve', 'vendor.credential.recover'])(
    'holds %s to the same hub scope',
    async (key) => {
      expect(await accountsVisibleTo(staff({ mode: 'SET', hubs: [HUB_B] }, key))).toEqual(ids(inB));
      expect(await accountsVisibleTo(staff({ mode: 'ALL' }, key))).toEqual(
        ids(inA, inB, established),
      );
    },
  );

  // Break caught: a vendor reading another vendor's account (the own-records rule).
  it('shows a vendor its own account and no other', async () => {
    expect(await accountsVisibleTo(vendorOf(inA))).toEqual([inA.accountId]);
  });

  it('shows the authentication capability every account, and a rider none', async () => {
    expect(await accountsVisibleTo(authentication)).toEqual(ids(inA, inB, established));
    expect(
      await accountsVisibleTo({
        principalType: 'RIDER',
        principalId: randomUUID(),
        sessionId: randomUUID(),
        surface: 'RIDER_ANDROID',
        riderId: randomUUID(),
        correlationId: 'vendor-accounts-test',
      }),
    ).toEqual([]);
  });

  // Break caught (SECURITY_DESIGN.md 14.4b): the probe not reaching the hub of an account, which lives on its organisation.
  it('lets the scope probe tell a staff caller the hub of an account it cannot see, and nothing more', async () => {
    const hub = await built.service.transactionWithContext(
      staff({ mode: 'SET', hubs: [HUB_A] }),
      (tx) => PROBE(tx, 'vendor_account', inB.accountId),
    );
    expect(hub).toBe(HUB_B);
    const none = await built.service.transactionWithContext(
      staff({ mode: 'SET', hubs: [HUB_A] }),
      (tx) => PROBE(tx, 'vendor_account', randomUUID()),
    );
    expect(none).toBeUndefined();
    const vendor = await built.service.transactionWithContext(vendorOf(inA), (tx) =>
      PROBE(tx, 'vendor_account', inB.accountId),
    );
    expect(vendor).toBeUndefined();
  });
});

describe('the vendor organisation, a global master record', () => {
  it('is read by a holder of a vendor key at any scope, by the vendor its own, and by nobody else', async () => {
    const read = (context: SecurityContext) =>
      built.service.transactionWithContext(context, async (tx) =>
        (
          (
            await tx.execute(
              sql`select id from vendor_organization where id = any(${`{${inA.organizationId},${inB.organizationId}}`}::uuid[]) order by id`,
            )
          ).rows as { id: string }[]
        ).map((row) => row.id),
      );
    const both = [inA.organizationId, inB.organizationId].toSorted();
    expect(await read(staff({ mode: 'SET', hubs: [] }))).toEqual(both);
    expect(await read(staff({ mode: 'ALL' }, 'staff.read'))).toEqual([]);
    expect(await read(vendorOf(inA))).toEqual([inA.organizationId]);
    expect(await read(authentication)).toEqual(both);
  });
});

describe('the vendor credential is the authentication capability’s alone', () => {
  // Break caught: a staff or vendor arm on the credential (the registry keeps Staff and Vendor DENY).
  it('is read by no staff and no vendor context, and by the authentication capability', async () => {
    const read = (context: SecurityContext) =>
      built.service.transactionWithContext(
        context,
        async (tx) =>
          (
            (
              await tx.execute(
                sql`select vendor_account_id from vendor_credential where vendor_account_id = ${inA.accountId}::uuid`,
              )
            ).rows as unknown[]
          ).length,
      );
    expect(await read(staff({ mode: 'ALL' }))).toBe(0);
    expect(await read(vendorOf(inA))).toBe(0);
    expect(await read(authentication)).toBe(1);
  });

  // Break caught: the runtime granted SELECT on a secret column, so some context's policy could hand it out.
  it('never lets the runtime select the shared secret’s hash or a browser credential’s hash, in any context', async () => {
    expect(await failureOf(authentication, sql`select secret_hash from vendor_credential`)).toBe(
      '42501',
    );
    expect(
      await failureOf(authentication, sql`select device_credential_hash from registered_device`),
    ).toBe('42501');
    expect(await failureOf(authentication, sql`select * from vendor_credential`)).toBe('42501');
  });

  it('gives the hash of a shared secret to the authentication capability alone', async () => {
    const hash = await built.service.transactionWithContext(
      authentication,
      async (tx) =>
        (
          await tx.execute(
            sql`select melarc.vendor_secret_hash(${established.accountId}::uuid) as hash`,
          )
        ).rows[0],
    );
    expect(hash).toEqual({ hash: SOME_SECRET_HASH });
    expect(
      await failureOf(
        staff({ mode: 'ALL' }),
        sql`select melarc.vendor_secret_hash(${established.accountId}::uuid)`,
      ),
    ).toBe('42501');
    expect(
      await failureOf(
        vendorOf(established),
        sql`select melarc.vendor_secret_hash(${established.accountId}::uuid)`,
      ),
    ).toBe('42501');
  });

  // Break caught: a browser credential found by a context that is not the sign-in's, or a lookup that returns the hash.
  it('finds a browser by its credential for the authentication capability alone, by id, account and status', async () => {
    const found = await built.service.transactionWithContext(
      authentication,
      async (tx) =>
        (
          await tx.execute(
            sql`select * from melarc.vendor_device_by_credential(${deviceOfA.credential.hash}::bytea)`,
          )
        ).rows,
    );
    expect(found).toEqual([
      { device_id: deviceOfA.id, vendor_account_id: inA.accountId, status: 'ACTIVE' },
    ]);
    const unknown = await built.service.transactionWithContext(
      authentication,
      async (tx) =>
        (
          await tx.execute(
            sql`select * from melarc.vendor_device_by_credential(${deviceCredential().hash}::bytea)`,
          )
        ).rows,
    );
    expect(unknown).toEqual([]);
    expect(
      await failureOf(
        vendorOf(inA),
        sql`select * from melarc.vendor_device_by_credential(${deviceOfA.credential.hash}::bytea)`,
      ),
    ).toBe('42501');
  });
});

describe('the registered browser', () => {
  it('is read by a vendor-key holder for an account it sees, by the vendor its own, and by nobody else', async () => {
    expect(await devicesVisibleTo(staff({ mode: 'SET', hubs: [HUB_A] }))).toEqual([deviceOfA.id]);
    expect(await devicesVisibleTo(staff({ mode: 'ALL' }))).toEqual(
      [deviceOfA.id, deviceOfB.id].toSorted(),
    );
    expect(await devicesVisibleTo(staff({ mode: 'ALL' }, 'staff.read'))).toEqual([]);
    expect(await devicesVisibleTo(vendorOf(inB))).toEqual([deviceOfB.id]);
  });

  // Break caught: a device brought back from REVOKED, or one moved between accounts.
  it('keeps its account and credential, and ends once', async () => {
    const device = await insertDevice(admin, inA.accountId);
    await admin.query(
      `update registered_device set status = 'REVOKED', ended_at = clock_timestamp() where id = $1`,
      [device.id],
    );
    await expect(
      admin.query(`update registered_device set status = 'ACTIVE', ended_at = null where id = $1`, [
        device.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `update registered_device set principal_id = $2, vendor_account_id = $2 where id = $1`,
        [deviceOfA.id, inB.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
        [device.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('holds one browser credential to one device', async () => {
    await expect(
      insertDevice(admin, inB.accountId, { credential: deviceOfA.credential }),
    ).rejects.toMatchObject({
      code: '23505',
    });
  });
});

describe('the guards of the vendor tables', () => {
  // Break caught: an identifier with an ambiguous character, a lower-case one, or one of another length (SECURITY_DESIGN.md 13.7a).
  it.each(['ABCDEFG0', 'ABCDEFGI', 'ABCDEFGL', 'ABCDEFGO', 'abcdefgh', 'ABCDEFG', 'ABCDEFGHJ'])(
    'refuses the account identifier %s',
    async (identifier) => {
      await expect(
        insertVendor(admin, vendorRow({ accountIdentifier: identifier })),
      ).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it('refuses a second account with an identifier already used, and a second account of one organisation', async () => {
    await expect(
      insertVendor(admin, vendorRow({ accountIdentifier: inA.accountIdentifier })),
    ).rejects.toMatchObject({
      code: '23505',
    });
    await expect(
      admin.query(
        `insert into vendor_account (id, vendor_organization_id, account_identifier, status) values ($1, $2, $3, 'ACTIVE')`,
        [randomUUID(), inA.organizationId, 'ZZZZZZZZ'],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  // Break caught: a delivery channel that names no registered address, or a credential with no channel at all.
  it('requires a recovery channel, and a delivery channel that names one the credential holds', async () => {
    await expect(
      insertVendor(
        admin,
        vendorRow({ recoveryEmail: null, recoveryPhone: null, deliveryChannel: null }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insertVendor(
        admin,
        vendorRow({
          recoveryEmail: 'x@example.test',
          recoveryPhone: null,
          deliveryChannel: 'PHONE',
        }),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a secret replaced without a new generation, or a generation that jumps or goes back.
  it('raises the credential generation by one, with the moment it was set, and never back', async () => {
    const row = await insertVendor(admin, vendorRow());
    await expect(
      admin.query(
        `update vendor_credential set secret_hash = $2, credential_established_at = clock_timestamp(), credential_generation = 2
          where vendor_account_id = $1`,
        [row.accountId, SOME_SECRET_HASH],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `update vendor_credential set secret_hash = $2, credential_established_at = clock_timestamp(), credential_generation = 1
        where vendor_account_id = $1`,
      [row.accountId, SOME_SECRET_HASH],
    );
    await expect(
      admin.query(
        `update vendor_credential set credential_generation = 0, secret_hash = null, credential_established_at = null where vendor_account_id = $1`,
        [row.accountId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: the API's login changing what the authentication capability never should: the status of an account (SLICE-008's)
  // or where its messages go (its own authorised workflow, domain-model.md 6.8).
  it('lets the API change neither an account’s status nor its recovery channel', async () => {
    expect(
      await failureOf(
        authentication,
        sql`update vendor_account set status = 'SUSPENDED' where id = ${inA.accountId}::uuid`,
      ),
    ).toBe('42501');
    expect(
      await failureOf(
        authentication,
        sql`update vendor_credential set recovery_email = 'other@example.test' where vendor_account_id = ${inA.accountId}::uuid`,
      ),
    ).toBe('42501');
    expect(
      await failureOf(
        authentication,
        sql`insert into vendor_organization (id) values (${randomUUID()}::uuid)`,
      ),
    ).toBe('42501');
  });
});

describe('the facts a vendor read is given (melarc.vendor_credential_facts)', () => {
  const facts = (
    context: SecurityContext,
    isolation: 'REPEATABLE READ' | 'READ COMMITTED' = 'REPEATABLE READ',
  ) =>
    built.service.transactionWithContext(
      context,
      async (tx) =>
        (
          await tx.execute(
            sql`select * from melarc.vendor_credential_facts(${`{${ours().join(',')}}`}::uuid[]) order by vendor_account_id`,
          )
        ).rows,
      isolation === 'REPEATABLE READ' ? { isolation } : {},
    );

  // Break caught: a fact given for an account outside the caller's scope, or a value (an address, a hash) among the facts.
  it('gives a holder of vendor.read the facts of the accounts its scope shows, and nothing that is a credential', async () => {
    const rows = await facts(staff({ mode: 'SET', hubs: [HUB_A] }));
    expect(rows).toEqual(
      [
        {
          vendor_account_id: inA.accountId,
          credential_established: false,
          has_recovery_email: true,
          has_recovery_phone: false,
          delivery_channel: 'EMAIL',
          credential_generation: 0,
        },
        {
          vendor_account_id: established.accountId,
          credential_established: true,
          has_recovery_email: true,
          has_recovery_phone: true,
          delivery_channel: 'EMAIL',
          credential_generation: 1,
        },
      ].toSorted((a, b) => a.vendor_account_id.localeCompare(b.vendor_account_id)),
    );
  });

  it('refuses another key, a vendor and a read at READ COMMITTED', async () => {
    await expect(facts(staff({ mode: 'ALL' }, 'staff.read'))).rejects.toMatchObject({});
    await expect(facts(vendorOf(inA))).rejects.toMatchObject({});
    await expect(facts(staff({ mode: 'ALL' }), 'READ COMMITTED')).rejects.toMatchObject({});
  });
});

describe('the facts an administrative act reads under the account’s lock (melarc.vendor_locked_facts)', () => {
  const locked = (context: SecurityContext, id: string) =>
    built.service.transactionWithContext(context, async (tx) => {
      const rows = (await tx.execute(sql`select * from melarc.vendor_locked_facts(${id}::uuid)`))
        .rows;
      const bound = (
        await tx.execute(
          sql`select current_setting('melarc.locked_vendor_account', true) as account, current_setting('melarc.principal_type', true) as type`,
        )
      ).rows[0];
      return { rows, bound };
    });

  // Break caught: the account read without its lock, the destination withheld from the act that must queue to it, the binding not set.
  it('locks an account the caller’s scope shows, binds the transaction to it, and gives the facts and the destination', async () => {
    const result = await locked(
      staff({ mode: 'SET', hubs: [HUB_A] }, 'vendor.organization.approve'),
      established.accountId,
    );
    expect(result.rows).toEqual([
      {
        vendor_account_id: established.accountId,
        account_status: 'ACTIVE',
        organization_status: 'ACTIVE',
        credential_established: true,
        credential_generation: 1,
        has_recovery_email: true,
        has_recovery_phone: true,
        delivery_channel: 'EMAIL',
        delivery_destination: established.recoveryEmail,
      },
    ]);
    expect(result.bound).toEqual({ account: established.accountId, type: 'STAFF' });
  });

  // Break caught: an administrative act that does not hold the account's identity lock, so a change of its standing could interleave.
  it('holds the account row’s lock until the act’s transaction ends', async () => {
    await built.service.transactionWithContext(
      staff({ mode: 'SET', hubs: [HUB_A] }, 'vendor.organization.approve'),
      async (tx) => {
        await tx.execute(sql`select * from melarc.vendor_locked_facts(${inA.accountId}::uuid)`);
        await expect(
          admin.query(`select 1 from vendor_account where id = $1 for update nowait`, [
            inA.accountId,
          ]),
        ).rejects.toMatchObject({ code: '55P03' });
      },
    );
  });

  // Break caught: the function confirming that an account outside the scope exists, or binding the transaction to it.
  it('gives nothing, and binds nothing, for an account outside the scope', async () => {
    const result = await locked(
      staff({ mode: 'SET', hubs: [HUB_A] }, 'vendor.organization.approve'),
      inB.accountId,
    );
    expect(result.rows).toEqual([]);
    expect(result.bound).toEqual({ account: '', type: 'STAFF' });
  });

  it('answers vendor.credential.recover too, and refuses vendor.read and a vendor', async () => {
    expect(
      (await locked(staff({ mode: 'ALL' }, 'vendor.credential.recover'), inB.accountId)).rows,
    ).toHaveLength(1);
    await expect(
      locked(staff({ mode: 'ALL' }, 'vendor.read'), inB.accountId),
    ).rejects.toMatchObject({});
    await expect(locked(vendorOf(inB), inB.accountId)).rejects.toMatchObject({});
  });
});

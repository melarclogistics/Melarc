import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { createScopeProbe } from '../../src/platform/database/scope-probe.js';
import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import {
  SOME_PIN_HASH,
  deviceKey,
  insertRider,
  insertRiderDevice,
  randomToken,
  riderPhone,
  riderRow,
  type RiderDeviceRow,
  type RiderRow,
} from './support/riders.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.53 (migration 0040): the rider identity and the rider part of the registered device, against a real PostgreSQL, as the API's login
 * (`melarc_api_runtime`). What each principal reads is row-level security and nothing else: a staff context reads the riders of the scope
 * of the operation it runs (the roster's key and the three device keys), a rider its own, the authentication capability all; the PIN's hash
 * and a device's key are in no column the runtime can select, and the database refuses a second ACTIVE device for a rider.
 */
const HUB_A = HUBS[0]?.id ?? '';
const HUB_B = 'b0b0b0b0-0000-4000-8000-00000000000b';
const PROBE = createScopeProbe({
  rider_identity: { schema: 'public', table: 'rider_identity', hubColumn: 'primary_hub_id' },
});

let database: TestDatabase;
let admin: pg.Client;
let built: BuiltService;
let inA: RiderRow;
let inB: RiderRow;
let withPin: RiderRow;
let deviceOfA: RiderDeviceRow;
let deviceOfB: RiderDeviceRow;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  built = buildService(database, { poolMax: 2 });
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [HUB_B]);
  inA = await insertRider(admin, riderRow({ hubId: HUB_A }));
  inB = await insertRider(admin, riderRow({ hubId: HUB_B }));
  withPin = await insertRider(admin, riderRow({ hubId: HUB_A, pinHash: SOME_PIN_HASH }));
  deviceOfA = await insertRiderDevice(admin, inA.id);
  deviceOfB = await insertRiderDevice(admin, inB.id);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const staff = (
  scope: { mode: 'SET' | 'ALL'; hubs?: readonly string[] },
  key: string | null = 'dispatch.read',
): SecurityContext => ({
  principalType: 'STAFF',
  principalId: randomUUID(),
  surface: 'OPS_PORTAL',
  correlationId: 'rider-identities-test',
  hubScopeMode: scope.mode,
  authorizedHubIds: scope.hubs ?? [],
  ...(key === null ? {} : { authorizationKey: key }),
});

const riderOf = (row: RiderRow): SecurityContext => ({
  principalType: 'RIDER',
  principalId: row.id,
  sessionId: randomUUID(),
  surface: 'RIDER_ANDROID',
  riderId: row.id,
  correlationId: 'rider-identities-test',
});

const vendor: SecurityContext = {
  principalType: 'VENDOR',
  principalId: randomUUID(),
  sessionId: randomUUID(),
  surface: 'VENDOR_PWA',
  vendorOrganizationId: randomUUID(),
  correlationId: 'rider-identities-test',
};

const authentication: SecurityContext = {
  principalType: 'SYSTEM',
  principalId: '61757468-0000-4000-8000-000000000001',
  surface: 'SYSTEM',
  taskCapability: 'authentication',
  correlationId: 'rider-identities-test',
};

const ours = (): string[] => [inA.id, inB.id, withPin.id];

async function ridersVisibleTo(context: SecurityContext): Promise<string[]> {
  return built.service.transactionWithContext(context, async (tx) => {
    const result = await tx.execute(
      sql`select id from rider_identity where id = any(${`{${ours().join(',')}}`}::uuid[]) order by id`,
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

const ids = (...rows: readonly RiderRow[]): string[] => rows.map((row) => row.id).toSorted();

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

describe('who reads a rider (AC-SLICE-000-113, the data half)', () => {
  // Break caught: the roster read across every hub by a hub-scoped holder of dispatch.read.
  it('shows a holder of dispatch.read in a set of hubs the riders whose primary hub is in those hubs, and no other', async () => {
    expect(await ridersVisibleTo(staff({ mode: 'SET', hubs: [HUB_A] }))).toEqual(ids(inA, withPin));
    expect(await ridersVisibleTo(staff({ mode: 'SET', hubs: [HUB_B] }))).toEqual(ids(inB));
  });

  // Break caught: the all-hub grant not reaching every rider, or an empty set read as all.
  it('shows the explicit all-hub scope every rider, and an empty set of hubs none', async () => {
    expect(await ridersVisibleTo(staff({ mode: 'ALL' }))).toEqual(ids(inA, inB, withPin));
    expect(await ridersVisibleTo(staff({ mode: 'SET', hubs: [] }))).toEqual([]);
  });

  // Break caught: the arm reached under a key that is not one of the four, or with no key at all.
  it.each([
    ['staff.read', 'staff.read'],
    ['vendor.read', 'vendor.read'],
    ['no key', null],
  ] as const)('shows a staff context under %s no rider', async (_name, key) => {
    expect(await ridersVisibleTo(staff({ mode: 'ALL' }, key))).toEqual([]);
  });

  // Break caught: a device key not reading the record a path names, which the guard asks under the operation's own key.
  it.each(['staff.device.register', 'staff.device.reregister', 'staff.device.revoke'])(
    'shows a holder of %s the riders of its scope',
    async (key) => {
      expect(await ridersVisibleTo(staff({ mode: 'SET', hubs: [HUB_B] }, key))).toEqual(ids(inB));
      expect(await ridersVisibleTo(staff({ mode: 'ALL' }, key))).toEqual(ids(inA, inB, withPin));
    },
  );

  // Break caught: a rider reading another rider (the own-record rule), or a vendor reading any.
  it('shows a rider itself and no other, a vendor none, and the authentication capability every rider', async () => {
    expect(await ridersVisibleTo(riderOf(inA))).toEqual([inA.id]);
    expect(await ridersVisibleTo(vendor)).toEqual([]);
    expect(await ridersVisibleTo(authentication)).toEqual(ids(inA, inB, withPin));
  });

  // Break caught (SECURITY_DESIGN.md 14.4b): the probe not reaching the hub of a rider the caller cannot see, or reaching it for others.
  it('lets the scope probe tell a staff caller the hub of a rider it cannot see, and nothing more', async () => {
    const hub = await built.service.transactionWithContext(
      staff({ mode: 'SET', hubs: [HUB_A] }),
      (tx) => PROBE(tx, 'rider_identity', inB.id),
    );
    expect(hub).toBe(HUB_B);
    const none = await built.service.transactionWithContext(
      staff({ mode: 'SET', hubs: [HUB_A] }),
      (tx) => PROBE(tx, 'rider_identity', randomUUID()),
    );
    expect(none).toBeUndefined();
    const rider = await built.service.transactionWithContext(riderOf(inA), (tx) =>
      PROBE(tx, 'rider_identity', inB.id),
    );
    expect(rider).toBeUndefined();
  });
});

describe('the rider’s PIN and the device’s key are secrets of columns the runtime cannot select', () => {
  // Break caught: the runtime granted SELECT on a secret column, so some context's policy could hand it out.
  it('never lets the runtime select the PIN’s hash or a device’s key, in any context', async () => {
    expect(await failureOf(authentication, sql`select pin_hash from rider_identity`)).toBe('42501');
    expect(await failureOf(authentication, sql`select * from rider_identity`)).toBe('42501');
    expect(await failureOf(authentication, sql`select public_key from registered_device`)).toBe(
      '42501',
    );
    expect(await failureOf(authentication, sql`select * from registered_device`)).toBe('42501');
  });

  it('gives the hash of a PIN to the authentication capability alone', async () => {
    const hash = await built.service.transactionWithContext(
      authentication,
      async (tx) =>
        (await tx.execute(sql`select melarc.rider_pin_hash(${withPin.id}::uuid) as hash`)).rows[0],
    );
    expect(hash).toEqual({ hash: SOME_PIN_HASH });
    for (const context of [staff({ mode: 'ALL' }), riderOf(withPin), vendor]) {
      expect(await failureOf(context, sql`select melarc.rider_pin_hash(${withPin.id}::uuid)`)).toBe(
        '42501',
      );
    }
  });

  // Break caught: the key given to a context that is not the sign-in's, or one that is given for a device that is not ACTIVE.
  it('gives the key of an active device to the authentication capability alone, and none for an ended one', async () => {
    const rows = await built.service.transactionWithContext(
      authentication,
      async (tx) =>
        (await tx.execute(sql`select * from melarc.rider_active_device(${inA.id}::uuid)`)).rows,
    );
    expect(rows).toEqual([{ device_id: deviceOfA.id, public_key: deviceOfA.key.publicKey }]);
    for (const context of [staff({ mode: 'ALL' }), riderOf(inA), vendor]) {
      expect(
        await failureOf(context, sql`select * from melarc.rider_active_device(${inA.id}::uuid)`),
      ).toBe('42501');
    }
    const ended = await insertRider(admin, riderRow());
    await insertRiderDevice(admin, ended.id, { status: 'REVOKED' });
    expect(
      await built.service.transactionWithContext(
        authentication,
        async (tx) =>
          (await tx.execute(sql`select * from melarc.rider_active_device(${ended.id}::uuid)`)).rows,
      ),
    ).toEqual([]);
  });
});

describe('the registered device of a rider', () => {
  it('is read by a holder of a device key or dispatch.read for a rider it sees, by the rider its own, and by nobody else', async () => {
    expect(await devicesVisibleTo(staff({ mode: 'SET', hubs: [HUB_A] }))).toEqual([deviceOfA.id]);
    expect(await devicesVisibleTo(staff({ mode: 'ALL' }, 'staff.device.revoke'))).toEqual(
      [deviceOfA.id, deviceOfB.id].toSorted(),
    );
    expect(await devicesVisibleTo(staff({ mode: 'ALL' }, 'staff.read'))).toEqual([]);
    expect(await devicesVisibleTo(riderOf(inB))).toEqual([deviceOfB.id]);
    expect(await devicesVisibleTo(vendor)).toEqual([]);
  });

  // Break caught: the database allowing two live devices for one rider, whatever raced to make the second.
  it('refuses a second ACTIVE device for a rider, and allows one again once the first has ended', async () => {
    const rider = await insertRider(admin, riderRow());
    const first = await insertRiderDevice(admin, rider.id);
    await expect(insertRiderDevice(admin, rider.id)).rejects.toMatchObject({ code: '23505' });
    await admin.query(
      `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
      [first.id],
    );
    const second = await insertRiderDevice(admin, rider.id);
    expect(second.id).not.toBe(first.id);
  });

  // Break caught: a rider device that carries no key, a key that is not the canonical form, or a vendor's credential on a rider's row.
  it.each([
    ['no key', null],
    ['a short key', 'A'.repeat(123)],
    ['a key with trailing padding that is not canonical', `${'A'.repeat(121)}B==`],
    ['a key with a character outside base64', `${'A'.repeat(121)}A!=`],
    ['a key of the wrong length', `${'A'.repeat(125)}A==`],
  ] as const)('refuses a rider device with %s', async (_name, key) => {
    const rider = await insertRider(admin, riderRow());
    await expect(
      admin.query(
        `insert into registered_device (id, principal_type, principal_id, rider_identity_id, device_kind, public_key, status, registered_at)
         values ($1, 'RIDER', $2, $2, 'RIDER_ANDROID_KEYPAIR', $3, 'ACTIVE', clock_timestamp())`,
        [randomUUID(), rider.id, key],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a rider device that names another rider, a vendor kind or a credential hash, and a vendor device that carries a key', async () => {
    const rider = await insertRider(admin, riderRow());
    const other = await insertRider(admin, riderRow());
    const key = deviceKey().publicKey;
    const attempt = (columns: string, values: unknown[]) =>
      admin.query(
        `insert into registered_device (id, principal_type, ${columns}, status, registered_at) values ($1, ${values.map((_v, i) => `$${String(i + 2)}`).join(', ')}, 'ACTIVE', clock_timestamp())`,
        [randomUUID(), ...values],
      );
    await expect(
      attempt('principal_id, rider_identity_id, device_kind, public_key', [
        'RIDER',
        rider.id,
        other.id,
        'RIDER_ANDROID_KEYPAIR',
        key,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      attempt('principal_id, rider_identity_id, device_kind, public_key', [
        'RIDER',
        rider.id,
        rider.id,
        'VENDOR_BROWSER_CREDENTIAL',
        key,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      attempt('principal_id, rider_identity_id, device_kind, public_key, device_credential_hash', [
        'RIDER',
        rider.id,
        rider.id,
        'RIDER_ANDROID_KEYPAIR',
        key,
        randomToken().hash,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a device brought back from REVOKED or REPLACED, or one moved to another rider or given another key.
  it('keeps its rider and its key for good, and ends once', async () => {
    const rider = await insertRider(admin, riderRow());
    const other = await insertRider(admin, riderRow());
    const device = await insertRiderDevice(admin, rider.id);
    await expect(
      admin.query(`update registered_device set public_key = $2 where id = $1`, [
        device.id,
        deviceKey().publicKey,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `update registered_device set principal_id = $2, rider_identity_id = $2 where id = $1`,
        [device.id, other.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
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
        `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
        [device.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the guards of the rider identity', () => {
  // Break caught: a number that is not E.164, or one already used.
  it.each(['0201234567', '+0123456789', '+12', '+1234567890123456', '+233 20 123 4567', ''])(
    'refuses the phone %j',
    async (phone) => {
      await expect(insertRider(admin, riderRow({ phone }))).rejects.toMatchObject({
        code: '23514',
      });
    },
  );

  it('refuses a second rider with a number already used, an unknown status and a blank name', async () => {
    await expect(insertRider(admin, riderRow({ phone: inA.phone }))).rejects.toMatchObject({
      code: '23505',
    });
    await expect(insertRider(admin, riderRow({ status: 'DRIVING' }))).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insertRider(admin, riderRow({ fullName: '   ' }))).rejects.toMatchObject({
      code: '23514',
    });
  });

  // Break caught: a PIN replaced without a new generation, or a generation that jumps or goes back.
  it('raises the PIN generation by one, with the moment it was set, and never back', async () => {
    const row = await insertRider(admin, riderRow());
    await expect(
      admin.query(
        `update rider_identity set pin_hash = $2, pin_established_at = clock_timestamp(), credential_generation = 2 where id = $1`,
        [row.id, SOME_PIN_HASH],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `update rider_identity set pin_hash = $2, pin_established_at = clock_timestamp(), credential_generation = 1 where id = $1`,
      [row.id, SOME_PIN_HASH],
    );
    await expect(
      admin.query(
        `update rider_identity set pin_established_at = clock_timestamp() where id = $1`,
        [row.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `update rider_identity set credential_generation = 0, pin_hash = null, pin_established_at = null where id = $1`,
        [row.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: a lock without failures behind it, or on a rider who holds no PIN to lock.
  it('allows a lock only after failures and only on a rider who holds a PIN', async () => {
    const none = await insertRider(admin, riderRow());
    await expect(
      admin.query(
        `update rider_identity set failed_attempt_count = 1, locked_until = clock_timestamp() + interval '1 minute' where id = $1`,
        [none.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `update rider_identity set locked_until = clock_timestamp() + interval '1 minute' where id = $1`,
        [withPin.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // Break caught: the API's login changing what rider administration owns (SLICE-009): the name, the number, the status, the hub.
  it('lets the API change only the PIN record, and neither create nor remove a rider', async () => {
    for (const column of ['status', 'phone', 'full_name', 'primary_hub_id']) {
      const value = column === 'primary_hub_id' ? HUB_B : column === 'status' ? 'INACTIVE' : 'x';
      expect(
        await failureOf(
          authentication,
          sql.raw(`update rider_identity set ${column} = '${value}' where id = '${inA.id}'`),
        ),
      ).toBe('42501');
    }
    expect(
      await failureOf(
        authentication,
        sql`insert into rider_identity (id, phone, full_name, status, primary_hub_id) values (${randomUUID()}::uuid, ${riderPhone()}, 'x', 'ACTIVE', ${HUB_A}::uuid)`,
      ),
    ).toBe('42501');
    expect(
      await failureOf(authentication, sql`delete from rider_identity where id = ${inA.id}::uuid`),
    ).toBe('42501');
  });

  // Break caught: a staff context changing a rider through the lock it holds, or a PIN written by a context that is not the capability's.
  it('lets a staff context lock a rider and change none of it', async () => {
    const context = staff({ mode: 'ALL' }, 'staff.device.revoke');
    await built.service.transactionWithContext(context, async (tx) => {
      const locked = await tx.execute(
        sql`select id from rider_identity where id = ${inA.id}::uuid for no key update`,
      );
      expect(locked.rows).toHaveLength(1);
    });
    // The privilege exists (it lets the lock be taken); the policy's check refuses the write, and no row is changed.
    expect(
      await failureOf(
        context,
        sql`update rider_identity set failed_attempt_count = 0 where id = ${inA.id}::uuid`,
      ),
    ).toBe('42501');
  });
});

describe('the facts an act reads under the rider’s lock (melarc.rider_locked_facts)', () => {
  const locked = (context: SecurityContext, id: string) =>
    built.service.transactionWithContext(context, async (tx) => {
      const rows = (await tx.execute(sql`select * from melarc.rider_locked_facts(${id}::uuid)`))
        .rows;
      const bound = (
        await tx.execute(
          sql`select current_setting('melarc.locked_rider', true) as rider, current_setting('melarc.principal_type', true) as type`,
        )
      ).rows[0];
      return { rows, bound };
    });

  // Break caught: the rider read without its lock, the binding not set, or the caller's context left switched to the capability.
  it('locks a rider the caller’s scope shows, binds the transaction to it, gives the facts and puts the context back', async () => {
    const result = await locked(
      staff({ mode: 'SET', hubs: [HUB_A] }, 'staff.device.register'),
      inA.id,
    );
    expect(result.rows).toEqual([
      {
        rider_id: inA.id,
        status: 'ACTIVE',
        primary_hub_id: HUB_A,
        pin_established: false,
        credential_generation: 0,
        active_device_id: deviceOfA.id,
        active_devices: 1,
        revoked_devices: 0,
        replaced_devices: 0,
      },
    ]);
    expect(result.bound).toEqual({ rider: inA.id, type: 'STAFF' });
  });

  it('counts the device history of a rider and the PIN it holds', async () => {
    const rider = await insertRider(admin, riderRow({ pinHash: SOME_PIN_HASH }));
    await insertRiderDevice(admin, rider.id, { status: 'REPLACED' });
    await insertRiderDevice(admin, rider.id, { status: 'REVOKED' });
    const current = await insertRiderDevice(admin, rider.id);
    const result = await locked(staff({ mode: 'ALL' }, 'staff.device.reregister'), rider.id);
    expect(result.rows).toMatchObject([
      {
        pin_established: true,
        credential_generation: 1,
        active_device_id: current.id,
        active_devices: 1,
        revoked_devices: 1,
        replaced_devices: 1,
      },
    ]);
  });

  // Break caught: a rider outside the scope answered as one inside it, or as an error that tells it exists.
  it('answers a rider outside the scope, and one that does not exist, with no row and no binding', async () => {
    for (const id of [inB.id, randomUUID()]) {
      const result = await locked(staff({ mode: 'SET', hubs: [HUB_A] }, 'staff.device.revoke'), id);
      expect(result.rows).toEqual([]);
      expect(result.bound?.rider).toBe('');
    }
  });

  it('refuses another key, a rider, a vendor and the capability, and a read at REPEATABLE READ', async () => {
    for (const context of [
      staff({ mode: 'ALL' }, 'dispatch.read'),
      staff({ mode: 'ALL' }, null),
      riderOf(inA),
      vendor,
      authentication,
    ]) {
      expect(
        await failureOf(context, sql`select * from melarc.rider_locked_facts(${inA.id}::uuid)`),
      ).toBe('42501');
    }
    await expect(
      built.service.transactionWithContext(
        staff({ mode: 'ALL' }, 'staff.device.revoke'),
        (tx) => tx.execute(sql`select * from melarc.rider_locked_facts(${inA.id}::uuid)`),
        { isolation: 'REPEATABLE READ' },
      ),
    ).rejects.toMatchObject({});
  });
});

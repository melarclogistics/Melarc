import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import {
  RiderDeviceContextError,
  RiderDeviceStore,
} from '../../src/platform/auth/rider/rider-device-store.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { RIDER_CHALLENGE_NO_RIDER } from '../../src/platform/auth/rider/rider-challenge-binding.js';
import { withHandle } from './support/handle.js';
import { observe, type Observer } from './support/observe.js';
import { systemContext } from './support/rls-fixture.js';
import { deviceKey, insertRider, insertRiderDevice, riderRow } from './support/riders.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.57, the rider's registered devices as `completeRiderDeviceEnrolment` writes them (`platform/auth/rider/rider-device-store.ts`), against a
 * real PostgreSQL as the API's login under the authentication capability: a device is registered `ACTIVE` on the database's clock with the
 * canonical key and never read back with it, an `ACTIVE` device is ended as `REPLACED` and no other, a second `ACTIVE` device is refused by the
 * table whatever the store does, and the counts a decision needs are read in one place.
 */
let database: TestDatabase;
let api: BuiltService;
let admin: pg.Client;
let observer: Observer;
const store = new RiderDeviceStore({ clock: new SystemClock() });
const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  api = buildService(database, { poolMax: 4 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  observer = await observe(database);
});

afterAll(async () => {
  await admin.end();
  await observer.close();
  await api.close();
  await database.drop();
});

const inTransaction = <T>(
  work: (handle: TransactionHandle) => Promise<T>,
  context = authentication,
): Promise<T> => withHandle(api.service, context, (handle) => work(handle));

const rider = () => insertRider(admin, riderRow());
const deviceRow = (id: string) =>
  observer.one<{
    status: string;
    ended_at: Date | null;
    registered_by: string | null;
    registered_at: Date;
    now: Date;
    public_key: string;
  }>(
    `select status, ended_at, registered_by::text, registered_at, clock_timestamp() as now, public_key
       from registered_device where id = $1`,
    [id],
  );

describe('registering a rider’s device', () => {
  // Break caught: a device that is not ACTIVE, not bound to the rider, not of the rider kind, a key stored in another spelling, a moment that
  // is not the database's, or an authorising officer lost.
  it('inserts an ACTIVE device of the rider with the canonical key, on the database’s clock, and answers the record without the key', async () => {
    const owner = await rider();
    const officer = randomUUID();
    const key = deviceKey();

    const record = await inTransaction((handle) =>
      store.register(handle, {
        riderId: owner.id,
        publicKey: key.publicKey,
        registeredBy: officer,
      }),
    );

    expect(record).toMatchObject({
      principal_type: 'RIDER',
      principal_id: owner.id,
      device_kind: 'RIDER_ANDROID_KEYPAIR',
      status: 'ACTIVE',
      registered_by: officer,
    });
    expect(Object.keys(record).toSorted()).toEqual([
      'device_kind',
      'id',
      'principal_id',
      'principal_type',
      'registered_at',
      'registered_by',
      'status',
    ]);
    expect(JSON.stringify(record)).not.toContain(key.publicKey);
    const stored = await deviceRow(record.id);
    expect(stored).toMatchObject({
      status: 'ACTIVE',
      ended_at: null,
      registered_by: officer,
      public_key: key.publicKey,
    });
    // On the database's clock: a moment a few seconds of the database's own, not a process's.
    expect(
      Math.abs((stored?.now.getTime() ?? 0) - (stored?.registered_at.getTime() ?? 0)),
    ).toBeLessThan(10_000);
    expect(Date.parse(record.registered_at)).toBe(stored?.registered_at.getTime());
  });

  it('records no authorising officer where there was none', async () => {
    const owner = await rider();

    const record = await inTransaction((handle) =>
      store.register(handle, { riderId: owner.id, publicKey: deviceKey().publicKey }),
    );

    expect(record.registered_by).toBeNull();
  });

  // Break caught: a store that tidies a second ACTIVE device away, or the index that is the last word on "one ACTIVE device" missing.
  it('is refused by the table when the rider already has an ACTIVE device, and leaves that device as it was', async () => {
    const owner = await rider();
    const held = await insertRiderDevice(admin, owner.id);

    await expect(
      inTransaction((handle) =>
        store.register(handle, { riderId: owner.id, publicKey: deviceKey().publicKey }),
      ),
    ).rejects.toThrow();

    expect(
      await observer.rows<{ id: string; status: string }>(
        `select id, status from registered_device where rider_identity_id = $1`,
        [owner.id],
      ),
    ).toEqual([{ id: held.id, status: 'ACTIVE' }]);
  });

  // Break caught: a key the table would refuse reaching it (the refusal would then read as a database fault), and an identifier that is
  // not an identifier reaching a statement.
  it.each([
    ['a key that is not a canonical P-256 key', { publicKey: 'AAAA' }],
    ['a key with a spare bit set', { publicKey: `${deviceKey().publicKey.slice(0, 121)}B==` }],
    ['a rider that is not an identifier', { riderId: 'not-a-uuid' }],
    ['an officer that is not an identifier', { registeredBy: 'root' }],
  ] as const)('refuses %s before it writes anything', async (_label, bad) => {
    const owner = await rider();
    const before = await observer.count('registered_device');

    await expect(
      inTransaction((handle) =>
        store.register(handle, {
          riderId: owner.id,
          publicKey: deviceKey().publicKey,
          ...bad,
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(await observer.count('registered_device')).toBe(before);
  });
});

describe('replacing a rider’s device', () => {
  // Break caught: an ended device that is not REPLACED, an ending that is not on the database's clock, or a device that was not ACTIVE ended.
  it('ends the ACTIVE device of the rider as REPLACED, on the database’s clock', async () => {
    const owner = await rider();
    const device = await insertRiderDevice(admin, owner.id);

    const ended = await inTransaction((handle) => store.replace(handle, device.id, owner.id));

    expect(ended).toMatchObject({ id: device.id, status: 'REPLACED', principal_id: owner.id });
    const stored = await deviceRow(device.id);
    expect(stored?.status).toBe('REPLACED');
    expect(stored?.ended_at).not.toBeNull();
    expect(
      Math.abs((stored?.now.getTime() ?? 0) - (stored?.ended_at?.getTime() ?? 0)),
    ).toBeLessThan(10_000);
  });

  // Break caught: a device ended that is another rider's, one that was revoked (REVOKED never becomes REPLACED), one that was already
  // replaced, or an id that names nothing.
  it('ends nothing and answers null for another rider’s device, a revoked or replaced one, and an unknown id', async () => {
    const owner = await rider();
    const other = await rider();
    const theirs = await insertRiderDevice(admin, other.id);
    const revoked = await insertRiderDevice(admin, owner.id, { status: 'REVOKED' });
    const replaced = await insertRiderDevice(admin, owner.id, { status: 'REPLACED' });

    for (const [id, riderId] of [
      [theirs.id, owner.id],
      [revoked.id, owner.id],
      [replaced.id, owner.id],
      [randomUUID(), owner.id],
      ['not-a-uuid', owner.id],
    ] as const) {
      expect(await inTransaction((handle) => store.replace(handle, id, riderId))).toBeNull();
    }

    expect((await deviceRow(theirs.id))?.status).toBe('ACTIVE');
    expect((await deviceRow(revoked.id))?.status).toBe('REVOKED');
    expect((await deviceRow(replaced.id))?.status).toBe('REPLACED');
  });
});

describe('what a decision about a rider’s devices needs', () => {
  // Break caught: a count that mixes the states (the first binding is refused for an ACTIVE or a REVOKED device and a replacement needs one),
  // or the rider's devices mixed with another's.
  it('counts the devices of the rider by state, and names the ACTIVE one', async () => {
    const owner = await rider();
    const other = await rider();
    await insertRiderDevice(admin, other.id);
    await insertRiderDevice(admin, owner.id, { status: 'REVOKED' });
    await insertRiderDevice(admin, owner.id, { status: 'REPLACED' });
    await insertRiderDevice(admin, owner.id, { status: 'REPLACED' });
    const active = await insertRiderDevice(admin, owner.id);

    const empty = await rider();
    const facts = await inTransaction((handle) => store.factsFor(handle, owner.id));
    const none = await inTransaction((handle) => store.factsFor(handle, empty.id));

    expect(facts).toEqual({ activeDeviceId: active.id, revokedDevices: 1, replacedDevices: 2 });
    expect(none).toEqual({ activeDeviceId: null, revokedDevices: 0, replacedDevices: 0 });
  });
});

describe('what the sign-in verifies a signature against (S0.59)', () => {
  // Break caught: a key read for a device that is not the rider's ACTIVE one (a revoked or replaced handset still able to sign in), or for
  // another rider, or a rider with no key answered as an error and so told apart from an unknown identifier.
  it('answers the key of the ACTIVE device of the rider and of no other device, and null for a rider with none or an identifier that names none', async () => {
    const owner = await rider();
    const other = await rider();
    await insertRiderDevice(admin, owner.id, { status: 'REVOKED' });
    await insertRiderDevice(admin, owner.id, { status: 'REPLACED' });
    const active = await insertRiderDevice(admin, owner.id);
    const theirs = await insertRiderDevice(admin, other.id);
    const without = await rider();

    const mine = await inTransaction((handle) => store.activeKeyFor(handle, owner.id));
    const alike = await inTransaction((handle) => store.activeKeyFor(handle, other.id));
    const none = await inTransaction((handle) => store.activeKeyFor(handle, without.id));
    const unknown = await inTransaction((handle) =>
      store.activeKeyFor(handle, RIDER_CHALLENGE_NO_RIDER),
    );

    expect(mine).toEqual({ deviceId: active.id, publicKey: active.key.publicKey });
    expect(alike).toEqual({ deviceId: theirs.id, publicKey: theirs.key.publicKey });
    expect(none).toBeNull();
    expect(unknown).toBeNull();
  });

  // Break caught: a session issued on a device that was revoked or replaced while the sign-in was in flight, or on another rider's device.
  it('tells whether a device is still an ACTIVE device of that rider', async () => {
    const owner = await rider();
    const other = await rider();
    const active = await insertRiderDevice(admin, owner.id);
    const revoked = await insertRiderDevice(admin, owner.id, { status: 'REVOKED' });

    const answers = await inTransaction(async (handle) => ({
      active: await store.isActiveFor(handle, active.id, owner.id),
      revoked: await store.isActiveFor(handle, revoked.id, owner.id),
      anotherRider: await store.isActiveFor(handle, active.id, other.id),
      unknown: await store.isActiveFor(handle, randomUUID(), owner.id),
      notAnId: await store.isActiveFor(handle, 'not-a-uuid', owner.id),
    }));

    expect(answers).toEqual({
      active: true,
      revoked: false,
      anotherRider: false,
      unknown: false,
      notAnId: false,
    });
  });
});

describe('the store', () => {
  // Break caught: a method added without the context check, or a method that lists or scans devices across riders.
  it('offers five acts, each for one rider, and refuses every context but the authentication capability’s', async () => {
    const owner = await rider();
    const methods = Object.getOwnPropertyNames(RiderDeviceStore.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods.toSorted()).toEqual([
      'activeKeyFor',
      'factsFor',
      'isActiveFor',
      'register',
      'replace',
    ]);

    const wrong = [
      systemContext('rate_limit'),
      {
        principalType: 'STAFF',
        principalId: randomUUID(),
        surface: 'OPS_PORTAL',
        correlationId: 'store-test',
      } as const,
    ];
    for (const context of wrong) {
      const calls: readonly ((handle: TransactionHandle) => Promise<unknown>)[] = [
        (handle) => store.register(handle, { riderId: owner.id, publicKey: deviceKey().publicKey }),
        (handle) => store.replace(handle, randomUUID(), owner.id),
        (handle) => store.factsFor(handle, owner.id),
        (handle) => store.activeKeyFor(handle, owner.id),
        (handle) => store.isActiveFor(handle, randomUUID(), owner.id),
      ];
      for (const call of calls) {
        await expect(inTransaction((handle) => call(handle), context)).rejects.toBeInstanceOf(
          RiderDeviceContextError,
        );
      }
    }
  });
});

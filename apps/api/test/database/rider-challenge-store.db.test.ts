import { createHash, randomBytes } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import {
  deviceContextBinding,
  phoneBinding,
  riderChallengeAudience,
  RIDER_CHALLENGE_NO_RIDER,
  sameBinding,
} from '../../src/platform/auth/rider/rider-challenge-binding.js';
import {
  RiderChallengeContextError,
  RiderChallengeExpiredError,
  RiderChallengeRequestError,
} from '../../src/platform/auth/rider/rider-challenge-errors.js';
import {
  RiderChallengeStore,
  type IssueRiderChallengeRequest,
} from '../../src/platform/auth/rider/rider-challenge-store.js';
import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { withHandle } from './support/handle.js';
import { insertRider, riderRow, type RiderRow } from './support/riders.js';
import { staffContext, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.59a, the store of the rider's sign-in challenges (`platform/auth/rider/`), against a real PostgreSQL as the API's login under the
 * authentication capability: a challenge is issued `PENDING` for a rider or for a number that matched none, lives for the lifetime it is given
 * on the database's clock, is found by the hash of its nonce and by nothing else, and is ended once. The request that issues one and the
 * sign-in that spends it are the operations' own tests.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let store: RiderChallengeStore;
const clock = new ManualClock();
const authentication = systemContext('authentication');
const AUDIENCE = riderChallengeAudience('local');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  // The race of a challenge that lapses during a wait for a lock ends when the database's clock says so: the lock bound is lengthened for this
  // service alone, and the bounds of production are untouched.
  api = buildService(database, {
    poolMax: 4,
    deadlines: {
      ...INERT_DEADLINES,
      lockTimeoutMs: 10_000,
      statementTimeoutMs: 12_000,
      transactionTimeoutMs: 15_000,
    },
  });
  store = new RiderChallengeStore({ clock });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await database.drop();
});

const inTransaction = <T>(
  action: (handle: TransactionHandle) => Promise<T>,
  context = authentication,
): Promise<T> => withHandle(api.service, context, (handle) => action(handle));

const rider = (overrides: Partial<RiderRow> = {}): Promise<RiderRow> =>
  insertRider(admin, riderRow(overrides));

const hashOf = (): Buffer => createHash('sha256').update(randomBytes(32)).digest();

function request(
  overrides: Partial<IssueRiderChallengeRequest> = {},
): IssueRiderChallengeRequest & { readonly nonceHash: Buffer } {
  return {
    riderId: null,
    nonceHash: hashOf(),
    phoneHash: phoneBinding('+99900000001'),
    deviceContextHash: null,
    audience: AUDIENCE,
    ttlMinutes: 5,
    ...overrides,
  } as IssueRiderChallengeRequest & { readonly nonceHash: Buffer };
}

const issue = (overrides: Partial<IssueRiderChallengeRequest> = {}) =>
  inTransaction((handle) => store.issue(handle, request(overrides)));

const rowOf = async (id: string) =>
  (
    await admin.query<{
      state: string;
      rider_identity_id: string | null;
      issued_at: Date;
      expires_at: Date;
      purpose: string;
      audience: string;
      device_context_hash: Buffer | null;
    }>(
      `select state, rider_identity_id, issued_at, expires_at, purpose, audience, device_context_hash
         from rider_sign_in_challenge where id = $1`,
      [id],
    )
  ).rows[0];

describe('issue', () => {
  // Break caught: a challenge issued in any state but PENDING, for another rider, or with another purpose than the sign-in's.
  it('issues a PENDING challenge for the rider, bound to the number, the service and the device', async () => {
    const owner = await rider();
    const context = deviceContextBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f');

    const issued = await issue({ riderId: owner.id, deviceContextHash: context });

    expect(issued.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(await rowOf(issued.id)).toMatchObject({
      state: 'PENDING',
      rider_identity_id: owner.id,
      purpose: 'RIDER_SIGN_IN',
      audience: AUDIENCE,
    });
    expect((await rowOf(issued.id))?.device_context_hash?.equals(context)).toBe(true);
  });

  // Break caught (§6.8: "a number that matched no rider … null"): a challenge for a number nobody holds that is not stored, or stored with
  // a rider, a device or a state that would tell it from any other.
  it('issues the same challenge for a number that matched no rider: no rider, no device context', async () => {
    const issued = await issue({ riderId: null });

    expect(await rowOf(issued.id)).toMatchObject({
      state: 'PENDING',
      rider_identity_id: null,
      device_context_hash: null,
      purpose: 'RIDER_SIGN_IN',
      audience: AUDIENCE,
    });
  });

  // Break caught (settings.md: `authentication_challenge_ttl_minutes`, 5): a lifetime read from the application's clock (a ManualClock that
  // is days behind the database's here), or one that is not the lifetime it was given.
  it('lives for the lifetime it is given, from the database’s clock and not the application’s', async () => {
    const databaseBefore = (await admin.query<{ now: Date }>('select clock_timestamp() as now'))
      .rows[0]?.now;

    const issued = await issue({ ttlMinutes: 7 });

    const row = await rowOf(issued.id);
    expect(row === undefined ? 0 : row.expires_at.getTime() - row.issued_at.getTime()).toBe(
      7 * 60_000,
    );
    expect(issued.expiresAt.getTime()).toBe(row?.expires_at.getTime());
    expect(
      Math.abs((row?.issued_at.getTime() ?? 0) - (databaseBefore?.getTime() ?? 0)),
    ).toBeLessThan(10_000);
    expect(Math.abs((row?.issued_at.getTime() ?? 0) - clock.now().getTime())).toBeGreaterThan(
      60_000,
    );
  });

  // Break caught: a second challenge that ends the first (a stranger who knows a number taking a rider's pending challenge away).
  it('ends no other challenge: a rider may hold several, each good for one presentation', async () => {
    const owner = await rider();
    const first = await issue({ riderId: owner.id });
    const second = await issue({ riderId: owner.id });

    expect((await rowOf(first.id))?.state).toBe('PENDING');
    expect((await rowOf(second.id))?.state).toBe('PENDING');
  });

  // Break caught: a request the store acts on though it names a rider that is not there, a hash of the wrong size, a device with no rider,
  // an audience nobody can compare, or a lifetime that is not a positive whole number of minutes.
  it('refuses a request it cannot act on, before anything is written', async () => {
    const owner = await rider();
    const before = (
      await admin.query<{ n: string }>('select count(*) as n from rider_sign_in_challenge')
    ).rows[0]?.n;
    const bad: [string, Partial<IssueRiderChallengeRequest>][] = [
      ['riderId', { riderId: 'not-a-uuid' }],
      ['nonceHash', { nonceHash: randomBytes(31) }],
      ['phoneHash', { phoneHash: randomBytes(33) }],
      ['deviceContextHash', { riderId: owner.id, deviceContextHash: randomBytes(16) }],
      ['deviceContextHash', { riderId: null, deviceContextHash: hashOf() }],
      ['audience', { audience: '' }],
      ['audience', { audience: 'a'.repeat(129) }],
      ['ttlMinutes', { ttlMinutes: 0 }],
      ['ttlMinutes', { ttlMinutes: 1.5 }],
    ];

    for (const [field, overrides] of bad) {
      await expect(issue(overrides), JSON.stringify(overrides)).rejects.toSatisfy(
        (error) => error instanceof RiderChallengeRequestError && error.field === field,
      );
    }
    expect(
      (await admin.query<{ n: string }>('select count(*) as n from rider_sign_in_challenge'))
        .rows[0]?.n,
    ).toBe(before);
  });

  it('refuses a rider that does not exist: the database holds the foreign key', async () => {
    await expect(issue({ riderId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })).rejects.toSatisfy(
      (error) => serverErrorIn(error)?.code === '23503',
    );
  });

  // Break caught: a nonce kept twice (a presentation that finds two rows, or consumes one and leaves the other).
  it('refuses a second challenge for one nonce hash', async () => {
    const nonceHash = hashOf();
    await issue({ nonceHash });

    await expect(issue({ nonceHash })).rejects.toSatisfy(
      (error) => serverErrorIn(error)?.code === '23505',
    );
  });
});

describe('findByNonceHash', () => {
  // Break caught: a lookup that finds a challenge by anything but the hash of its nonce, or that returns a hash or a nonce it should not.
  it('finds the challenge a nonce hash names, and none for a hash that names none', async () => {
    const owner = await rider();
    const nonceHash = hashOf();
    const phone = phoneBinding('+99900000042');
    const context = deviceContextBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f');
    const issued = await issue({
      riderId: owner.id,
      nonceHash,
      phoneHash: phone,
      deviceContextHash: context,
    });

    const found = await inTransaction((handle) => store.findByNonceHash(handle, nonceHash));
    const absent = await inTransaction((handle) => store.findByNonceHash(handle, hashOf()));

    expect(absent).toBeNull();
    expect(found?.expired).toBe(false);
    expect(found?.challenge).toMatchObject({
      id: issued.id,
      riderIdentityId: owner.id,
      state: 'PENDING',
      purpose: 'RIDER_SIGN_IN',
      audience: AUDIENCE,
    });
    expect(sameBinding(found?.challenge.phoneHash ?? null, phone)).toBe(true);
    expect(sameBinding(found?.challenge.deviceContextHash ?? null, context)).toBe(true);
    expect(Object.keys(found?.challenge ?? {}).some((key) => /nonce/i.test(key))).toBe(false);
  });

  // Break caught: a lookup that judges the time on the application's clock, or never says that a challenge has lapsed.
  it('says on the database’s clock whether the time of the challenge has passed', async () => {
    const nonceHash = hashOf();
    const issued = await issue({ nonceHash });
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1`,
      [issued.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );

    const found = await inTransaction((handle) => store.findByNonceHash(handle, nonceHash));

    expect(found).toMatchObject({ expired: true, challenge: { id: issued.id, state: 'PENDING' } });
  });

  it('refuses a hash that is not 32 bytes', async () => {
    await expect(
      inTransaction((handle) => store.findByNonceHash(handle, randomBytes(31))),
    ).rejects.toBeInstanceOf(RiderChallengeRequestError);
  });
});

describe('lockForDecision', () => {
  // Break caught: a decision made on a time from before the wait for the lock; the clock is read after it.
  it('judges the time of a challenge on the database’s clock, read after the lock', async () => {
    const live = await issue({});
    const lapsed = await issue({});
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1`,
      [lapsed.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );

    const first = await inTransaction((handle) => store.lockForDecision(handle, live.id));
    const second = await inTransaction((handle) => store.lockForDecision(handle, lapsed.id));
    const absent = await inTransaction((handle) =>
      store.lockForDecision(handle, RIDER_CHALLENGE_NO_RIDER),
    );

    expect(first).toMatchObject({ expired: false, challenge: { state: 'PENDING' } });
    expect(second).toMatchObject({ expired: true, challenge: { state: 'PENDING' } });
    expect(absent).toBeNull();
  });

  // Break caught: a lock that does not hold: two decisions of one challenge each reading it PENDING and each consuming it.
  it('holds the row until the transaction ends: a second decision waits and then finds the first one’s outcome', async () => {
    const issued = await issue({});
    const outcomes: string[] = [];
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from rider_sign_in_challenge where id = $1 for no key update`, [
        issued.id,
      ]);
      const rival = inTransaction(async (handle) => {
        const decided = await store.lockForDecision(handle, issued.id);
        outcomes.push(`rival saw ${decided?.challenge.state ?? 'nothing'}`);
      });
      // The rival is waiting for the row lock while the holder consumes the challenge; it proceeds when the holder commits.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(outcomes).toEqual([]);
      await holder.query(`update rider_sign_in_challenge set state = 'CONSUMED' where id = $1`, [
        issued.id,
      ]);
      outcomes.push('holder consumed');
      await holder.query('commit');
      await rival;
    } finally {
      await holder.end();
    }

    expect(outcomes).toEqual(['holder consumed', 'rival saw CONSUMED']);
  });

  // Break caught (the mutation run of 27 October 2026): the time of the decision read in the statement that takes the lock. A holder that
  // leaves the row unchanged lets such a statement go on with the time it read before the wait, so that a challenge that lapsed during the wait
  // is judged live. The time is read in the next statement, after the lock is granted.
  it('reads the time after the lock is granted: a challenge that lapses during the wait is expired', async () => {
    const issued = await issue({ ttlMinutes: 1 });
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 seconds', expires_at = now() + interval '1500 milliseconds' where id = $1`,
      [issued.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from rider_sign_in_challenge where id = $1 for no key update`, [
        issued.id,
      ]);
      const deciding = inTransaction((handle) => store.lockForDecision(handle, issued.id));
      // The time passes while the decision waits, and the holder lets go with the row exactly as it was.
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      await holder.query('commit');

      expect(await deciding).toMatchObject({ expired: true, challenge: { state: 'PENDING' } });
    } finally {
      await holder.end();
    }
  });
});

describe('consume', () => {
  // Break caught: a challenge that survives a presentation, or a consumption that succeeds twice.
  it('consumes a live challenge once: true for the request that did and false for any other', async () => {
    const issued = await issue({});

    const first = await inTransaction((handle) => store.consume(handle, issued.id));
    const second = await inTransaction((handle) => store.consume(handle, issued.id));

    expect([first, second]).toEqual([true, false]);
    expect((await rowOf(issued.id))?.state).toBe('CONSUMED');
  });

  // Break caught: two requests in parallel each told they consumed it (a signature accepted twice).
  it('has one winner among parallel consumptions', async () => {
    const issued = await issue({});

    const results = await Promise.all(
      Array.from({ length: 4 }, () => inTransaction((handle) => store.consume(handle, issued.id))),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  // Break caught: an expired challenge consumed, or its lapse reported as anything but the one typed expiry.
  it('does not consume a challenge past its time, and says so as false', async () => {
    const lapsed = await issue({});
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1`,
      [lapsed.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );

    expect(await inTransaction((handle) => store.consume(handle, lapsed.id))).toBe(false);
    expect((await rowOf(lapsed.id))?.state).toBe('PENDING');
  });

  // Break caught (migration 0021's convention): a lapse during a wait for a lock, reported as a defect, or swallowed and the challenge
  // consumed after its time.
  it('raises the typed expiry when the challenge lapses during the wait for a lock', async () => {
    const issued = await issue({ ttlMinutes: 1 });
    // The statement's own `where` judges the time before the wait and the guard after it: a holder that keeps the row until after the
    // time has passed, leaving it unchanged, makes the guard the one that refuses.
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 seconds', expires_at = now() + interval '1500 milliseconds' where id = $1`,
      [issued.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select id from rider_sign_in_challenge where id = $1 for no key update`, [
        issued.id,
      ]);
      const consuming = inTransaction((handle) => store.consume(handle, issued.id));
      const settled = consuming.then(
        () => 'consumed' as const,
        (error: unknown) =>
          error instanceof RiderChallengeExpiredError ? 'expired' : String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      await holder.query('commit');

      expect(await settled).toBe('expired');
      expect((await rowOf(issued.id))?.state).toBe('PENDING');
    } finally {
      await holder.end();
    }
  });

  // Break caught (the mutation run of 27 October 2026): every failure of the consumption reported as an expiry, which would answer a defect of the
  // database (a refusal that states no reason, a lost commit) as a sign-in that merely lapsed. Only the reason the guard states is the expiry.
  it('rethrows any other failure of a consumption as it was, and not as an expiry', async () => {
    const issued = await issue({});
    await admin.query(
      `create function melarc.zz_refuses() returns trigger language plpgsql as $$ begin raise exception 'a refusal that states no reason' using errcode = '23514'; end $$`,
    );
    await admin.query(
      `create trigger zz_refuses before update on rider_sign_in_challenge for each row execute function melarc.zz_refuses()`,
    );
    try {
      const failure = await inTransaction((handle) => store.consume(handle, issued.id)).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(RiderChallengeExpiredError);
      expect(serverErrorIn(failure)?.code).toBe('23514');
    } finally {
      await admin.query(`drop trigger zz_refuses on rider_sign_in_challenge`);
      await admin.query(`drop function melarc.zz_refuses()`);
    }
    expect((await rowOf(issued.id))?.state).toBe('PENDING');
  });
});

describe('end', () => {
  // Break caught: a binding that does not hold leaving the challenge usable, or a lapse recorded before the time has passed.
  it('ends a PENDING challenge as UNUSABLE at once, and as EXPIRED only after its time', async () => {
    const unusable = await issue({});
    const early = await issue({});
    const lapsed = await issue({});
    await admin.query(
      `alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard`,
    );
    await admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes' where id = $1`,
      [lapsed.id],
    );
    await admin.query(
      `alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard`,
    );

    const results = await inTransaction(async (handle) => ({
      unusable: await store.end(handle, unusable.id, 'UNUSABLE'),
      early: await store.end(handle, early.id, 'EXPIRED'),
      lapsed: await store.end(handle, lapsed.id, 'EXPIRED'),
    }));

    expect(results).toEqual({ unusable: true, early: false, lapsed: true });
    expect((await rowOf(unusable.id))?.state).toBe('UNUSABLE');
    expect((await rowOf(early.id))?.state).toBe('PENDING');
    expect((await rowOf(lapsed.id))?.state).toBe('EXPIRED');
  });

  // Break caught: a terminal challenge ended again (a consumed one made unusable, which would rewrite the history of a sign-in).
  it('ends nothing that is not PENDING', async () => {
    const issued = await issue({});
    await inTransaction((handle) => store.consume(handle, issued.id));

    expect(await inTransaction((handle) => store.end(handle, issued.id, 'UNUSABLE'))).toBe(false);
    expect((await rowOf(issued.id))?.state).toBe('CONSUMED');
  });
});

describe('the context', () => {
  // Break caught: a store that answers "no challenge" to a caller that is not the authentication capability, which reads as an absence.
  it('refuses every method outside the authentication capability, before a table is touched', async () => {
    const issued = await issue({});
    const outside = [staffContext([]), systemContext('rate_limit')];

    const actions: readonly ((handle: TransactionHandle) => Promise<unknown>)[] = [
      (handle) => store.issue(handle, request()),
      (handle) => store.findByNonceHash(handle, hashOf()),
      (handle) => store.lockForDecision(handle, issued.id),
      (handle) => store.consume(handle, issued.id),
      (handle) => store.end(handle, issued.id, 'UNUSABLE'),
    ];
    for (const context of outside) {
      for (const action of actions) {
        await expect(inTransaction(action, context)).rejects.toBeInstanceOf(
          RiderChallengeContextError,
        );
      }
    }
  });
});

describe('the bindings', () => {
  // Break caught: a binding that is not a digest of the canonical text under its own namespace, so that a phone and a device that read
  // alike, or a digest made for another purpose, compare equal.
  it('are 32-byte digests of different namespaces that compare in constant time', () => {
    const phone = phoneBinding('+99900000001');
    const device = deviceContextBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f');

    expect(phone).toHaveLength(32);
    expect(device).toHaveLength(32);
    expect(sameBinding(phone, phoneBinding('+99900000001'))).toBe(true);
    expect(sameBinding(phone, phoneBinding('+99900000002'))).toBe(false);
    expect(
      sameBinding(
        phoneBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f'),
        deviceContextBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f'),
      ),
    ).toBe(false);
    expect(
      sameBinding(
        deviceContextBinding('4F1D3C7E-1B2A-4C5D-8E9F-0A1B2C3D4E5F'),
        deviceContextBinding('4f1d3c7e-1b2a-4c5d-8e9f-0a1b2c3d4e5f'),
      ),
    ).toBe(true);
    expect(sameBinding(null, null)).toBe(true);
    expect(sameBinding(null, phone)).toBe(false);
    expect(sameBinding(phone, null)).toBe(false);
    expect(sameBinding(phone, phone.subarray(0, 31))).toBe(false);
  });

  it('name the environment of the service', () => {
    expect(riderChallengeAudience('production')).toBe('melarc-api/production');
    expect(riderChallengeAudience('local')).not.toBe(riderChallengeAudience('staging'));
  });
});

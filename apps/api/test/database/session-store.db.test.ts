import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BundleSnapshot,
  NewSession,
  StoredSession,
} from '../../src/platform/auth/ports/session-store.port.js';
import { PostgresSessionStore } from '../../src/platform/auth/sessions/postgres.session-store.adapter.js';
import { SessionSnapshotUnreadableError } from '../../src/platform/auth/sessions/session-errors.js';
import { INERT_DEADLINES } from '../../src/platform/config/inert-config.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from './support/admin.js';
import { hashOf } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { HUB_A, HUB_B, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.24, the session store (`SessionStore` over PostgreSQL) against a real PostgreSQL, as `melarc_api_runtime` under the
 * `authentication` capability: what it writes and reads back, the activity it coalesces, and the sessions it ends (by session, by
 * principal, by bundle) and the reasons it keeps. Time is the database's: the rows are aged by changing the data.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: Admin;
let observer: Observer;
let unitOfWork: PostgresUnitOfWork;
const store = new PostgresSessionStore(new ManualClock(new Date()));

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 2 });
  admin = await openAdmin(database);
  observer = await observe(database);
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.close();
  await observer.close();
  await built.close();
  await database.drop();
});

const SNAPSHOT: BundleSnapshot = {
  format: 1,
  name: 'Senior Ops',
  audience: 'STAFF',
  privileged: true,
  grants: [
    { permission: 'pickup.read', hubScope: 'own', ownershipScope: 'any', tier: 'S' },
    { permission: 'staff.read', hubScope: 'all', ownershipScope: 'any', tier: null },
  ],
};

/** A browser session (staff, vendor) holds the hash of its synchronizer token and a rider's session none, as the table requires. */
function newSession(overrides: Partial<NewSession> = {}): NewSession {
  const issuedAt = new Date(Date.now() - 1_000);
  return {
    principalType: 'STAFF',
    principalId: randomUUID(),
    tokenHash: hashOf(randomUUID()),
    ...(overrides.principalType === 'RIDER' ? {} : { csrfTokenHash: hashOf(randomUUID()) }),
    authority: {
      bundleId: BUNDLE_IDS.seniorOps,
      bundleRevision: 1,
      policyRevision: null,
      snapshot: SNAPSHOT,
      authorizedHubIds: [HUB_A, HUB_B],
    },
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 8 * 60 * 60_000),
    ...overrides,
  };
}

const create = (session: NewSession): Promise<StoredSession> =>
  unitOfWork.run(systemContext('authentication'), (handle) => store.create(handle, session));
const find = (hash: Uint8Array): Promise<StoredSession | null> =>
  unitOfWork.run(systemContext('authentication'), (handle) => store.findByTokenHash(handle, hash));
const activity = (id: string, idleMinutes: number | null = 30): Promise<boolean> =>
  unitOfWork.run(systemContext('authentication'), (handle) =>
    store.recordActivity(handle, id, idleMinutes),
  );
const terminate = (
  selector: Parameters<PostgresSessionStore['terminate']>[1],
  reason: Parameters<PostgresSessionStore['terminate']>[2] = 'ADMIN_REVOKED',
): Promise<number> =>
  unitOfWork.run(
    systemContext('authentication'),
    async (handle) => (await store.terminate(handle, selector, reason)).length,
  );

const rowOf = async (id: string) =>
  observer.one<{
    terminated_at: Date | null;
    termination_reason: string | null;
    last_activity_at: Date;
  }>(`select terminated_at, termination_reason, last_activity_at from session where id = $1`, [id]);

describe('create', () => {
  // Break caught: the authority a session was issued with not being what is stored (the bundle, its revision, its content, its hubs),
  // so that authorization would later read something other than what the person was given.
  it('stores the authority it was given and returns the session as stored', async () => {
    const given = newSession({ authority: { ...newSession().authority, bundleRevision: 4 } });

    const stored = await create(given);

    expect(stored).toMatchObject({
      principalType: 'STAFF',
      principalId: given.principalId,
      state: 'ACTIVE',
      terminatedAt: null,
      terminationReason: null,
      registeredDeviceId: null,
      clientRootSignal: null,
    });
    expect(
      Buffer.from(stored.csrfTokenHash ?? []).equals(given.csrfTokenHash ?? Buffer.alloc(0)),
    ).toBe(true);
    expect(stored.authority).toEqual(given.authority);
    expect(stored.issuedAt).toEqual(given.issuedAt);
    expect(stored.expiresAt).toEqual(given.expiresAt);
    expect(stored.lastActivityAt).toEqual(given.issuedAt);
    expect(stored.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const row = await observer.one<{ bundle_revision: number; bundle_snapshot: BundleSnapshot }>(
      `select bundle_revision, bundle_snapshot from session where id = $1`,
      [stored.id],
    );
    expect(row?.bundle_revision).toBe(4);
    expect(row?.bundle_snapshot).toEqual(SNAPSHOT);
  });

  // Break caught: the token kept in a readable form. Only the hash it was given is stored.
  it('stores the hash it was given and nothing from which the token could be read', async () => {
    const hash = hashOf('a token');
    const stored = await create(newSession({ tokenHash: hash }));

    const row = await observer.one<{ token_hash: Buffer; row: string }>(
      `select token_hash, s::text as row from session s where id = $1`,
      [stored.id],
    );
    expect(row?.token_hash.equals(hash)).toBe(true);
    expect(row?.row).not.toContain('a token');
  });

  it('keeps the device, the root signal and the synchronizer token of a vendor or a rider session', async () => {
    const device = randomUUID();
    const csrf = hashOf('csrf');

    const vendor = await create(
      newSession({
        principalType: 'VENDOR',
        registeredDeviceId: device,
        csrfTokenHash: csrf,
        authority: { ...newSession().authority, policyRevision: 3 },
      }),
    );
    const rider = await create(
      newSession({
        principalType: 'RIDER',
        registeredDeviceId: device,
        clientRootSignal: 'DETECTED',
        authority: { ...newSession().authority, policyRevision: 2 },
      }),
    );

    expect(vendor.registeredDeviceId).toBe(device);
    expect(Buffer.from(vendor.csrfTokenHash ?? []).equals(csrf)).toBe(true);
    expect(vendor.authority.policyRevision).toBe(3);
    expect(rider.clientRootSignal).toBe('DETECTED');
    expect(rider.csrfTokenHash).toBeNull();
  });
});

describe('findByTokenHash', () => {
  // Break caught: a session looked up by anything but the hash of what was presented, or a miss reported as a session.
  it('finds a session by the hash of its token, and a hash nobody holds finds nothing', async () => {
    const given = newSession();
    const created = await create(given);
    await create(newSession());

    expect((await find(given.tokenHash))?.id).toBe(created.id);
    expect(await find(hashOf(randomUUID()))).toBeNull();
  });

  // Break caught: an ended session hidden from the lookup, so that a refused request could not be told from an unknown token and
  // the vendor who was displaced could not be told it was displaced (SESSION_SUPERSEDED).
  it('returns an ended session with the reason it ended', async () => {
    const given = newSession({ principalType: 'VENDOR', registeredDeviceId: randomUUID() });
    const created = await create({
      ...given,
      authority: { ...given.authority, policyRevision: 1 },
    });
    await terminate({ by: 'session', sessionId: created.id }, 'SUPERSEDED_BY_NEW_LOGIN');

    const found = await find(given.tokenHash);

    expect(found?.state).toBe('TERMINATED');
    expect(found?.terminationReason).toBe('SUPERSEDED_BY_NEW_LOGIN');
    expect(found?.terminatedAt).toBeInstanceOf(Date);
  });

  // Break caught: a snapshot of a format this build does not know being read as if it were of the one it does. A session it cannot
  // read is not trusted, and is not guessed at.
  it('refuses a snapshot of a format it does not know', async () => {
    await admin.query(
      `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                            token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
       values ($1, 'STAFF', $2, '{"format":2}'::jsonb, $3, 1, '{}', $4, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`,
      [randomUUID(), randomUUID(), BUNDLE_IDS.seniorOps, hashOf('future')],
    );

    await expect(find(hashOf('future'))).rejects.toBeInstanceOf(SessionSnapshotUnreadableError);
  });

  // Break caught: only the shape of the snapshot checked and not its format, so that a snapshot of a newer format that happens to look
  // like this one is read as this one. The body below is exactly the shape of format 1, and only the number differs.
  it('refuses a snapshot of the right shape and another format', async () => {
    await admin.query(
      `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                            token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
       values ($1, 'STAFF', $2, $3::jsonb, $4, 1, '{}', $5, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({ ...SNAPSHOT, format: 2 }),
        BUNDLE_IDS.seniorOps,
        hashOf('future-shaped'),
      ],
    );

    await expect(find(hashOf('future-shaped'))).rejects.toBeInstanceOf(
      SessionSnapshotUnreadableError,
    );
  });

  // Break caught: a snapshot that names a grant the format does not allow (a scope that is not one of the three) read as authority.
  it('refuses a snapshot of the right format whose body is not the shape of it', async () => {
    await admin.query(
      `insert into session (id, principal_type, principal_id, bundle_snapshot, bundle_id, bundle_revision, authorized_hub_ids,
                            token_hash, csrf_token_hash, issued_at, expires_at, last_activity_at)
       values ($1, 'STAFF', $2, $3::jsonb, $4, 1, '{}', $5, decode(repeat('ab', 32), 'hex'), now(), now() + interval '1 hour', now())`,
      [
        randomUUID(),
        randomUUID(),
        JSON.stringify({
          ...SNAPSHOT,
          grants: [
            { permission: 'staff.read', hubScope: 'everywhere', ownershipScope: 'any', tier: null },
          ],
        }),
        BUNDLE_IDS.seniorOps,
        hashOf('odd-grant'),
      ],
    );

    await expect(find(hashOf('odd-grant'))).rejects.toBeInstanceOf(SessionSnapshotUnreadableError);
  });
});

describe('recordActivity', () => {
  /**
   * Lets `minutes` pass for a session, by changing the data (the database's clock is the one that judges): its issue, its recorded
   * activity and its absolute end all move back together. The table's guard trigger forbids this to the application, and rightly,
   * so it is switched off for the one statement, as the kit does for the other tables whose guards forbid ageing.
   */
  const age = async (id: string, minutes: number) => {
    await admin.query('alter table session disable trigger session_guard');
    try {
      await admin.query(
        `update session set issued_at = issued_at - make_interval(mins => $2),
                            last_activity_at = last_activity_at - make_interval(mins => $2),
                            expires_at = expires_at - make_interval(mins => $2) where id = $1`,
        [id, minutes],
      );
    } finally {
      await admin.query('alter table session enable trigger session_guard');
    }
  };
  /** A session issued a moment ago, with eight hours to run: live on every count until it is aged. */
  const live = async (): Promise<StoredSession> => {
    const issuedAt = new Date(Date.now() - 1_000);
    return create(
      newSession({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 8 * 3_600_000) }),
    );
  };

  // Break caught: a write per request, which a burst of requests would turn into a burst of updates on one row.
  it('writes once for a burst, and again once the recorded activity is old enough', async () => {
    const stored = await live();
    await age(stored.id, 10);
    const aged = (await rowOf(stored.id))?.last_activity_at.getTime() ?? 0;

    expect(await activity(stored.id)).toBe(true);
    const first = (await rowOf(stored.id))?.last_activity_at.getTime() ?? 0;
    expect(first).toBeGreaterThan(aged + 9 * 60_000);

    // The burst: covered by the write above, nothing more is written.
    expect(await activity(stored.id)).toBe(false);
    expect(await activity(stored.id)).toBe(false);
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(first);

    // Once the recorded one is older than the coalescing window, it is written again.
    await age(stored.id, 1);
    expect(await activity(stored.id)).toBe(true);
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBeGreaterThan(first - 1_000);
  });

  // Break caught: the activity written on a clock other than the database's (the caller's, a request's), which can run ahead or
  // behind and has no say in whether the session is still live.
  it('is stamped by the database’s own clock, within the span of the statement', async () => {
    const stored = await live();
    await age(stored.id, 5);
    const before = Date.now();

    await activity(stored.id);

    const at = (await rowOf(stored.id))?.last_activity_at.getTime() ?? 0;
    expect(at).toBeGreaterThanOrEqual(before - 2_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 2_000);
  });

  // Break caught: activity recorded on a session that has ended, which would revive what a guard trigger holds ended.
  it('records nothing on an ended session, and raises nothing', async () => {
    const stored = await live();
    await age(stored.id, 10);
    await terminate({ by: 'session', sessionId: stored.id }, 'SIGNED_OUT');
    const before = (await rowOf(stored.id))?.last_activity_at.getTime();

    expect(await activity(stored.id)).toBe(false);

    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(before);
  });

  // Break caught: a session past its absolute end given a fresh activity, which a later check could take for a live one.
  it('records nothing on a session past its absolute end, whatever its activity says', async () => {
    const stored = await create(
      newSession({
        issuedAt: new Date(Date.now() - 600 * 60_000),
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    // Its recorded activity is recent enough to be inside the idle limit and old enough to be outside the coalescing window, so that
    // the absolute end is the only thing that can refuse the write (a session idle for hours would be refused by the idle rule).
    await admin.query('alter table session disable trigger session_guard');
    await admin.query(
      `update session set last_activity_at = clock_timestamp() - interval '2 minutes' where id = $1`,
      [stored.id],
    );
    await admin.query('alter table session enable trigger session_guard');
    const before = (await rowOf(stored.id))?.last_activity_at.getTime();

    expect(await activity(stored.id, 30)).toBe(false);
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(before);
    // The same recorded activity on a session that is still inside its absolute end is written: the end was what refused it.
    const alive = await create(
      newSession({
        issuedAt: new Date(Date.now() - 600 * 60_000),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    await admin.query('alter table session disable trigger session_guard');
    await admin.query(
      `update session set last_activity_at = clock_timestamp() - interval '2 minutes' where id = $1`,
      [alive.id],
    );
    await admin.query('alter table session enable trigger session_guard');
    expect(await activity(alive.id, 30)).toBe(true);
  });

  // Break caught: an idle session revived by the very request that finds it idle: its activity extended instead of left to end it.
  it('records nothing on a browser session that is already idle, and writes for a rider that has no idle rule', async () => {
    const idle = await live();
    await age(idle.id, 31);
    const idleBefore = (await rowOf(idle.id))?.last_activity_at.getTime();

    expect(await activity(idle.id, 30)).toBe(false);
    expect((await rowOf(idle.id))?.last_activity_at.getTime()).toBe(idleBefore);

    // One tick inside the limit is live, and is written.
    const inside = await live();
    await admin.query('alter table session disable trigger session_guard');
    await admin.query(
      `update session set issued_at = clock_timestamp() - interval '40 minutes',
                          last_activity_at = clock_timestamp() - make_interval(mins => 30) + interval '5 seconds' where id = $1`,
      [inside.id],
    );
    await admin.query('alter table session enable trigger session_guard');
    expect(await activity(inside.id, 30)).toBe(true);

    const rider = await create(
      newSession({
        principalType: 'RIDER',
        registeredDeviceId: randomUUID(),
        authority: { ...newSession().authority, policyRevision: 1 },
        issuedAt: new Date(Date.now() - 120 * 60_000),
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    );
    await age(rider.id, 31);
    expect(await activity(rider.id, null)).toBe(true);
  });

  /**
   * A lock that changes nothing, held while the database's clock crosses a boundary (the review of 12 October 2026, V01; plan
   * `OB-131`). PostgreSQL re-checks a waiting UPDATE's qualification only against a row that the other transaction *changed*; a holder
   * that only locked the row (`SELECT ... FOR UPDATE`) leaves the qualification as it was evaluated before the wait, and the clock
   * it read then. So the existing tests, whose holder changes the row, do not say what happens when only real time passes. Here the
   * holder changes nothing; the boundary is two seconds away and is crossed while the write waits, by polling the database's own
   * clock with a short step and a bound, never by a long sleep and never by changing a guarded column.
   */
  describe('a lock that changes nothing, held while the clock crosses a boundary', () => {
    // These writes wait for two seconds on purpose, which is the default lock time of a request (`DATABASE_LOCK_TIMEOUT_MS`): a write
    // that waits longer than that is ended by the database and the recorder logs it, which is right in production and is not what
    // is being asked here. So this describe has a service of its own, whose lock and statement times are longer than the wait.
    let patient: BuiltService;
    let patientUnitOfWork: PostgresUnitOfWork;
    beforeAll(() => {
      patient = buildService(database, {
        poolMax: 2,
        deadlines: { ...INERT_DEADLINES, lockTimeoutMs: 15_000, statementTimeoutMs: 30_000 },
      });
      patientUnitOfWork = new PostgresUnitOfWork(patient.service);
    });
    afterAll(async () => {
      await patient.close();
    });
    const activityHere = (id: string, idleMinutes: number | null): Promise<boolean> =>
      patientUnitOfWork.run(systemContext('authentication'), (handle) =>
        store.recordActivity(handle, id, idleMinutes),
      );

    /** Locks the row of a session from a connection of its own and changes nothing. */
    async function lockOnly(id: string): Promise<pg.Client> {
      const client = clientFor(database.urlFor('postgres'));
      client.on('error', () => undefined);
      await client.connect();
      await client.query('begin');
      await client.query('select 1 from session where id = $1 for update', [id]);
      return client;
    }

    /** Waits, by asking the server, until a statement on the session table is blocked on a lock. */
    async function untilWaiting(): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await observer.rows(
          `select 1 from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database() and query ~* 'from session where id|update session'`,
        );
        if (waiting.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the write never waited on the row lock');
    }

    /** Waits, by asking the database's clock, until it has passed `boundary`; bounded. */
    async function untilClockPasses(boundary: Date): Promise<void> {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const now = await observer.one<{ past: boolean }>(
          `select clock_timestamp() > $1::timestamptz as past`,
          [boundary],
        );
        if (now?.past === true) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('the database clock did not pass the boundary in time');
    }

    // Break caught: the idle limit judged before the wait on the row and not after it, so that a write which waited past the limit
    // gives the session a fresh activity and keeps alive what the limit had ended.
    it('does not extend a session that goes idle while the write waits for it', async () => {
      const issuedAt = new Date(Date.now() - (30 * 60_000 - 2_000));
      const stored = await create(
        newSession({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 8 * 3_600_000) }),
      );
      const before = (await rowOf(stored.id))?.last_activity_at.getTime();
      const holder = await lockOnly(stored.id);
      try {
        const pending = activityHere(stored.id, 30);
        await untilWaiting();
        await untilClockPasses(new Date(issuedAt.getTime() + 30 * 60_000));
        await holder.query('rollback');

        expect(await pending).toBe(false);
      } finally {
        await holder.end();
      }
      expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(before);
    });

    // Break caught: the absolute end judged before the wait and not after it, so that a write which waited past it is recorded on a
    // session whose end has come.
    it('records nothing on a session whose absolute end comes while the write waits for it', async () => {
      const issuedAt = new Date(Date.now() - 2 * 3_600_000);
      const expiresAt = new Date(Date.now() + 2_000);
      const stored = await create(newSession({ issuedAt, expiresAt }));
      const before = (await rowOf(stored.id))?.last_activity_at.getTime();
      const holder = await lockOnly(stored.id);
      try {
        // No idle limit, so the absolute end is the only thing that can refuse the write.
        const pending = activityHere(stored.id, null);
        await untilWaiting();
        await untilClockPasses(expiresAt);
        await holder.query('rollback');

        expect(await pending).toBe(false);
      } finally {
        await holder.end();
      }
      expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(before);
    });

    // Control: the same write, with the same lock released before either boundary, is made. A test that cannot show this proves
    // nothing about the two above, because it would be refused whatever the order.
    it('writes when the lock is released before the boundary', async () => {
      const issuedAt = new Date(Date.now() - (30 * 60_000 - 20_000));
      const stored = await create(
        newSession({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 8 * 3_600_000) }),
      );
      const before = (await rowOf(stored.id))?.last_activity_at.getTime() ?? 0;
      const holder = await lockOnly(stored.id);
      try {
        const pending = activityHere(stored.id, 30);
        await untilWaiting();
        await holder.query('rollback');

        expect(await pending).toBe(true);
      } finally {
        await holder.end();
      }
      expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBeGreaterThan(before);
    });
  });

  // Break caught: activity moving back (a clock step, a late request) and making an idle session look idler or fresher. A recorded
  // activity a little ahead of the database's clock (the table tolerates a few minutes) is left alone, not pulled back to now.
  it('never moves the recorded activity back', async () => {
    const stored = await live();
    await admin.query(
      `update session set last_activity_at = clock_timestamp() + interval '2 minutes' where id = $1`,
      [stored.id],
    );
    const ahead = (await rowOf(stored.id))?.last_activity_at.getTime();

    expect(await activity(stored.id)).toBe(false);

    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(ahead);
  });

  it('refuses an id that is not a session id and an idle limit that is not whole minutes', async () => {
    await expect(activity('not-a-uuid')).rejects.toBeInstanceOf(TypeError);
    await expect(activity(randomUUID(), 0)).rejects.toBeInstanceOf(RangeError);
    await expect(activity(randomUUID(), 1.5)).rejects.toBeInstanceOf(RangeError);
  });
});

describe('terminate', () => {
  // Break caught: a session left ACTIVE after it was ended, or ended with some other reason than the one given.
  it('ends one session with the reason, and a second ending keeps the first reason', async () => {
    const stored = await create(newSession());

    expect(await terminate({ by: 'session', sessionId: stored.id }, 'SIGNED_OUT')).toBe(1);
    expect(await terminate({ by: 'session', sessionId: stored.id }, 'ADMIN_REVOKED')).toBe(0);

    expect(await rowOf(stored.id)).toMatchObject({ termination_reason: 'SIGNED_OUT' });
    expect((await rowOf(stored.id))?.terminated_at).toBeInstanceOf(Date);
  });

  // Break caught: an ending that reaches another principal's sessions, or another type's with the same id.
  it('ends the live sessions of one principal and no other principal’s, with the reason', async () => {
    const principalId = randomUUID();
    const first = await create(newSession({ principalId }));
    const second = await create(newSession({ principalId }));
    const another = await create(newSession());
    const sameIdVendor = await create(
      newSession({
        principalType: 'VENDOR',
        principalId,
        registeredDeviceId: randomUUID(),
        authority: { ...newSession().authority, policyRevision: 1 },
      }),
    );

    const ended = await terminate(
      { by: 'principal', principalType: 'STAFF', principalId },
      'CREDENTIAL_CHANGED',
    );

    expect(ended).toBe(2);
    expect((await rowOf(first.id))?.termination_reason).toBe('CREDENTIAL_CHANGED');
    expect((await rowOf(second.id))?.termination_reason).toBe('CREDENTIAL_CHANGED');
    expect((await rowOf(another.id))?.terminated_at).toBeNull();
    expect((await rowOf(sameIdVendor.id))?.terminated_at).toBeNull();
  });

  // Break caught: sessions of a bundle left live after a change to it, or a revision at or above the floor being ended with them.
  it('ends the live sessions of a bundle, only those below a revision when one is given, and keeps earlier endings', async () => {
    const bundle = BUNDLE_IDS.platformAdmin;
    const as = (bundleRevision: number): NewSession => {
      const given = newSession();
      return { ...given, authority: { ...given.authority, bundleId: bundle, bundleRevision } };
    };
    const old = await create(as(1));
    const older = await create(as(2));
    const current = await create(as(3));
    const otherBundle = await create(newSession());
    await terminate({ by: 'session', sessionId: older.id }, 'SIGNED_OUT');

    const ended = await terminate(
      { by: 'bundle', bundleId: bundle, belowRevision: 3 },
      'AUTHORITY_CHANGED',
    );

    expect(ended).toBe(1);
    expect((await rowOf(old.id))?.termination_reason).toBe('AUTHORITY_CHANGED');
    expect((await rowOf(older.id))?.termination_reason).toBe('SIGNED_OUT');
    expect((await rowOf(current.id))?.terminated_at).toBeNull();
    expect((await rowOf(otherBundle.id))?.terminated_at).toBeNull();

    expect(await terminate({ by: 'bundle', bundleId: bundle }, 'ADMIN_REVOKED')).toBe(1);
    expect((await rowOf(current.id))?.termination_reason).toBe('ADMIN_REVOKED');
  });

  // Break caught: a revocation that fails because the database clock stepped back past the session's issue (an NTP correction): the
  // row refuses an end earlier than its issue, the whole revoking transaction (a suspension, a credential change, a reduction) rolls
  // back, and the session stays live. The end is never recorded earlier than the issue.
  it('ends a session whose issue is later than the database clock, recording the end no earlier than the issue', async () => {
    const issuedAt = new Date(Date.now() + 60 * 60_000);
    const stored = await create(
      newSession({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 8 * 60 * 60_000) }),
    );

    expect(await terminate({ by: 'session', sessionId: stored.id }, 'SUSPENDED')).toBe(1);

    const row = await rowOf(stored.id);
    expect(row?.termination_reason).toBe('SUSPENDED');
    expect(row?.terminated_at?.getTime()).toBe(issuedAt.getTime());
  });

  // Break caught: a malformed selector reaching every session, or a revision bound that is not a whole number.
  it('refuses a selector that is not well formed, before it sends anything', async () => {
    const attempt = (selector: unknown) =>
      terminate(selector as Parameters<PostgresSessionStore['terminate']>[1]);

    await expect(attempt({ by: 'session', sessionId: 'not-a-uuid' })).rejects.toThrow(TypeError);
    await expect(
      attempt({ by: 'principal', principalType: 'ADMIN', principalId: randomUUID() }),
    ).rejects.toThrow(TypeError);
    await expect(
      attempt({ by: 'bundle', bundleId: randomUUID(), belowRevision: 1.5 }),
    ).rejects.toThrow(TypeError);
    await expect(attempt({ by: 'everyone' })).rejects.toThrow(TypeError);
  });
});

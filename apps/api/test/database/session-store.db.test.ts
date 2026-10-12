import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  BundleSnapshot,
  NewSession,
  StoredSession,
} from '../../src/platform/auth/ports/session-store.port.js';
import { ACTIVITY_COALESCE_MS } from '../../src/platform/auth/sessions/session-parameters.js';
import { PostgresSessionStore } from '../../src/platform/auth/sessions/postgres.session-store.adapter.js';
import { SessionSnapshotUnreadableError } from '../../src/platform/auth/sessions/session-errors.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { openAdmin, type Admin } from './support/admin.js';
import { hashOf } from './support/identities.js';
import { observe, type Observer } from './support/observe.js';
import { HUB_A, HUB_B, systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { createTestDatabase, type TestDatabase } from './support/test-database.js';

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
const activity = (id: string, at: Date): Promise<void> =>
  unitOfWork.run(systemContext('authentication'), (handle) => store.recordActivity(handle, id, at));
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
  // Break caught: a write per request, which a burst of requests would turn into a burst of updates on one row.
  it('writes once for a burst, and again once the recorded activity is old enough', async () => {
    const issuedAt = new Date(Date.now() - 10 * 60_000);
    const stored = await create(
      newSession({ issuedAt, expiresAt: new Date(issuedAt.getTime() + 3_600_000) }),
    );
    const start = stored.lastActivityAt.getTime();

    await activity(stored.id, new Date(start + 5_000));
    await activity(stored.id, new Date(start + ACTIVITY_COALESCE_MS - 1));
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(start);

    await activity(stored.id, new Date(start + ACTIVITY_COALESCE_MS));
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(start + ACTIVITY_COALESCE_MS);
    await activity(stored.id, new Date(start + ACTIVITY_COALESCE_MS + 1_000));
    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(start + ACTIVITY_COALESCE_MS);
  });

  // Break caught: activity moving back (a clock step, a late request) and making an idle session look idler or fresher.
  it('never moves the recorded activity back', async () => {
    const stored = await create(newSession());
    await activity(stored.id, new Date(stored.lastActivityAt.getTime() + 2 * ACTIVITY_COALESCE_MS));
    const recorded = (await rowOf(stored.id))?.last_activity_at.getTime();

    await activity(stored.id, new Date(stored.lastActivityAt.getTime()));

    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(recorded);
  });

  // Break caught: activity recorded on a session that has ended, which would revive what a guard trigger holds ended.
  it('records nothing on an ended session, and raises nothing', async () => {
    const stored = await create(newSession());
    await terminate({ by: 'session', sessionId: stored.id }, 'SIGNED_OUT');
    const before = (await rowOf(stored.id))?.last_activity_at.getTime();

    await activity(
      stored.id,
      new Date(stored.lastActivityAt.getTime() + 10 * ACTIVITY_COALESCE_MS),
    );

    expect((await rowOf(stored.id))?.last_activity_at.getTime()).toBe(before);
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

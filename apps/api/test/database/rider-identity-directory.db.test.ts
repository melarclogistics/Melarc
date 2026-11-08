import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RoutedIdentityDirectory } from '../../src/platform/auth/directory/routed.identity-directory.adapter.js';
import type { PrincipalRef } from '../../src/platform/auth/ports/identity-directory.port.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import {
  NotARiderQuestionError,
  PostgresRiderIdentityDirectory,
} from '../../src/staff/postgres.rider-identity-directory.adapter.js';
import { PostgresStaffIdentityDirectory } from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { PostgresVendorAccountDirectory } from '../../src/vendor/postgres.vendor-account-directory.adapter.js';
import { waitUntilBlocked } from './support/policy-fixtures.js';
import { insertRider, riderRow, SOME_PIN_HASH, type RiderRow } from './support/riders.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.53, the rider `IdentityDirectory` against a real PostgreSQL, as the API's login under the `authentication` capability: what it finds by
 * the canonical phone, the lock it takes (the rider's row), the first PIN it writes, the lockout it keeps over the PIN, what a rider session
 * is shown as, and the questions that are not the rider directory's. It is reached through the platform's router, as the composition binds it.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let unitOfWork: PostgresUnitOfWork;
const riders = new PostgresRiderIdentityDirectory();
const directory = new RoutedIdentityDirectory({
  STAFF: new PostgresStaffIdentityDirectory(),
  VENDOR: new PostgresVendorAccountDirectory(),
  RIDER: riders,
});
const POLICY = { maxAttempts: 3, lockoutMinutes: 15 };
const HUB = HUBS[0]?.id ?? '';

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 3 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const rider = (overrides: Partial<RiderRow> = {}): Promise<RiderRow> =>
  insertRider(admin, riderRow(overrides));
const inside = <T>(work: (handle: TransactionHandle) => Promise<T>) =>
  unitOfWork.run(systemContext('authentication'), work);
const ref = (row: RiderRow): PrincipalRef => ({ type: 'RIDER', id: row.id });
const credential = async (row: RiderRow) =>
  (
    await admin.query<{
      failed_attempt_count: number;
      locked: boolean;
      credential_generation: string;
      pin_hash: string | null;
    }>(
      `select failed_attempt_count, (locked_until is not null and locked_until > clock_timestamp()) as locked,
              credential_generation, pin_hash
         from rider_identity where id = $1`,
      [row.id],
    )
  ).rows[0];

describe('findRiderByCanonicalPhone', () => {
  // Break caught: a summary naming the wrong bundle (a session snapshots the fixed Rider bundle), the wrong hub, or another rider.
  it('summarises the rider: its status, its PIN, the fixed Rider bundle and its primary hub', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    expect(
      await inside((handle) => directory.findRiderByCanonicalPhone(handle, row.phone)),
    ).toEqual({
      ref: { type: 'RIDER', id: row.id },
      status: 'ACTIVE',
      credentialGeneration: 1,
      credentialEstablishedAt: new Date('2026-10-01T09:00:00Z'),
      bundleId: BUNDLE_IDS.rider,
      authorizedHubIds: [HUB],
    });
  });

  it('says a rider that holds no PIN yet holds generation 0 and no moment', async () => {
    const row = await rider();
    expect(await inside((handle) => directory.readIdentity(handle, ref(row)))).toMatchObject({
      credentialGeneration: 0,
      credentialEstablishedAt: null,
    });
  });

  // The finder takes the canonical phone; the caller makes it (`canonicalRiderPhone`).
  it('finds nothing for a number that is not one, or not in its canonical form', async () => {
    const row = await rider();
    for (const phone of [
      '+99900000000000000',
      row.phone.slice(1),
      `${row.phone} `,
      row.phone.replace('+999', '+998'),
    ]) {
      expect(
        await inside((handle) => directory.findRiderByCanonicalPhone(handle, phone)),
      ).toBeNull();
    }
  });

  it('says each status as it is, the suspended included', async () => {
    for (const status of [
      'ACTIVE',
      'INACTIVE',
      'TEMPORARILY_UNAVAILABLE',
      'SUSPENDED',
      'OFFBOARDED',
    ]) {
      const row = await rider({ status });
      expect((await inside((handle) => directory.readIdentity(handle, ref(row))))?.status).toBe(
        status,
      );
    }
  });
});

describe('lockIdentity', () => {
  // Break caught: a lock on a row a device act does not take (the officers' acts lock this row first), so a sign-in, an enrolment or a
  // revocation could interleave with it.
  it('locks the rider row until the transaction ends', async () => {
    const row = await rider();
    await inside(async (handle) => {
      expect((await directory.lockIdentity(handle, ref(row)))?.ref.id).toBe(row.id);
      const other = clientFor(database.urlFor('postgres'));
      await other.connect();
      try {
        await expect(
          other.query(`select 1 from rider_identity where id = $1 for update nowait`, [row.id]),
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await other.end();
      }
    });
  });

  it('answers a rider that is not there with nothing', async () => {
    expect(
      await inside((handle) => directory.lockIdentity(handle, { type: 'RIDER', id: randomUUID() })),
    ).toBeNull();
  });

  // Break caught: the state read in the statement that waited for the lock, whose snapshot is older than the wait: a rider suspended, or a
  // PIN replaced, by the transaction that held the lock would be judged as it was before.
  it('reads the rider as it stands once the lock is held, after any wait', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from rider_identity where id = $1 for update`, [row.id]);
      const read = inside((handle) => directory.lockIdentity(handle, ref(row)));
      await waitUntilBlocked(admin, database.name, /rider_identity/);
      await holder.query(
        `update rider_identity set status = 'SUSPENDED', pin_hash = $2, pin_established_at = clock_timestamp(), credential_generation = 2
          where id = $1`,
        [row.id, `${SOME_PIN_HASH}v2`],
      );
      await holder.query('commit');
      expect(await read).toMatchObject({ status: 'SUSPENDED', credentialGeneration: 2 });
    } finally {
      await holder.end();
    }
  });
});

describe('establishCredential', () => {
  // Break caught: a first PIN written past a PIN that is there (a replacement is a handset's enrolment, never a setup), or one that leaves
  // the lockout or the generation as they were.
  it('writes the first PIN once, from generation 0 to 1, and clears the lockout', async () => {
    const row = await rider();
    await admin.query(`update rider_identity set failed_attempt_count = 2 where id = $1`, [row.id]);
    expect(
      await inside((handle) => directory.establishCredential(handle, ref(row), SOME_PIN_HASH)),
    ).toEqual({ generation: 1 });
    expect(await credential(row)).toEqual({
      failed_attempt_count: 0,
      locked: false,
      credential_generation: '1',
      pin_hash: SOME_PIN_HASH,
    });
    expect(
      (
        await admin.query<{ moment: boolean }>(
          `select pin_established_at is not null as moment from rider_identity where id = $1`,
          [row.id],
        )
      ).rows[0]?.moment,
    ).toBe(true);
    expect(
      await inside((handle) =>
        directory.establishCredential(handle, ref(row), `${SOME_PIN_HASH}x`),
      ),
    ).toBeNull();
    expect((await credential(row))?.pin_hash).toBe(SOME_PIN_HASH);
  });

  it('writes nothing for a rider that is not there', async () => {
    expect(
      await inside((handle) =>
        directory.establishCredential(handle, { type: 'RIDER', id: randomUUID() }, SOME_PIN_HASH),
      ),
    ).toBeNull();
  });

  it('refuses a hash that is not one before touching the row', async () => {
    const row = await rider();
    for (const hash of ['', 'x'.repeat(1025)]) {
      await expect(
        inside((handle) => directory.establishCredential(handle, ref(row), hash)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect((await credential(row))?.credential_generation).toBe('0');
  });
});

describe('replaceCredential', () => {
  // Break caught: a replacement that does not raise the generation (an old session's PIN would still be the credential), that leaves the
  // lockout, or that creates a PIN for a rider with none.
  it('replaces the PIN, raises the generation by one and clears the lockout; for a rider with none it writes nothing', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    await admin.query(
      `update rider_identity set failed_attempt_count = 3, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [row.id],
    );
    expect(
      await inside((handle) => directory.replaceCredential(handle, ref(row), `${SOME_PIN_HASH}v2`)),
    ).toEqual({ generation: 2 });
    expect(await credential(row)).toEqual({
      failed_attempt_count: 0,
      locked: false,
      credential_generation: '2',
      pin_hash: `${SOME_PIN_HASH}v2`,
    });
    const none = await rider();
    expect(
      await inside((handle) => directory.replaceCredential(handle, ref(none), SOME_PIN_HASH)),
    ).toBeNull();
    expect((await credential(none))?.pin_hash).toBeNull();
  });
});

describe('the PIN lockout', () => {
  // Break caught: a count that is not atomic, that does not tip once, or that keeps counting inside a lock.
  it('counts each failure, sets the lock at the policy’s count once, and then counts nothing', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    const fail = () =>
      inside((handle) => directory.recordFailedAttempt(handle, ref(row), 1, POLICY));
    expect(await fail()).toMatchObject({ counted: true, failedAttemptCount: 1, tipped: false });
    expect(await fail()).toMatchObject({ counted: true, failedAttemptCount: 2, tipped: false });
    const tipped = await fail();
    expect(tipped).toMatchObject({ counted: true, failedAttemptCount: 3, tipped: true });
    expect(tipped.counted && tipped.tipped ? tipped.lockedUntil.getTime() : 0).toBeGreaterThan(
      Date.now(),
    );
    expect(await fail()).toEqual({ counted: false, reason: 'LOCKED' });
    expect(await inside((handle) => directory.isCredentialLocked(handle, ref(row)))).toBe(true);
    await inside((handle) => directory.clearFailedAttempts(handle, ref(row)));
    expect(await credential(row)).toMatchObject({ failed_attempt_count: 0, locked: false });
    expect(await inside((handle) => directory.isCredentialLocked(handle, ref(row)))).toBe(false);
  });

  // Break caught: a lock that has run out still refusing, or the count carrying on from the old lock's total.
  it('restarts from one after a lock has run out', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    await admin.query(
      `update rider_identity set failed_attempt_count = 3, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [row.id],
    );
    expect(await inside((handle) => directory.isCredentialLocked(handle, ref(row)))).toBe(false);
    expect(
      await inside((handle) => directory.recordFailedAttempt(handle, ref(row), 1, POLICY)),
    ).toMatchObject({ counted: true, failedAttemptCount: 1, tipped: false });
  });

  // Break caught (A03 of 21 October 2026, for the rider): an old verification counting against a new PIN, or against a rider that can no
  // longer sign in.
  it('counts nothing against another generation, a suspended rider or one that is not there', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    expect(
      await inside((handle) => directory.recordFailedAttempt(handle, ref(row), 2, POLICY)),
    ).toEqual({ counted: false, reason: 'STALE' });
    for (const status of ['SUSPENDED', 'OFFBOARDED', 'INACTIVE', 'TEMPORARILY_UNAVAILABLE']) {
      const other = await rider({ pinHash: SOME_PIN_HASH, status });
      expect(
        await inside((handle) => directory.recordFailedAttempt(handle, ref(other), 1, POLICY)),
      ).toEqual({ counted: false, reason: 'STALE' });
      expect((await credential(other))?.failed_attempt_count).toBe(0);
    }
    expect(
      await inside((handle) =>
        directory.recordFailedAttempt(handle, { type: 'RIDER', id: randomUUID() }, 1, POLICY),
      ),
    ).toEqual({ counted: false, reason: 'STALE' });
    expect((await credential(row))?.failed_attempt_count).toBe(0);
  });

  // Break caught: concurrent failures overwriting one another's count, or one stepping over the threshold without setting the lock.
  it('counts concurrent failures one each and sets the lock exactly once', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        inside((handle) => directory.recordFailedAttempt(handle, ref(row), 1, POLICY)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.counted)).toHaveLength(3);
    expect(outcomes.filter((outcome) => outcome.counted && outcome.tipped)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.counted)).toHaveLength(3);
    expect(await credential(row)).toMatchObject({ failed_attempt_count: 3, locked: true });
  });

  it('refuses a policy or a generation that is not a whole number before touching the row', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    for (const [generation, policy] of [
      [0, POLICY],
      [1.5, POLICY],
      [1, { maxAttempts: 0, lockoutMinutes: 15 }],
      [1, { maxAttempts: 3, lockoutMinutes: 0.5 }],
    ] as const) {
      await expect(
        inside((handle) => directory.recordFailedAttempt(handle, ref(row), generation, policy)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect((await credential(row))?.failed_attempt_count).toBe(0);
  });
});

describe('readCredentialHash and rehashCredential', () => {
  it('gives the hash through the authentication-only reader, and rehashes only the hash that was verified', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    expect(await inside((handle) => directory.readCredentialHash(handle, ref(row)))).toBe(
      SOME_PIN_HASH,
    );
    expect(
      await inside((handle) =>
        directory.rehashCredential(
          handle,
          ref(row),
          1,
          'not-the-stored-hash',
          `${SOME_PIN_HASH}v2`,
        ),
      ),
    ).toBe(false);
    expect(
      await inside((handle) =>
        directory.rehashCredential(handle, ref(row), 1, SOME_PIN_HASH, `${SOME_PIN_HASH}v2`),
      ),
    ).toBe(true);
    expect(await credential(row)).toMatchObject({
      pin_hash: `${SOME_PIN_HASH}v2`,
      credential_generation: '1',
    });
  });

  // Break caught: a rehash of the old PIN's hash writing over a PIN a replacement has since set.
  it('does not rehash a PIN the identity no longer holds', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    await admin.query(
      `update rider_identity set pin_hash = $2, pin_established_at = clock_timestamp(), credential_generation = 2 where id = $1`,
      [row.id, `${SOME_PIN_HASH}new`],
    );
    expect(
      await inside((handle) =>
        directory.rehashCredential(handle, ref(row), 1, SOME_PIN_HASH, `${SOME_PIN_HASH}v2`),
      ),
    ).toBe(false);
    expect((await credential(row))?.pin_hash).toBe(`${SOME_PIN_HASH}new`);
  });

  it('gives no hash for a rider with no PIN or none at all', async () => {
    const row = await rider();
    expect(await inside((handle) => directory.readCredentialHash(handle, ref(row)))).toBeNull();
    expect(
      await inside((handle) =>
        directory.readCredentialHash(handle, { type: 'RIDER', id: randomUUID() }),
      ),
    ).toBeNull();
  });
});

describe('what a rider session is shown as and where its messages go', () => {
  it('names the rider by its full name', async () => {
    const row = await rider({ fullName: 'Kwame Mensah' });
    expect(await inside((handle) => directory.displayName(handle, ref(row)))).toBe('Kwame Mensah');
    expect(
      await inside((handle) => directory.displayName(handle, { type: 'RIDER', id: randomUUID() })),
    ).toBeNull();
  });

  // Break caught (credential-recovery.md section 5.7: never a rider): a recovery link offered to a rider, or a channel guessed for one.
  it('has no deliverable channel and no self-service recovery, whatever the rider holds', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    expect(await inside((handle) => directory.registeredChannel(handle, ref(row)))).toBeNull();
    expect(await inside((handle) => directory.recoveryEligible(handle, ref(row)))).toBe(false);
  });
});

describe('the questions that are not the rider directory’s', () => {
  it('refuses a staff or vendor principal and the staff and vendor finders, which the router never sends it', async () => {
    for (const type of ['STAFF', 'VENDOR'] as const) {
      await expect(
        inside((handle) => riders.readIdentity(handle, { type, id: randomUUID() })),
      ).rejects.toBeInstanceOf(NotARiderQuestionError);
      await expect(
        inside((handle) => riders.lockIdentity(handle, { type, id: randomUUID() })),
      ).rejects.toBeInstanceOf(NotARiderQuestionError);
    }
    await expect(inside(() => riders.findStaffByCanonicalEmail())).rejects.toBeInstanceOf(
      NotARiderQuestionError,
    );
    await expect(inside(() => riders.findVendorAccountByIdentifier())).rejects.toBeInstanceOf(
      NotARiderQuestionError,
    );
    await expect(inside(() => riders.findStaffForSignIn())).rejects.toBeInstanceOf(
      NotARiderQuestionError,
    );
    await expect(inside(() => riders.accountLabel())).rejects.toBeInstanceOf(
      NotARiderQuestionError,
    );
    await expect(inside(() => riders.vendorOrganizationOf())).rejects.toBeInstanceOf(
      NotARiderQuestionError,
    );
  });

  // Break caught: the router sending a rider to the staff directory (which would refuse it as not built) or a staff member to the rider's.
  it('is reached for a rider through the router, and the other audiences still reach theirs', async () => {
    const row = await rider({ pinHash: SOME_PIN_HASH });
    expect(await inside((handle) => directory.lockIdentity(handle, ref(row)))).toMatchObject({
      ref: { type: 'RIDER', id: row.id },
      bundleId: BUNDLE_IDS.rider,
    });
    expect(await inside((handle) => directory.displayName(handle, ref(row)))).toBe(row.fullName);
    expect(
      await inside((handle) => directory.readIdentity(handle, { type: 'STAFF', id: row.id })),
    ).toBeNull();
  });

  // Break caught: a staff context reaching a PIN through the directory (row-level security gives it none).
  it('finds nothing under a staff context that holds no roster key, which row-level security keeps from the rider', async () => {
    const row = await rider();
    const found = await unitOfWork.run(
      {
        principalType: 'STAFF',
        principalId: randomUUID(),
        surface: 'OPS_PORTAL',
        correlationId: 'rider-directory-test',
        hubScopeMode: 'ALL',
        authorizedHubIds: [],
        authorizationKey: 'vendor.read',
      },
      (handle) => directory.findRiderByCanonicalPhone(handle, row.phone),
    );
    expect(found).toBeNull();
  });
});

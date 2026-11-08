import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  IdentityDirectory,
  PrincipalRef,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { PostgresUnitOfWork } from '../../src/platform/database/postgres.unit-of-work.adapter.js';
import {
  IdentityDirectoryNotBuiltError,
  PostgresStaffIdentityDirectory,
} from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.32, the staff `IdentityDirectory`'s reads and writes for the sign-in, against a real PostgreSQL as the API's login under the
 * `authentication` capability: the lookup that tells whether a lock is in force on the database's clock, the credential's hash (which
 * only a definer function returns), the atomic count of a failed attempt and the lock it may set, the reset, and the name a session
 * shows.
 */
let database: TestDatabase;
let built: BuiltService;
let admin: pg.Client;
let unitOfWork: PostgresUnitOfWork;
const directory: IdentityDirectory = new PostgresStaffIdentityDirectory();
const POLICY = { maxAttempts: 5, lockoutMinutes: 15 } as const;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  built = buildService(database, { poolMax: 4 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  unitOfWork = new PostgresUnitOfWork(built.service);
});

afterAll(async () => {
  await admin.end();
  await built.close();
  await database.drop();
});

const staff = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const inside = <T>(
  work: (handle: Parameters<IdentityDirectory['readIdentity']>[0]) => Promise<T>,
): Promise<T> => unitOfWork.run(systemContext('authentication'), work);
const ref = (row: StaffRow): PrincipalRef => ({ type: 'STAFF', id: row.id });
const failures = (record: StaffRow, times: number) =>
  admin.query('update staff_identity set failed_attempt_count = $2 where id = $1', [
    record.id,
    times,
  ]);

const countOf = async (
  row: StaffRow,
): Promise<{ failed_attempt_count: number; locked_until: Date | null }> =>
  (
    await admin.query<{ failed_attempt_count: number; locked_until: Date | null }>(
      'select failed_attempt_count, locked_until from staff_identity where id = $1',
      [row.id],
    )
  ).rows[0] ?? { failed_attempt_count: -1, locked_until: null };

const databaseNow = async (): Promise<Date> =>
  (await admin.query<{ now: Date }>('select clock_timestamp() as now')).rows[0]?.now ?? new Date(0);

describe('findStaffForSignIn', () => {
  // Break caught: a sign-in that cannot tell a locked credential from an open one, or one that reads the lock on the application's clock.
  it('summarises the identity as the other finders do and says whether a lock is in force on the database’s clock', async () => {
    const open = await staff({ roleBundleId: BUNDLE_IDS.seniorOps });
    const locked = await staff();
    const lapsed = await staff();
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [locked.id],
    );
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [lapsed.id],
    );

    const found = await inside(async (handle) => ({
      open: await directory.findStaffForSignIn(handle, open.workEmailCanonical),
      locked: await directory.findStaffForSignIn(handle, locked.workEmailCanonical),
      lapsed: await directory.findStaffForSignIn(handle, lapsed.workEmailCanonical),
    }));

    expect(found.open).toEqual({
      summary: {
        ref: ref(open),
        status: 'ACTIVE',
        credentialGeneration: 1,
        credentialEstablishedAt: open.credentialEstablishedAt,
        bundleId: BUNDLE_IDS.seniorOps,
        authorizedHubIds: [],
        origin: 'MAKER_CHECKER',
      },
      locked: false,
    });
    expect(found.locked?.locked).toBe(true);
    // A lock that has run out is no lock, though the count is still on the record until the next attempt resets it.
    expect(found.lapsed?.locked).toBe(false);
  });

  it('finds by the canonical address only, never a rejected profile, and nothing for an unknown address', async () => {
    const row = await staff({
      workEmail: 'Mixed.Case@Example.Test',
      workEmailCanonical: 'mixed.case@example.test',
    });
    const rejected = await staff({ status: 'REJECTED' });

    expect(
      await inside((h) => directory.findStaffForSignIn(h, 'Mixed.Case@Example.Test')),
    ).toBeNull();
    expect(
      (await inside((h) => directory.findStaffForSignIn(h, row.workEmailCanonical)))?.summary.ref,
    ).toEqual(ref(row));
    expect(
      await inside((h) => directory.findStaffForSignIn(h, rejected.workEmailCanonical)),
    ).toBeNull();
    expect(await inside((h) => directory.findStaffForSignIn(h, 'nobody@example.test'))).toBeNull();
  });

  it('treats the address as a value and never as a pattern', async () => {
    await staff({ workEmailCanonical: 'someone@example.test' });

    expect(await inside((h) => directory.findStaffForSignIn(h, '%@example.test'))).toBeNull();
    expect(await inside((h) => directory.findStaffForSignIn(h, "x' or '1'='1"))).toBeNull();
  });
});

describe('readCredentialHash', () => {
  // Break caught: the hash read through a path any context can use, or the wrong identity's hash.
  it('returns the stored hash of the identity under the authentication capability, and null where there is none', async () => {
    const credentialed = await staff({
      credentialHash: '$argon2id$v=19$m=19456,t=2,p=1$YWJj$ZGVm',
    });
    const bare = await staff({ credentialHash: null, credentialEstablishedAt: null });

    expect(await inside((h) => directory.readCredentialHash(h, ref(credentialed)))).toBe(
      '$argon2id$v=19$m=19456,t=2,p=1$YWJj$ZGVm',
    );
    expect(await inside((h) => directory.readCredentialHash(h, ref(bare)))).toBeNull();
    expect(
      await inside((h) => directory.readCredentialHash(h, { type: 'STAFF', id: randomUUID() })),
    ).toBeNull();
  });

  it('refuses any other capability: the credential is read for the authentication capability alone', async () => {
    const credentialed = await staff();

    const refused = await unitOfWork
      .run(systemContext('rate_limit'), (h) => directory.readCredentialHash(h, ref(credentialed)))
      .then(
        () => undefined,
        (error: unknown) => serverErrorIn(error),
      );

    expect(refused?.code).toBe('42501');
    expect(refused?.message).toMatch(/authentication capability alone/);
  });
});

describe('recordFailedAttempt', () => {
  // Break caught: a count that does not rise, or one that sets the lock early or late.
  it('counts each failure and sets the lock on the fifth, on the database’s clock, and says which one tipped it', async () => {
    const row = await staff();
    const results = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      results.push(
        await inside((h) =>
          directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY),
        ),
      );
    }
    const after = await databaseNow();

    expect(results.map((r) => r.counted && r.failedAttemptCount)).toEqual([1, 2, 3, 4, 5]);
    expect(results.map((r) => r.counted && r.tipped)).toEqual([false, false, false, false, true]);
    const tipped = results[4];
    if (tipped?.counted !== true || tipped.lockedUntil === null) throw new Error('no lock was set');
    // fifteen minutes from now, on the database's clock: not the application's, not earlier than the attempts
    expect(tipped.lockedUntil.getTime()).toBeGreaterThan(after.getTime() + 14 * 60_000);
    expect(tipped.lockedUntil.getTime()).toBeLessThan(after.getTime() + 15 * 60_000 + 1_000);
    expect((await countOf(row)).locked_until?.getTime()).toBe(tipped.lockedUntil.getTime());
  });

  // Break caught (AC-SLICE-000-77): a failure inside a lock that counts, or moves the lock (an attacker extending it, or a tipped event
  // written twice).
  it('neither counts nor moves a lock that is in force', async () => {
    const row = await staff();
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [row.id],
    );
    const before = await countOf(row);

    const result = await inside((h) =>
      directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY),
    );

    expect(result).toEqual({ counted: false, reason: 'LOCKED' });
    expect(await countOf(row)).toEqual(before);
  });

  // Break caught (the audit of 21 October 2026, A03): a failure counted against whatever credential the identity holds when the
  // update runs. A verification that started against generation 1 and finished after a replacement committed generation 2 and cleared
  // its counters would add one to the new credential's, and a few of them would lock it. The attempt names the generation it was made
  // against, and counts only while the identity still holds it and can still sign in.
  it('counts nothing against a credential that is not the one verified, or an identity that cannot sign in, and says it is stale', async () => {
    const replaced = await staff();
    await admin.query(
      `update staff_identity set credential_hash = 'second', credential_established_at = clock_timestamp(),
                                 credential_generation = 2, failed_attempt_count = 3 where id = $1`,
      [replaced.id],
    );
    const suspended = await staff();
    await admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.id,
    ]);
    const offboarded = await staff();
    await admin.query(`update staff_identity set status = 'OFFBOARDED' where id = $1`, [
      offboarded.id,
    ]);

    // the attempt of the first credential, finishing after the second was set
    expect(await inside((h) => directory.recordFailedAttempt(h, ref(replaced), 1, POLICY))).toEqual(
      { counted: false, reason: 'STALE' },
    );
    expect((await countOf(replaced)).failed_attempt_count).toBe(3);
    // a generation the identity has not reached is as stale as one it has left
    expect(await inside((h) => directory.recordFailedAttempt(h, ref(replaced), 3, POLICY))).toEqual(
      { counted: false, reason: 'STALE' },
    );
    for (const row of [suspended, offboarded]) {
      expect(
        await inside((h) =>
          directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY),
        ),
      ).toEqual({ counted: false, reason: 'STALE' });
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    }
    // and the current generation of the replaced credential is counted as it always was
    const current = await inside((h) => directory.recordFailedAttempt(h, ref(replaced), 2, POLICY));
    expect(current.counted && current.failedAttemptCount).toBe(4);
  });

  // Break caught: a stale attempt that is the fifth: it would lock the credential that replaced the one it was made against.
  it('does not lock a replacement credential with the attempt of the credential it replaced', async () => {
    const row = await staff();
    await admin.query(
      `update staff_identity set credential_hash = 'second', credential_established_at = clock_timestamp(),
                                 credential_generation = 2, failed_attempt_count = 4 where id = $1`,
      [row.id],
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        inside((h) => directory.recordFailedAttempt(h, ref(row), 1, POLICY)),
      ),
    );

    expect(results.every((result) => !result.counted && result.reason === 'STALE')).toBe(true);
    expect(await countOf(row)).toEqual({ failed_attempt_count: 4, locked_until: null });
  });

  // Break caught (AC-SLICE-000-78: "at the first attempt after it the count is zero"): a lapsed lock that keeps its count, so that one
  // more wrong password locks the identity again at once.
  it('starts again from one when the lock has run out, and sets no lock', async () => {
    const row = await staff();
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [row.id],
    );

    const result = await inside((h) =>
      directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY),
    );

    expect(result).toEqual({
      counted: true,
      failedAttemptCount: 1,
      tipped: false,
      lockedUntil: null,
    });
    expect(await countOf(row)).toEqual({ failed_attempt_count: 1, locked_until: null });
  });

  // Break caught (AC-SLICE-000-77, "concurrent wrong passwords at the limit set one lock and record one event"): a read-then-write count,
  // so that concurrent failures lose a count, or step over the threshold without setting the lock, or tip it twice.
  it('lets concurrent failures each add one, set exactly one lock and tip exactly once', async () => {
    const row = await staff();

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        inside((h) => directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY)),
      ),
    );

    const counted = results.filter((r) => r.counted);
    expect(counted).toHaveLength(5);
    expect(counted.filter((r) => r.tipped)).toHaveLength(1);
    expect(counted.map((r) => r.failedAttemptCount).toSorted()).toEqual([1, 2, 3, 4, 5]);
    expect(results.filter((r) => !r.counted)).toHaveLength(7);
    const final = await countOf(row);
    expect(final.failed_attempt_count).toBe(5);
    expect(final.locked_until).toBeInstanceOf(Date);
  });

  it('counts nothing for an identity that does not exist, and for none but the one named', async () => {
    const row = await staff();
    const other = await staff();

    expect(
      await inside((h) =>
        directory.recordFailedAttempt(h, { type: 'STAFF', id: randomUUID() }, 1, POLICY),
      ),
    ).toEqual({ counted: false, reason: 'STALE' });
    await inside((h) =>
      directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY),
    );

    expect((await countOf(row)).failed_attempt_count).toBe(1);
    expect((await countOf(other)).failed_attempt_count).toBe(0);
  });

  it('uses the policy it is given and refuses one that is not whole numbers of one or more', async () => {
    const row = await staff();

    const two = await inside((h) =>
      directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, {
        maxAttempts: 2,
        lockoutMinutes: 1,
      }),
    );
    const tips = await inside((h) =>
      directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, {
        maxAttempts: 2,
        lockoutMinutes: 1,
      }),
    );

    expect(two.counted && two.tipped).toBe(false);
    expect(tips.counted && tips.tipped).toBe(true);
    for (const bad of [
      { maxAttempts: 0, lockoutMinutes: 15 },
      { maxAttempts: 5, lockoutMinutes: 0 },
      { maxAttempts: 2.5, lockoutMinutes: 15 },
      { maxAttempts: 5, lockoutMinutes: Number.NaN },
    ]) {
      await expect(
        inside((h) => directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, bad)),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('writes under the transaction it is given and is undone with it', async () => {
    const row = await staff();

    await expect(
      inside(async (h) => {
        await directory.recordFailedAttempt(h, ref(row), row.credentialGeneration, POLICY);
        throw new Error('the transaction fails after the count');
      }),
    ).rejects.toThrow('the transaction fails after the count');

    expect((await countOf(row)).failed_attempt_count).toBe(0);
  });
});

describe('rehashCredential', () => {
  const NEW_HASH = '$argon2id$v=19$m=65536,t=2,p=1$bmV3$aGFzaA';
  const hashOf = async (row: StaffRow) =>
    (
      await admin.query<{ hash: string; generation: string; established: Date }>(
        'select credential_hash as hash, credential_generation as generation, credential_established_at as established from staff_identity where id = $1',
        [row.id],
      )
    ).rows[0];

  // Break caught: a rehash that is a replacement (the generation or the moment moved, so every session of the identity would end), or one
  // that writes another identity's credential.
  it('replaces the hash of the credential of the generation verified, and changes neither the generation nor the moment', async () => {
    const row = await staff();
    const other = await staff();
    const before = await hashOf(row);

    const written = await inside((h) =>
      directory.rehashCredential(h, ref(row), 1, before?.hash ?? '', NEW_HASH),
    );

    expect(written).toBe(true);
    const after = await hashOf(row);
    expect(after?.hash).toBe(NEW_HASH);
    expect(after?.generation).toBe(before?.generation);
    expect(after?.established.getTime()).toBe(before?.established.getTime());
    expect((await hashOf(other))?.hash).not.toBe(NEW_HASH);
  });

  // Break caught: a hash of the credential that was verified written over a credential that replaced it meanwhile.
  it('writes nothing when the identity holds another credential than the one verified, or none, or does not exist', async () => {
    const replaced = await staff();
    await admin.query(
      `update staff_identity set credential_hash = 'other', credential_established_at = clock_timestamp(), credential_generation = 2 where id = $1`,
      [replaced.id],
    );
    const bare = await staff({ credentialHash: null, credentialEstablishedAt: null });

    expect(
      await inside((h) => directory.rehashCredential(h, ref(replaced), 1, 'other', NEW_HASH)),
    ).toBe(false);
    expect(await inside((h) => directory.rehashCredential(h, ref(bare), 1, 'x', NEW_HASH))).toBe(
      false,
    );
    expect(
      await inside((h) =>
        directory.rehashCredential(h, { type: 'STAFF', id: randomUUID() }, 1, 'x', NEW_HASH),
      ),
    ).toBe(false);
    expect((await hashOf(replaced))?.hash).toBe('other');
    expect((await hashOf(bare))?.hash).toBeNull();
  });

  // Break caught (the audit of 21 October 2026, A01): a rewrite conditional on the generation alone. A rehash does not move the
  // generation, so two instances that verified the same hash and each computed an upgrade (one at a larger cost, one under a newer
  // pepper) would write in whatever order they got the lock, and the older upgrade could replace the newer. The write is conditional on
  // the stored hash being the one that was verified.
  it('keeps a hash that was upgraded since the one verified was read, and writes when it is still the one verified', async () => {
    const row = await staff();
    const verified = (await hashOf(row))?.hash ?? '';
    const NEWEST = '$argon2id$v=19$m=131072,t=3,p=1,pv=2$bmV3ZXN0$aGFzaA';
    // another instance upgraded further and committed first
    await admin.query('update staff_identity set credential_hash = $2 where id = $1', [
      row.id,
      NEWEST,
    ]);

    const older = await inside((h) =>
      directory.rehashCredential(h, ref(row), 1, verified, NEW_HASH),
    );

    expect(older).toBe(false);
    expect((await hashOf(row))?.hash).toBe(NEWEST);
    // and the identity whose stored hash is still the verified one is upgraded
    const untouched = await staff();
    const read = (await hashOf(untouched))?.hash ?? '';
    expect(
      await inside((h) => directory.rehashCredential(h, ref(untouched), 1, read, NEW_HASH)),
    ).toBe(true);
    expect((await hashOf(untouched))?.hash).toBe(NEW_HASH);
  });

  it('refuses a generation that is not one or more and a hash that is not 1 to 1024 characters', async () => {
    const row = await staff();

    for (const generation of [0, -1, 1.5]) {
      await expect(
        inside((h) => directory.rehashCredential(h, ref(row), generation, 'verified', NEW_HASH)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    for (const hash of ['', 'x'.repeat(1025)]) {
      await expect(
        inside((h) => directory.rehashCredential(h, ref(row), 1, 'verified', hash)),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      inside((h) => directory.rehashCredential(h, ref(row), 1, '', NEW_HASH)),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('clearFailedAttempts', () => {
  it('sets the count to zero and ends the lock, for the identity named and no other', async () => {
    const row = await staff();
    const other = await staff();
    for (const each of [row, other]) {
      await admin.query(
        `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
        [each.id],
      );
    }

    await inside((h) => directory.clearFailedAttempts(h, ref(row)));

    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    expect((await countOf(other)).failed_attempt_count).toBe(5);
  });

  it('does nothing to an identity with nothing to clear, and for one that does not exist', async () => {
    const row = await staff();

    await inside((h) => directory.clearFailedAttempts(h, ref(row)));
    await inside((h) => directory.clearFailedAttempts(h, { type: 'STAFF', id: randomUUID() }));

    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
  });
});

describe('displayName', () => {
  it('is the full name of the identity, and null for one that does not exist', async () => {
    const row = await staff({ fullName: 'Ama Mensah' });

    expect(await inside((h) => directory.displayName(h, ref(row)))).toBe('Ama Mensah');
    expect(
      await inside((h) => directory.displayName(h, { type: 'STAFF', id: randomUUID() })),
    ).toBeNull();
  });
});

describe('what is not built (S0.32)', () => {
  // Break caught: a vendor or a rider found as nobody (a success stub): a reference that is not staff fails and says so.
  it('refuses a reference that is not staff for every new operation', async () => {
    for (const type of ['VENDOR', 'RIDER'] as const) {
      const other = { type, id: randomUUID() };
      await expect(inside((h) => directory.readCredentialHash(h, other))).rejects.toBeInstanceOf(
        IdentityDirectoryNotBuiltError,
      );
      await expect(
        inside((h) => directory.recordFailedAttempt(h, other, 1, POLICY)),
      ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
      await expect(
        inside((h) => directory.rehashCredential(h, other, 1, 'hash', 'new')),
      ).rejects.toBeInstanceOf(IdentityDirectoryNotBuiltError);
      await expect(inside((h) => directory.clearFailedAttempts(h, other))).rejects.toBeInstanceOf(
        IdentityDirectoryNotBuiltError,
      );
      await expect(inside((h) => directory.displayName(h, other))).rejects.toBeInstanceOf(
        IdentityDirectoryNotBuiltError,
      );
    }
  });
});

describe('establishCredential resets the count', () => {
  // Break caught (the contract of completeStaffCredentialSetup: "Establishing it resets the credential's failed-attempt count"): a first
  // credential written over a count that an earlier arrangement left, so that the new password starts one failure from a lock.
  it('clears a count the identity held before it had a credential', async () => {
    const bare = await staff({ credentialHash: null, credentialEstablishedAt: null });
    await failures(bare, 3);

    await inside((h) =>
      directory.establishCredential(h, ref(bare), '$argon2id$v=19$m=19456,t=2,p=1$YWJj$ZGVm'),
    );

    expect(await countOf(bare)).toEqual({ failed_attempt_count: 0, locked_until: null });
  });
});

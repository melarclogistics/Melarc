import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MfaChallengeContextError,
  MfaChallengeRequestError,
} from '../../src/platform/auth/mfa/mfa-challenge-errors.js';
import { MfaChallengeStore } from '../../src/platform/auth/mfa/mfa-challenge-store.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.32, the store of MFA challenges (`platform/auth/mfa/`), against a real PostgreSQL as the API's login under the authentication
 * capability: a challenge is issued `PENDING` for an identity on the credential it holds, lives for the lifetime it is given on the
 * database's clock, and ends any other live challenge of the same identity. The second step that spends it is S0.33's.
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let store: MfaChallengeStore;
const clock = new ManualClock();
const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 4 });
  store = new MfaChallengeStore({ clock });
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

const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const issue = (owner: StaffRow, ttlMinutes = 5, credentialGeneration = 1) =>
  inTransaction((handle) =>
    store.issue(handle, { staffIdentityId: owner.id, credentialGeneration, ttlMinutes }),
  );

describe('issue', () => {
  // Break caught: a challenge issued in any state but PENDING, with a wrong code already counted, or for another identity.
  it('issues a PENDING challenge with no wrong code, bound to the identity and the credential', async () => {
    const owner = await identity();

    const challenge = await issue(owner);

    expect(challenge).toMatchObject({
      staffIdentityId: owner.id,
      credentialGeneration: 1,
      state: 'PENDING',
      attemptCount: 0,
    });
    expect(challenge.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(
      (
        await admin.query('select state, attempt_count from mfa_challenge where id = $1', [
          challenge.id,
        ])
      ).rows,
    ).toEqual([{ state: 'PENDING', attempt_count: 0 }]);
  });

  // Break caught (settings.md: `authentication_challenge_ttl_minutes`, 5): a lifetime read from the application's clock (a ManualClock
  // that is days behind the database's here), or one that is not the lifetime it was given.
  it('lives for the lifetime it is given, from the database’s clock and not the application’s', async () => {
    const owner = await identity();
    const databaseBefore = (await admin.query<{ now: Date }>('select clock_timestamp() as now'))
      .rows[0]?.now;

    const challenge = await issue(owner, 7);

    expect(challenge.expiresAt.getTime() - challenge.issuedAt.getTime()).toBe(7 * 60_000);
    // issued now by the database: within seconds of the database's own clock, and nowhere near the manual clock's October 10th
    expect(Math.abs(challenge.issuedAt.getTime() - (databaseBefore?.getTime() ?? 0))).toBeLessThan(
      10_000,
    );
    expect(Math.abs(challenge.issuedAt.getTime() - clock.now().getTime())).toBeGreaterThan(60_000);
  });

  // Break caught: a challenge issued on a credential that is not the identity's current one (the guard refuses it), or for an identity
  // that is not there.
  it('refuses a credential the identity does not hold, and an identity that does not exist', async () => {
    const owner = await identity();

    await expect(issue(owner, 5, 2)).rejects.toSatisfy(
      (error) =>
        serverErrorIn(error)?.message.includes(
          'issued on the credential its identity holds now',
        ) === true,
    );
    await expect(
      inTransaction((handle) =>
        store.issue(handle, {
          staffIdentityId: randomUUID(),
          credentialGeneration: 1,
          ttlMinutes: 5,
        }),
      ),
    ).rejects.toSatisfy(
      (error) =>
        serverErrorIn(error)?.message.includes(
          'issued on the credential its identity holds now',
        ) === true,
    );
  });

  // Break caught (state-machines §: "a challenge ... superseded ... is finished"): two live challenges for one identity, either of which a
  // code could be tried on, so that the three wrong codes of a challenge could be had again by asking for another.
  it('ends the identity’s other live challenge, and no other identity’s', async () => {
    const owner = await identity();
    const other = await identity();
    const first = await issue(owner);
    const bystander = await issue(other);

    const second = await issue(owner);

    const states = async (id: string): Promise<string> =>
      (await admin.query<{ state: string }>('select state from mfa_challenge where id = $1', [id]))
        .rows[0]?.state ?? 'GONE';
    expect(await states(first.id)).toBe('UNUSABLE');
    expect(await states(second.id)).toBe('PENDING');
    expect(await states(bystander.id)).toBe('PENDING');
  });

  it('does not touch a challenge that already ended', async () => {
    const owner = await identity();
    const consumed = await issue(owner);
    await admin.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [consumed.id]);

    await issue(owner);

    expect(
      (
        await admin.query<{ state: string }>('select state from mfa_challenge where id = $1', [
          consumed.id,
        ])
      ).rows[0]?.state,
    ).toBe('CONSUMED');
  });

  it('refuses a request that is not a UUID, a generation of one or more and a lifetime of whole minutes', async () => {
    const owner = await identity();
    const bad = [
      { staffIdentityId: 'not-a-uuid', credentialGeneration: 1, ttlMinutes: 5 },
      { staffIdentityId: owner.id, credentialGeneration: 0, ttlMinutes: 5 },
      { staffIdentityId: owner.id, credentialGeneration: 1.5, ttlMinutes: 5 },
      { staffIdentityId: owner.id, credentialGeneration: 1, ttlMinutes: 0 },
      { staffIdentityId: owner.id, credentialGeneration: 1, ttlMinutes: 2.5 },
    ];

    for (const request of bad) {
      await expect(inTransaction((handle) => store.issue(handle, request))).rejects.toBeInstanceOf(
        MfaChallengeRequestError,
      );
    }
  });

  it('refuses a transaction that is not the authentication capability’s, before it touches a table', async () => {
    const owner = await identity();

    await expect(
      inTransaction(
        (handle) =>
          store.issue(handle, {
            staffIdentityId: owner.id,
            credentialGeneration: 1,
            ttlMinutes: 5,
          }),
        systemContext('rate_limit'),
      ),
    ).rejects.toBeInstanceOf(MfaChallengeContextError);
  });
});

describe('findById', () => {
  it('reads a challenge by its id, and answers null for one that is not there', async () => {
    const owner = await identity();
    const challenge = await issue(owner);

    expect(await inTransaction((handle) => store.findById(handle, challenge.id))).toEqual(
      challenge,
    );
    expect(await inTransaction((handle) => store.findById(handle, randomUUID()))).toBeNull();
    await expect(inTransaction((handle) => store.findById(handle, 'nope'))).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe('the store offers no list and no scan', () => {
  // Break caught (GBT-E5, the port half): a method that reads challenges by anything but the id and the identity's own issue.
  it('has the methods the sign-in needs and no more', () => {
    expect(
      Object.getOwnPropertyNames(MfaChallengeStore.prototype)
        .filter((name) => name !== 'constructor')
        .toSorted(),
    ).toEqual(['consume', 'end', 'findById', 'issue', 'lockForDecision', 'recordWrongCode']);
  });
});

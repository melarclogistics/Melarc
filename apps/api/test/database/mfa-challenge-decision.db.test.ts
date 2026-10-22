import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MfaChallengeExpiredError } from '../../src/platform/auth/mfa/mfa-challenge-errors.js';
import { MfaChallengeStore } from '../../src/platform/auth/mfa/mfa-challenge-store.js';
import type { TransactionHandle } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { serverErrorIn } from '../../src/platform/database/database-failures.js';
import { PostgresStaffIdentityDirectory } from '../../src/staff/postgres.staff-identity-directory.adapter.js';
import { ManualClock } from '../../src/test-support/manual-clock.js';
import { challengeRow, insertChallenge } from './support/credentials.js';
import { delayConsumption, refuseConsumption } from './support/guard-race.js';
import { withHandle } from './support/handle.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.33, the store of MFA challenges as the second step uses it, against a real PostgreSQL as the API's login under the authentication
 * capability: the row is locked and judged on the database's clock, a wrong code is counted by one conditional update that ends the
 * challenge at the maximum, a challenge is consumed once, and one is ended as expired only when its time has passed. And the directory's
 * answer to "is this credential locked now".
 */
let database: TestDatabase;
let admin: pg.Client;
let api: BuiltService;
let store: MfaChallengeStore;
const directory = new PostgresStaffIdentityDirectory();
const authentication = systemContext('authentication');

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  api = buildService(database, { poolMax: 8 });
  store = new MfaChallengeStore({ clock: new ManualClock() });
});

afterAll(async () => {
  await admin.end();
  await api.close();
  await database.drop();
});

const inTransaction = <T>(action: (handle: TransactionHandle) => Promise<T>): Promise<T> =>
  withHandle(api.service, authentication, (handle) => action(handle));
const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow(overrides));
const live = async () => (await insertChallenge(admin, challengeRow((await identity()).id))).id;
const lapsed = async () =>
  (
    await insertChallenge(
      admin,
      challengeRow((await identity()).id, {
        issuedAt: new Date(Date.now() - 10 * 60_000),
        expiresAt: new Date(Date.now() - 5 * 60_000),
      }),
    )
  ).id;
const stateOf = async (id: string): Promise<{ state: string; attempt_count: number }> =>
  (
    await admin.query<{ state: string; attempt_count: number }>(
      'select state, attempt_count from mfa_challenge where id = $1',
      [id],
    )
  ).rows[0] ?? { state: 'GONE', attempt_count: -1 };

describe('lockForDecision', () => {
  // Break caught: a judgement of expiry on the application's clock or on a read taken before the lock, or a challenge read with no lock
  // (two requests for one challenge would decide on the same state).
  it('reads the challenge and whether its time has passed on the database’s clock', async () => {
    const open = await live();
    const gone = await lapsed();

    const found = await inTransaction(async (handle) => ({
      open: await store.lockForDecision(handle, open),
      gone: await store.lockForDecision(handle, gone),
      none: await store.lockForDecision(handle, randomUUID()),
    }));

    expect(found.open).toMatchObject({ expired: false, challenge: { id: open, state: 'PENDING' } });
    expect(found.gone).toMatchObject({ expired: true, challenge: { id: gone, state: 'PENDING' } });
    expect(found.none).toBeNull();
  });

  it('holds the row until the transaction ends, and reads what another transaction committed while it waited', async () => {
    const id = await live();
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from mfa_challenge where id = $1 for no key update', [id]);
      let finished = false;
      const waiting = inTransaction((handle) => store.lockForDecision(handle, id)).then((found) => {
        finished = true;
        return found;
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      expect(finished).toBe(false);

      await holder.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [id]);
      await holder.query('commit');

      expect((await waiting)?.challenge.state).toBe('CONSUMED');
    } finally {
      await holder.end();
    }
  });

  // Break caught (the audit of 21 October 2026, A06): the time read in the statement that takes the lock. A lock held on a row that
  // nobody changes is waited for without the statement running again, so an expression in its list is the time at which the wait began:
  // a challenge that lapsed while the request waited would be judged live. The lock is taken in one statement and the time read in the
  // next.
  it('judges whether the time has passed on the time after a wait for a lock held on an unchanged row', async () => {
    const owner = await identity();
    const lapsing = (
      await insertChallenge(
        admin,
        challengeRow(owner.id, {
          issuedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 1_200),
        }),
      )
    ).id;
    const holder = clientFor(database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from mfa_challenge where id = $1 for no key update', [lapsing]);
      const waiting = inTransaction((handle) => store.lockForDecision(handle, lapsing));
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      await holder.query('commit');

      const found = await waiting;
      expect(found?.expired).toBe(true);
      expect(found?.challenge.state).toBe('PENDING');
    } finally {
      await holder.end();
    }
  });

  it('refuses a transaction that is not the authentication capability’s and an id that is not a UUID', async () => {
    const id = await live();

    await expect(
      withHandle(api.service, systemContext('rate_limit'), (handle) =>
        store.lockForDecision(handle, id),
      ),
    ).rejects.toThrow(/authentication capability/);
    await expect(
      inTransaction((handle) => store.lockForDecision(handle, 'nope')),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe('recordWrongCode', () => {
  // Break caught: a count that does not rise, or a challenge that survives the wrong code that should end it.
  it('counts each wrong code and ends the challenge with the one that reaches the maximum', async () => {
    const id = await live();

    const counts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      counts.push(await inTransaction((handle) => store.recordWrongCode(handle, id, 3)));
    }

    expect(counts.map((challenge) => [challenge?.attemptCount, challenge?.state])).toEqual([
      [1, 'PENDING'],
      [2, 'PENDING'],
      [3, 'UNUSABLE'],
    ]);
    expect(await stateOf(id)).toEqual({ state: 'UNUSABLE', attempt_count: 3 });
  });

  // Break caught: a wrong code counted on a challenge that has ended (a fourth code is a request to a finished challenge), or on one
  // that has expired.
  it('counts nothing on a challenge that is not live: ended, consumed or past its time', async () => {
    const ended = await live();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await inTransaction((handle) => store.recordWrongCode(handle, ended, 3));
    }
    const consumed = await live();
    await admin.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [consumed]);
    const gone = await lapsed();

    expect(await inTransaction((handle) => store.recordWrongCode(handle, ended, 3))).toBeNull();
    expect(await inTransaction((handle) => store.recordWrongCode(handle, consumed, 3))).toBeNull();
    expect(await inTransaction((handle) => store.recordWrongCode(handle, gone, 3))).toBeNull();

    expect(await stateOf(ended)).toEqual({ state: 'UNUSABLE', attempt_count: 3 });
    expect(await stateOf(consumed)).toEqual({ state: 'CONSUMED', attempt_count: 0 });
    expect(await stateOf(gone)).toEqual({ state: 'PENDING', attempt_count: 0 });
  });

  // Break caught: a read-then-write count, so that concurrent wrong codes lose a count or step over the maximum.
  it('lets concurrent wrong codes each add one and none step over the maximum', async () => {
    const id = await live();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        inTransaction((handle) => store.recordWrongCode(handle, id, 3)),
      ),
    );

    expect(
      results
        .filter((challenge) => challenge !== null)
        .map((challenge) => challenge.attemptCount)
        .toSorted(),
    ).toEqual([1, 2, 3]);
    expect(results.filter((challenge) => challenge === null)).toHaveLength(3);
    expect(await stateOf(id)).toEqual({ state: 'UNUSABLE', attempt_count: 3 });
  });

  it('refuses a maximum that is not a whole number of one or more', async () => {
    const id = await live();

    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(
        inTransaction((handle) => store.recordWrongCode(handle, id, bad)),
      ).rejects.toBeInstanceOf(Error);
    }
  });
});

describe('consume', () => {
  // Break caught: a challenge that can be consumed twice, or after it ended or expired.
  it('consumes a live challenge once, and never an ended, expired or consumed one', async () => {
    const id = await live();
    const gone = await lapsed();
    const ended = await live();
    await admin.query(`update mfa_challenge set state = 'UNUSABLE' where id = $1`, [ended]);

    expect(await inTransaction((handle) => store.consume(handle, id))).toBe(true);
    expect(await inTransaction((handle) => store.consume(handle, id))).toBe(false);
    expect(await inTransaction((handle) => store.consume(handle, gone))).toBe(false);
    expect(await inTransaction((handle) => store.consume(handle, ended))).toBe(false);
    expect(await inTransaction((handle) => store.consume(handle, randomUUID()))).toBe(false);
    expect((await stateOf(id)).state).toBe('CONSUMED');
    expect((await stateOf(gone)).state).toBe('PENDING');
  });

  it('lets exactly one of two concurrent consumptions win', async () => {
    const id = await live();

    const results = await Promise.all([
      inTransaction((handle) => store.consume(handle, id)),
      inTransaction((handle) => store.consume(handle, id)),
    ]);

    expect(results.toSorted()).toEqual([false, true]);
  });
});

/**
 * A consumption whose `where` passed and whose time ran out before the table's guard looked at the row (the audit of 21 October 2026,
 * A06): the guard refuses it, the statement fails and the transaction with it. The store raises that refusal, and only that one, as
 * `MfaChallengeExpiredError`; the race is made by a trigger that sleeps in front of the guard and counts the times it was reached, so
 * that a test cannot pass because the time ran out early and was refused somewhere else.
 */
describe('a consumption that meets the expiry after its own check', () => {
  const EXPIRES_IN_MS = 2_500;
  const DELAY_SECONDS = 3.2;
  const asRows = async (statement: string): Promise<readonly unknown[]> =>
    (await admin.query<Record<string, unknown>>(statement)).rows;

  const lapsing = async (): Promise<string> =>
    (
      await insertChallenge(
        admin,
        challengeRow((await identity()).id, {
          issuedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + EXPIRES_IN_MS),
        }),
      )
    ).id;

  // Break caught: the guard's refusal escaping as a generic database failure (an answer of 500 for an ordinary race), or the challenge
  // left consumed by a transaction that did not commit.
  it('is raised as the expiry of the challenge, and the challenge stays as it was', async () => {
    const id = await lapsing();
    const race = await delayConsumption(asRows, 'mfa_challenge', DELAY_SECONDS);
    try {
      await expect(inTransaction((handle) => store.consume(handle, id))).rejects.toBeInstanceOf(
        MfaChallengeExpiredError,
      );
      expect(await race.hits()).toBe(1);
    } finally {
      await race.remove();
    }

    expect(await stateOf(id)).toEqual({ state: 'PENDING', attempt_count: 0 });
  });

  // Break caught: any check violation of the table taken for the expiry (a defect answered as a sign-in that merely lapsed), or the
  // reason of the other table's guard taken for this one's.
  it.each([
    ['states no reason', null, undefined],
    ['states another reason', 'reason=SOMETHING_ELSE', undefined],
    ['states the reason of the grant table', 'reason=GRANT_EXPIRED', undefined],
    ['states the reason of an expiry', 'reason=CHALLENGE_EXPIRED', MfaChallengeExpiredError],
  ])('treats a refusal that %s as what it is', async (_name, detail, typed) => {
    const id = await live();
    const race = await refuseConsumption(asRows, 'mfa_challenge', detail);
    let failure: unknown;
    try {
      failure = await inTransaction((handle) => store.consume(handle, id)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(await race.hits()).toBe(1);
    } finally {
      await race.remove();
    }

    expect(failure).toBeInstanceOf(Error);
    if (typed === undefined) {
      expect(failure).not.toBeInstanceOf(MfaChallengeExpiredError);
      expect(serverErrorIn(failure)?.code).toBe('23514');
    } else {
      expect(failure).toBeInstanceOf(typed);
    }
    expect((await stateOf(id)).state).toBe('PENDING');
    expect(await inTransaction((handle) => store.consume(handle, id))).toBe(true);
  });
});

describe('end', () => {
  // Break caught: a live challenge marked expired (a sign-in ended early), or a challenge that never ends because the time has passed.
  it('ends a live challenge as unusable, and an overdue one as expired, and only so', async () => {
    const open = await live();
    const gone = await lapsed();
    const stillOpen = await live();

    expect(await inTransaction((handle) => store.end(handle, open, 'UNUSABLE'))).toBe(true);
    expect(await inTransaction((handle) => store.end(handle, gone, 'EXPIRED'))).toBe(true);
    // a challenge with time left is not expired by being asked to be
    expect(await inTransaction((handle) => store.end(handle, stillOpen, 'EXPIRED'))).toBe(false);

    expect((await stateOf(open)).state).toBe('UNUSABLE');
    expect((await stateOf(gone)).state).toBe('EXPIRED');
    expect((await stateOf(stillOpen)).state).toBe('PENDING');
  });

  it('does nothing to a challenge that already ended', async () => {
    const id = await live();
    await admin.query(`update mfa_challenge set state = 'CONSUMED' where id = $1`, [id]);

    expect(await inTransaction((handle) => store.end(handle, id, 'UNUSABLE'))).toBe(false);
    expect((await stateOf(id)).state).toBe('CONSUMED');
  });
});

describe('isCredentialLocked', () => {
  const ref = (row: StaffRow) => ({ type: 'STAFF' as const, id: row.id });

  // Break caught: a lock judged on the application's clock, or a lapsed lock read as a lock.
  it('says whether a lock is in force now, on the database’s clock', async () => {
    const open = await identity();
    const locked = await identity();
    const lapsedLock = await identity();
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [locked.id],
    );
    await admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [lapsedLock.id],
    );

    const answers = await inTransaction(async (handle) => [
      await directory.isCredentialLocked(handle, ref(open)),
      await directory.isCredentialLocked(handle, ref(locked)),
      await directory.isCredentialLocked(handle, ref(lapsedLock)),
      await directory.isCredentialLocked(handle, { type: 'STAFF', id: randomUUID() }),
    ]);

    expect(answers).toEqual([false, true, false, false]);
  });
});

import { randomBytes, randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { hotp } from '../../src/platform/auth/crypto/hotp.js';
import type { MfaFactorStore } from '../../src/platform/auth/mfa/mfa-factor-store.js';
import { MFA_FACTOR_STORE } from '../../src/platform/auth/mfa/mfa-providers.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  IDENTITY_DIRECTORY,
  type IdentityDirectory,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/auth/ports/unit-of-work.port.js';
import type { SessionIssuer } from '../../src/platform/auth/sessions/session-issuer.js';
import { SESSION_ISSUER } from '../../src/platform/auth/sessions/session-providers.js';
import type { RequestOptions, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { challengeRow, insertChallenge } from './support/credentials.js';
import { delayConsumption, refuseConsumption } from './support/guard-race.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { systemContext } from './support/rls-fixture.js';
import { seedReferenceData } from './support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.33, `completeStaffMfaSignIn` against the real application and a real PostgreSQL: a privileged identity is taken through the
 * password step (`staffSignIn`, which answers `202` with a challenge) and the second step presents a code. Every request is a real HTTP
 * request from the kit's client. An identity's factor is arranged through the application's own store with a seed the test knows, so a
 * code is computed as an authenticator would, on the application's clock (a `ManualClock` the test moves). What each answer did is
 * read back from a second connection. Every identity and every seed is a throwaway of a disposable database.
 */

const OPS = 'http://127.0.0.1:5173';
const SIGN_IN = '/api/v1/auth/staff/sign-in';
const MFA = '/api/v1/auth/staff/sign-in/mfa';
const PASSWORD = 'correct horse battery staple';

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;
let hasher: Hasher;
let hashed: string;
const hashCalls = vi.fn();

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  kit = await startIntegrationKit(database, { poolMax: 4 });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  hasher = kit.app.app.get<Hasher>(HASHER, { strict: false });
  hashed = await hasher.hash('STAFF_PASSWORD', PASSWORD);
  // Every derivation the application makes from here on is counted: the second step makes none.
  for (const method of ['hash', 'verify', 'verifyAgainstDummy'] as const) {
    const original = hasher[method].bind(hasher) as (...args: unknown[]) => Promise<unknown>;
    (hasher as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      hashCalls(method);
      return original(...args);
    };
  }
});

afterAll(async () => {
  await admin.end();
  await kit.stop();
  await database.drop();
});

beforeEach(() => {
  hashCalls.mockClear();
});

const post = (path: string, body: unknown, options: RequestOptions = {}): Promise<TestResponse> =>
  kit.client.post(path, body, { origin: OPS, ...options });

interface Privileged {
  readonly row: StaffRow;
  /** The seed of the identity's ACTIVE factor, as the authenticator holds it. */
  readonly seed: Uint8Array;
}

/** A privileged identity that has set its password and holds no factor yet. */
async function unenrolled(overrides: Partial<StaffRow> = {}): Promise<{ readonly row: StaffRow }> {
  const row = await insertStaff(
    admin,
    staffRow({ credentialHash: hashed, roleBundleId: BUNDLE_IDS.seniorOps, ...overrides }),
  );
  return { row };
}

/** A privileged identity with a proven factor, whose seed (the authenticator's) the test knows. */
async function privileged(overrides: Partial<StaffRow> = {}): Promise<Privileged> {
  const { row } = await unenrolled(overrides);
  const seed = new Uint8Array(randomBytes(20));
  const factors = kit.app.app.get<MfaFactorStore>(MFA_FACTOR_STORE, { strict: false });
  const unitOfWork = kit.app.app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
  await unitOfWork.run(systemContext('authentication'), async (handle) => {
    const factor = await factors.create(handle, {
      staffIdentityId: row.id,
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed,
    });
    await factors.activate(handle, factor.id, '0');
  });
  return { row, seed };
}

/** The code an authenticator holding `seed` shows on the application's clock, `offset` steps from now. */
function codeFor(seed: Uint8Array, offset = 0): string {
  return hotp(seed, Math.floor(kit.clock.now().getTime() / 30_000) + offset, 6);
}

/** A well-formed code that none of the three steps of the window shows. */
function wrongCode(seed: Uint8Array): string {
  const accepted = new Set([-1, 0, 1].map((offset) => codeFor(seed, offset)));
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const text = String(candidate).padStart(6, '0');
    if (!accepted.has(text)) return text;
  }
  throw new Error('no wrong code exists');
}

/** The password step: the challenge a privileged identity is given. */
async function challengeOf(row: StaffRow, password = PASSWORD): Promise<string> {
  const response = await post(SIGN_IN, { email: row.workEmail, password });
  expect(response.status).toBe(202);
  return (response.json() as { challenge_id: string }).challenge_id;
}

const complete = (challengeId: string, code: string, options: RequestOptions = {}) =>
  post(MFA, { challenge_id: challengeId, code }, options);

interface Answer {
  status: number;
  code: string | undefined;
  message: string | undefined;
  cookies: number;
}
function answerOf(response: TestResponse): Answer {
  const body = response.json() as { code?: string; message?: string };
  return {
    status: response.status,
    code: body.code,
    message: body.message,
    cookies: response.setCookies.length,
  };
}

interface Counts {
  failed_attempt_count: number;
  locked_until: Date | null;
}
const countOf = async (row: StaffRow): Promise<Counts> =>
  (await kit.observe.one<Counts>(
    'select failed_attempt_count, locked_until from staff_identity where id = $1',
    [row.id],
  )) ?? { failed_attempt_count: -1, locked_until: null };
const challengeState = async (id: string): Promise<{ state: string; attempt_count: number }> =>
  (await kit.observe.one<{ state: string; attempt_count: number }>(
    'select state, attempt_count from mfa_challenge where id = $1',
    [id],
  )) ?? { state: 'GONE', attempt_count: -1 };
const sessionsOf = (row: StaffRow): Promise<number> =>
  kit.observe.count('session', { principal_type: 'STAFF', principal_id: row.id });

interface AuditFacts {
  event_code: string;
  outcome: string;
  enhanced: boolean;
  actor_type: string;
  actor_id: string | null;
  object_type: string | null;
  object_id: string | null;
  detail: Record<string, unknown>;
  before_after: Record<string, unknown> | null;
}
const auditOf = async (requestId: string): Promise<AuditFacts[]> =>
  kit.observe.rows<AuditFacts>(
    `select event_code, outcome, enhanced, actor_type, actor_id, object_type, object_id, detail, before_after
       from audit_event where correlation_id = $1 order by recorded_at, id`,
    [requestId],
  );
const requestIdOf = (response: TestResponse): string =>
  (response.json() as { request_id: string }).request_id;

describe('a privileged sign-in is completed by a proven code (AC-SLICE-000-02)', () => {
  // Break caught: a session issued without the code, one that is not privileged for its whole life, cookies that differ from the
  // ordinary sign-in's, or a challenge left open after the session it produced.
  it('is answered 200 with the session and the two cookies, privileged for 480 minutes, and consumes the challenge', async () => {
    const { row, seed } = await privileged();
    await kit.admin.setColumn('staff_identity', 'failed_attempt_count', 3, { id: row.id });
    const challenge = await challengeOf(row);
    // The password step verified a password; the second step is what is counted.
    hashCalls.mockClear();

    const response = await complete(challenge, codeFor(seed));

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.setCookies.map((cookie) => cookie.name).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
    ]);
    expect(response.setCookies.find((c) => c.name === 'melarc_session')).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: undefined,
    });
    expect(response.setCookies.find((c) => c.name === 'melarc_csrf')).toMatchObject({
      httpOnly: false,
      maxAge: undefined,
    });
    const body = response.json() as { principal_id: string; permissions: string[]; state: string };
    expect(body).toMatchObject({ principal_id: row.id, state: 'ACTIVE' });
    expect(body.permissions.length).toBeGreaterThan(0);
    const stored = await kit.observe.one<{
      issued_at: Date;
      expires_at: Date;
      bundle_snapshot: { name: string; privileged: boolean };
    }>('select issued_at, expires_at, bundle_snapshot from session where principal_id = $1', [
      row.id,
    ]);
    expect(stored?.bundle_snapshot).toMatchObject({ name: 'Senior Ops', privileged: true });
    expect((stored?.expires_at.getTime() ?? 0) - (stored?.issued_at.getTime() ?? 0)).toBe(
      480 * 60_000,
    );
    expect(await challengeState(challenge)).toEqual({ state: 'CONSUMED', attempt_count: 0 });
    // A complete sign-in clears the count the password step left standing, and records the step the code proved.
    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    const factor = await kit.observe.one<{ last_verified_counter: string }>(
      `select last_verified_counter from mfa_factor where staff_identity_id = $1 and status = 'ACTIVE'`,
      [row.id],
    );
    expect(factor?.last_verified_counter).toBe(
      String(Math.floor(kit.clock.now().getTime() / 30_000)),
    );
    expect(hashCalls).not.toHaveBeenCalled();
  });

  it('writes auth.mfa.completed and auth.session.issued for the person, and no code, token or seed', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    const code = codeFor(seed);

    const response = await complete(challenge, code);

    const issued = await kit.observe.one<{
      event_code: string;
      enhanced: boolean;
      actor_id: string;
    }>(
      `select event_code, enhanced, actor_id from audit_event where event_code = 'auth.session.issued' and actor_id = $1`,
      [row.id],
    );
    expect(issued).toMatchObject({
      event_code: 'auth.session.issued',
      enhanced: false,
      actor_id: row.id,
    });
    const completed = await kit.observe.one<AuditFacts>(
      `select event_code, outcome, enhanced, actor_type, actor_id, object_type, object_id, detail, before_after
         from audit_event where event_code = 'auth.mfa.completed' and actor_id = $1`,
      [row.id],
    );
    expect(completed).toMatchObject({
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor_type: 'STAFF',
      actor_id: row.id,
    });
    expect(completed?.before_after).toBeNull();
    const everything = JSON.stringify(
      await kit.observe.rows(
        `select detail, related_ids, before_after from audit_event where actor_id = $1 or object_id = $1`,
        [row.id],
      ),
    );
    // The challenge reference is a handle and is named in the events of its own sign-in; it is not a credential, so it is not listed.
    for (const secret of [code, Buffer.from(seed).toString('hex'), PASSWORD]) {
      expect(everything).not.toContain(secret);
    }
    expect(kit.app.logs.text()).not.toContain(code);
    expect(response.status).toBe(200);
  });
});

describe('the challenge is single-use, short-lived and grants nothing (AC-SLICE-000-03)', () => {
  // Break caught: a challenge that can be completed twice (two sessions from one password), or one whose second use is told apart.
  it('refuses a second use of a challenge that was completed with CHALLENGE_UNUSABLE, and issues one session', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    expect((await complete(challenge, codeFor(seed))).status).toBe(200);

    const again = await complete(challenge, codeFor(seed));

    expect(answerOf(again)).toMatchObject({ status: 422, code: 'CHALLENGE_UNUSABLE', cookies: 0 });
    expect(await sessionsOf(row)).toBe(1);
  });

  // Break caught: a challenge past its time that still takes a code, or one told apart from an unusable one by the wrong code.
  it('refuses a challenge older than its lifetime with CHALLENGE_EXPIRED, and marks it expired', async () => {
    const { row, seed } = await privileged();
    const lapsed = await insertChallenge(
      admin,
      challengeRow(row.id, {
        issuedAt: new Date(Date.now() - 10 * 60_000),
        expiresAt: new Date(Date.now() - 5 * 60_000),
      }),
    );

    const response = await complete(lapsed.id, codeFor(seed));

    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'CHALLENGE_EXPIRED',
      cookies: 0,
    });
    expect((await challengeState(lapsed.id)).state).toBe('EXPIRED');
    expect(await sessionsOf(row)).toBe(0);
    // Expired stays expired: the same answer, and still no session, the correct code included.
    expect(answerOf(await complete(lapsed.id, codeFor(seed)))).toMatchObject({
      code: 'CHALLENGE_EXPIRED',
    });
  });

  it('answers a challenge that is not there, a superseded one and a consumed one alike: CHALLENGE_UNUSABLE', async () => {
    const { row, seed } = await privileged();
    const first = await challengeOf(row);
    const second = await challengeOf(row);
    const code = codeFor(seed);

    const unknown = answerOf(await complete(randomUUID(), code));
    const superseded = answerOf(await complete(first, code));

    expect(unknown).toMatchObject({ status: 422, code: 'CHALLENGE_UNUSABLE', cookies: 0 });
    expect(superseded).toEqual(unknown);
    expect(await sessionsOf(row)).toBe(0);
    expect((await challengeState(second)).state).toBe('PENDING');
  });

  // The data half of "a challenge is not a session": the password step stores a challenge and no session. The other half, that a
  // challenge reference presented to an operation that needs a session is `401 SESSION_INVALID`, is held where an operation that needs
  // one can be reached: `authentication-guard.db.test.ts` (the cookie and the bearer credential), and, with the first product operation
  // behind a session (S0.34), the criterion's own words complete there.
  it('makes a challenge and no session: no session exists until the code is proved', async () => {
    const { row } = await privileged();
    const challenge = await challengeOf(row);

    expect(await sessionsOf(row)).toBe(0);
    expect(await kit.observe.count('session', { id: challenge })).toBe(0);
    expect(await kit.observe.count('mfa_challenge', { id: challenge })).toBe(1);
  });
});

/**
 * A challenge that runs out after every look the second step takes (the audit of 21 October 2026, A06). Two interleavings: the table's
 * guard refuses the consumption after the statement's own check passed (a trigger that sleeps in front of the guard makes it so, and
 * counts the times it was reached, so that a test cannot pass because the time ran out before a look), and the time runs out between
 * the decision and the issue, so that the consumption finds nothing to consume. Both are answered `CHALLENGE_EXPIRED`, the challenge is
 * ended as expired, and the issue has rolled back whole; a refusal of the same SQLSTATE that states no expiry is a defect, and is not.
 */
describe('a challenge that runs out between its check and its consumption', () => {
  const rowsOf = async (statement: string): Promise<readonly unknown[]> =>
    (await admin.query<Record<string, unknown>>(statement)).rows;
  const lapsingChallenge = async (row: StaffRow): Promise<string> =>
    (
      await insertChallenge(
        admin,
        challengeRow(row.id, {
          issuedAt: new Date(Date.now() - 60_000),
          expiresAt: new Date(Date.now() + 2_500),
        }),
      )
    ).id;
  const stepOf = async (row: StaffRow): Promise<string | null | undefined> =>
    (
      await kit.observe.one<{ last_verified_counter: string | null }>(
        'select last_verified_counter from mfa_factor where staff_identity_id = $1',
        [row.id],
      )
    )?.last_verified_counter;

  it('is answered CHALLENGE_EXPIRED when the guard refuses the consumption, with the challenge ended and no session', async () => {
    const { row, seed } = await privileged();
    const id = await lapsingChallenge(row);
    const race = await delayConsumption(rowsOf, 'mfa_challenge', 3.2);
    let response: TestResponse;
    let hits: number;
    try {
      response = await complete(id, codeFor(seed));
      hits = await race.hits();
    } finally {
      await race.remove();
    }

    expect(hits).toBe(1);
    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'CHALLENGE_EXPIRED',
      cookies: 0,
    });
    expect(await sessionsOf(row)).toBe(0);
    expect((await challengeState(id)).state).toBe('EXPIRED');
    // what the proof would have spent was not spent, and nothing was counted against the person
    expect(await stepOf(row)).toBe('0');
    expect(await countOf(row)).toMatchObject({ failed_attempt_count: 0, locked_until: null });
    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => [event.event_code, event.detail.cause])).toEqual([
      ['auth.session.failed', 'CHALLENGE_EXPIRED'],
    ]);
  });

  // Break caught: a challenge that lapsed after the decision answered as one that is "unusable" (the sign-in is told to start again
  // with no hint that it was slow) and left PENDING, so that the next code is judged by the decision as an expiry after all.
  it('is answered CHALLENGE_EXPIRED, and the challenge is ended, when its time ran out between the decision and the issue', async () => {
    const { row, seed } = await privileged();
    const id = await challengeOf(row);
    const issuer = kit.app.app.get<SessionIssuer>(SESSION_ISSUER, { strict: false });
    const issue = issuer.issue.bind(issuer);
    issuer.issue = async (...args) => {
      await kit.admin.query('alter table mfa_challenge disable trigger mfa_challenge_update_guard');
      try {
        await kit.admin.query(
          `update mfa_challenge set issued_at = clock_timestamp() - interval '10 minutes',
                                    expires_at = clock_timestamp() - interval '1 second' where id = $1`,
          [id],
        );
      } finally {
        await kit.admin.query(
          'alter table mfa_challenge enable trigger mfa_challenge_update_guard',
        );
      }
      return issue(...args);
    };
    let response: TestResponse;
    try {
      response = await complete(id, codeFor(seed));
    } finally {
      issuer.issue = (...args) => issue(...args);
    }

    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'CHALLENGE_EXPIRED',
      cookies: 0,
    });
    expect(await sessionsOf(row)).toBe(0);
    expect((await challengeState(id)).state).toBe('EXPIRED');
    expect(await stepOf(row)).toBe('0');
    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => event.detail.cause)).toEqual(['CHALLENGE_EXPIRED']);
  });

  // Break caught (the audit: "do not swallow generic SQLSTATE 23514"): every check violation of the table answered as an expired
  // sign-in, which would turn a defect into an ordinary refusal that nobody looks at.
  it.each([
    ['states no reason', null],
    ['states a reason that is no expiry', 'reason=SOMETHING_ELSE'],
    ['states the reason of the grant table', 'reason=GRANT_EXPIRED'],
  ])('does not answer a refusal that %s as an expired sign-in', async (_name, detail) => {
    const { row, seed } = await privileged();
    const id = await challengeOf(row);
    const race = await refuseConsumption(rowsOf, 'mfa_challenge', detail);
    let response: TestResponse;
    let hits: number;
    try {
      response = await complete(id, codeFor(seed));
      hits = await race.hits();
    } finally {
      await race.remove();
    }

    expect(hits).toBe(1);
    expect(response.status).toBe(500);
    expect(answerOf(response).code).not.toBe('CHALLENGE_EXPIRED');
    expect(await sessionsOf(row)).toBe(0);
    expect(await challengeState(id)).toEqual({ state: 'PENDING', attempt_count: 0 });
    expect(await stepOf(row)).toBe('0');
  });
});

describe('a wrong code is refused and counted twice (AC-SLICE-000-79)', () => {
  // Break caught: a wrong code that is not counted against the challenge, or not against the identity, or one that issues a session.
  it('is refused with MFA_PROOF_INVALID, counts once against the challenge and once against the identity', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);

    const response = await complete(challenge, wrongCode(seed));

    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'MFA_PROOF_INVALID',
      cookies: 0,
    });
    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 1 });
    expect((await countOf(row)).failed_attempt_count).toBe(1);
    expect(await sessionsOf(row)).toBe(0);
  });

  // Break caught: a challenge that survives a fourth wrong code, or one that answers the correct code after the third wrong one.
  it('ends the challenge at the third wrong code: every code after it, the correct one included, is CHALLENGE_UNUSABLE', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    const wrong = wrongCode(seed);

    const answers = [];
    for (let attempt = 1; attempt <= 3; attempt += 1)
      answers.push(answerOf(await complete(challenge, wrong)));
    const correct = answerOf(await complete(challenge, codeFor(seed)));

    expect(answers.map((answer) => answer.code)).toEqual([
      'MFA_PROOF_INVALID',
      'MFA_PROOF_INVALID',
      'MFA_PROOF_INVALID',
    ]);
    expect(correct).toMatchObject({ status: 422, code: 'CHALLENGE_UNUSABLE' });
    expect(await challengeState(challenge)).toEqual({ state: 'UNUSABLE', attempt_count: 3 });
    expect((await countOf(row)).failed_attempt_count).toBe(3);
    expect(await sessionsOf(row)).toBe(0);
  });

  // Break caught: wrong codes guessed across fresh challenges at no cost to the identity (the count the two steps share).
  it('adds each wrong code of any challenge to the identity’s count, so fresh challenges buy no fresh guesses', async () => {
    const { row, seed } = await privileged();
    const wrong = wrongCode(seed);

    await complete(await challengeOf(row), wrong);
    await complete(await challengeOf(row), wrong);
    await complete(await challengeOf(row), wrong);

    expect((await countOf(row)).failed_attempt_count).toBe(3);
  });

  // Break caught (AC-126): a code accepted twice in its window (a replay), or a replay that is not counted like any wrong code.
  it('refuses a code already used inside its window with MFA_PROOF_INVALID, on a later challenge too', async () => {
    const { row, seed } = await privileged();
    const code = codeFor(seed);
    expect((await complete(await challengeOf(row), code)).status).toBe(200);
    const later = await challengeOf(row);

    const replay = await complete(later, code);

    expect(answerOf(replay)).toMatchObject({ status: 422, code: 'MFA_PROOF_INVALID' });
    expect(await challengeState(later)).toEqual({ state: 'PENDING', attempt_count: 1 });
    expect((await countOf(row)).failed_attempt_count).toBe(1);
    expect(await sessionsOf(row)).toBe(1);
  });

  it('writes auth.session.failed with the cause WRONG_MFA_CODE at the factor MFA_CODE, and the enhanced auth.mfa.failed beside it', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);

    const response = await complete(challenge, wrongCode(seed));

    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => event.event_code).toSorted()).toEqual([
      'auth.mfa.failed',
      'auth.session.failed',
    ]);
    const failed = events.find((event) => event.event_code === 'auth.session.failed');
    expect(failed?.detail).toMatchObject({ cause: 'WRONG_MFA_CODE', factor: 'MFA_CODE' });
    expect(failed).toMatchObject({
      object_id: row.id,
      object_type: 'StaffIdentity',
      enhanced: false,
    });
    const mfaFailed = events.find((event) => event.event_code === 'auth.mfa.failed');
    expect(mfaFailed).toMatchObject({ enhanced: true, outcome: 'REJECTED', object_id: row.id });
    expect(mfaFailed?.before_after).toBeNull();
    expect(JSON.stringify(events)).not.toContain(Buffer.from(seed).toString('hex'));
  });
});

describe('a lock reached at the second factor is announced only to someone who proved the password (AC-SLICE-000-80)', () => {
  // Break caught: the lock announced to a caller who has not proved the password, or not announced to one who has, or the fifth
  // failure (a wrong code) not setting the lock the password steps counted towards.
  it('sets the lock on the wrong code that is the fifth failure, then answers the correct code CREDENTIAL_LOCKED', async () => {
    const { row, seed } = await privileged();
    await kit.admin.setColumn('staff_identity', 'failed_attempt_count', 4, { id: row.id });
    const challenge = await challengeOf(row);

    const wrong = await complete(challenge, wrongCode(seed));
    const correct = await complete(challenge, codeFor(seed));
    const password = await post(SIGN_IN, { email: row.workEmail, password: PASSWORD });

    expect(answerOf(wrong)).toMatchObject({ status: 422, code: 'MFA_PROOF_INVALID' });
    expect(answerOf(correct)).toMatchObject({ status: 422, code: 'CREDENTIAL_LOCKED', cookies: 0 });
    // a new password sign-in answers INVALID_CREDENTIALS with no mention of a lock
    expect(answerOf(password)).toMatchObject({ status: 422, code: 'INVALID_CREDENTIALS' });
    expect(JSON.stringify(password.json())).not.toMatch(/lock/i);
    expect((await countOf(row)).locked_until).toBeInstanceOf(Date);
    expect(await sessionsOf(row)).toBe(0);
    const tipped = await auditOf(requestIdOf(wrong));
    expect(tipped.map((event) => event.event_code).toSorted()).toEqual([
      'auth.lockout.applied',
      'auth.mfa.failed',
      'auth.session.failed',
    ]);
    expect(
      tipped.find((event) => event.event_code === 'auth.lockout.applied')?.detail,
    ).toMatchObject({ factor: 'MFA_CODE' });
    const inside = await auditOf(requestIdOf(correct));
    expect(inside.map((event) => event.detail.cause)).toEqual(['LOCKED_OUT']);
    expect(inside.map((event) => event.event_code)).toEqual(['auth.session.failed']);
  });

  it('neither verifies a code nor counts anything while a lock is in force', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    await kit.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [row.id],
    );
    const before = await countOf(row);

    const answer = await complete(challenge, wrongCode(seed));

    expect(answerOf(answer)).toMatchObject({ code: 'CREDENTIAL_LOCKED' });
    expect(await countOf(row)).toEqual(before);
    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
  });

  // Break caught: the lock read once, at the decision. A correct code whose request was in flight when the fifth failure set the lock
  // would be given its session, and the clear that the session issue makes would wipe the lock it never saw. The decision has committed
  // when the session is asked for, so setting the lock as the issue is called is the interleaving made certain (the decision holds the
  // identity's lock until it commits, so nothing can be set from inside it).
  it('answers CREDENTIAL_LOCKED, spends nothing and keeps the lock, for a correct code in flight when the lock was set', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    const issuer = kit.app.app.get<SessionIssuer>(SESSION_ISSUER, { strict: false });
    const issue = issuer.issue.bind(issuer);
    issuer.issue = async (...args) => {
      await kit.admin.query(
        `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
        [row.id],
      );
      return issue(...args);
    };
    let answer: TestResponse;
    try {
      answer = await complete(challenge, codeFor(seed));
    } finally {
      issuer.issue = (...args) => issue(...args);
    }

    expect(answerOf(answer)).toMatchObject({ status: 422, code: 'CREDENTIAL_LOCKED', cookies: 0 });
    expect(await sessionsOf(row)).toBe(0);
    const count = await countOf(row);
    expect(count.failed_attempt_count).toBe(5);
    expect(count.locked_until).toBeInstanceOf(Date);
    // nothing the proof would have spent was spent: the challenge is live and the step is the one the enrolment recorded
    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
    expect(
      (
        await kit.observe.one<{ last_verified_counter: string }>(
          'select last_verified_counter from mfa_factor where staff_identity_id = $1',
          [row.id],
        )
      )?.last_verified_counter,
    ).toBe('0');
    const events = await auditOf(requestIdOf(answer));
    expect(events.map((event) => event.detail.cause)).toEqual(['LOCKED_OUT']);
  });
});

describe('a privileged identity with no ACTIVE factor is stopped at the second step (AC-SLICE-000-123, -32)', () => {
  // Break caught: a session for an identity that never proved a factor; a refusal that counts as a wrong code (a person who has
  // never been given an authenticator would be locked out of the product); a refusal that tells nothing in the audit.
  it('answers 403 MFA_ENROLMENT_REQUIRED, with no session, no cookie and no count, however often it is asked', async () => {
    const { row } = await unenrolled();
    const answers = [];
    // Nine sign-ins and nine challenges (the staff sign-in is limited to ten a minute), each asked twice.
    for (let round = 1; round <= 9; round += 1) {
      const challenge = await challengeOf(row);
      answers.push(answerOf(await complete(challenge, '123456')));
      answers.push(answerOf(await complete(challenge, '654321')));
    }

    for (const answer of answers) {
      expect(answer).toMatchObject({ status: 403, code: 'MFA_ENROLMENT_REQUIRED', cookies: 0 });
    }
    expect(answers).toHaveLength(18);
    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    expect(await sessionsOf(row)).toBe(0);
  });

  it('leaves the challenge of such an identity PENDING with no wrong code, however often it is asked', async () => {
    const { row } = await unenrolled();
    const challenge = await challengeOf(row);

    for (let attempt = 1; attempt <= 6; attempt += 1) await complete(challenge, '123456');

    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
  });

  it('is audited with the cause MFA_ENROLMENT_REQUIRED at the MFA_CODE factor, and no auth.mfa.failed', async () => {
    const { row } = await unenrolled();
    const challenge = await challengeOf(row);

    const response = await complete(challenge, '123456');

    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => event.event_code)).toEqual(['auth.session.failed']);
    expect(events[0]?.detail).toMatchObject({
      cause: 'MFA_ENROLMENT_REQUIRED',
      factor: 'MFA_CODE',
    });
    expect(events[0]).toMatchObject({ object_id: row.id });
  });

  it('is the answer of an identity whose only factor is PENDING too', async () => {
    const { row } = await unenrolled();
    await kit.admin.query(
      `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version, secret_envelope_version, created_by_purpose)
       values (gen_random_uuid(), $1, 'TOTP', 'PENDING', $2, $3, 1, 1, 'STAFF_CREDENTIAL_SETUP')`,
      [row.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
    );
    const challenge = await challengeOf(row);

    expect(answerOf(await complete(challenge, '123456'))).toMatchObject({
      status: 403,
      code: 'MFA_ENROLMENT_REQUIRED',
    });
  });
});

describe('a TOTP code is six digits, single-use and accepted one step either side (AC-SLICE-000-126)', () => {
  // Break caught: a code that is not six decimal digits reaching the verifier, or one echoed back.
  it.each([['12345'], ['1234567'], ['12345a'], [' 123456'], ['１２３４５６']])(
    'refuses %j at the schema with VALIDATION_FAILED, before the challenge is looked at',
    async (code) => {
      const { row } = await privileged();
      const challenge = await challengeOf(row);

      const response = await complete(challenge, code);

      expect(response.status).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
      expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    },
  );

  // Break caught: a window of the wrong width (a code two steps away accepted, or the step before refused).
  it('accepts the step before and the step after, and refuses a code two steps away', async () => {
    const before = await privileged();
    const after = await privileged();
    const far = await privileged();
    const past = await privileged();

    expect((await complete(await challengeOf(before.row), codeFor(before.seed, -1))).status).toBe(
      200,
    );
    expect((await complete(await challengeOf(after.row), codeFor(after.seed, 1))).status).toBe(200);
    const ahead = answerOf(await complete(await challengeOf(far.row), codeFor(far.seed, 2)));
    const behind = answerOf(await complete(await challengeOf(past.row), codeFor(past.seed, -2)));

    expect(ahead).toMatchObject({ status: 422, code: 'MFA_PROOF_INVALID' });
    expect(behind).toMatchObject({ status: 422, code: 'MFA_PROOF_INVALID' });
  });

  it('refuses a body that is not exactly a challenge reference and a code', async () => {
    for (const body of [
      {},
      { challenge_id: randomUUID() },
      { code: '123456' },
      { challenge_id: 'not-a-uuid', code: '123456' },
      { challenge_id: randomUUID(), code: '123456', extra: true },
    ]) {
      const response = await post(MFA, body);
      expect(response.status).toBe(400);
      expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('what the second step does not do', () => {
  // Break caught: a hash computed for a step that has no password: the work of this step is a code, and no slot is taken.
  it('computes no hash of any kind', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    hashCalls.mockClear();

    await complete(challenge, wrongCode(seed));
    await complete(challenge, codeFor(seed));

    expect(hashCalls).not.toHaveBeenCalled();
  });

  // Break caught: a code accepted for an identity that was suspended, or whose password was replaced, after the challenge was issued:
  // the challenge is bound to the credential that was proved and to an identity that can still sign in.
  it('refuses INVALID_CREDENTIALS, with no session, when the identity was suspended after the challenge was issued', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    await kit.admin.setColumn('staff_identity', 'status', 'SUSPENDED', { id: row.id });

    const response = await complete(challenge, codeFor(seed));

    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'INVALID_CREDENTIALS',
      cookies: 0,
    });
    expect(await sessionsOf(row)).toBe(0);
    expect((await challengeState(challenge)).state).toBe('UNUSABLE');
  });

  it('refuses INVALID_CREDENTIALS, with no session, when the password was replaced after the challenge was issued', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    await kit.admin.query(
      `update staff_identity set credential_hash = $2, credential_established_at = clock_timestamp(), credential_generation = credential_generation + 1 where id = $1`,
      [row.id, hashed],
    );

    const response = await complete(challenge, codeFor(seed));

    expect(answerOf(response)).toMatchObject({
      status: 422,
      code: 'INVALID_CREDENTIALS',
      cookies: 0,
    });
    expect(await sessionsOf(row)).toBe(0);
  });

  // Break caught (the lock order of SECURITY_DESIGN.md §13.10a, and AC-SLICE-000-88's spirit for the challenge): two completions of
  // one challenge with its correct code, one winner, one session, one challenge consumed.
  it('lets exactly one of two concurrent completions of one challenge win', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    const code = codeFor(seed);

    const responses = await Promise.all([complete(challenge, code), complete(challenge, code)]);

    const statuses = responses.map((response) => response.status).toSorted();
    expect(statuses).toEqual([200, 422]);
    expect(await sessionsOf(row)).toBe(1);
    expect((await challengeState(challenge)).state).toBe('CONSUMED');
    const losers = responses.filter((response) => response.status === 422);
    expect(losers.map((response) => answerOf(response).code)).toEqual(['CHALLENGE_UNUSABLE']);
  });

  // Break caught: wrong codes that race and lose a count (the identity's count or the challenge's).
  it('adds every concurrent wrong code to the challenge and to the identity', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    const wrong = wrongCode(seed);

    const responses = await Promise.all([complete(challenge, wrong), complete(challenge, wrong)]);

    for (const response of responses)
      expect(answerOf(response)).toMatchObject({ code: 'MFA_PROOF_INVALID' });
    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 2 });
    expect((await countOf(row)).failed_attempt_count).toBe(2);
  });
});

describe('it is a browser pre-session mutation of the Ops Portal, limited by challenge', () => {
  // Break caught: an Origin check applied after the code was examined or counted.
  it.each([
    ['no Origin', null],
    ['a foreign Origin', 'https://evil.example'],
    ['the Origin of the Vendor PWA', 'http://127.0.0.1:5174'],
    ['the literal null', 'null'],
  ])(
    'refuses %s with 403 CSRF_VALIDATION_FAILED before the code is examined or counted',
    async (_name, origin) => {
      const { row, seed } = await privileged();
      const challenge = await challengeOf(row);

      const response = await complete(challenge, wrongCode(seed), { origin });

      expect(response.status).toBe(403);
      expect((response.json() as { code: string }).code).toBe('CSRF_VALIDATION_FAILED');
      expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    },
  );

  // Break caught: a limit keyed on something a caller can vary for free (the network address) or only on references that exist.
  it('refuses the eleventh request of a minute for one challenge reference with RATE_LIMITED, examining nothing', async () => {
    const { row } = await unenrolled();
    const challenge = await challengeOf(row);
    for (let attempt = 1; attempt <= 10; attempt += 1) await complete(challenge, '123456');
    const before = await countOf(row);

    const refused = await complete(challenge, '123456');

    expect(refused.status).toBe(429);
    expect((refused.json() as { code: string }).code).toBe('RATE_LIMITED');
    expect(refused.header('retry-after')).toBeNull();
    expect(await countOf(row)).toEqual(before);
    // another reference has a key of its own, and an invented one is limited exactly as a real one is
    const invented = randomUUID();
    const results: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1)
      results.push((await complete(invented, '123456')).status);
    expect(results.slice(0, 10).every((status) => status === 422)).toBe(true);
    expect(results[10]).toBe(429);
  });

  it('needs no session and no CSRF token: there is no session to hold one', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);

    expect((await complete(challenge, codeFor(seed), { csrf: 'omit' })).status).toBe(200);
  });
});

/**
 * The answer of a sign-in that issues a session is built **in the issuing transaction** (the audit of 21 October 2026, A04). Built after
 * the commit in a transaction of its own, a failure to read the hubs or the display name left the session committed, the proof spent and
 * the success event written, and answered the person with a failure and no credential. The read of the display name is made to fail here,
 * which is the last thing the transaction does: everything it wrote goes with it.
 */
describe('a second step whose answer cannot be built', () => {
  /** Makes the directory fail to name the principal, the read the answer is built from, for as long as `work` runs. */
  async function whileNamingFails<T>(work: () => Promise<T>): Promise<T> {
    const directory = kit.app.app.get<IdentityDirectory>(IDENTITY_DIRECTORY, { strict: false });
    const original = directory.displayName.bind(directory);
    directory.displayName = () => Promise.reject(new Error('the display name could not be read'));
    try {
      return await work();
    } finally {
      directory.displayName = (...args) => original(...args);
    }
  }
  const issuedEvents = (row: StaffRow): Promise<number> =>
    kit.observe.count('audit_event', { event_code: 'auth.session.issued', actor_id: row.id });
  const completedEvents = (row: StaffRow): Promise<number> =>
    kit.observe.count('audit_event', { event_code: 'auth.mfa.completed', actor_id: row.id });

  // Break caught: the answer built after the commit: the session, the consumed challenge, the recorded step, the cleared count and the
  // success events all committed for a person who is answered with a failure, whose code is then spent and whose challenge is gone.
  it('commits no session, no consumed challenge, no recorded step, no cleared count and no event, and the code can be presented again', async () => {
    const { row, seed } = await privileged();
    const challenge = await challengeOf(row);
    await kit.admin.query('update staff_identity set failed_attempt_count = 2 where id = $1', [
      row.id,
    ]);
    const code = codeFor(seed);

    const failed = await whileNamingFails(() => complete(challenge, code));

    expect(failed.status).toBe(500);
    expect(failed.setCookies).toEqual([]);
    expect(await sessionsOf(row)).toBe(0);
    expect(await challengeState(challenge)).toEqual({ state: 'PENDING', attempt_count: 0 });
    expect(
      (
        await kit.observe.one<{ last_verified_counter: string }>(
          'select last_verified_counter from mfa_factor where staff_identity_id = $1',
          [row.id],
        )
      )?.last_verified_counter,
    ).toBe('0');
    expect((await countOf(row)).failed_attempt_count).toBe(2);
    expect(await issuedEvents(row)).toBe(0);
    expect(await completedEvents(row)).toBe(0);

    // Nothing was spent, so the same challenge and the same code complete the sign-in.
    const again = await complete(challenge, code);
    expect(again.status).toBe(200);
    expect(await sessionsOf(row)).toBe(1);
    expect(await challengeState(challenge)).toMatchObject({ state: 'CONSUMED' });
    expect((await countOf(row)).failed_attempt_count).toBe(0);
    expect(await completedEvents(row)).toBe(1);
  });
});

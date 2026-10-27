import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HASH_ADMISSION,
  type HashAdmission,
  type HashSlot,
} from '../../src/platform/auth/ports/hash-admission.port.js';
import { Argon2Hasher } from '../../src/platform/auth/crypto/argon2.hasher.adapter.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  IDENTITY_DIRECTORY,
  type IdentityDirectory,
} from '../../src/platform/auth/ports/identity-directory.port.js';
import type { AppConfig } from '../../src/platform/config/load-config.js';
import { APP_CONFIG } from '../../src/platform/platform.tokens.js';
import type { RequestOptions, TestResponse } from '../../src/test-support/test-client.js';
import { sameShape } from '../../src/test-support/work-shape.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { backendPidOf, waitUntilBlockedBy } from './support/lock-wait.js';
import { seedReferenceData } from './support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.32, `staffSignIn` against the real application and a real PostgreSQL: every request is a real HTTP request from the kit's client,
 * as a page of the Ops Portal makes it. Identities are arranged as the administrator, with the password hashed by the application's own
 * hasher; what the operation did is read back from a second connection. The hasher's own methods are watched, because "one derivation
 * for each branch that reached a hash, and none for a request the limiter or the slots refused" is a claim about work and not about
 * answers (SECURITY_DESIGN.md §13.4b, §13.4c). Every identity is a throwaway of a disposable database.
 */

const OPS = 'http://127.0.0.1:5173';
const SIGN_IN = '/api/v1/auth/staff/sign-in';
const PASSWORD = 'correct horse battery staple';
/** An older cost than the write profile's (65536 KiB, 2 passes), accepted by the kit's configuration. */
const OLDER_COST = '8192:2:1';

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;
let hasher: Hasher;
let hashed: string;
const calls = { verify: vi.fn(), dummy: vi.fn(), hash: vi.fn() };

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    // One older cost is accepted, so that a hash made at it is verified and then replaced (OB-39).
    env: { ARGON2_ACCEPTED_PROFILES: OLDER_COST },
  });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  // The application's own hasher, watched: each method is replaced on the one instance by a wrapper that counts and calls through.
  hasher = kit.app.app.get<Hasher>(HASHER, { strict: false });
  hashed = await hasher.hash('STAFF_PASSWORD', PASSWORD);
  const original = {
    verify: hasher.verify.bind(hasher),
    dummy: hasher.verifyAgainstDummy.bind(hasher),
    hash: hasher.hash.bind(hasher),
  };
  hasher.verify = (...args) => {
    calls.verify(...args);
    return original.verify(...args);
  };
  hasher.verifyAgainstDummy = (...args) => {
    calls.dummy(...args);
    return original.dummy(...args);
  };
  hasher.hash = (...args) => {
    calls.hash(...args);
    return original.hash(...args);
  };
});

afterAll(async () => {
  await admin.end();
  await kit.stop();
  await database.drop();
});

beforeEach(() => {
  calls.verify.mockClear();
  calls.dummy.mockClear();
  calls.hash.mockClear();
});

const post = (body: unknown, options: RequestOptions = {}): Promise<TestResponse> =>
  kit.client.post(SIGN_IN, body, { origin: OPS, ...options });

const identity = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  insertStaff(admin, staffRow({ credentialHash: hashed, ...overrides }));
const privileged = (overrides: Partial<StaffRow> = {}): Promise<StaffRow> =>
  identity({ roleBundleId: BUNDLE_IDS.seniorOps, ...overrides });
const signIn = (row: StaffRow, password = PASSWORD, options: RequestOptions = {}) =>
  post({ email: row.workEmail, password }, options);

const WRONG = 'not the right password';

interface Answer {
  status: number;
  code: string | undefined;
  message: string | undefined;
  keys: string[];
  cookies: number;
}

function answerOf(response: TestResponse): Answer {
  const body = response.json() as { code?: string; message?: string };
  return {
    status: response.status,
    code: body.code,
    message: body.message,
    keys: Object.keys(body).toSorted(),
    cookies: response.setCookies.length,
  };
}

interface Count {
  failed_attempt_count: number;
  locked_until: Date | null;
}
const countOf = async (row: StaffRow): Promise<Count> =>
  (await kit.observe.one<Count>(
    'select failed_attempt_count, locked_until from staff_identity where id = $1',
    [row.id],
  )) ?? { failed_attempt_count: -1, locked_until: null };

/** The database's clock now, as text with its microseconds (a JavaScript date keeps milliseconds only). */
const databaseNow = async (): Promise<string> =>
  (await kit.observe.one<{ now: string }>('select clock_timestamp()::text as now'))?.now ?? '';

const sessionsOf = (row: StaffRow): Promise<number> =>
  kit.observe.count('session', { principal_type: 'STAFF', principal_id: row.id });
const challengesOf = (row: StaffRow) =>
  kit.observe.rows<{
    id: string;
    state: string;
    credential_generation: string;
    attempt_count: number;
    issued_at: Date;
    expires_at: Date;
  }>(
    'select id, state, credential_generation, attempt_count, issued_at, expires_at from mfa_challenge where staff_identity_id = $1 order by issued_at, id',
    [row.id],
  );

interface AuditFacts {
  event_code: string;
  outcome: string;
  enhanced: boolean;
  actor_type: string;
  actor_id: string | null;
  object_type: string | null;
  object_id: string | null;
  detail: Record<string, unknown>;
  related_ids: Record<string, unknown> | null;
}
/** The events of one request, by the request id the answer names. */
const auditOf = async (requestId: string): Promise<AuditFacts[]> =>
  kit.observe.rows<AuditFacts>(
    `select event_code, outcome, enhanced, actor_type, actor_id, object_type, object_id, detail, related_ids
       from audit_event where correlation_id = $1 order by recorded_at, id`,
    [requestId],
  );
const requestIdOf = (response: TestResponse): string =>
  (response.json() as { request_id: string }).request_id;

const INVALID = { status: 422, code: 'INVALID_CREDENTIALS' };

describe('an Ops Staff member signs in (AC-SLICE-000-01)', () => {
  // Break caught: a session that is not the one the contract describes, cookies that are not the two the contract names or are
  // readable where they must not be, a token in the body, or a response a cache may keep.
  it('is answered 200 with a session of the contract’s shape and the two cookies, and the session is stored', async () => {
    const row = await identity();

    const response = await signIn(row);

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      principal_type: 'STAFF',
      principal_id: row.id,
      state: 'ACTIVE',
      authorized_hub_ids: [],
      principal_display_name: row.fullName,
      authorized_hubs: [],
    });
    expect(Object.keys(body).toSorted()).toEqual(
      [
        'authorized_hub_ids',
        'authorized_hubs',
        'expires_at',
        'id',
        'issued_at',
        'last_activity_at',
        'permissions',
        'principal_display_name',
        'principal_id',
        'principal_type',
        'state',
      ].toSorted(),
    );
    const stored = await kit.observe.one<{
      id: string;
      bundle_snapshot: { name: string; grants: { permission: string }[] };
      issued_at: Date;
      expires_at: Date;
    }>('select id, bundle_snapshot, issued_at, expires_at from session where principal_id = $1', [
      row.id,
    ]);
    expect(body.id).toBe(stored?.id);
    // The permissions are the keys of the snapshot, never role names, and the credentials are in no body.
    expect(body.permissions).toEqual(
      stored?.bundle_snapshot.grants.map((grant) => grant.permission).toSorted(),
    );
    expect(JSON.stringify(body)).not.toMatch(/token|secret|password|hash/i);
    // Ops Staff hold the standard tier: 720 minutes (settings.md §7.5).
    expect((stored?.expires_at.getTime() ?? 0) - (stored?.issued_at.getTime() ?? 0)).toBe(
      720 * 60_000,
    );

    const [session, csrf] = [
      response.setCookies.find((c) => c.name === 'melarc_session'),
      response.setCookies.find((c) => c.name === 'melarc_csrf'),
    ];
    expect(response.setCookies).toHaveLength(2);
    expect(session).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: undefined,
      expires: undefined,
    });
    expect(csrf).toMatchObject({
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: undefined,
      expires: undefined,
    });
    expect(session?.value).not.toBe(csrf?.value);
    expect(kit.app.logs.text()).not.toContain(PASSWORD);
    expect(kit.app.logs.text()).not.toContain(session?.value ?? 'x');
  });

  it('snapshots the bundle and the hubs of the identity into the session and names the actor in the audit', async () => {
    const hub =
      (await kit.observe.one<{ id: string }>('select id from hub order by name limit 1'))?.id ?? '';
    const row = await identity({ primaryHubId: hub });

    const response = await signIn(row);

    expect(response.status).toBe(200);
    const stored = await kit.observe.one<{
      bundle_id: string;
      authorized_hub_ids: string[];
      bundle_snapshot: { name: string };
    }>(
      'select bundle_id, authorized_hub_ids, bundle_snapshot from session where principal_id = $1',
      [row.id],
    );
    expect(stored).toMatchObject({ bundle_id: BUNDLE_IDS.opsStaff, authorized_hub_ids: [hub] });
    expect(stored?.bundle_snapshot.name).toBe('Ops Staff');
    expect((response.json() as { authorized_hubs: unknown[] }).authorized_hubs).toHaveLength(1);
    const event = await kit.observe.one<{ actor_type: string; actor_id: string }>(
      `select actor_type, actor_id from audit_event where event_code = 'auth.session.issued' and actor_id = $1`,
      [row.id],
    );
    expect(event).toEqual({ actor_type: 'STAFF', actor_id: row.id });
  });

  // Break caught (SECURITY_DESIGN.md §13.4a: "NFKC is applied before hashing, the same at set time and at verify time"): a password
  // hashed as typed at sign-in while setup hashed its NFKC form, so a person who set a compatibility form could never sign in.
  it('verifies the NFKC form of the password, the form the setup hashed', async () => {
    const typed = '\uFB01nal \uFB01nish \uFB01ne'; // 14 code points as sent, 17 after NFKC
    const row = await identity({
      credentialHash: await hasher.hash('STAFF_PASSWORD', typed.normalize('NFKC')),
    });
    calls.hash.mockClear();

    const response = await signIn(row, typed);

    expect(response.status).toBe(200);
  });

  it('compares the address in its canonical form: trimmed, lower-cased as a whole, nothing folded', async () => {
    const row = await identity();

    expect(
      (await post({ email: `  ${row.workEmail.toUpperCase()} \n`, password: PASSWORD })).status,
    ).toBe(200);
  });

  // Break caught: a success that leaves the count it found (a thief's four wrong passwords still standing against the owner), or that
  // runs a derivation for a branch that needs none.
  it('clears the failed-attempt count on a complete sign-in, with one verification and no dummy', async () => {
    const row = await identity();
    await kit.admin.setColumn('staff_identity', 'failed_attempt_count', 4, { id: row.id });

    const response = await signIn(row);

    expect(response.status).toBe(200);
    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    expect(calls.verify).toHaveBeenCalledTimes(1);
    expect(calls.dummy).not.toHaveBeenCalled();
  });
});

describe('a privileged identity is given a challenge and no session (AC-SLICE-000-02, the first step)', () => {
  // Break caught: a session, or any cookie, issued to a privileged identity before a code is proven; a body that names more than the
  // challenge's two members.
  it('is answered 202 with the challenge alone: no session, no cookie, a row that grants nothing', async () => {
    const row = await privileged();

    const response = await signIn(row);

    expect(response.status).toBe(202);
    expect(response.header('set-cookie')).toBeNull();
    expect(response.setCookies).toEqual([]);
    const body = response.json() as {
      challenge_id: string;
      expires_at: string;
      trusted_browser_days: number;
    };
    // The challenge says how many days a browser remembered at the next step stays trusted: the server's number, never the screen's.
    expect(Object.keys(body).toSorted()).toEqual([
      'challenge_id',
      'expires_at',
      'trusted_browser_days',
    ]);
    expect(body.trusted_browser_days).toBe(7);
    expect(await sessionsOf(row)).toBe(0);
    const [challenge] = await challengesOf(row);
    expect(challenge).toMatchObject({
      id: body.challenge_id,
      state: 'PENDING',
      credential_generation: '1',
      attempt_count: 0,
    });
    expect(new Date(body.expires_at).getTime()).toBe(challenge?.expires_at.getTime());
    // authentication_challenge_ttl_minutes: five minutes, on the database's clock
    expect((challenge?.expires_at.getTime() ?? 0) - (challenge?.issued_at.getTime() ?? 0)).toBe(
      5 * 60_000,
    );
    expect(calls.verify).toHaveBeenCalledTimes(1);
  });

  // Break caught: the answer revealing whether the identity holds a factor (the password step "says nothing about the factor").
  it('answers the same 202 whether or not the identity holds an ACTIVE factor', async () => {
    const without = await privileged();
    const withFactor = await privileged();
    await kit.admin.query(
      `insert into mfa_factor (id, staff_identity_id, factor_type, status, secret_ciphertext, secret_nonce, secret_key_version, secret_envelope_version, created_by_purpose)
       values (gen_random_uuid(), $1, 'TOTP', 'PENDING', $2, $3, 1, 1, 'STAFF_CREDENTIAL_SETUP')`,
      [withFactor.id, Buffer.alloc(40, 7), Buffer.alloc(12, 3)],
    );
    await kit.admin.query(
      `update mfa_factor set status = 'ACTIVE', enrolled_at = now(), last_verified_counter = '1' where staff_identity_id = $1`,
      [withFactor.id],
    );

    const a = await signIn(without);
    const b = await signIn(withFactor);

    expect([a.status, b.status]).toEqual([202, 202]);
    expect(Object.keys(a.json() as object).toSorted()).toEqual(
      Object.keys(b.json() as object).toSorted(),
    );
    expect(a.setCookies).toHaveLength(0);
    expect(b.setCookies).toHaveLength(0);
  });

  it('makes a new challenge the only live one: the earlier one is finished', async () => {
    const row = await privileged();

    await signIn(row);
    await signIn(row);

    const states = (await challengesOf(row)).map((challenge) => challenge.state).toSorted();
    expect(states).toEqual(['PENDING', 'UNUSABLE']);
  });

  it('does not clear the count: a complete sign-in is the second step’s', async () => {
    const row = await privileged();
    await kit.admin.setColumn('staff_identity', 'failed_attempt_count', 3, { id: row.id });

    expect((await signIn(row)).status).toBe(202);

    expect((await countOf(row)).failed_attempt_count).toBe(3);
  });
});

describe('every failure is answered alike (AC-SLICE-000-04)', () => {
  // Break caught: any response that tells which of the seven reasons it was (a status, a code, a message, a member of the body or a
  // cookie), which is how an attacker learns which addresses are real staff.
  it('answers an unknown address, a wrong password, and every ineligible identity with the same 422 INVALID_CREDENTIALS', async () => {
    const wrong = await identity();
    const pending = await identity({ status: 'PENDING_APPROVAL', approvedBy: null });
    const suspended = await identity({ status: 'SUSPENDED' });
    const offboarded = await identity({ status: 'OFFBOARDED' });
    const uncredentialed = await identity({ credentialHash: null, credentialEstablishedAt: null });
    const rejected = await identity({ status: 'REJECTED' });

    const answers = [
      answerOf(await post({ email: 'nobody@example.test', password: PASSWORD })),
      answerOf(await signIn(wrong, WRONG)),
      answerOf(await signIn(pending)),
      answerOf(await signIn(suspended)),
      answerOf(await signIn(offboarded)),
      answerOf(await signIn(uncredentialed)),
      answerOf(await signIn(rejected)),
    ];

    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(answers[0]).toMatchObject({ ...INVALID, cookies: 0 });
    expect(answers[0]?.keys).toEqual(['code', 'message', 'request_id']);
    // Nothing was counted for an identity that never reached the password.
    for (const row of [pending, suspended, offboarded, uncredentialed]) {
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    }
    expect((await countOf(wrong)).failed_attempt_count).toBe(1);
  });

  // Break caught: a precise cause that is lost (the audit "does distinguish them"), or one that carries the string as typed, the
  // password, or an address (an identifier field is where a mistyped password lands).
  it('records the precise cause and the factor reached in the audit, and never what was typed', async () => {
    const wrong = await identity();
    const suspended = await identity({ status: 'SUSPENDED' });
    const typedAddress = 'someone.unknown@example.test';

    const unknown = await post({ email: typedAddress, password: PASSWORD });
    const bad = await signIn(wrong, WRONG);
    const ineligible = await signIn(suspended);

    const [unknownEvent] = await auditOf(requestIdOf(unknown));
    const [badEvent] = await auditOf(requestIdOf(bad));
    const [ineligibleEvent] = await auditOf(requestIdOf(ineligible));
    expect(unknownEvent).toMatchObject({
      event_code: 'auth.session.failed',
      outcome: 'REJECTED',
      enhanced: false,
      actor_type: 'SYSTEM',
      object_id: null,
    });
    expect(unknownEvent?.detail).toMatchObject({
      cause: 'UNKNOWN_PRINCIPAL',
      factor: 'NONE',
      identifier_kind: 'WORK_EMAIL',
    });
    expect(unknownEvent?.detail.identifier_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(badEvent).toMatchObject({
      event_code: 'auth.session.failed',
      object_type: 'StaffIdentity',
      object_id: wrong.id,
    });
    expect(badEvent?.detail).toMatchObject({ cause: 'WRONG_PASSWORD', factor: 'PASSWORD' });
    expect(ineligibleEvent).toMatchObject({ object_id: suspended.id });
    expect(ineligibleEvent?.detail).toMatchObject({
      cause: 'INELIGIBLE_PRINCIPAL',
      factor: 'NONE',
    });
    const everything = JSON.stringify([unknownEvent, badEvent, ineligibleEvent]);
    for (const secret of [PASSWORD, WRONG, typedAddress, wrong.workEmail])
      expect(everything).not.toContain(secret);
    expect(kit.app.logs.text()).not.toContain(WRONG);
    expect(kit.app.logs.text()).not.toContain(typedAddress);
  });

  // Break caught: a branch that does no derivation (a timing signal), or does two, or one that runs one for a request that was
  // refused before identity-dependent work.
  it('does one verification derivation on each branch that reached a hash: the real one for a wrong password, a dummy for the rest', async () => {
    const wrong = await identity();
    const suspended = await identity({ status: 'SUSPENDED' });
    const uncredentialed = await identity({ credentialHash: null, credentialEstablishedAt: null });
    const locked = await identity();
    await kit.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [locked.id],
    );
    const cases: [string, () => Promise<TestResponse>, 'verify' | 'dummy'][] = [
      ['a wrong password', () => signIn(wrong, WRONG), 'verify'],
      [
        'an unknown address',
        () => post({ email: 'nobody@example.test', password: PASSWORD }),
        'dummy',
      ],
      ['a suspended identity', () => signIn(suspended), 'dummy'],
      ['an identity with no credential', () => signIn(uncredentialed), 'dummy'],
      ['a locked identity, correct password and all', () => signIn(locked), 'dummy'],
    ];

    for (const [name, request, kind] of cases) {
      calls.verify.mockClear();
      calls.dummy.mockClear();
      const response = await request();
      expect(response.status, name).toBe(422);
      expect(calls[kind], name).toHaveBeenCalledTimes(1);
      expect(calls[kind === 'verify' ? 'dummy' : 'verify'], name).not.toHaveBeenCalled();
    }
  });
});

describe('a fifth wrong password locks the credential and nobody is told (AC-SLICE-000-77)', () => {
  // Break caught: a lock announced to someone who proved nothing, one that is verified (the correct password gets in), one that is
  // extended by the attempts inside it, or one that is not set on the fifth.
  it('locks on the fifth, answers the sixth INVALID_CREDENTIALS without examining it, and does not extend the lock', async () => {
    const row = await identity();
    // The configured duration, read from the setting the application reads: no figure of this test's own.
    const configured = await kit.observe.one<{ minutes: number }>(
      `select (value #>> '{}')::int as minutes from setting where key = 'signin_lockout_minutes'`,
    );
    const answers: Answer[] = [];
    for (let attempt = 1; attempt <= 4; attempt += 1)
      answers.push(answerOf(await signIn(row, WRONG)));
    // The lock is written on the database's clock, so it is judged on the database's clock: two observations of it, as text with its
    // microseconds, bracket the fifth attempt (a comparison with the host's own clock would be a comparison of two clocks).
    const before = await databaseNow();
    answers.push(answerOf(await signIn(row, WRONG)));
    const after = await databaseNow();
    const locked = await countOf(row);
    calls.verify.mockClear();
    calls.dummy.mockClear();

    const sixth = answerOf(await signIn(row));
    const stillLocked = await countOf(row);

    for (const answer of answers) expect(answer).toMatchObject(INVALID);
    expect(sixth).toEqual({ ...answers[0], message: sixth.message });
    expect(sixth).toMatchObject(INVALID);
    expect(locked.failed_attempt_count).toBe(5);
    expect(locked.locked_until).toBeInstanceOf(Date);
    // The lock ends the configured number of minutes after the moment the fifth attempt was counted, which lies between the two
    // observations: the database makes the comparison on the full microseconds, never on the milliseconds of a JavaScript date.
    expect(configured?.minutes).toBeGreaterThan(0);
    const within = await kit.observe.one<{ not_early: boolean; not_late: boolean }>(
      `select locked_until >= $1::timestamptz + make_interval(mins => $3::int) as not_early,
              locked_until <= $2::timestamptz + make_interval(mins => $3::int) as not_late
         from staff_identity where id = $4`,
      [before, after, configured?.minutes ?? 0, row.id],
    );
    expect(within).toEqual({ not_early: true, not_late: true });
    // the sixth, with the correct password: one dummy derivation, the result unused; no real verification; nothing counted or moved
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dummy).toHaveBeenCalledTimes(1);
    expect(stillLocked).toEqual(locked);
  });

  // Break caught: a lock event written for every failure inside the lock, or twice (AC-77: "one event per lock"), or one that names
  // what was typed.
  it('writes one auth.lockout.applied for the lock, naming the factor and the moment and no credential, and LOCKED_OUT for what follows', async () => {
    const row = await identity();
    const responses: TestResponse[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) responses.push(await signIn(row, WRONG));
    const after = await signIn(row, WRONG);

    const fifthResponse = responses[4];
    if (fifthResponse === undefined) throw new Error('five attempts were made');
    const fifth = await auditOf(requestIdOf(fifthResponse));
    const sixth = await auditOf(requestIdOf(after));

    expect(fifth.map((event) => event.event_code).toSorted()).toEqual([
      'auth.lockout.applied',
      'auth.session.failed',
    ]);
    const lockout = fifth.find((event) => event.event_code === 'auth.lockout.applied');
    expect(lockout).toMatchObject({
      object_type: 'StaffIdentity',
      object_id: row.id,
      outcome: 'SUCCEEDED',
    });
    expect(lockout?.detail).toMatchObject({ factor: 'PASSWORD' });
    expect(typeof lockout?.detail.locked_until).toBe('string');
    expect(JSON.stringify(fifth)).not.toContain(WRONG);
    expect(sixth.map((event) => event.event_code)).toEqual(['auth.session.failed']);
    expect(sixth[0]?.detail).toMatchObject({ cause: 'LOCKED_OUT' });
    const total = await kit.observe.count('audit_event', {
      event_code: 'auth.lockout.applied',
      object_id: row.id,
    });
    expect(total).toBe(1);
  });

  // Break caught (AC-77: "concurrent wrong passwords at the limit set one lock and record one event"): a read-then-write count.
  it('sets one lock and records one event when failures race at the limit', async () => {
    const row = await identity();
    await kit.admin.setColumn('staff_identity', 'failed_attempt_count', 4, { id: row.id });

    const responses = await Promise.all([signIn(row, WRONG), signIn(row, WRONG)]);

    for (const response of responses) expect(answerOf(response)).toMatchObject(INVALID);
    expect(
      await kit.observe.count('audit_event', {
        event_code: 'auth.lockout.applied',
        object_id: row.id,
      }),
    ).toBe(1);
    const failed = await Promise.all(
      responses.map(
        async (response) =>
          (await auditOf(requestIdOf(response))).find(
            (event) => event.event_code === 'auth.session.failed',
          )?.detail.cause,
      ),
    );
    expect(failed.toSorted()).toEqual(['LOCKED_OUT', 'WRONG_PASSWORD']);
    expect((await countOf(row)).failed_attempt_count).toBe(5);
  });

  it('answers an unknown address as it answers a locked one and never locks anything', async () => {
    const answers: Answer[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      answers.push(answerOf(await post({ email: 'ghost@example.test', password: WRONG })));
    }

    for (const answer of answers) expect(answer).toMatchObject(INVALID);
    expect(
      await kit.observe.count('staff_identity', { work_email_canonical: 'ghost@example.test' }),
    ).toBe(0);
  });

  // Break caught: the failure counted in a transaction that the refusal rolls back (the lockout would never count), or a failure to
  // write the record that reads as an ordinary wrong password.
  it('commits the count before it answers, and a record that cannot be written is a failure and not a wrong password', async () => {
    const row = await identity();
    const broken = await kit.admin.breakWrites('audit_event');
    try {
      const response = await signIn(row, WRONG);
      expect(response.status).toBeGreaterThanOrEqual(500);
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    } finally {
      await broken.mend();
    }

    expect(answerOf(await signIn(row, WRONG))).toMatchObject(INVALID);
    expect((await countOf(row)).failed_attempt_count).toBe(1);
  });
});

describe('a lock ends on its own and a correct sign-in resets the count (AC-SLICE-000-78)', () => {
  // Break caught: a lapsed lock that keeps its count, or one that still refuses the correct password.
  it('verifies normally once the time has passed, issues the session and leaves the count at zero', async () => {
    const row = await identity();
    await kit.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [row.id],
    );

    const response = await signIn(row);

    expect(response.status).toBe(200);
    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    expect(calls.verify).toHaveBeenCalledTimes(1);
  });

  it('counts a wrong password after a lapsed lock from one, not from five', async () => {
    const row = await identity();
    await kit.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [row.id],
    );

    expect(answerOf(await signIn(row, WRONG))).toMatchObject(INVALID);

    expect(await countOf(row)).toEqual({ failed_attempt_count: 1, locked_until: null });
  });

  it('never locks on four wrong passwords followed by the correct one', async () => {
    const row = await identity();
    for (let attempt = 1; attempt <= 4; attempt += 1) await signIn(row, WRONG);

    expect((await signIn(row)).status).toBe(200);
    for (let attempt = 1; attempt <= 4; attempt += 1) await signIn(row, WRONG);

    expect((await countOf(row)).locked_until).toBeNull();
    expect((await countOf(row)).failed_attempt_count).toBe(4);
  });

  it('does not end a live session of the identity when it locks', async () => {
    const row = await identity();
    expect((await signIn(row)).status).toBe(200);
    for (let attempt = 1; attempt <= 5; attempt += 1) await signIn(row, WRONG);

    expect((await countOf(row)).locked_until).toBeInstanceOf(Date);
    expect(await kit.observe.count('session', { principal_id: row.id })).toBe(1);
    expect(
      (
        await kit.observe.one<{ terminated_at: Date | null }>(
          'select terminated_at from session where principal_id = $1',
          [row.id],
        )
      )?.terminated_at,
    ).toBeNull();
  });

  it('counts a wrong password of a privileged identity as it counts any other', async () => {
    const row = await privileged();

    expect(answerOf(await signIn(row, WRONG))).toMatchObject(INVALID);

    expect((await countOf(row)).failed_attempt_count).toBe(1);
    expect(await challengesOf(row)).toEqual([]);
  });

  /**
   * A request whose password is verified correct while the fifth wrong one commits and sets the lock: the lock is read once, at the
   * lookup, so without a judgement under the identity's lock the request would be given its session (or its challenge) and the session
   * issue would clear the lock it never saw. The wrapper sets the lock in the database as the verification returns, which is the
   * interleaving made certain.
   */
  async function signInWhileLocked(row: StaffRow): Promise<TestResponse> {
    const watched = hasher.verify.bind(hasher);
    hasher.verify = async (...args) => {
      const verdict = await watched(...args);
      await admin.query(
        `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '15 minutes' where id = $1`,
        [row.id],
      );
      return verdict;
    };
    try {
      return await signIn(row);
    } finally {
      // Put back what was there: the counting wrapper of beforeAll, which `watched` calls through.
      hasher.verify = (...args) => watched(...args);
    }
  }

  // Break caught: the lock re-judged by nobody under the identity's lock, so that a correct password that was already being verified
  // is given a session after the fifth failure, and the issue clears the lock.
  it('refuses a correct password that was in flight when the lock was set, and leaves the lock as it is', async () => {
    const row = await identity();

    const response = await signInWhileLocked(row);

    expect(answerOf(response)).toMatchObject(INVALID);
    expect(response.setCookies).toHaveLength(0);
    expect(await sessionsOf(row)).toBe(0);
    const count = await countOf(row);
    expect(count.failed_attempt_count).toBe(5);
    expect(count.locked_until).toBeInstanceOf(Date);
    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => event.detail.cause)).toEqual(['LOCKED_OUT']);
  });

  it('gives a privileged identity no challenge for a correct password that was in flight when the lock was set', async () => {
    const row = await privileged();

    const response = await signInWhileLocked(row);

    expect(answerOf(response)).toMatchObject(INVALID);
    expect(await challengesOf(row)).toEqual([]);
    expect((await countOf(row)).locked_until).toBeInstanceOf(Date);
  });

  /**
   * A wrong password whose verification is still running when `during` commits: the count is made against the credential that was
   * verified, so a replacement (which clears the counters) or a suspension that commits in between must not be given the old
   * attempt's failure (the audit of 21 October 2026, A03).
   */
  async function wrongPasswordWhile(row: StaffRow, during: () => Promise<unknown>) {
    const watched = hasher.verify.bind(hasher);
    hasher.verify = async (...args) => {
      const verdict = await watched(...args);
      await during();
      return verdict;
    };
    try {
      return await signIn(row, WRONG);
    } finally {
      hasher.verify = (...args) => watched(...args);
    }
  }

  const REPLACE_CREDENTIAL = `update staff_identity set credential_hash = $2, credential_established_at = clock_timestamp(),
      credential_generation = credential_generation + 1, failed_attempt_count = $3, locked_until = null where id = $1`;

  // Break caught: a failure counted against whatever credential the identity holds when the count is made. The credential was
  // replaced while the old password was being verified; the replacement's counters stand as they were, and an attempt that would have
  // been the fifth does not lock it.
  it.each([
    ['the counters of the replacement are zero', 0],
    ['the replacement already holds four failures', 4],
  ])('counts nothing on a credential that replaced the one verified: %s', async (_name, held) => {
    const row = await identity();

    const response = await wrongPasswordWhile(row, () =>
      admin.query(REPLACE_CREDENTIAL, [row.id, hashed, held]),
    );

    expect(answerOf(response)).toMatchObject(INVALID);
    expect(await countOf(row)).toEqual({ failed_attempt_count: held, locked_until: null });
    const events = await auditOf(requestIdOf(response));
    expect(events.map((event) => event.event_code)).toEqual(['auth.session.failed']);
    expect(events.map((event) => event.detail.cause)).toEqual(['INELIGIBLE_PRINCIPAL']);
  });

  it('counts nothing on an identity that was suspended while the password was being verified', async () => {
    const row = await identity();

    const response = await wrongPasswordWhile(row, () =>
      admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [row.id]),
    );

    expect(answerOf(response)).toMatchObject(INVALID);
    expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    expect((await auditOf(requestIdOf(response))).map((event) => event.detail.cause)).toEqual([
      'INELIGIBLE_PRINCIPAL',
    ]);
  });
});

describe('a refused request is neither verified nor counted (AC-SLICE-000-81)', () => {
  // Break caught: a limit keyed on something other than the canonical address (the network address, or the text as typed), one that
  // is not before the verification, or one that tells a real address from a made-up one.
  it('refuses the eleventh request of a minute for one canonical address with RATE_LIMITED, examining nothing', async () => {
    const row = await identity();
    for (let attempt = 1; attempt <= 10; attempt += 1) await signIn(row, WRONG);
    const before = await countOf(row);
    calls.verify.mockClear();
    calls.dummy.mockClear();

    const refused = await post({ email: `  ${row.workEmail.toUpperCase()}  `, password: PASSWORD });

    expect(refused.status).toBe(429);
    expect((refused.json() as { code: string }).code).toBe('RATE_LIMITED');
    expect(refused.header('retry-after')).toBeNull();
    // the correct password among them was not examined: no derivation at all, and nothing counted
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dummy).not.toHaveBeenCalled();
    expect(await countOf(row)).toEqual(before);
    // another address has a key of its own
    const other = await identity();
    expect((await signIn(other)).status).toBe(200);
  });

  it('limits an address that belongs to nobody exactly as it limits one that does', async () => {
    const results: number[] = [];
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      results.push((await post({ email: 'made.up@example.test', password: WRONG })).status);
    }

    expect(results.slice(0, 10).every((status) => status === 422)).toBe(true);
    expect(results[10]).toBe(429);
  });

  // Break caught: a request refused because no slot is free that is verified anyway, counted, or given a dummy hash.
  it('refuses a request when no hash slot is free, without a derivation and without counting, the correct password included', async () => {
    const admission = kit.app.app.get<HashAdmission>(HASH_ADMISSION, { strict: false });
    const row = await identity();
    const held: HashSlot[] = [];
    for (let slot = admission.tryAdmit(); slot !== null; slot = admission.tryAdmit())
      held.push(slot);
    try {
      const wrong = await signIn(row, WRONG);
      const right = await signIn(row);

      for (const response of [wrong, right]) {
        expect(response.status).toBe(429);
        expect((response.json() as { code: string }).code).toBe('RATE_LIMITED');
      }
      expect(calls.verify).not.toHaveBeenCalled();
      expect(calls.dummy).not.toHaveBeenCalled();
      expect(await countOf(row)).toEqual({ failed_attempt_count: 0, locked_until: null });
    } finally {
      for (const slot of held) slot.release();
    }
    expect((await signIn(row)).status).toBe(200);
  });
});

describe('the password and the address are bounded and judged first', () => {
  // Break caught: a password longer than the bound that reaches a hash, or one whose refusal echoes it.
  it.each([
    ['a password of 129 characters', { email: 'a@b.test', password: 'x'.repeat(129) }],
    ['a body with no password', { email: 'a@b.test' }],
    ['a body with no address', { password: PASSWORD }],
    [
      'a member the contract does not name',
      { email: 'a@b.test', password: PASSWORD, remember: true },
    ],
    ['a password that is not text', { email: 'a@b.test', password: 12345 }],
    ['an address that is not an address', { email: 'not an email', password: PASSWORD }],
    // PostgreSQL refuses a text that holds a NUL byte: an address with one that reached the lookup was a server error, which an unknown
    // address never is.
    [
      'an address with a NUL byte in its local part',
      { email: `ali${String.fromCharCode(0)}ce@example.com`, password: PASSWORD },
    ],
    [
      'an address with a NUL byte in its domain',
      { email: `alice@exam${String.fromCharCode(0)}ple.com`, password: PASSWORD },
    ],
    // The limiter takes no key from a text longer than its bound, and the service trims before it judges: padding an address past the
    // bound would have skipped the limit (AC-SLICE-000-81) and run the whole lookup and derivation for it.
    [
      'an address padded with white space past the bound the limiter takes a key from',
      { email: `${' '.repeat(2000)}alice@example.com`, password: PASSWORD },
    ],
    [
      'an address padded with line breaks and tabs past that bound',
      { email: `${'\r\n\t'.repeat(500)}alice@example.com${'\t'.repeat(500)}`, password: PASSWORD },
    ],
  ])('refuses %s with 400 VALIDATION_FAILED and derives nothing', async (_name, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect((response.json() as { code: string }).code).toBe('VALIDATION_FAILED');
    expect(response.text).not.toContain(PASSWORD);
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dummy).not.toHaveBeenCalled();
  });

  // Break caught (AC-SLICE-000-87): a password that passes the schema and expands past 128 after NFKC being hashed, or counted, or told
  // apart: "answered INVALID_CREDENTIALS, is not hashed and is not counted".
  it('answers a password that expands past 128 after NFKC as a wrong one, without a derivation and without a count', async () => {
    const row = await identity();

    const response = await signIn(row, 'ﬃ'.repeat(100));

    expect(answerOf(response)).toMatchObject(INVALID);
    expect(calls.verify).not.toHaveBeenCalled();
    expect(calls.dummy).not.toHaveBeenCalled();
    expect((await countOf(row)).failed_attempt_count).toBe(0);
  });

  it('refuses a lone surrogate in the password without echoing it, and a short wrong password is only a wrong one', async () => {
    const row = await identity();

    const lone = await signIn(row, `${'a'.repeat(12)}\uD800`);
    const short = await signIn(row, 'abc');

    expect(lone.status).toBe(400);
    expect(lone.text).not.toContain('abc');
    expect(answerOf(short)).toMatchObject(INVALID);
    expect((await countOf(row)).failed_attempt_count).toBe(1);
  });
});

describe('it is a browser pre-session mutation of the Ops Portal', () => {
  // Break caught: an Origin check applied after the password was examined or counted, or one that lets a foreign page, the other
  // surface, or no Origin at all through.
  it.each([
    ['no Origin', null],
    ['a foreign Origin', 'https://evil.example'],
    ['the Origin of the Vendor PWA', 'http://127.0.0.1:5174'],
    ['the literal null', 'null'],
  ])(
    'refuses %s with 403 CSRF_VALIDATION_FAILED before the password is examined or counted',
    async (_name, origin) => {
      const row = await identity();

      const response = await signIn(row, WRONG, { origin });

      expect(response.status).toBe(403);
      expect((response.json() as { code: string }).code).toBe('CSRF_VALIDATION_FAILED');
      expect(calls.verify).not.toHaveBeenCalled();
      expect(calls.dummy).not.toHaveBeenCalled();
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    },
  );

  it('needs no session and no CSRF token: there is no session to hold one', async () => {
    const row = await identity();

    expect((await signIn(row, PASSWORD, { csrf: 'omit' })).status).toBe(200);
  });
});

describe('the work of outwardly equivalent failure branches (AC-SLICE-000-04, work shape)', () => {
  // Break caught: a branch that reads another table, sends another statement, or writes (a dummy write per request) only to look like
  // another: the control is that the branches do the same bounded work, and a branch that reached the credential does the one thing
  // more it must, the count.
  it('sends the same statements for an unknown address, an ineligible identity and a locked one, and the wrong password only the two more it must', async () => {
    const suspended = await identity({ status: 'SUSPENDED' });
    const pending = await identity({ status: 'PENDING_APPROVAL', approvedBy: null });
    const uncredentialed = await identity({ credentialHash: null, credentialEstablishedAt: null });
    const locked = await identity();
    const wrong = await identity();
    await kit.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [locked.id],
    );
    const traced = async (request: () => Promise<TestResponse>) =>
      (await kit.trace(request)).statements;

    const unknown = await traced(() => post({ email: 'nobody@example.test', password: PASSWORD }));
    const branches = {
      suspended: await traced(() => signIn(suspended)),
      pending: await traced(() => signIn(pending)),
      uncredentialed: await traced(() => signIn(uncredentialed)),
      locked: await traced(() => signIn(locked)),
    };
    const wrongPassword = await traced(() => signIn(wrong, WRONG));

    expect(unknown.length).toBeGreaterThan(0);
    for (const [name, statements] of Object.entries(branches)) {
      expect(sameShape(statements, unknown), name).toBe(true);
    }
    // the branch that reached the credential reads the hash and counts the failure: those two statements, and nothing else more
    const extra = wrongPassword.filter((statement) => !unknown.includes(statement));
    expect(extra).toHaveLength(2);
    expect(extra.some((statement) => statement.includes('staff_credential_hash'))).toBe(true);
    expect(
      extra.some(
        (statement) =>
          statement.startsWith('update staff_identity') &&
          statement.includes('failed_attempt_count'),
      ),
    ).toBe(true);
    expect(wrongPassword.length).toBe(unknown.length + 2);
  });
});

/**
 * Runs a request while another transaction holds the identity's row lock and has changed the identity, and commits that change a moment
 * later. The request's verification took no lock; what it decides under the lock sees the identity as it is.
 */
async function raceAgainstChange(
  row: StaffRow,
  change: string,
  values: unknown[],
  request: () => Promise<TestResponse>,
): Promise<TestResponse> {
  const holder = clientFor(database.urlFor('postgres'));
  const observer = clientFor(database.urlFor('postgres'));
  await holder.connect();
  await observer.connect();
  try {
    await holder.query('begin');
    await holder.query('select id from staff_identity where id = $1 for no key update', [row.id]);
    await holder.query(change, [row.id, ...values]);
    const pending = request();
    // The change is committed when the request is seen waiting for the lock, and not after some time that it may or may not have taken:
    // the wait ends when this test says so (the audit of 26 October 2026, decision 9).
    await waitUntilBlockedBy(observer, await backendPidOf(holder), 'the sign-in', pending);
    await holder.query('commit');
    return await pending;
  } finally {
    await holder.end();
    await observer.end();
  }
}

const REPLACE_CREDENTIAL = `update staff_identity set credential_hash = $2, credential_established_at = clock_timestamp(),
  credential_generation = credential_generation + 1 where id = $1`;
const SUSPEND = "update staff_identity set status = 'SUSPENDED' where id = $1";

describe('the identity changed between the proof and the issue', () => {
  // Break caught: a session (or a challenge) issued on a password that was proved against a credential which has since been replaced:
  // the new owner of the account would meet a session that rests on the old password.
  it.each([
    ['an Ops Staff member', identity],
    ['a privileged identity', privileged],
  ])(
    'answers %s whose credential was replaced meanwhile INVALID_CREDENTIALS and issues nothing',
    async (_name, make) => {
      const row = await make();

      const response = await raceAgainstChange(row, REPLACE_CREDENTIAL, [hashed], () =>
        signIn(row),
      );

      expect(answerOf(response)).toMatchObject(INVALID);
      expect(await sessionsOf(row)).toBe(0);
      expect(await challengesOf(row)).toEqual([]);
      expect(response.setCookies).toEqual([]);
      const event = (await auditOf(requestIdOf(response)))[0];
      expect(event?.detail).toMatchObject({ cause: 'INELIGIBLE_PRINCIPAL' });
      expect((await countOf(row)).failed_attempt_count).toBe(0);
    },
  );

  it.each([
    ['an Ops Staff member', identity],
    ['a privileged identity', privileged],
  ])(
    'answers %s who was suspended meanwhile INVALID_CREDENTIALS and issues nothing',
    async (_name, make) => {
      const row = await make();

      const response = await raceAgainstChange(row, SUSPEND, [], () => signIn(row));

      expect(answerOf(response)).toMatchObject(INVALID);
      expect(await sessionsOf(row)).toBe(0);
      expect(await challengesOf(row)).toEqual([]);
    },
  );
});

describe('the bundle changed between the decision and the issue', () => {
  // Break caught: an Ops Staff decision made on a read of the bundle, and a session issued to an identity whose bundle became privileged
  // while the sign-in waited for the identity lock: a privileged session with no second factor proved. The decision is made again under
  // the lock, and the sign-in is then carried out as a privileged one.
  it('gives an identity whose bundle became privileged meanwhile a challenge and no session', async () => {
    const row = await identity();

    const response = await raceAgainstChange(
      row,
      'update staff_identity set role_bundle_id = $2 where id = $1',
      [BUNDLE_IDS.seniorOps],
      () => signIn(row),
    );

    expect(response.status).toBe(202);
    expect(response.setCookies).toEqual([]);
    expect(await sessionsOf(row)).toBe(0);
    expect((await challengesOf(row)).map((challenge) => challenge.state)).toEqual(['PENDING']);
  });
});

describe('a hash made at an older cost is replaced after a correct password (OB-39)', () => {
  async function olderHash(): Promise<string> {
    const config = kit.app.app.get<AppConfig>(APP_CONFIG, { strict: false });
    return new Argon2Hasher(config.keys, { memoryKiB: 8192, passes: 2, parallelism: 1 }).hash(
      'STAFF_PASSWORD',
      PASSWORD,
    );
  }
  const hashOf = async (row: StaffRow) =>
    (
      await kit.admin.query<{ hash: string; generation: string; established: Date }>(
        'select credential_hash as hash, credential_generation as generation, credential_established_at as established from staff_identity where id = $1',
        [row.id],
      )
    )[0];

  // Break caught: a stored hash that stays at the old cost for ever, one rewritten as a new credential (the generation or the moment
  // moved: every session of the identity would end), or one rewritten after a wrong password.
  it.each([
    ['an Ops Staff member', identity],
    ['a privileged identity', privileged],
  ])(
    'rewrites the hash of %s at the write profile, as the same credential',
    async (_name, make) => {
      const stored = await olderHash();
      const row = await make({ credentialHash: stored });
      const before = await hashOf(row);

      const response = await signIn(row);

      expect([200, 202]).toContain(response.status);
      const after = await hashOf(row);
      expect(before?.hash).toMatch(/m=8192,/);
      expect(after?.hash).toMatch(/m=65536,/);
      expect(after?.generation).toBe(before?.generation);
      expect(after?.established.getTime()).toBe(before?.established.getTime());
      // one verification derivation, and the rehash that the hasher advised adds one (they run one after the other in one slot)
      expect(calls.verify).toHaveBeenCalledTimes(1);
      expect(calls.hash).toHaveBeenCalledTimes(1);
      // the new hash verifies the same password
      expect((await hasher.verify('STAFF_PASSWORD', PASSWORD, after?.hash ?? '')).matches).toBe(
        true,
      );
    },
  );

  // Break caught (the audit of 21 October 2026, A01): a rewrite conditional on the generation alone. A rehash does not move the
  // generation, so two instances that verified the same hash and each computed an upgrade (one at a larger cost, one under a newer
  // pepper) wrote in whatever order they got the identity's lock, and the older upgrade could replace the newer. Here another
  // instance's upgrade commits after this request has verified the hash it read and computed its own: the newer hash stays, and the
  // sign-in, which is valid, succeeds all the same.
  it.each([
    [
      'an Ops Staff member',
      identity,
      'a larger cost',
      '$argon2id$v=19$m=131072,t=3,p=1$bmV3ZXI$aGFzaA',
    ],
    [
      'an Ops Staff member',
      identity,
      'a newer pepper',
      '$argon2id$v=19$m=65536,t=2,p=1,pv=2$bmV3ZXI$aGFzaA',
    ],
    [
      'a privileged identity',
      privileged,
      'a larger cost',
      '$argon2id$v=19$m=131072,t=3,p=1$bmV3ZXI$aGFzaA',
    ],
    [
      'a privileged identity',
      privileged,
      'a newer pepper',
      '$argon2id$v=19$m=65536,t=2,p=1,pv=2$bmV3ZXI$aGFzaA',
    ],
  ])(
    'keeps the hash that another instance upgraded after this request verified the old one (%s, %s)',
    async (_name, make, _kind, newer) => {
      const row = await make({ credentialHash: await olderHash() });
      const before = await hashOf(row);
      const watched = hasher.hash.bind(hasher);
      hasher.hash = async (...args) => {
        const own = await watched(...args);
        // the other instance's upgrade commits first, on the same generation
        await admin.query('update staff_identity set credential_hash = $2 where id = $1', [
          row.id,
          newer,
        ]);
        return own;
      };
      let response: TestResponse;
      try {
        response = await signIn(row);
      } finally {
        hasher.hash = (...args) => watched(...args);
      }

      expect([200, 202]).toContain(response.status);
      const after = await hashOf(row);
      expect(after?.hash).toBe(newer);
      expect(after?.generation).toBe(before?.generation);
      // one verification, and the rehash that was computed and then not written
      expect(calls.verify).toHaveBeenCalledTimes(1);
      expect(calls.hash).toHaveBeenCalledTimes(1);
    },
  );

  it('leaves the hash as it was after a wrong password, and for a hash already at the write profile', async () => {
    const wrongRow = await identity({ credentialHash: await olderHash() });
    const current = await identity();
    const stored = (await hashOf(wrongRow))?.hash;

    await signIn(wrongRow, WRONG);
    await signIn(current);

    expect((await hashOf(wrongRow))?.hash).toBe(stored);
    expect((await hashOf(current))?.hash).toBe(hashed);
    expect(calls.hash).not.toHaveBeenCalled();
  });
});

/**
 * The answer of a sign-in that issues a session is built **in the issuing transaction** (the audit of 21 October 2026, A04). Built after
 * the commit in a transaction of its own, a failure to read the hubs or the display name left the session committed, the proof spent and
 * the success event written, and answered the person with a failure and no credential. The read of the display name is made to fail here,
 * which is the last thing the transaction does: everything it wrote goes with it.
 */
describe('a session whose answer cannot be built', () => {
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

  // Break caught: the answer built after the commit, in a transaction of its own: the session, the cleared count and the success event
  // all committed for a person who is answered with a failure and never receives the credential.
  it('commits no session, no event and no cleared count, and the sign-in can be repeated', async () => {
    const row = await identity();
    await kit.admin.query('update staff_identity set failed_attempt_count = 2 where id = $1', [
      row.id,
    ]);

    const failed = await whileNamingFails(() => signIn(row));

    expect(failed.status).toBe(500);
    expect(failed.setCookies).toEqual([]);
    expect(await sessionsOf(row)).toBe(0);
    expect(await issuedEvents(row)).toBe(0);
    expect((await countOf(row)).failed_attempt_count).toBe(2);

    const again = await signIn(row);
    expect(again.status).toBe(200);
    expect(await sessionsOf(row)).toBe(1);
    expect(await issuedEvents(row)).toBe(1);
    expect((await countOf(row)).failed_attempt_count).toBe(0);
  });
});

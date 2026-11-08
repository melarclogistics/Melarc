import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/auth/ports/audit-writer.port.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  TOKEN_SERVICE,
  type TokenService,
} from '../../src/platform/auth/ports/token-service.port.js';
import type {
  RequestOptions,
  TestClient,
  TestResponse,
} from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { challengeRow, insertChallenge } from './support/credentials.js';
import {
  OPS_STAFF_SNAPSHOT,
  insertSessionRow,
  insertStaff,
  sessionRow,
  staffRow,
  type SessionRow,
  type StaffRow,
} from './support/identities.js';
import { presenting as presentingFrom } from './support/http-sessions.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { seedReferenceData } from './support/seeded.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.34, `getCurrentSession` and `signOut` against the real application and a real PostgreSQL: a staff member is signed in by the real
 * sign-in and every request is a real HTTP request from the kit's client, with its cookie jar and its CSRF echo. A Vendor's and a
 * Rider's session cannot be issued yet (their sign-ins are S0.48 and S0.59), so theirs are arranged as rows, with tokens the
 * application's own token service made, and the instance is given the fixed-policy revision and the organisation resolver that those
 * tasks will give it. What each answer did is read back from a second connection.
 */
const OPS = 'http://127.0.0.1:5173';
const VENDOR = 'http://127.0.0.1:5174';
const SIGN_IN = '/api/v1/auth/staff/sign-in';
const SESSION = '/api/v1/auth/session';
const PASSWORD = 'correct horse battery staple';
const ORGANISATION = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const HUB = HUBS[0]?.id ?? '';

let database: TestDatabase;
let kit: IntegrationKit;
let admin: pg.Client;
let hashed: string;
let tokens: TokenService;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
    vendorOrganization: () => Promise.resolve(ORGANISATION),
  });
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  const hasher = kit.app.app.get<Hasher>(HASHER, { strict: false });
  hashed = await hasher.hash('STAFF_PASSWORD', PASSWORD);
  tokens = kit.app.app.get<TokenService>(TOKEN_SERVICE, { strict: false });
});

afterAll(async () => {
  await admin.end();
  await kit.stop();
  await database.drop();
});

interface SignedIn {
  readonly row: StaffRow;
  readonly client: TestClient;
  readonly view: Record<string, unknown>;
  readonly session: string;
  readonly csrf: string;
}

/** A staff member signed in by the real sign-in, in a browser (a client with a jar) of its own. */
async function signedIn(overrides: Partial<StaffRow> = {}): Promise<SignedIn> {
  const row = await insertStaff(
    admin,
    staffRow({ credentialHash: hashed, primaryHubId: HUB, fullName: 'Ama Mensah', ...overrides }),
  );
  const client = kit.client.fork();
  const response = await client.post(
    SIGN_IN,
    { email: row.workEmail, password: PASSWORD },
    { origin: OPS },
  );
  expect(response.status).toBe(200);
  const session = client.cookie('melarc_session');
  const csrf = client.cookie('melarc_csrf');
  if (session === undefined || csrf === undefined) throw new Error('the sign-in set no cookie');
  return { row, client, view: response.json() as Record<string, unknown>, session, csrf };
}

const presenting = (token: string, csrf?: string): TestClient => presentingFrom(kit, token, csrf);

/** The request a page makes to sign out: `DELETE` with the Ops Portal's `Origin` and, from its jar, the synchronizer token. */
const signOut = (client: TestClient, options: RequestOptions = {}): Promise<TestResponse> =>
  client.delete(SESSION, { origin: OPS, ...options });

const sessionOf = (id: string) =>
  kit.observe.one<{
    terminated_at: Date | null;
    termination_reason: string | null;
    last_activity_at: Date;
  }>('select terminated_at, termination_reason, last_activity_at from session where id = $1', [id]);

interface Terminated {
  actor_type: string;
  actor_id: string | null;
  surface_context: string;
  object_type: string;
  object_id: string | null;
  outcome: string;
  enhanced: boolean;
  reason_code: string | null;
  detail: Record<string, unknown>;
  correlation_id: string;
}
const terminationsOf = (sessionId: string): Promise<Terminated[]> =>
  kit.observe.rows<Terminated>(
    `select actor_type, actor_id, surface_context, object_type, object_id, outcome, enhanced, reason_code, detail, correlation_id
       from audit_event where event_code = 'auth.session.terminated' and object_id = $1 order by recorded_at, id`,
    [sessionId],
  );
const rejectionsOf = (requestId: string) =>
  kit.observe.rows<{ detail: Record<string, unknown> }>(
    `select detail from audit_event where event_code = 'auth.csrf.rejected' and correlation_id = $1`,
    [requestId],
  );
const requestIdOf = (response: TestResponse): string =>
  (response.json() as { request_id: string }).request_id;
const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;

/** A vendor's or a rider's live session as a row, with the credentials a client would hold. */
async function arranged(type: 'VENDOR' | 'RIDER'): Promise<{
  readonly row: SessionRow;
  readonly token: string;
  readonly csrf: string | undefined;
}> {
  const issued = tokens.issue();
  const csrf = type === 'VENDOR' ? tokens.issue() : undefined;
  const row = await insertSessionRow(
    admin,
    sessionRow({
      principalType: type,
      principalId: randomUUID(),
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: type === 'VENDOR' ? BUNDLE_IDS.vendor : BUNDLE_IDS.rider,
      snapshot: {
        ...OPS_STAFF_SNAPSHOT,
        name: type === 'VENDOR' ? 'Vendor' : 'Rider',
        audience: type,
      },
      tokenHash: Buffer.from(issued.hash),
      csrfTokenHash: csrf === undefined ? null : Buffer.from(csrf.hash),
    }),
  );
  return { row, token: issued.token, csrf: csrf?.token };
}

/** Lets minutes pass for a session by changing the data; the database's clock is the one that judges. */
async function age(id: string, minutes: number): Promise<void> {
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
}

describe('getCurrentSession (AC-SLICE-000-83)', () => {
  // Break caught: a read that answers with something other than the caller's own session as the sign-in showed it, or that names
  // fields the contract's closed schema does not, or leaves one of the two display fields out.
  it('answers the caller’s own session with the principal, the hubs by name, the expiry and the keys, as the sign-in did', async () => {
    const person = await signedIn();

    const response = await person.client.get(SESSION);

    expect(response.status).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(Object.keys(person.view).toSorted());
    expect(body).toMatchObject({
      id: person.view.id,
      principal_type: 'STAFF',
      principal_id: person.row.id,
      state: 'ACTIVE',
      authorized_hub_ids: [HUB],
      principal_display_name: 'Ama Mensah',
      expires_at: person.view.expires_at,
      issued_at: person.view.issued_at,
      permissions: person.view.permissions,
    });
    expect(body.authorized_hubs).toEqual([{ id: HUB, display_name: HUBS[0]?.name }]);
    expect(Array.isArray(body.permissions)).toBe(true);
  });

  // Break caught: a credential, a hash, the synchronizer token or the contents of a bundle in the answer (AC-SLICE-000-83).
  it('contains no session token, no token hash, no CSRF value and nothing of a bundle beyond the keys', async () => {
    const person = await signedIn();
    const stored = await kit.observe.one<{ token_hash: Buffer; csrf_token_hash: Buffer }>(
      'select token_hash, csrf_token_hash from session where id = $1',
      [person.view.id],
    );

    const response = await person.client.get(SESSION);

    expect(response.status).toBe(200);
    const text = response.text;
    expect(text).not.toContain(person.session);
    expect(text).not.toContain(person.csrf);
    expect(text).not.toContain(stored?.token_hash.toString('hex') ?? 'absent');
    expect(text).not.toContain(stored?.csrf_token_hash.toString('hex') ?? 'absent');
    expect(text).not.toContain(stored?.token_hash.toString('base64') ?? 'absent');
    // No property could hold one: the names the answer uses are the contract's, and none is about a credential or a bundle.
    for (const name of Object.keys(response.json() as Record<string, unknown>)) {
      expect(name).not.toMatch(/token|hash|csrf|snapshot|bundle|grants|role|secret|password/i);
    }
    expect(response.setCookies).toEqual([]);
  });

  // Break caught: a safe read demanding the synchronizer token ("a safe read needs no token", AC-SLICE-000-84), or a read with no
  // credential, or with one that names no session, being answered.
  it('needs no synchronizer token, and refuses a request with no session or an unknown one (401 SESSION_INVALID)', async () => {
    const person = await signedIn();

    expect((await presenting(person.session).get(SESSION)).status).toBe(200);

    const none = await kit.client.fork().get(SESSION);
    expect([none.status, codeOf(none)]).toEqual([401, 'SESSION_INVALID']);
    const unknown = await presenting(tokens.issue().token).get(SESSION);
    expect([unknown.status, codeOf(unknown)]).toEqual([401, 'SESSION_INVALID']);
  });

  // Break caught (decision A of 12 October 2026): a read the page makes on its own extending the idle lifetime, so that a screen
  // that polls the session keeps an unattended session alive for ever.
  it('does not count as the person acting: the recorded activity is left as it was', async () => {
    const person = await signedIn();
    await age(String(person.view.id), 3);
    const before = (await sessionOf(String(person.view.id)))?.last_activity_at;

    expect((await person.client.get(SESSION)).status).toBe(200);

    expect((await sessionOf(String(person.view.id)))?.last_activity_at).toEqual(before);
  });

  // Break caught: the read of an ended session answered from the record: the session read is the one the credential stands behind.
  it('refuses a session that has ended, whatever ended it', async () => {
    const person = await signedIn();
    await admin.query(
      `update session set terminated_at = clock_timestamp(), termination_reason = 'ADMIN_REVOKED' where id = $1`,
      [person.view.id],
    );

    const response = await presenting(person.session).get(SESSION);

    expect([response.status, codeOf(response)]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('signOut (AC-SLICE-000-82)', () => {
  // Break caught: a sign-out that answers and leaves the session live, that sets the cookies with an `Expires` and no `Max-Age`, or that
  // clears the vendor's device cookie.
  it('is answered 204, ends the session with SIGNED_OUT and expires the two cookies with a literal Max-Age=0', async () => {
    const person = await signedIn();

    const response = await signOut(person.client);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(await sessionOf(String(person.view.id))).toMatchObject({
      termination_reason: 'SIGNED_OUT',
    });
    expect((await sessionOf(String(person.view.id)))?.terminated_at).toBeInstanceOf(Date);
    expect(
      response.setCookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        maxAge: cookie.maxAge,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
      })),
    ).toEqual([
      {
        name: 'melarc_session',
        value: '',
        maxAge: 0,
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      },
      {
        name: 'melarc_csrf',
        value: '',
        maxAge: 0,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      },
    ]);
    // The browser has removed what it held.
    expect(person.client.cookie('melarc_session')).toBeUndefined();
    expect(person.client.cookie('melarc_csrf')).toBeUndefined();
  });

  // Break caught: the termination not recorded, recorded with the token, or recorded as someone else.
  it('records auth.session.terminated once, by the person, with the reason and never the token', async () => {
    const person = await signedIn();

    const response = await signOut(person.client);

    const events = await terminationsOf(String(person.view.id));
    expect(events).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: person.row.id,
        surface_context: 'OPS_PORTAL',
        object_type: 'Session',
        object_id: person.view.id,
        outcome: 'SUCCEEDED',
        enhanced: false,
        reason_code: 'SIGNED_OUT',
        detail: {},
        correlation_id: expect.any(String) as string,
      },
    ]);
    expect(response.status).toBe(204);
    const stored = JSON.stringify(
      await kit.observe.rows('select * from audit_event where object_id = $1', [person.view.id]),
    );
    expect(stored).not.toContain(person.session);
    expect(stored).not.toContain(person.csrf);
  });

  // Break caught: the credential still accepted after the sign-out, or a second sign-out that answers 204 and writes a second event.
  it('refuses the next request on that credential, and a second sign-out, with 401 SESSION_INVALID, changing nothing', async () => {
    const person = await signedIn();
    expect((await signOut(person.client)).status).toBe(204);
    const ended = await sessionOf(String(person.view.id));

    const next = await presenting(person.session).get(SESSION);
    const again = await signOut(presenting(person.session, person.csrf));

    expect([next.status, codeOf(next)]).toEqual([401, 'SESSION_INVALID']);
    expect([again.status, codeOf(again)]).toEqual([401, 'SESSION_INVALID']);
    expect(again.setCookies).toEqual([]);
    expect(await sessionOf(String(person.view.id))).toEqual(ended);
    expect(await terminationsOf(String(person.view.id))).toHaveLength(1);
  });

  // Break caught: a sign-out ending another session of the same person, which a person on two devices would not mean.
  it('ends the session that signs out and no other session of the same person', async () => {
    const first = await signedIn();
    const other = kit.client.fork();
    const second = await other.post(
      SIGN_IN,
      { email: first.row.workEmail, password: PASSWORD },
      { origin: OPS },
    );
    const secondId = (second.json() as { id: string }).id;

    expect((await signOut(first.client)).status).toBe(204);

    expect((await sessionOf(String(first.view.id)))?.terminated_at).toBeInstanceOf(Date);
    expect((await sessionOf(secondId))?.terminated_at).toBeNull();
    expect((await other.get(SESSION)).status).toBe(200);
  });

  // Break caught: the sign-out ended and the record of it lost, or the record written and the session left live: one transaction.
  it('ends the session and writes its event together: when the event cannot be written, nothing changes', async () => {
    const person = await signedIn();
    const audit = kit.app.app.get<AuditWriter>(AUDIT_WRITER, { strict: false });
    const failing = vi.spyOn(audit, 'write').mockRejectedValueOnce(new Error('the ledger refused'));
    try {
      const response = await signOut(person.client);

      expect(response.status).toBeGreaterThanOrEqual(500);
      expect(failing).toHaveBeenCalled();
    } finally {
      failing.mockRestore();
    }

    expect((await sessionOf(String(person.view.id)))?.terminated_at).toBeNull();
    expect(await terminationsOf(String(person.view.id))).toEqual([]);
    expect(person.client.cookie('melarc_session')).toBe(person.session);
    expect((await person.client.get(SESSION)).status).toBe(200);
  });
});

describe('an unsafe request without the synchronizer token (AC-SLICE-000-84)', () => {
  // Break caught: a sign-out accepted on the cookie alone, from a foreign origin or with a token that is not the session's.
  it.each([
    ['no token', { csrf: 'omit' as const }],
    ['a token that does not match', { csrf: 'A'.repeat(43) }],
    ['an Origin that is not allowed', { origin: 'https://evil.example' }],
  ] as const)(
    'is refused 403 CSRF_VALIDATION_FAILED with %s, changes nothing, and is audited without the token',
    async (_name, options) => {
      const person = await signedIn();

      const response = await signOut(person.client, options);

      expect([response.status, codeOf(response)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
      expect(response.setCookies).toEqual([]);
      expect((await sessionOf(String(person.view.id)))?.terminated_at).toBeNull();
      expect(await terminationsOf(String(person.view.id))).toEqual([]);
      const rejected = await rejectionsOf(requestIdOf(response));
      expect(rejected).toHaveLength(1);
      expect(JSON.stringify(rejected)).not.toContain(person.csrf);
      expect(JSON.stringify(rejected)).not.toContain(person.session);
      // The same request with the correct token and Origin succeeds.
      expect((await signOut(person.client)).status).toBe(204);
    },
  );
});

describe('a session that has been idle is ended by the request that finds it (AC-SLICE-000-35)', () => {
  /** A staff session as a row (a privileged identity is challenged at sign-in, so its session is arranged), idle for `idleMinutes`. */
  async function idleStaff(privileged: boolean, idleMinutes: number) {
    const issued = tokens.issue();
    const csrf = tokens.issue();
    const row = await insertSessionRow(
      admin,
      sessionRow({
        principalId: randomUUID(),
        bundleId: privileged ? BUNDLE_IDS.seniorOps : BUNDLE_IDS.opsStaff,
        snapshot: {
          ...OPS_STAFF_SNAPSHOT,
          name: privileged ? 'Senior Ops' : 'Ops Staff',
          privileged,
        },
        tokenHash: Buffer.from(issued.hash),
        csrfTokenHash: Buffer.from(csrf.hash),
        issuedAt: new Date(Date.now() - 100 * 60_000),
        lastActivityAt: new Date(Date.now() - idleMinutes * 60_000),
      }),
    );
    return { row, token: issued.token, csrf: csrf.token };
  }

  // Break caught: a privileged browser session idle for sixteen minutes still answering, or left ACTIVE in the table.
  it('refuses a privileged session idle for 16 minutes with 401 SESSION_INVALID and terminates it with EXPIRED', async () => {
    const idle = await idleStaff(true, 16);

    const response = await presenting(idle.token).get(SESSION);

    expect([response.status, codeOf(response)]).toEqual([401, 'SESSION_INVALID']);
    expect(await sessionOf(idle.row.id)).toMatchObject({ termination_reason: 'EXPIRED' });
    expect(await terminationsOf(idle.row.id)).toMatchObject([
      {
        actor_type: 'SYSTEM',
        actor_id: null,
        reason_code: 'EXPIRED',
        enhanced: false,
        detail: { cause: 'IDLE' },
      },
    ]);
  });

  // Break caught: the idle limit of the privileged tier applied to every browser session, or none applied to the standard one.
  it('keeps a standard session of the same idleness, and ends it only at its own limit of 30 minutes', async () => {
    const within = await idleStaff(false, 16);
    const beyond = await idleStaff(false, 31);

    expect((await presenting(within.token).get(SESSION)).status).toBe(200);
    expect((await presenting(beyond.token).get(SESSION)).status).toBe(401);

    expect((await sessionOf(within.row.id))?.terminated_at).toBeNull();
    expect(await sessionOf(beyond.row.id)).toMatchObject({ termination_reason: 'EXPIRED' });
  });

  // Break caught: a request that is refused for an expiry writing the refusal into a sign-out: the next request finds the session ended
  // by expiry, says the same, and writes nothing more.
  it('answers the next request the same and writes no second record', async () => {
    const idle = await idleStaff(true, 16);
    expect((await presenting(idle.token).get(SESSION)).status).toBe(401);

    const again = await presenting(idle.token, idle.csrf).delete(SESSION, { origin: OPS });

    expect([again.status, codeOf(again)]).toEqual([401, 'SESSION_INVALID']);
    expect(await terminationsOf(idle.row.id)).toHaveLength(1);
  });
});

describe('a vendor and a rider sign out on their own transaction (P-1, the first consumer)', () => {
  // Break caught: the arms of 0023 not reaching the real route: a vendor's sign-out that cannot commit, that leaves the device cookie
  // cleared, or whose event is not its own.
  it('ends a vendor session, expires only the two session cookies and records the vendor’s own event', async () => {
    const vendor = await arranged('VENDOR');

    const response = await presenting(vendor.token, vendor.csrf).delete(SESSION, {
      origin: VENDOR,
    });

    expect(response.status).toBe(204);
    expect(response.setCookies.map((cookie) => [cookie.name, cookie.maxAge])).toEqual([
      ['melarc_session', 0],
      ['melarc_csrf', 0],
    ]);
    expect(await sessionOf(vendor.row.id)).toMatchObject({ termination_reason: 'SIGNED_OUT' });
    expect(await terminationsOf(vendor.row.id)).toMatchObject([
      {
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: vendor.row.principalId,
        surface_context: 'VENDOR_PWA',
        reason_code: 'SIGNED_OUT',
        enhanced: false,
      },
    ]);
  });

  // Break caught: a native client sent cookies it has nowhere to keep, or a rider session that signing out leaves live.
  it('ends a rider session by its bearer credential, with no cookie and the rider’s own event', async () => {
    const rider = await arranged('RIDER');

    const response = await kit.client.bearer(rider.token).delete(SESSION);

    expect(response.status).toBe(204);
    expect(response.setCookies).toEqual([]);
    expect(await sessionOf(rider.row.id)).toMatchObject({ termination_reason: 'SIGNED_OUT' });
    expect(await terminationsOf(rider.row.id)).toMatchObject([
      {
        actor_type: 'RIDER',
        actor_id: rider.row.principalId,
        surface_context: 'RIDER_ANDROID',
        reason_code: 'SIGNED_OUT',
      },
    ]);
    const next = await kit.client.bearer(rider.token).delete(SESSION);
    expect([next.status, codeOf(next)]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('a challenge is not a session (AC-SLICE-000-03)', () => {
  // Break caught: the reference of a sign-in challenge accepted where a session credential is, which would make the first step of a
  // privileged sign-in a session of its own.
  it('is refused 401 SESSION_INVALID when presented to a business operation as a cookie or as a bearer credential, and is left unspent', async () => {
    const row = await insertStaff(admin, staffRow({ roleBundleId: BUNDLE_IDS.seniorOps }));
    const challenge = await insertChallenge(admin, challengeRow(row.id));

    const asCookie = await presenting(challenge.id).get(SESSION);
    const asBearer = await kit.client.bearer(challenge.id).get(SESSION);
    const asSignOut = await signOut(presenting(challenge.id, challenge.id));

    for (const response of [asCookie, asBearer, asSignOut]) {
      expect([response.status, codeOf(response)]).toEqual([401, 'SESSION_INVALID']);
      expect(response.setCookies).toEqual([]);
    }
    expect(
      await kit.observe.one<{ state: string }>('select state from mfa_challenge where id = $1', [
        challenge.id,
      ]),
    ).toEqual({ state: 'PENDING' });
    expect(await kit.observe.count('session', { principal_id: row.id })).toBe(0);
  });
});

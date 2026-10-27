import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hotp } from '../../src/platform/auth/crypto/hotp.js';
import type { MfaFactorStore } from '../../src/platform/auth/mfa/mfa-factor-store.js';
import { MFA_FACTOR_STORE } from '../../src/platform/auth/mfa/mfa-providers.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  TOKEN_SERVICE,
  type TokenService,
} from '../../src/platform/auth/ports/token-service.port.js';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/auth/ports/unit-of-work.port.js';
import { TRUSTED_BROWSER_STORE } from '../../src/platform/auth/trusted-browsers/trusted-browser-providers.js';
import type { TrustedBrowserStore } from '../../src/platform/auth/trusted-browsers/trusted-browser-store.js';
import type {
  RequestOptions,
  TestClient,
  TestResponse,
} from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { presenting, arrangedFixedSession } from './support/http-sessions.js';
import { insertStaff, staffRow, type StaffRow } from './support/identities.js';
import { systemContext } from './support/rls-fixture.js';
import {
  API,
  HUB_A,
  HUB_B,
  OPS,
  codeOf,
  outcomeOf,
  startStaffRoutes,
  versionOf,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * The trusted browser (staff-authentication.md §5.8; `AC-SLICE-000-133` to `-139`) against the real application and a real PostgreSQL,
 * every request a real HTTP request: a Senior Ops or Platform Admin who proves a code and asks to be remembered is given a credential
 * that, for seven days and for that browser alone, stands in for the code of the second step; and for nothing else. What each answer did
 * is read from a second connection and never from the application's own.
 */
const PASSWORD = 'correct horse battery staple';
const SIGN_IN = `${API}/auth/staff/sign-in`;
const MFA = `${API}/auth/staff/sign-in/mfa`;
const OWN = `${API}/auth/staff/trusted-browsers`;
const OF = (id: string) => `${API}/ops/staff/${id}/trusted-browsers`;
const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';
const COOKIE = 'melarc_trusted_browser';
const REASON = { reason_code: 'SESSION_SECURITY_CONCERN' };
/** What the administrator's removal needs beside the session: the Ops origin and an `Idempotency-Key` (a fresh one unless given). */
const KEYED = (key: string = randomUUID()): RequestOptions => ({
  origin: OPS,
  headers: { 'idempotency-key': key },
});

/** A value a test has arranged and knows is there; a missing one is the test's own defect. */
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('The test arranged this value and it is not there.');
  return value;
}

let routes: StaffRoutes;
let hasher: Hasher;
let tokens: TokenService;
let hashed: string;

beforeAll(async () => {
  routes = await startStaffRoutes();
  hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
  tokens = routes.kit.app.app.get<TokenService>(TOKEN_SERVICE, { strict: false });
  hashed = await hasher.hash('STAFF_PASSWORD', PASSWORD);
});

afterAll(async () => {
  await routes.stop();
});

interface Privileged {
  readonly row: StaffRow;
  readonly seed: Uint8Array;
  readonly factorId: string;
}

/** A privileged identity with a proven authenticator whose seed the test holds, and a password. */
async function privileged(overrides: Partial<StaffRow> = {}): Promise<Privileged> {
  const row = await insertStaff(
    routes.admin,
    staffRow({ credentialHash: hashed, roleBundleId: BUNDLE_IDS.seniorOps, ...overrides }),
  );
  const seed = new Uint8Array(randomBytes(20));
  const factors = routes.kit.app.app.get<MfaFactorStore>(MFA_FACTOR_STORE, { strict: false });
  const unitOfWork = routes.kit.app.app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
  const factorId = await unitOfWork.run(systemContext('authentication'), async (handle) => {
    const factor = await factors.create(handle, {
      staffIdentityId: row.id,
      createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
      seed,
    });
    await factors.activate(handle, factor.id, '0');
    return factor.id;
  });
  return { row, seed, factorId };
}

/** The next code an authenticator holding `seed` shows: each call moves the application's clock a step, so no step is presented twice. */
function nextCode(seed: Uint8Array): string {
  routes.kit.clock.advance(30_000);
  return hotp(seed, Math.floor(routes.kit.clock.now().getTime() / 30_000), 6);
}

const signIn = (
  client: TestClient,
  who: Privileged | StaffRow,
  password = PASSWORD,
  options: RequestOptions = {},
) =>
  client.post(
    SIGN_IN,
    { email: ('row' in who ? who.row : who).workEmail, password },
    { origin: OPS, headers: { 'user-agent': CHROME }, ...options },
  );

/** The whole remembered sign-in of a browser: the password, then the code with `trust_browser`. */
async function remember(client: TestClient, who: Privileged, trust: boolean | 'absent' = true) {
  const first = await signIn(client, who);
  expect(first.status).toBe(202);
  const challenge = (first.json() as { challenge_id: string }).challenge_id;
  const second = await client.post(
    MFA,
    {
      challenge_id: challenge,
      code: nextCode(who.seed),
      ...(trust === 'absent' ? {} : { trust_browser: trust }),
    },
    { origin: OPS, headers: { 'user-agent': CHROME } },
  );
  return { first, second, challenge };
}

interface BrowserRow {
  id: string;
  label: string;
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revocation_cause: string | null;
  revoked_by: string | null;
  token_hash: Buffer;
}
const browsersOf = (row: StaffRow): Promise<BrowserRow[]> =>
  routes.admin
    .query<BrowserRow>(
      `select id, label, created_at, expires_at, last_used_at, revoked_at, revocation_cause, revoked_by, token_hash
         from trusted_browser where staff_identity_id = $1 order by created_at, id`,
      [row.id],
    )
    .then((result) => result.rows);
const validCount = async (row: StaffRow): Promise<number> =>
  (await browsersOf(row)).filter((browser) => browser.revoked_at === null).length;

const auditOf = (code: string, objectId: string) =>
  routes.rows<{
    enhanced: boolean;
    actor_type: string;
    actor_id: string | null;
    reason_code: string | null;
    detail: Record<string, unknown>;
    before_after: Record<string, unknown> | null;
    related_ids: Record<string, unknown> | null;
  }>(
    `select enhanced, actor_type, actor_id, reason_code, detail, before_after, related_ids from audit_event
      where event_code = $1 and object_id = $2 order by recorded_at, id`,
    [code, objectId],
  );

/** Ages a trusted browser as if it were issued `days` ago: only the administrator can back-date one, past the guards. */
async function age(id: string, days: number): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update trusted_browser set created_at = created_at - make_interval(days => $2::int),
                                  expires_at = expires_at - make_interval(days => $2::int) where id = $1`,
      [id, days],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

describe('a proven code, asked to be remembered, issues a bounded credential (AC-SLICE-000-133)', () => {
  // Break caught: the cookie missing or missing an attribute, a stored credential, a lifetime other than seven days, or the choice not
  // being offered by the password step.
  it('sets the one persistent cookie, stores only its hash (AC-SLICE-000-139), and lasts seven days from the database’s clock', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();

    const { first, second } = await remember(browser, who);

    expect(first.setCookies).toEqual([]);
    expect(first.json()).toMatchObject({ trusted_browser_days: 7 });
    expect(second.status).toBe(200);
    expect(second.setCookies.map((cookie) => cookie.name).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
      COOKIE,
    ]);
    const cookie = second.setCookies.find((each) => each.name === COOKIE);
    expect(cookie).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/api/v1/auth/staff',
      maxAge: 604_800,
    });
    expect(cookie?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The session cookies stay browser-session cookies: the trusted one is the only persistent cookie of the sign-in.
    for (const name of ['melarc_csrf', 'melarc_session']) {
      expect(second.setCookies.find((each) => each.name === name)?.maxAge).toBeUndefined();
    }
    const stored = await browsersOf(who.row);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.label).toBe('Chrome on Windows');
    expect((stored[0]?.expires_at.getTime() ?? 0) - (stored[0]?.created_at.getTime() ?? 0)).toBe(
      7 * 24 * 60 * 60_000,
    );
    expect(stored[0]?.last_used_at).toBeNull();
    // Only the hash of the credential is kept, and it is not the credential.
    const expectedHash = tokens.hash(cookie?.value ?? '');
    expect(
      Buffer.compare(stored[0]?.token_hash ?? Buffer.alloc(0), Buffer.from(expectedHash ?? [])),
    ).toBe(0);
    const everywhere = await routes.admin.query<{ n: string }>(
      `select (select count(*) from audit_event where detail::text like '%' || $1 || '%' or related_ids::text like '%' || $1 || '%'
                   or before_after::text like '%' || $1 || '%') as n`,
      [cookie?.value],
    );
    expect(everywhere.rows[0]?.n).toBe('0');
    expect(second.text).not.toContain(cookie?.value ?? 'x');
  });

  it('records the issue and the session with the fact second_factor TOTP, for the person, with no credential', async () => {
    const who = await privileged();

    await remember(routes.kit.client.fork(), who);

    const issued = await auditOf('auth.trusted_browser.issued', who.row.id);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      enhanced: false,
      actor_type: 'STAFF',
      actor_id: who.row.id,
      detail: { label: 'Chrome on Windows' },
    });
    expect(issued[0]?.related_ids).toMatchObject({ factor_id: who.factorId });
    const session = await routes.rows<{ detail: Record<string, unknown> | null }>(
      `select detail from audit_event where event_code = 'auth.session.issued' and actor_id = $1`,
      [who.row.id],
    );
    expect(session.map((event) => event.detail)).toEqual([{ second_factor: 'TOTP' }]);
  });

  // Break caught: a trusted browser made without being asked, or made for `false`.
  it.each([
    ['no choice', 'absent'],
    ['the choice declined', false],
  ] as const)('makes none for %s', async (_name, choice) => {
    const who = await privileged();
    const browser = routes.kit.client.fork();

    const { second } = await remember(browser, who, choice);

    expect(second.status).toBe(200);
    expect(second.setCookies.map((cookie) => cookie.name)).not.toContain(COOKIE);
    expect(await browsersOf(who.row)).toEqual([]);
    expect(await auditOf('auth.trusted_browser.issued', who.row.id)).toEqual([]);
  });

  // Break caught: a wrong code, an expired challenge or a lock that still remembers the browser.
  it('makes none for a wrong code, and none when the challenge is spent', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    const first = await signIn(browser, who);
    const challenge = (first.json() as { challenge_id: string }).challenge_id;

    const wrong = await browser.post(
      MFA,
      { challenge_id: challenge, code: '000000', trust_browser: true },
      { origin: OPS },
    );
    expect(outcomeOf(wrong)).toEqual([422, 'MFA_PROOF_INVALID']);
    expect(wrong.setCookies).toEqual([]);

    const good = await browser.post(
      MFA,
      { challenge_id: challenge, code: nextCode(who.seed), trust_browser: true },
      { origin: OPS },
    );
    expect(good.status).toBe(200);
    const again = await browser.post(
      MFA,
      { challenge_id: challenge, code: nextCode(who.seed), trust_browser: true },
      { origin: OPS },
    );
    expect(outcomeOf(again)).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(await browsersOf(who.row)).toHaveLength(1);
  });

  // Break caught: a body that accepts a value that is not a boolean.
  it('refuses a trust_browser that is not a boolean', async () => {
    const who = await privileged();
    const first = await signIn(routes.kit.client.fork(), who);

    const response = await routes.kit.client.fork().post(
      MFA,
      {
        challenge_id: (first.json() as { challenge_id: string }).challenge_id,
        code: nextCode(who.seed),
        trust_browser: 'yes',
      },
      { origin: OPS },
    );

    expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
    expect(await browsersOf(who.row)).toEqual([]);
  });

  // Break caught: more than five valid, the wrong one giving way, or the replaced browser still signing in.
  it('keeps at most five valid: a sixth removes the oldest, which then asks for a code', async () => {
    const who = await privileged();
    const browsers: TestClient[] = [];
    for (let index = 0; index < 6; index += 1) {
      const browser = routes.kit.client.fork();
      expect((await remember(browser, who)).second.status).toBe(200);
      browsers.push(browser);
    }

    expect(await validCount(who.row)).toBe(5);
    const stored = await browsersOf(who.row);
    expect(stored[0]).toMatchObject({ revocation_cause: 'REPLACED', revoked_by: null });
    const revoked = await auditOf('auth.trusted_browser.revoked', who.row.id);
    expect(revoked.map((event) => event.detail)).toEqual([{ cause: 'REPLACED' }]);
    // The first browser is asked for a code again; the sixth is not.
    expect((await signIn(required(browsers[0]), who)).status).toBe(202);
    expect((await signIn(required(browsers[5]), who)).status).toBe(200);
  });
});

describe('a trusted browser skips the second factor and nothing else (AC-SLICE-000-134)', () => {
  // Break caught: a challenge issued although the browser is trusted, a renewal of the lifetime, a use that is not recorded, a count that
  // is not cleared, or the cookie set again.
  it('answers 200 with the session, records the use, never moves the end, clears the count and sets no trusted cookie', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    const [before] = await browsersOf(who.row);
    await routes.kit.admin.setColumn('staff_identity', 'failed_attempt_count', 2, {
      id: who.row.id,
    });
    const challengesBefore = await routes.kit.observe.count('mfa_challenge', {
      staff_identity_id: who.row.id,
    });

    const response = await signIn(browser, who);

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.setCookies.map((cookie) => cookie.name).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
    ]);
    expect(response.json()).toMatchObject({ principal_id: who.row.id, state: 'ACTIVE' });
    const [after] = await browsersOf(who.row);
    expect(after?.last_used_at).not.toBeNull();
    expect(after?.expires_at.getTime()).toBe(before?.expires_at.getTime());
    expect(await routes.kit.observe.count('mfa_challenge', { staff_identity_id: who.row.id })).toBe(
      challengesBefore,
    );
    const row = await routes.kit.observe.one<{ failed_attempt_count: number }>(
      'select failed_attempt_count from staff_identity where id = $1',
      [who.row.id],
    );
    expect(row?.failed_attempt_count).toBe(0);
    // The session is exactly the one a proven code issues: privileged for 480 minutes.
    const stored = await routes.kit.observe.one<{
      issued_at: Date;
      expires_at: Date;
      bundle_snapshot: { name: string; privileged: boolean };
    }>(
      'select issued_at, expires_at, bundle_snapshot from session where principal_id = $1 order by issued_at desc limit 1',
      [who.row.id],
    );
    expect(stored?.bundle_snapshot).toMatchObject({ name: 'Senior Ops', privileged: true });
    expect((stored?.expires_at.getTime() ?? 0) - (stored?.issued_at.getTime() ?? 0)).toBe(
      480 * 60_000,
    );
    const issued = await routes.rows<{ detail: Record<string, unknown> | null }>(
      `select detail from audit_event where event_code = 'auth.session.issued' and actor_id = $1 order by recorded_at, id`,
      [who.row.id],
    );
    expect(issued.map((event) => event.detail)).toEqual([
      { second_factor: 'TOTP' },
      { second_factor: 'TRUSTED_BROWSER' },
    ]);
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.mfa.completed' and actor_id = $1`,
        [who.row.id],
      ),
    ).toHaveLength(1);
  });

  // Break caught: the cookie standing in for the password, a count that does not move, or a lock that gives way to the cookie.
  it('still asks for the password: a wrong one is INVALID_CREDENTIALS and counted, and a lock refuses a correct one', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    const sessions = () => routes.kit.observe.count('session', { principal_id: who.row.id });
    const sessionsBefore = await sessions();

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const wrong = await signIn(browser, who, 'not the password');
      expect(outcomeOf(wrong)).toEqual([422, 'INVALID_CREDENTIALS']);
      expect(wrong.setCookies).toEqual([]);
    }
    const locked = await routes.kit.observe.one<{
      failed_attempt_count: number;
      locked_until: Date | null;
    }>('select failed_attempt_count, locked_until from staff_identity where id = $1', [who.row.id]);
    expect(locked?.failed_attempt_count).toBe(5);
    expect(locked?.locked_until).not.toBeNull();

    const refused = await signIn(browser, who);
    expect(outcomeOf(refused)).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await sessions()).toBe(sessionsBefore);
    expect((await browsersOf(who.row))[0]?.last_used_at).toBeNull();
  });

  // Break caught: an invalid credential behaving differently from none, being mentioned, or being answered with a cookie.
  it.each([
    ['an unknown credential', () => `${COOKIE}=${'A'.repeat(43)}`],
    ['a credential that is not a token at all', () => `${COOKIE}=not a token`],
    ['an empty credential', () => `${COOKIE}=`],
    ['the credential sent twice', () => `${COOKIE}=${'A'.repeat(43)}; ${COOKIE}=${'B'.repeat(43)}`],
  ])('answers the ordinary challenge for %s, with no word about it', async (_name, header) => {
    const who = await privileged();
    const without = await signIn(routes.kit.client.fork(), who);

    const response = await signIn(routes.kit.client.fork(), who, PASSWORD, {
      headers: { cookie: header() },
    });

    expect(response.status).toBe(202);
    expect(response.setCookies).toEqual([]);
    expect(Object.keys(response.json() as object).toSorted()).toEqual(
      Object.keys(without.json() as object).toSorted(),
    );
    expect(response.header('cache-control')).toBe(without.header('cache-control'));
    expect(await browsersOf(who.row)).toEqual([]);
  });

  // Break caught: a credential of one person standing in for another's code.
  it('does not let one person’s credential stand in for another’s code', async () => {
    const owner = await privileged();
    const other = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, owner);
    const cookie = browser.cookie(COOKIE) ?? '';

    const response = await signIn(routes.kit.client.fork(), other, PASSWORD, {
      headers: { cookie: `${COOKIE}=${cookie}` },
    });

    expect(response.status).toBe(202);
    expect((await browsersOf(owner.row))[0]?.last_used_at).toBeNull();
  });

  // Break caught: a credential read for an Ops Staff sign-in, or one that changes what such a sign-in answers.
  it('is not read for an Ops Staff sign-in, which is answered 200 as ever with the fact second_factor NONE', async () => {
    const staff = await insertStaff(routes.admin, staffRow({ credentialHash: hashed }));
    const response = await signIn(routes.kit.client.fork(), staff, PASSWORD, {
      headers: { cookie: `${COOKIE}=${'A'.repeat(43)}` },
    });

    expect(response.status).toBe(200);
    expect(response.setCookies.map((cookie) => cookie.name).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
    ]);
    const issued = await routes.rows<{ detail: Record<string, unknown> | null }>(
      `select detail from audit_event where event_code = 'auth.session.issued' and actor_id = $1`,
      [staff.id],
    );
    expect(issued.map((event) => event.detail)).toEqual([{ second_factor: 'NONE' }]);
  });

  // Break caught: signing out ending the trust, which would defeat its purpose.
  it('survives signing out', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    expect((await browser.delete(`${API}/auth/session`, { origin: OPS })).status).toBe(204);
    expect(browser.cookie('melarc_session')).toBeUndefined();
    expect(browser.cookie(COOKIE)).toBeDefined();

    expect((await signIn(browser, who)).status).toBe(200);
  });

  // Break caught: a credential that outlives its seven days, because use renewed it or the clock read was the application's.
  it('stops standing in once seven days have passed on the database’s clock', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    const [stored] = await browsersOf(who.row);

    await age(stored?.id ?? '', 8);

    expect((await signIn(browser, who)).status).toBe(202);
    expect((await browsersOf(who.row))[0]?.last_used_at).toBeNull();
  });

  // Break caught: the cookie outliving the seven days in the browser itself (the jar judges Max-Age).
  it('is dropped by the browser itself after seven days', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    expect(browser.cookie(COOKIE)).toBeDefined();

    routes.kit.clock.advance(7 * 24 * 60 * 60_000 + 1000);

    expect(browser.cookie(COOKIE)).toBeUndefined();
  });
});

describe('a trusted browser ends when the thing it vouched for changes (AC-SLICE-000-135)', () => {
  // Break caught: a browser that survives a reset of the authenticator, or a reset that leaves no trace of it.
  it('ends with a reset of the authenticator, in its transaction, recorded for the browser', async () => {
    const who = await privileged({ primaryHubId: null });
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    const platformAdmin = await routes.platformAdmin();

    const reset = await platformAdmin.client.post(
      `${API}/ops/staff/${who.row.id}/mfa/reset`,
      { reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' },
      {
        origin: OPS,
        headers: { 'if-match': await versionOf(platformAdmin, who.row.id) },
      },
    );

    expect(reset.status).toBe(200);
    expect((await browsersOf(who.row))[0]).toMatchObject({
      revocation_cause: 'FACTOR_RESET',
      revoked_by: platformAdmin.identity.id,
    });
    expect(
      (await auditOf('auth.trusted_browser.revoked', who.row.id)).map((event) => event.detail),
    ).toEqual([{ cause: 'FACTOR_RESET' }]);
    // The cookie is still in the browser, and stands in for nothing.
    expect(browser.cookie(COOKIE)).toBeDefined();
    expect((await signIn(browser, who)).status).toBe(202);
  });

  // Break caught: a browser that survives a replaced authenticator because only the cause was recorded and the binding not checked.
  it('stands in for nothing once the authenticator it vouched for is not the identity’s active one', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    await remember(browser, who);
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update mfa_factor set status = 'REVOKED', revoked_at = clock_timestamp() where id = $1`,
      [who.factorId],
    );
    await routes.admin.query('commit');

    expect((await signIn(browser, who)).status).toBe(202);
  });

  // Break caught: a browser that survives a new password (the credential generation moved) or an identity that is no longer active.
  it('stands in for nothing once the credential moved or the identity is not active', async () => {
    const moved = await privileged();
    const movedBrowser = routes.kit.client.fork();
    await remember(movedBrowser, moved);
    const newHash = await hasher.hash('STAFF_PASSWORD', 'another long passphrase');
    await routes.admin.query(
      `update staff_identity set credential_hash = $2, credential_generation = 2, credential_established_at = clock_timestamp() where id = $1`,
      [moved.row.id, newHash],
    );
    expect((await signIn(movedBrowser, moved, 'another long passphrase')).status).toBe(202);

    const suspended = await privileged();
    const suspendedBrowser = routes.kit.client.fork();
    await remember(suspendedBrowser, suspended);
    await routes.admin.query('begin');
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(`update staff_identity set status = 'SUSPENDED' where id = $1`, [
      suspended.row.id,
    ]);
    await routes.admin.query('commit');
    expect(outcomeOf(await signIn(suspendedBrowser, suspended))).toEqual([
      422,
      'INVALID_CREDENTIALS',
    ]);
  });
});

/** A browser of an actor that presents the session and, when it has one, a trusted-browser credential. */
function browserOf(actor: Actor, trusted?: string): TestClient {
  const client = routes.kit.client.fork();
  const original = client.request.bind(client);
  client.request = (method: string, path: string, options?: RequestOptions) =>
    original(method, path, {
      ...options,
      headers: {
        ...options?.headers,
        cookie: [
          `melarc_session=${actor.token}`,
          ...(actor.csrf === undefined ? [] : [`melarc_csrf=${actor.csrf}`]),
          ...(trusted === undefined ? [] : [`${COOKIE}=${trusted}`]),
        ].join('; '),
      },
      ...(actor.csrf === undefined ? {} : { csrf: options?.csrf ?? actor.csrf }),
    });
  return client;
}

/** A trusted browser arranged for an identity through the application's own store, with a credential the test holds. */
async function arranged(who: Actor, label = 'Firefox on Linux') {
  const factors = routes.kit.app.app.get<MfaFactorStore>(MFA_FACTOR_STORE, { strict: false });
  const store = routes.kit.app.app.get<TrustedBrowserStore>(TRUSTED_BROWSER_STORE, {
    strict: false,
  });
  const unitOfWork = routes.kit.app.app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
  const credential = tokens.issue();
  const id = await unitOfWork.run(systemContext('authentication'), async (handle) => {
    const active = await routes.admin.query<{ id: string }>(
      `select id from mfa_factor where staff_identity_id = $1 and status = 'ACTIVE'`,
      [who.identity.id],
    );
    let factorId = active.rows[0]?.id;
    if (factorId === undefined) {
      const factor = await factors.create(handle, {
        staffIdentityId: who.identity.id,
        createdByPurpose: 'STAFF_CREDENTIAL_SETUP',
        seed: new Uint8Array(randomBytes(20)),
      });
      await factors.activate(handle, factor.id, '0');
      factorId = factor.id;
    }
    return (
      await store.issue(handle, {
        staffIdentityId: who.identity.id,
        tokenHash: credential.hash,
        factorId,
        credentialGeneration: who.identity.credentialGeneration,
        label,
      })
    ).browser.id;
  });
  return { id, token: credential.token };
}

describe('a person lists and removes their own trusted browsers (AC-SLICE-000-136)', () => {
  // Break caught: another person's browsers listed, a removed or ended one shown as usable, the wrong order, the browser asking not
  // marked, or anything that could be used to sign in in the answer.
  it('lists the person’s valid browsers, newest first, marks the one asking, and shows nothing usable', async () => {
    const me = await routes.seniorOps();
    const stranger = await routes.seniorOps();
    const older = await arranged(me, 'Safari on macOS');
    const newer = await arranged(me, 'Edge on Windows');
    const gone = await arranged(me);
    await browserOf(me).delete(`${OWN}/${gone.id}`, { origin: OPS });
    const ended = await arranged(me);
    await age(ended.id, 9);
    await arranged(stranger);

    const response = await browserOf(me, newer.token).get(OWN);

    expect(response.status).toBe(200);
    const items = (response.json() as { items: { id: string; label: string; current: boolean }[] })
      .items;
    expect(items.map((item) => [item.id, item.label, item.current])).toEqual([
      [newer.id, 'Edge on Windows', true],
      [older.id, 'Safari on macOS', false],
    ]);
    expect(Object.keys(items[0] ?? {}).toSorted()).toEqual([
      'created_at',
      'current',
      'expires_at',
      'id',
      'label',
      'last_used_at',
    ]);
    for (const secret of [newer.token, older.token, me.token]) {
      expect(response.text).not.toContain(secret);
    }
    expect(response.text).not.toMatch(/token|hash|factor|generation/i);
  });

  it('is an empty list for a role that signs in without an authenticator, and for a person who asks with no credential', async () => {
    const staff = await routes.opsStaff();
    const me = await routes.seniorOps();
    await arranged(me);

    expect((await staff.client.get(OWN)).json()).toEqual({ items: [] });
    const without = (await browserOf(me).get(OWN)).json() as { items: { current: boolean }[] };
    expect(without.items.map((item) => item.current)).toEqual([false]);
  });

  // Break caught: a Vendor's session or a Rider's credential reaching an operation of the Ops Portal's staff: the three models never mix.
  it('refuses a Vendor with PERMISSION_DENIED and a Rider’s bearer credential as no session, on all four operations', async () => {
    const vendor = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR');
    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const asVendor = presenting(routes.kit, vendor.token, vendor.csrf);
    // A Vendor's request is judged from the Vendor PWA's origin: from the Ops origin it is a CSRF refusal before it is anything else.
    const VENDOR_ORIGIN = 'http://127.0.0.1:5174';
    const asRider = routes.kit.client.bearer(rider.token);
    const id = randomUUID();
    const NO_SESSION: [number, string] = [401, 'SESSION_INVALID'];
    const calls: [string, (client: TestClient) => Promise<TestResponse>, [number, string]][] = [
      ['list', (client) => client.get(OWN), NO_SESSION],
      ['remove', (client) => client.delete(`${OWN}/${id}`, { origin: VENDOR_ORIGIN }), NO_SESSION],
      ['administrator list', (client) => client.get(OF(id)), NO_SESSION],
      [
        'administrator removal',
        (client) =>
          client.post(`${OF(id)}/revoke`, REASON, {
            origin: VENDOR_ORIGIN,
            headers: { 'idempotency-key': randomUUID() },
          }),
        NO_SESSION,
      ],
    ];

    for (const [name, call, forRider] of calls) {
      expect(outcomeOf(await call(asVendor)), name).toEqual([403, 'PERMISSION_DENIED']);
      expect(outcomeOf(await call(asRider)), name).toEqual(forRider);
    }
  });

  // Break caught: the list or the removal answered to a request with no session.
  it('refuses a request with no session', async () => {
    const list = await routes.kit.client.fork().get(OWN);
    const remove = await routes.kit.client.fork().delete(`${OWN}/${randomUUID()}`, { origin: OPS });

    expect(outcomeOf(list)).toEqual([401, 'SESSION_INVALID']);
    expect(outcomeOf(remove)[0]).toBe(401);
  });

  // Break caught: a removal that leaves the row usable, records nobody, clears a cookie that is not the browser asking's, or reaches
  // another person's browser.
  it('removes one once (SELF), clears the cookie only when it is the browser asking, and tells another’s from an absent one by nothing', async () => {
    const me = await routes.seniorOps();
    const stranger = await routes.seniorOps();
    const mine = await arranged(me);
    const other = await arranged(me);
    const theirs = await arranged(stranger);

    const notAsking = await browserOf(me, mine.token).delete(`${OWN}/${other.id}`, { origin: OPS });
    expect(notAsking.status).toBe(204);
    expect(notAsking.setCookies).toEqual([]);
    const again = await browserOf(me, mine.token).delete(`${OWN}/${other.id}`, { origin: OPS });
    const foreign = await browserOf(me, mine.token).delete(`${OWN}/${theirs.id}`, { origin: OPS });
    const absent = await browserOf(me).delete(`${OWN}/${randomUUID()}`, { origin: OPS });
    expect([outcomeOf(again), outcomeOf(foreign), outcomeOf(absent)]).toEqual([
      [404, 'NOT_FOUND'],
      [404, 'NOT_FOUND'],
      [404, 'NOT_FOUND'],
    ]);
    expect((await browsersOf(stranger.identity)).every((row) => row.revoked_at === null)).toBe(
      true,
    );

    // One that has ended (its seven days are over) is as gone as a removed one: it is not the person's to remove, and nothing is written.
    const ended = await arranged(me);
    await age(ended.id, 9);
    const gone = await browserOf(me, mine.token).delete(`${OWN}/${ended.id}`, { origin: OPS });
    expect(outcomeOf(gone)).toEqual([404, 'NOT_FOUND']);
    expect(
      (await browsersOf(me.identity)).find((row) => row.id === ended.id)?.revoked_at,
    ).toBeNull();

    const asking = await browserOf(me, mine.token).delete(`${OWN}/${mine.id}`, { origin: OPS });
    expect(asking.status).toBe(204);
    expect(asking.setCookies).toHaveLength(1);
    expect(asking.setCookies[0]).toMatchObject({
      name: COOKIE,
      value: '',
      maxAge: 0,
      path: '/api/v1/auth/staff',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    const rows = await browsersOf(me.identity);
    expect(
      rows
        .filter((row) => row.revoked_at !== null)
        .map((row) => [row.id, row.revocation_cause, row.revoked_by]),
    ).toEqual([
      [mine.id, 'SELF', me.identity.id],
      [other.id, 'SELF', me.identity.id],
    ]);
    const events = await auditOf('auth.trusted_browser.revoked', me.identity.id);
    expect(events.map((event) => [event.actor_id, event.detail])).toEqual([
      [me.identity.id, { cause: 'SELF' }],
      [me.identity.id, { cause: 'SELF' }],
    ]);
  });

  // Break caught: a removal without the synchronizer token or from another origin.
  it('refuses a removal without the synchronizer token or from another origin', async () => {
    const me = await routes.seniorOps();
    const mine = await arranged(me);

    const noToken = await browserOf(me).delete(`${OWN}/${mine.id}`, { origin: OPS, csrf: 'omit' });
    const wrongOrigin = await browserOf(me).delete(`${OWN}/${mine.id}`, {
      origin: 'http://evil.example',
    });

    expect(outcomeOf(noToken)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(outcomeOf(wrongOrigin)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect((await browsersOf(me.identity))[0]?.revoked_at).toBeNull();
  });

  // Break caught: a removed browser still signing in.
  it('stops a removed browser from standing in for the code', async () => {
    const who = await privileged();
    const browser = routes.kit.client.fork();
    const { second } = await remember(browser, who);
    expect(second.status).toBe(200);
    const [stored] = await browsersOf(who.row);
    const session =
      second.setCookies.find((cookie) => cookie.name === 'melarc_session')?.value ?? '';
    const csrf = second.setCookies.find((cookie) => cookie.name === 'melarc_csrf')?.value ?? '';

    const removal = await browser.delete(`${OWN}/${stored?.id ?? ''}`, { origin: OPS });
    expect(removal.status).toBe(204);
    expect(session).not.toBe('');
    expect(csrf).not.toBe('');

    expect(browser.cookie(COOKIE)).toBeUndefined();
    expect((await signIn(browser, who)).status).toBe(202);
  });
});

describe('a Platform Admin removes another person’s trusted browsers, with a reason (AC-SLICE-000-137)', () => {
  // Break caught: the key held without the tier opening the list or the removal, or a role without the key getting past the scope.
  it('refuses a Senior Ops caller with INSUFFICIENT_AUTHORITY and an Ops Staff caller with PERMISSION_DENIED', async () => {
    const target = await routes.seniorOps();
    await arranged(target);
    const seniorOps = await routes.seniorOps();
    const staff = await routes.opsStaff();

    for (const [caller, expected] of [
      [seniorOps, 'INSUFFICIENT_AUTHORITY'],
      [staff, 'PERMISSION_DENIED'],
    ] as const) {
      const list = await caller.client.get(OF(target.identity.id));
      const revoke = await caller.client.post(`${OF(target.identity.id)}/revoke`, REASON, KEYED());
      expect([codeOf(list), codeOf(revoke)]).toEqual([expected, expected]);
    }
    expect((await browsersOf(target.identity)).every((row) => row.revoked_at === null)).toBe(true);
  });

  // Break caught: a list that shows a credential, the wrong people's browsers, or `current` true for an administrator's list.
  it('lists the identity’s valid browsers with labels and dates only', async () => {
    const target = await routes.seniorOps();
    const first = await arranged(target, 'Chrome on Windows');
    const second = await arranged(target, 'Safari on macOS');
    await arranged(await routes.seniorOps());
    const admin = await routes.platformAdmin();

    const response = await admin.client.get(OF(target.identity.id));

    expect(response.status).toBe(200);
    const items = (response.json() as { items: { id: string; current: boolean }[] }).items;
    expect(items.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(items.every((item) => !item.current)).toBe(true);
    expect(response.text).not.toMatch(/token|hash|factor|generation/i);
    expect(outcomeOf(await admin.client.get(OF(randomUUID())))).toEqual([404, 'NOT_FOUND']);
  });

  // Break caught: a removal that leaves some usable, names no administrator, writes a plain event or leaves out the reason, the count or
  // the people it ended.
  it('removes all of them in one transaction, names the administrator, and writes the enhanced event with the reason and the count', async () => {
    const target = await routes.seniorOps();
    const bystander = await routes.seniorOps();
    const first = await arranged(target);
    const second = await arranged(target);
    await agedAndNot(target);
    const spared = await arranged(bystander);
    const admin = await routes.platformAdmin();

    const response = await admin.client.post(
      `${OF(target.identity.id)}/revoke`,
      { ...REASON, note: 'Lost laptop reported by the team lead' },
      KEYED(),
    );

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ revoked: 3 });
    const rows = await browsersOf(target.identity);
    const removed = rows.filter((row) => row.revoked_at !== null);
    expect(removed.map((row) => [row.revocation_cause, row.revoked_by])).toEqual(
      removed.map(() => ['ADMINISTRATOR', admin.identity.id]),
    );
    expect(removed.map((row) => row.id).toSorted()).toContain(first.id);
    expect(removed.map((row) => row.id).toSorted()).toContain(second.id);
    expect(
      (await browsersOf(bystander.identity)).find((row) => row.id === spared.id)?.revoked_at,
    ).toBeNull();
    const [event, ...rest] = await auditOf(
      'auth.trusted_browser.admin_revoked',
      target.identity.id,
    );
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      enhanced: true,
      actor_type: 'STAFF',
      actor_id: admin.identity.id,
      reason_code: 'SESSION_SECURITY_CONCERN',
      detail: { revoked: 3 },
      before_after: { valid_trusted_browsers: { before: 3, after: 0 } },
    });
    const nothing = await admin.client.post(`${OF(target.identity.id)}/revoke`, REASON, KEYED());
    expect(nothing.json()).toEqual({ revoked: 0 });
  });

  // Break caught: a reason that is missing, unknown or from another domain accepted; a note the ledger would refuse; no token; a state
  // changed by a refused request.
  it('refuses a missing, unknown or unpermitted reason, a note the ledger would refuse, a missing token, and changes nothing', async () => {
    const target = await routes.seniorOps();
    await arranged(target);
    const admin = await routes.platformAdmin();
    const revoke = (body: unknown, options: RequestOptions = {}) =>
      admin.client.post(`${OF(target.identity.id)}/revoke`, body, { ...KEYED(), ...options });

    expect(codeOf(await revoke({}))).toBe('VALIDATION_FAILED');
    expect(codeOf(await revoke({ reason_code: '' }))).toBe('REASON_REQUIRED');
    expect(codeOf(await revoke({ reason_code: 'NO_SUCH_REASON' }))).toBe('REASON_NOT_ACTIVE');
    expect(codeOf(await revoke({ reason_code: 'MFA_AUTHENTICATOR_UNAVAILABLE' }))).toBe(
      'REASON_NOT_ACTIVE',
    );
    expect(codeOf(await revoke({ ...REASON, note: 'write to ama@example.test' }))).toBe(
      'VALIDATION_FAILED',
    );
    const noToken = await routes.kit.client
      .fork()
      .post(`${OF(target.identity.id)}/revoke`, REASON, {
        origin: OPS,
        csrf: 'omit',
        headers: { cookie: `melarc_session=${admin.token}`, 'idempotency-key': randomUUID() },
      });
    expect(codeOf(noToken)).toBe('CSRF_VALIDATION_FAILED');
    expect(codeOf(await revoke(REASON, { origin: 'http://evil.example' }))).toBe(
      'CSRF_VALIDATION_FAILED',
    );
    expect(await validCount(target.identity)).toBe(1);
    expect(await auditOf('auth.trusted_browser.admin_revoked', target.identity.id)).toEqual([]);
  });

  it('removes nothing for an identity that has none, and says so', async () => {
    const staff = await routes.opsStaff();
    const admin = await routes.platformAdmin();

    const response = await admin.client.post(`${OF(staff.identity.id)}/revoke`, REASON, KEYED());

    expect(response.json()).toEqual({ revoked: 0 });
    expect(
      outcomeOf(await admin.client.post(`${OF(randomUUID())}/revoke`, REASON, KEYED())),
    ).toEqual([404, 'NOT_FOUND']);
  });

  // Break caught (G03 of the audit of 26 October 2026): "every valid browser" is not a fixed set. The answer of a removal is lost; the
  // person proves a code again and is remembered; the administrator's retry removed that new browser too and wrote a second event. The
  // retry now replays the first answer and touches nothing.
  it('replays the answer of a removal whose answer was lost, removes nothing enrolled since, and writes one event', async () => {
    const target = await routes.seniorOps();
    const first = await arranged(target);
    const admin = await routes.platformAdmin();
    const key = randomUUID();

    const original = await admin.client.post(
      `${OF(target.identity.id)}/revoke`,
      REASON,
      KEYED(key),
    );
    expect(original.json()).toEqual({ revoked: 1 });
    // The person is remembered again between the request and its retry.
    const enrolledSince = await arranged(target, 'Firefox on Linux');
    expect(await validCount(target.identity)).toBe(1);

    const retry = await admin.client.post(`${OF(target.identity.id)}/revoke`, REASON, KEYED(key));

    expect(retry.status).toBe(200);
    expect(retry.json()).toEqual({ revoked: 1 });
    expect(await validCount(target.identity)).toBe(1);
    const rows = await browsersOf(target.identity);
    expect(rows.find((row) => row.id === enrolledSince.id)?.revoked_at).toBeNull();
    expect(rows.find((row) => row.id === first.id)?.revocation_cause).toBe('ADMINISTRATOR');
    expect(await auditOf('auth.trusted_browser.admin_revoked', target.identity.id)).toHaveLength(1);
    // A new command is a new key: it removes what is there now, and is a second act with its own event.
    const next = await admin.client.post(`${OF(target.identity.id)}/revoke`, REASON, KEYED());
    expect(next.json()).toEqual({ revoked: 1 });
    expect(await validCount(target.identity)).toBe(0);
    expect(await auditOf('auth.trusted_browser.admin_revoked', target.identity.id)).toHaveLength(2);
  });

  // Break caught: a key that is not bound to what it was used for, so that it replays the answer for another person, reason or note.
  it('refuses the same key for another identity, reason or note with IDEMPOTENCY_KEY_CONFLICT, and removes nothing', async () => {
    const target = await routes.seniorOps();
    const other = await routes.seniorOps();
    await arranged(target);
    await arranged(other);
    const admin = await routes.platformAdmin();
    const key = randomUUID();
    const original = await admin.client.post(
      `${OF(target.identity.id)}/revoke`,
      REASON,
      KEYED(key),
    );
    expect(original.status).toBe(200);
    const again = await arranged(target, 'Edge on Windows');

    const otherIdentity = await admin.client.post(
      `${OF(other.identity.id)}/revoke`,
      REASON,
      KEYED(key),
    );
    const otherReason = await admin.client.post(
      `${OF(target.identity.id)}/revoke`,
      { reason_code: 'SESSION_ANOMALOUS_ACTIVITY' },
      KEYED(key),
    );
    const otherNote = await admin.client.post(
      `${OF(target.identity.id)}/revoke`,
      { ...REASON, note: 'A note the first request did not have' },
      KEYED(key),
    );

    for (const response of [otherIdentity, otherReason, otherNote]) {
      expect(outcomeOf(response)).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    }
    expect(await validCount(other.identity)).toBe(1);
    expect(
      (await browsersOf(target.identity)).find((row) => row.id === again.id)?.revoked_at,
    ).toBeNull();
    expect(await auditOf('auth.trusted_browser.admin_revoked', other.identity.id)).toEqual([]);
  });

  // Break caught: an operation that runs without a key, or with one the store cannot keep, and so cannot be repeated safely.
  it('needs an Idempotency-Key of one to 128 characters, and changes nothing without one', async () => {
    const target = await routes.seniorOps();
    await arranged(target);
    const admin = await routes.platformAdmin();
    const url = `${OF(target.identity.id)}/revoke`;

    const missing = await admin.client.post(url, REASON, { origin: OPS });
    const empty = await admin.client.post(url, REASON, KEYED(''));
    const tooLong = await admin.client.post(url, REASON, KEYED('k'.repeat(129)));

    for (const response of [missing, empty, tooLong]) {
      expect(outcomeOf(response)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(await validCount(target.identity)).toBe(1);
    expect(await auditOf('auth.trusted_browser.admin_revoked', target.identity.id)).toEqual([]);
  });

  // Break caught: a refused request that keeps its receipt, so that the key is spent and the corrected request is told it is a conflict
  // or a replay of nothing.
  it('keeps no receipt for a request that failed: the key can be used again for the corrected request', async () => {
    const target = await routes.seniorOps();
    await arranged(target);
    const admin = await routes.platformAdmin();
    const key = randomUUID();
    const url = `${OF(target.identity.id)}/revoke`;

    const refused = await admin.client.post(url, { reason_code: 'NO_SUCH_REASON' }, KEYED(key));
    expect(outcomeOf(refused)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(await validCount(target.identity)).toBe(1);

    const corrected = await admin.client.post(url, REASON, KEYED(key));

    expect(corrected.status).toBe(200);
    expect(corrected.json()).toEqual({ revoked: 1 });
  });
});

// G04 of the audit of 26 October 2026: an authorised read of another person's records outside the actor's own hub is audited (audit.md
// sections 5.4 and 6), and the administrator's list of another person's trusted browsers is such a read. The rule is the one the other staff
// lists follow: the hub is the identity's, read from the identity and never from the client; the baseline is the actor's primary hub; one
// bounded event for the foreign hub, naming the hub and the operation; none inside the actor's own hub, for an identity with no hub or for an
// empty answer; and a ledger that cannot take the event fails the read.
describe('the administrator’s list audits the hub boundary it crosses (G04)', () => {
  interface Crossing {
    readonly object_type: string;
    readonly object_id: string;
    readonly responsible_hub_id: string | null;
    readonly enhanced: boolean;
    readonly outcome: string;
    readonly related_ids: Record<string, unknown> | null;
    readonly before_after: unknown;
    readonly note: string | null;
    readonly detail: Record<string, unknown>;
  }
  const crossingsBy = (officer: Actor) =>
    routes.rows<Crossing>(
      `select object_type, object_id, responsible_hub_id, enhanced, outcome, related_ids, before_after, note, detail
         from audit_event
        where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by recorded_at, id`,
      [officer.identity.id],
    );

  // Break caught: no event at all (the finding), one that names the person, a browser or a label, or one that is not enhanced.
  it('writes one enhanced, bounded event for the foreign hub, naming the hub and the operation and nothing of the browsers', async () => {
    const target = await routes.seniorOps(HUB_B);
    const first = await arranged(target, 'Chrome on Windows');
    const second = await arranged(target, 'Safari on macOS');
    const officer = await routes.platformAdmin();

    const answer = await officer.client.get(OF(target.identity.id));

    expect(answer.status).toBe(200);
    expect((answer.json() as { items: unknown[] }).items).toHaveLength(2);
    const events = await crossingsBy(officer);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      object_type: 'HUB',
      object_id: HUB_B,
      responsible_hub_id: HUB_B,
      enhanced: true,
      outcome: 'SUCCEEDED',
      related_ids: { operation_id: 'listStaffTrustedBrowsers' },
      before_after: null,
      note: null,
    });
    const written = JSON.stringify(events);
    for (const secret of [
      target.identity.id,
      first.id,
      second.id,
      first.token,
      'Chrome on Windows',
      'Safari on macOS',
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  // Break caught: the hub taken from the client or from the administrator's session, so that a read of another hub looks like a read of
  // the administrator's own, or an own-hub read is reported as a crossing.
  it('writes none for an identity of the actor’s own hub, and one for another hub when the actor has a hub of its own', async () => {
    const own = await routes.seniorOps(HUB_A);
    const foreign = await routes.seniorOps(HUB_B);
    await arranged(own);
    await arranged(foreign);
    const officer = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);

    expect((await officer.client.get(OF(own.identity.id))).status).toBe(200);
    expect(await crossingsBy(officer)).toEqual([]);

    expect((await officer.client.get(OF(foreign.identity.id))).status).toBe(200);
    const events = await crossingsBy(officer);
    expect(events.map((event) => event.object_id)).toEqual([HUB_B]);
  });

  // Break caught: an event for a person who has no hub (nothing to cross) and for an answer that shows nothing (it represents no hub),
  // which is what the other lists do.
  it('writes none for an identity with no hub and none for an empty answer', async () => {
    const hubless = await routes.seniorOps(null);
    await arranged(hubless);
    const nothingToShow = await routes.seniorOps(HUB_B);
    const officer = await routes.platformAdmin();

    const noHub = await officer.client.get(OF(hubless.identity.id));
    const empty = await officer.client.get(OF(nothingToShow.identity.id));

    expect((noHub.json() as { items: unknown[] }).items).toHaveLength(1);
    expect(empty.json()).toEqual({ items: [] });
    expect(await crossingsBy(officer)).toEqual([]);
  });

  // Break caught: a refused read writing the event, which would record a crossing that did not happen.
  it('writes none for a read that is refused', async () => {
    const target = await routes.seniorOps(HUB_B);
    await arranged(target);
    const senior = await routes.seniorOps(HUB_A);
    const staff = await routes.opsStaff(HUB_A);
    const officer = await routes.platformAdmin();

    expect(outcomeOf(await senior.client.get(OF(target.identity.id)))).toEqual([
      403,
      'INSUFFICIENT_AUTHORITY',
    ]);
    expect(outcomeOf(await staff.client.get(OF(target.identity.id)))).toEqual([
      403,
      'PERMISSION_DENIED',
    ]);
    expect(outcomeOf(await officer.client.get(OF(randomUUID())))).toEqual([404, 'NOT_FOUND']);
    expect(await crossingsBy(senior)).toEqual([]);
    expect(await crossingsBy(staff)).toEqual([]);
    expect(await crossingsBy(officer)).toEqual([]);
  });

  // Break caught: a read that returns the list when the event cannot be written, which is an unaudited cross-hub read: exactly what the
  // event exists to prevent.
  it('fails the read when the ledger cannot take the event, and shows no list', async () => {
    const target = await routes.seniorOps(HUB_B);
    const browser = await arranged(target);
    const officer = await routes.platformAdmin();
    await routes.admin.query(`
      create function public.melarc_test_refuse_crossing() returns trigger language plpgsql as
        $$ begin raise exception 'the event is refused by the test' using errcode = 'P0001'; end $$`);
    await routes.admin.query(`
      create trigger melarc_test_refuse_crossing before insert on audit_event
        for each row when (new.event_code = 'auth.hub_boundary.crossed') execute function public.melarc_test_refuse_crossing()`);
    let answer;
    try {
      answer = await officer.client.get(OF(target.identity.id));
    } finally {
      await routes.admin.query('drop trigger melarc_test_refuse_crossing on audit_event');
      await routes.admin.query('drop function public.melarc_test_refuse_crossing()');
    }

    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(answer.text).not.toContain(browser.id);
    expect(await crossingsBy(officer)).toEqual([]);
  });
});

/** One more browser of the identity that has already ended: history, not removed by the administrator's act and not counted by it. */
async function agedAndNot(who: Actor): Promise<void> {
  const ended = await arranged(who, 'Opera on Windows');
  await age(ended.id, 9);
  // and one that is valid, so the count is of the valid ones alone
  await arranged(who, 'Edge on Windows');
}

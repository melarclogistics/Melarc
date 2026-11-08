import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { sameShape } from '../../src/test-support/work-shape.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { codeOf, OPS } from './support/staff-routes.js';
import {
  HUB_A,
  SECRET,
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S0.48, `vendorSignIn` against the real application and a real PostgreSQL (`AC-SLICE-000-14`, `-18`, `-19`, `-26`, `-41`, `-95`, `-96`,
 * `-98`, `-99`, `-127`; `-29`, `-35`, `-44` and `-82` to `-84` re-verified for a vendor session). **Three factors, all required**: the
 * account identifier, the shared secret and the registered browser's credential in its cookie, decided in the contract's order (the
 * browser, the account's standing, the lock, the secret), with one answer for every failure but the lock a registered browser is told. A
 * new sign-in displaces the earlier session, which is told so. Every request goes through HTTP from the Vendor origin; what the
 * application did is read from a second connection.
 */
let routes: VendorRoutes;

beforeAll(async () => {
  routes = await startVendorRoutes();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);
const signIn = (
  client: TestClient,
  arranged: ArrangedVendor,
  secret = arranged.secret,
  identifier = arranged.row.accountIdentifier,
) => routes.signIn(client, identifier, secret);
const withoutRequest = (response: TestResponse) => ({
  ...(response.json() as object),
  request_id: undefined,
});
const credentialOf = async (arranged: ArrangedVendor) =>
  (
    await rows<{ failed_attempt_count: number; locked: boolean }>(
      `select failed_attempt_count, (locked_until is not null and locked_until > clock_timestamp()) as locked
         from vendor_credential where vendor_account_id = $1`,
      [arranged.row.accountId],
    )
  )[0];
const sessionsOf = (arranged: ArrangedVendor) =>
  rows<{
    id: string;
    registered_device_id: string | null;
    terminated_at: Date | null;
    termination_reason: string | null;
  }>(
    `select id, registered_device_id, terminated_at, termination_reason from session where principal_id = $1 order by issued_at`,
    [arranged.row.accountId],
  );

describe('a sign-in with the three factors', () => {
  // Break caught (AC-SLICE-000-127, the vendor's half at API level): the session cookies given a lifetime of their own, or the browser's
  // credential rotated or not renewed at sign-in.
  it('issues the session in two lifetime-less cookies and renews the browser’s own credential for 400 days', async () => {
    const vendor = await routes.vendor();
    const client = routes.browser(vendor.device.credential.token);

    const response = await signIn(client, vendor);

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const set = Object.fromEntries(response.setCookies.map((cookie) => [cookie.name, cookie]));
    expect(Object.keys(set).toSorted()).toEqual([
      'melarc_csrf',
      'melarc_session',
      'melarc_vendor_device',
    ]);
    expect(set.melarc_session).toMatchObject({
      secure: true,
      httpOnly: true,
      maxAge: undefined,
      expires: undefined,
      path: '/',
    });
    expect(set.melarc_csrf).toMatchObject({
      secure: true,
      httpOnly: false,
      maxAge: undefined,
      expires: undefined,
    });
    expect(set.melarc_vendor_device).toMatchObject({
      value: vendor.device.credential.token,
      secure: true,
      httpOnly: true,
      maxAge: 34_560_000,
      path: '/',
      sameSite: 'Lax',
    });
    // The same credential renewed: no browser registered, none replaced.
    expect(
      await rows(`select count(*)::int as n from registered_device where principal_id = $1`, [
        vendor.row.accountId,
      ]),
    ).toEqual([{ n: 1 }]);

    const body = response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      principal_type: 'VENDOR',
      principal_id: vendor.row.accountId,
      authorized_hub_ids: [],
    });
    expect(JSON.stringify(body)).not.toContain(set.melarc_session?.value ?? 'x');
    const [session] = await sessionsOf(vendor);
    expect(session?.registered_device_id).toBe(vendor.device.id);
    const [issued] = await rows<{ actor_type: string; actor_id: string }>(
      `select actor_type, actor_id::text from audit_event where event_code = 'auth.session.issued' and object_id = $1`,
      [session?.id],
    );
    expect(issued).toEqual({ actor_type: 'VENDOR_ACCOUNT', actor_id: vendor.row.accountId });
  });

  it('reads the account identifier without regard to case or the spaces around it', async () => {
    const vendor = await routes.vendor();
    const response = await signIn(
      routes.browser(vendor.device.credential.token),
      vendor,
      vendor.secret,
      `  ${vendor.row.accountIdentifier.toLowerCase()} `,
    );
    expect(response.status).toBe(200);
  });

  // AC-SLICE-000-83 and -15, for a vendor: the session names the organisation, never a person, and holds no credential.
  it('answers getCurrentSession with the organisation’s name and no credential, and signs out', async () => {
    const vendor = await routes.vendor({
      legalName: 'Asante Foods Limited',
      tradingName: 'Asante Foods',
    });
    const client = routes.browser(vendor.device.credential.token);
    expect((await signIn(client, vendor)).status).toBe(200);
    const current = await client.get('/api/v1/auth/session');
    expect(current.status).toBe(200);
    expect(current.json()).toMatchObject({
      principal_type: 'VENDOR',
      principal_display_name: 'Asante Foods',
    });
    expect(current.text).not.toContain(client.cookie('melarc_session') ?? 'x');

    // AC-SLICE-000-84: an unsafe request without the synchronizer token is refused; with it, sign-out ends the session (-82).
    const refused = await client.delete('/api/v1/auth/session', { csrf: 'omit' });
    expect([refused.status, codeOf(refused)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    const out = await client.delete('/api/v1/auth/session');
    expect(out.status).toBe(204);
    const after = await client.get('/api/v1/auth/session');
    expect([after.status, codeOf(after)]).toEqual([401, 'SESSION_INVALID']);
    // Signing out never deletes the browser's credential.
    expect(client.cookie('melarc_vendor_device')).toBe(vendor.device.credential.token);
  });
});

describe('the failures, one answer for each (AC-SLICE-000-41, -96, -98)', () => {
  // Break caught: a browser that never registered reaching the secret (counting it, locking the team out, or telling it anything).
  it('refuses an unregistered browser, whatever the secret, and counts nothing and is never told of a lock', async () => {
    const vendor = await routes.vendor();
    const strangers = [
      routes.browser(),
      routes.browser(randomBytes(32).toString('base64url')),
      routes.browser('not a credential'),
      routes.browser((await routes.vendor()).device.credential.token),
    ];
    const answers: TestResponse[] = [];
    for (const stranger of strangers) {
      answers.push(await signIn(stranger, vendor, 'a wrong secret here'));
      answers.push(await signIn(stranger, vendor));
    }
    for (const answer of answers) {
      expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
      expect(answer.setCookies).toEqual([]);
    }
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
    expect(await sessionsOf(vendor)).toEqual([]);
    // The registered browser signs in straight afterwards.
    expect((await signIn(routes.browser(vendor.device.credential.token), vendor)).status).toBe(200);
  });

  it('refuses a revoked browser as an unregistered one', async () => {
    const vendor = await routes.vendor();
    const revoked = await routes.anotherDevice(vendor, { status: 'REVOKED' });
    const answer = await signIn(routes.browser(revoked.credential.token), vendor);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
    // A wrong secret from it reaches nothing either: the secret is never examined, and nothing is counted against the team.
    const wrong = await signIn(
      routes.browser(revoked.credential.token),
      vendor,
      'a wrong secret here',
    );
    expect([wrong.status, codeOf(wrong)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
  });

  // AC-SLICE-000-98: the identifier is not a control; a wrong one is a wrong secret.
  it('answers a wrong identifier and a wrong secret identically', async () => {
    const vendor = await routes.vendor();
    const client = routes.browser(vendor.device.credential.token);
    const wrongIdentifier = await signIn(client, vendor, vendor.secret, 'ZZZZZZZZ');
    const malformedIdentifier = await signIn(client, vendor, vendor.secret, 'not one!');
    const wrongSecret = await signIn(client, vendor, 'a wrong secret here');
    for (const answer of [wrongIdentifier, malformedIdentifier, wrongSecret]) {
      expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
    }
    expect(withoutRequest(wrongIdentifier)).toEqual(withoutRequest(wrongSecret));
    expect(withoutRequest(malformedIdentifier)).toEqual(withoutRequest(wrongSecret));
  });

  it('refuses a suspended account as a failure, and counts nothing', async () => {
    const vendor = await routes.vendor({ accountStatus: 'SUSPENDED' });
    const answer = await signIn(
      routes.browser(vendor.device.credential.token),
      vendor,
      'a wrong secret here',
    );
    expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
  });

  it('refuses a secret longer than 128 at the schema, and one that expands past 128 as a failure that is never counted', async () => {
    const vendor = await routes.vendor();
    const client = routes.browser(vendor.device.credential.token);
    const long = await signIn(client, vendor, 'a'.repeat(129));
    expect([long.status, codeOf(long)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(long.text).not.toContain('a'.repeat(129));
    const expands = await signIn(client, vendor, 'ﬃ'.repeat(43));
    expect([expands.status, codeOf(expands)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
  });

  it('refuses a page of another origin before anything is examined', async () => {
    const vendor = await routes.vendor();
    const answer = await routes
      .browser(vendor.device.credential.token)
      .post(
        '/api/v1/auth/vendor/sign-in',
        { account_identifier: vendor.row.accountIdentifier, secret: vendor.secret },
        { origin: OPS },
      );
    expect([answer.status, codeOf(answer)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect(await sessionsOf(vendor)).toEqual([]);
  });
});

describe('the work of outwardly equivalent failure branches (vendor-authentication.md section 5.6, work shape)', () => {
  // Break caught: a branch that reads another table or sends another statement because of what it found (the account, the browser, the
  // standing), so that what the database was asked tells an unknown account from a wrong browser; and a wrong secret doing more than the
  // three things only it must (the lock, the hash, the count).
  it('sends the same statements for an unknown account, another account’s browser, a revoked browser and a suspended account', async () => {
    const vendor = await routes.vendor();
    const other = await routes.vendor();
    const suspended = await routes.vendor({ accountStatus: 'SUSPENDED' });
    const revoked = await routes.anotherDevice(vendor, { status: 'REVOKED' });
    const traced = async (request: () => Promise<TestResponse>) => {
      const { result, statements } = await routes.kit.trace(request);
      expect([result.status, codeOf(result)]).toEqual([422, 'INVALID_CREDENTIALS']);
      return statements;
    };

    const unknown = await traced(() =>
      signIn(routes.browser(vendor.device.credential.token), vendor, SECRET, 'ZZZZZZZZ'),
    );
    const branches = {
      anotherAccountsBrowser: await traced(() =>
        signIn(routes.browser(other.device.credential.token), vendor),
      ),
      revokedBrowser: await traced(() => signIn(routes.browser(revoked.credential.token), vendor)),
      suspendedAccount: await traced(() =>
        signIn(routes.browser(suspended.device.credential.token), suspended),
      ),
    };
    const wrongSecret = await traced(() =>
      signIn(routes.browser(vendor.device.credential.token), vendor, 'a wrong secret here'),
    );

    expect(unknown.length).toBeGreaterThan(0);
    for (const [name, statements] of Object.entries(branches)) {
      expect(sameShape(statements, unknown), name).toBe(true);
    }
    // The branch that reached the secret reads the lock and the hash, and counts the failure: those three, and nothing else more.
    const extra = wrongSecret.filter((statement) => !unknown.includes(statement));
    expect(extra).toHaveLength(3);
    expect(wrongSecret.length).toBe(unknown.length + 3);
    expect(
      extra.filter(
        (statement) => statement.includes('failed_attempt_count') && statement.startsWith('update'),
      ),
    ).toHaveLength(1);
  });
});

describe('the shared lockout (AC-SLICE-000-95)', () => {
  it('locks the credential for everyone at the fifth wrong secret, tells a registered browser so, and opens again after the lock', async () => {
    const vendor = await routes.vendor();
    const second = await routes.anotherDevice(vendor);
    const client = routes.browser(vendor.device.credential.token);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const answer = await signIn(client, vendor, `wrong secret number ${String(attempt)}`);
      expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
    }
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 5, locked: true });
    const [{ locked_until: lockedUntil } = { locked_until: null }] = await rows<{
      locked_until: Date;
    }>(`select locked_until from vendor_credential where vendor_account_id = $1`, [
      vendor.row.accountId,
    ]);

    const correct = await signIn(client, vendor);
    expect([correct.status, codeOf(correct)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    const colleague = await signIn(routes.browser(second.credential.token), vendor);
    expect([colleague.status, codeOf(colleague)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    // A locked attempt is not verified, not counted and does not extend the lock.
    expect(
      await rows(
        `select failed_attempt_count, locked_until from vendor_credential where vendor_account_id = $1`,
        [vendor.row.accountId],
      ),
    ).toEqual([{ failed_attempt_count: 5, locked_until: lockedUntil }]);
    expect(
      await rows(
        `select count(*)::int as n from audit_event where event_code = 'auth.lockout.applied' and object_id = $1`,
        [vendor.row.accountId],
      ),
    ).toEqual([{ n: 1 }]);
    // An unregistered browser is never told of the lock.
    const stranger = await signIn(routes.browser(), vendor);
    expect([stranger.status, codeOf(stranger)]).toEqual([422, 'INVALID_CREDENTIALS']);

    await routes.admin.query(
      `update vendor_credential set locked_until = clock_timestamp() - interval '1 second' where vendor_account_id = $1`,
      [vendor.row.accountId],
    );
    expect((await signIn(client, vendor)).status).toBe(200);
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
  });

  it('answers a suspended account that is locked as a failure, not a lock', async () => {
    const vendor = await routes.vendor({ accountStatus: 'SUSPENDED' });
    await routes.admin.query(
      `update vendor_credential set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '15 minutes' where vendor_account_id = $1`,
      [vendor.row.accountId],
    );
    const answer = await signIn(routes.browser(vendor.device.credential.token), vendor);
    expect([answer.status, codeOf(answer)]).toEqual([422, 'INVALID_CREDENTIALS']);
  });
});

describe('one live session per account (AC-SLICE-000-14)', () => {
  it('ends the earlier session when a colleague signs in on another browser, and tells the displaced one so', async () => {
    const vendor = await routes.vendor();
    const second = await routes.anotherDevice(vendor);
    const first = routes.browser(vendor.device.credential.token);
    const other = routes.browser(second.credential.token);

    expect((await signIn(first, vendor)).status).toBe(200);
    expect((await signIn(other, vendor)).status).toBe(200);

    const sessions = await sessionsOf(vendor);
    expect(
      sessions.map((session) => [session.registered_device_id, session.termination_reason]),
    ).toEqual([
      [vendor.device.id, 'SUPERSEDED_BY_NEW_LOGIN'],
      [second.id, null],
    ]);
    const displaced = await first.get('/api/v1/auth/session');
    expect([displaced.status, codeOf(displaced)]).toEqual([401, 'SESSION_SUPERSEDED']);
    expect((await other.get('/api/v1/auth/session')).status).toBe(200);
    expect(
      await rows(
        `select count(*)::int as n from audit_event where event_code = 'auth.session.superseded' and object_id = $1`,
        [sessions[0]?.id],
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe('the ceiling, keyed on the account and its browser (AC-SLICE-000-19)', () => {
  it('limits ten a minute for an account and a browser, gives a second browser its own bucket, and invented material one partition', async () => {
    const vendor = await routes.vendor();
    const second = await routes.anotherDevice(vendor);
    const client = routes.browser(vendor.device.credential.token);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(codeOf(await signIn(client, vendor, `wrong ${String(attempt)} secret`))).not.toBe(
        'RATE_LIMITED',
      );
      // Unlock between attempts so that the count is the ceiling's, not the lock's.
      await routes.admin.query(
        `update vendor_credential set failed_attempt_count = 0, locked_until = null where vendor_account_id = $1`,
        [vendor.row.accountId],
      );
    }
    const limited = await signIn(client, vendor);
    expect([limited.status, codeOf(limited)]).toEqual([429, 'RATE_LIMITED']);
    expect(await sessionsOf(vendor)).toEqual([]);
    // A second registered browser of the account is a bucket of its own.
    expect((await signIn(routes.browser(second.credential.token), vendor)).status).toBe(200);

    // Material that is not a registered browser of the account shares one partition: inventing values buys no bucket.
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect(
        codeOf(await signIn(routes.browser(randomBytes(32).toString('base64url')), vendor)),
      ).toBe('INVALID_CREDENTIALS');
    }
    const invented = await signIn(routes.browser(randomBytes(32).toString('base64url')), vendor);
    expect([invented.status, codeOf(invented)]).toEqual([429, 'RATE_LIMITED']);
    const none = await signIn(routes.browser(), vendor);
    expect([none.status, codeOf(none)]).toEqual([429, 'RATE_LIMITED']);
    // A browser registered to another account is not this account's: it shares the partition too.
    const foreign = await signIn(
      routes.browser((await routes.vendor()).device.credential.token),
      vendor,
    );
    expect([foreign.status, codeOf(foreign)]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('a vendor session and the operations it is not for (AC-SLICE-000-18, -26, -29, -44)', () => {
  async function signedIn(): Promise<{ vendor: ArrangedVendor; client: TestClient }> {
    const vendor = await routes.vendor();
    const client = routes.browser(vendor.device.credential.token);
    expect((await signIn(client, vendor)).status).toBe(200);
    return { vendor, client };
  }

  // AC-SLICE-000-26 and -102: refused at the surface gate, whether or not the record exists, and never told an authentication code.
  it.each([
    ['the vendor list', '/api/v1/ops/vendors'],
    ['its own account', 'own'],
    ['the staff list', '/api/v1/staff-identities'],
    ['the bundles a maker may name', '/api/v1/staff-role-bundles/assignable'],
  ])('refuses %s with PERMISSION_DENIED', async (_name, path) => {
    const { vendor, client } = await signedIn();
    const answer = await client.get(
      path === 'own' ? `/api/v1/ops/vendors/${vendor.row.accountId}` : path,
    );
    expect([answer.status, codeOf(answer)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('is refused 401 SESSION_INVALID once it holds no session, never 403', async () => {
    const { client } = await signedIn();
    await client.delete('/api/v1/auth/session');
    const answer = await client.get('/api/v1/ops/vendors');
    expect([answer.status, codeOf(answer)]).toEqual([401, 'SESSION_INVALID']);
  });

  // AC-SLICE-000-35 for a vendor: the Standard tier's idle limit ends it.
  it('expires on idle', async () => {
    const { vendor, client } = await signedIn();
    const [session] = await sessionsOf(vendor);
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `update session set issued_at = now() - interval '45 minutes', last_activity_at = now() - interval '31 minutes' where id = $1`,
        [session?.id],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback');
      throw error;
    }
    const answer = await client.get('/api/v1/auth/session');
    expect([answer.status, codeOf(answer)]).toEqual([401, 'SESSION_INVALID']);
    expect((await sessionsOf(vendor))[0]?.termination_reason).toBe('EXPIRED');
  });
});

describe('a Platform Admin ends a vendor session (AC-SLICE-000-99)', () => {
  it('ends it with ADMIN_REVOKED and an enhanced event, leaves the secret and the browsers, and refuses Senior Ops and Ops Staff', async () => {
    const vendor = await routes.vendor();
    const client = routes.browser(vendor.device.credential.token);
    expect((await signIn(client, vendor)).status).toBe(200);
    const [session] = await sessionsOf(vendor);
    const listing = `/api/v1/auth/sessions?principal_type=VENDOR&principal_id=${vendor.row.accountId}`;

    const admin = await routes.platformAdmin();
    const listed = await admin.client.get(listing);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.json())).toContain(session?.id ?? 'x');

    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const seniorList = await senior.client.get(listing);
    expect([seniorList.status, codeOf(seniorList)]).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    const seniorRevoke = await senior.client.post(
      `/api/v1/auth/sessions/${session?.id ?? ''}/revoke`,
      { reason_code: 'SESSION_SECURITY_CONCERN' },
      { origin: OPS },
    );
    expect([seniorRevoke.status, codeOf(seniorRevoke)]).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    const opsStaff = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
    const staffRevoke = await opsStaff.client.post(
      `/api/v1/auth/sessions/${session?.id ?? ''}/revoke`,
      { reason_code: 'SESSION_SECURITY_CONCERN' },
      { origin: OPS },
    );
    expect([staffRevoke.status, codeOf(staffRevoke)]).toEqual([403, 'PERMISSION_DENIED']);
    const empty = await admin.client.post(
      `/api/v1/auth/sessions/${session?.id ?? ''}/revoke`,
      { reason_code: '' },
      { origin: OPS },
    );
    expect([empty.status, codeOf(empty)]).toEqual([422, 'REASON_REQUIRED']);

    const revoked = await admin.client.post(
      `/api/v1/auth/sessions/${session?.id ?? ''}/revoke`,
      { reason_code: 'SESSION_SECURITY_CONCERN' },
      { origin: OPS },
    );
    expect(revoked.status).toBe(200);
    expect((await sessionsOf(vendor))[0]?.termination_reason).toBe('ADMIN_REVOKED');
    const next = await client.get('/api/v1/auth/session');
    expect([next.status, codeOf(next)]).toEqual([401, 'SESSION_INVALID']);
    expect(
      await rows(
        `select enhanced from audit_event where event_code = 'auth.session.terminated' and object_id = $1`,
        [session?.id],
      ),
    ).toEqual([{ enhanced: true }]);
    expect(
      await rows(`select status from registered_device where id = $1`, [vendor.device.id]),
    ).toEqual([{ status: 'ACTIVE' }]);
    expect(await credentialOf(vendor)).toEqual({ failed_attempt_count: 0, locked: false });
    // The browser signs in again with the same secret.
    expect((await signIn(client, vendor)).status).toBe(200);
  });
});

describe('the device credential is what the cookie carries (sanity of the arrangement)', () => {
  it('stores only the SHA-256 of the 32 bytes the browser holds', async () => {
    const vendor = await routes.vendor();
    const hash = createHash('sha256')
      .update(Buffer.from(vendor.device.credential.token, 'base64url'))
      .digest();
    expect(
      await rows(`select id from registered_device where device_credential_hash = $1`, [hash]),
    ).toEqual([{ id: vendor.device.id }]);
    expect(SECRET.length).toBeGreaterThanOrEqual(12);
  });
});

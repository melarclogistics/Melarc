import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { activateFactor, factorRow, insertFactor } from './support/credentials.js';
import { refuseConsumption } from './support/guard-race.js';
import { waitUntilBlocked } from './support/policy-fixtures.js';
import {
  COMPLETE,
  startRecoveryRoutes,
  type ArrangedStaff,
  type RecoveryRoutes,
} from './support/recovery-routes.js';
import { codeOf } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import type { ArrangedVendor } from './support/vendor-routes.js';

/**
 * S0.51a, `completeCredentialRecovery`, against the real application and a real PostgreSQL (`AC-SLICE-000-17`, `-22`, `-24`, `-36`, `-87`,
 * `-97`, `-103`, `-106`, `-125`, the completion half of `-121` and of `GBT-B15`). A link is asked for through HTTP and read from its queued
 * message as the principal would; the completion is posted from the link's surface with no session; what changed is read from a second
 * connection, and every sign-in is the real operation.
 */
let routes: RecoveryRoutes;

beforeAll(async () => {
  routes = await startRecoveryRoutes();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);
const NEW_PASSWORD = 'a brand new staff password';
const NEW_SECRET = 'a brand new shared secret';

/** Asks for a link for a principal through the operation and returns its token, as the message carries it; a new link must be issued. */
async function linkFor(
  type: 'STAFF' | 'VENDOR',
  identifier: string,
  principalId: string,
): Promise<{ id: string; token: string }> {
  const before = (await routes.requestsOf(principalId)).length;
  expect((await routes.requestRecovery(type, identifier)).status).toBe(202);
  const requests = await routes.requestsOf(principalId);
  expect(requests).toHaveLength(before + 1);
  const newest = requests[requests.length - 1];
  const message = await routes.deliveredFor(routes.admin, newest?.id ?? '');
  if (message === undefined) throw new Error('no message was queued for the link');
  return { id: newest?.id ?? '', token: message.token };
}

const complete = (
  client: TestClient,
  token: string,
  newCredential: string,
): Promise<TestResponse> => client.post(COMPLETE, { token, new_credential: newCredential });

const staffSignIn = (email: string, password: string) =>
  routes.opsBrowser().post('/api/v1/auth/staff/sign-in', { email, password });

const sessionsOf = (principalId: string) =>
  rows<{ id: string; termination_reason: string | null }>(
    `select id, termination_reason from session where principal_id = $1 order by issued_at`,
    [principalId],
  );

const withoutRequest = (response: TestResponse) => ({
  ...(response.json() as object),
  request_id: undefined,
});

/** Moves a request's issue back in time, as if it had been issued that long ago: the arrangement sets the guard aside. */
async function age(id: string, seconds: number): Promise<void> {
  await routes.admin.query('begin');
  try {
    await routes.admin.query('set local session_replication_role = replica');
    await routes.admin.query(
      `update recovery_request set issued_at = issued_at - make_interval(secs => $2), expires_at = expires_at - make_interval(secs => $2)
        where id = $1`,
      [id, seconds],
    );
    await routes.admin.query('commit');
  } catch (error) {
    await routes.admin.query('rollback');
    throw error;
  }
}

describe('a staff member completes recovery', () => {
  // Break caught: a completion that leaves a session alive, keeps the old password, sets a cookie, or leaves the lock in force.
  it('replaces the password, ends every session, sets no cookie and clears the lock (AC-SLICE-000-106)', async () => {
    const staff = await routes.staffMember();
    expect((await staffSignIn(staff.row.workEmail, staff.password)).status).toBe(200);
    expect((await staffSignIn(staff.row.workEmail, staff.password)).status).toBe(200);
    await routes.admin.query(
      `update staff_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '15 minutes' where id = $1`,
      [staff.row.id],
    );
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);

    const answer = await complete(routes.opsBrowser(), link.token, NEW_PASSWORD);

    expect([answer.status, answer.text, answer.setCookies]).toEqual([204, '', []]);
    expect(answer.header('cache-control')).toBe('no-store');
    expect((await sessionsOf(staff.row.id)).map((session) => session.termination_reason)).toEqual([
      'CREDENTIAL_CHANGED',
      'CREDENTIAL_CHANGED',
    ]);
    expect(
      await rows(
        `select credential_generation, failed_attempt_count, locked_until from staff_identity where id = $1`,
        [staff.row.id],
      ),
    ).toEqual([{ credential_generation: '2', failed_attempt_count: 0, locked_until: null }]);
    expect(await rows(`select state from recovery_request where id = $1`, [link.id])).toEqual([
      { state: 'CONSUMED' },
    ]);
    expect([(await staffSignIn(staff.row.workEmail, staff.password)).status]).toEqual([422]);
    expect((await staffSignIn(staff.row.workEmail, NEW_PASSWORD)).status).toBe(200);
    expect(
      await rows(
        `select actor_type, actor_id, detail from audit_event where event_code = 'auth.credential.changed' and object_id = $1`,
        [staff.row.id],
      ),
    ).toEqual([
      {
        actor_type: 'STAFF',
        actor_id: staff.row.id,
        detail: { cause: 'RECOVERY', credential_kind: 'STAFF_PASSWORD' },
      },
    ]);
  });

  // Break caught: password recovery that resets, removes or bypasses the second factor (credential-recovery.md section 4.1).
  it('leaves a Platform Admin’s factor ACTIVE and untouched, and the next sign-in still asks for it (AC-SLICE-000-36)', async () => {
    const admin = await routes.staffMember({
      roleBundleId: BUNDLE_IDS.platformAdmin,
      primaryHubId: null,
    });
    const factor = await insertFactor(routes.admin, factorRow(admin.row.id));
    await activateFactor(routes.admin, factor.id);
    const before = await rows(`select * from mfa_factor where staff_identity_id = $1`, [
      admin.row.id,
    ]);
    const link = await linkFor('STAFF', admin.row.workEmail, admin.row.id);

    expect((await complete(routes.opsBrowser(), link.token, NEW_PASSWORD)).status).toBe(204);

    expect(
      await rows(`select * from mfa_factor where staff_identity_id = $1`, [admin.row.id]),
    ).toEqual(before);
    const signIn = await staffSignIn(admin.row.workEmail, NEW_PASSWORD);
    expect(signIn.status).toBe(202);
    expect(signIn.setCookies).toEqual([]);
  });

  // Break caught: a staff member's trusted browsers left valid on the record after the password they were trusted with was replaced
  // (domain-model.md 6.8: CREDENTIAL_CHANGED is the cause the recovery writes).
  it('ends the person’s trusted browsers with CREDENTIAL_CHANGED, and records it', async () => {
    const admin = await routes.staffMember({
      roleBundleId: BUNDLE_IDS.platformAdmin,
      primaryHubId: null,
    });
    const factor = await insertFactor(routes.admin, factorRow(admin.row.id));
    await activateFactor(routes.admin, factor.id);
    await routes.admin.query(
      `insert into trusted_browser (id, staff_identity_id, token_hash, factor_id, credential_generation, label, created_at, expires_at)
       values (gen_random_uuid(), $1, sha256(gen_random_uuid()::text::bytea), $2, 1, 'Firefox on Linux', now(), now() + interval '7 days')`,
      [admin.row.id, factor.id],
    );
    const link = await linkFor('STAFF', admin.row.workEmail, admin.row.id);

    expect((await complete(routes.opsBrowser(), link.token, NEW_PASSWORD)).status).toBe(204);

    expect(
      await rows(
        `select revocation_cause, revoked_by from trusted_browser where staff_identity_id = $1`,
        [admin.row.id],
      ),
    ).toEqual([{ revocation_cause: 'CREDENTIAL_CHANGED', revoked_by: null }]);
    expect(
      await rows(
        `select detail from audit_event where event_code = 'auth.trusted_browser.revoked' and object_id = $1`,
        [admin.row.id],
      ),
    ).toEqual([{ detail: { cause: 'CREDENTIAL_CHANGED' } }]);
  });

  // Break caught: a suspension lifted by a recovery, or the suspended principal's completion refused (section 5.3).
  it('replaces the password of a suspended staff member and leaves the suspension standing', async () => {
    const staff = await routes.staffMember({ status: 'SUSPENDED' });
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    expect((await complete(routes.opsBrowser(), link.token, NEW_PASSWORD)).status).toBe(204);
    expect(
      await rows(`select status, credential_generation from staff_identity where id = $1`, [
        staff.row.id,
      ]),
    ).toEqual([{ status: 'SUSPENDED', credential_generation: '2' }]);
    expect((await staffSignIn(staff.row.workEmail, NEW_PASSWORD)).status).toBe(422);
  });
});

describe('a vendor completes recovery (AC-SLICE-000-17, -22, -24)', () => {
  async function signedInTwice(
    arranged: ArrangedVendor,
  ): Promise<{ first: TestClient; second: TestClient }> {
    const other = await routes.anotherDevice(arranged);
    const first = routes.browser(arranged.device.credential.token);
    const second = routes.browser(other.credential.token);
    expect(
      (await routes.signIn(first, arranged.row.accountIdentifier, arranged.secret)).status,
    ).toBe(200);
    // The second browser's sign-in displaces the first's session.
    expect(
      (await routes.signIn(second, arranged.row.accountIdentifier, arranged.secret)).status,
    ).toBe(200);
    return { first, second };
  }

  // Break caught: the shared secret replaced while a browser of the person being removed stays registered, a session left alive, or no
  // credential given to the browser that completed the recovery.
  it('replaces the secret, ends every session, revokes every browser and registers the one completing it', async () => {
    const arranged = await routes.vendor();
    const { second } = await signedInTwice(arranged);
    const link = await linkFor('VENDOR', arranged.row.accountIdentifier, arranged.row.accountId);
    const completing = routes.browser();

    const answer = await complete(completing, link.token, NEW_SECRET);

    expect(answer.status).toBe(204);
    expect(answer.setCookies.map((cookie) => cookie.name)).toEqual(['melarc_vendor_device']);
    expect(answer.setCookies[0]).toMatchObject({
      httpOnly: true,
      secure: true,
      maxAge: 34_560_000,
    });
    const sessions = await sessionsOf(arranged.row.accountId);
    expect(sessions.map((session) => session.termination_reason)).toEqual([
      'SUPERSEDED_BY_NEW_LOGIN',
      'CREDENTIAL_CHANGED',
    ]);
    expect((await second.get('/api/v1/auth/session')).status).toBe(401);
    const devices = await rows<{ status: string; registered_by: string | null }>(
      `select status, registered_by from registered_device where principal_id = $1 order by registered_at`,
      [arranged.row.accountId],
    );
    expect(devices.map((device) => device.status)).toEqual(['REVOKED', 'REVOKED', 'ACTIVE']);
    expect(devices[2]?.registered_by).toBeNull();

    // The new secret signs in from the browser that completed the recovery, and from no browser registered before it.
    expect(
      (await routes.signIn(completing, arranged.row.accountIdentifier, NEW_SECRET)).status,
    ).toBe(200);
    const old = await routes.signIn(
      routes.browser(arranged.device.credential.token),
      arranged.row.accountIdentifier,
      NEW_SECRET,
    );
    expect([old.status, codeOf(old)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(
      await rows(
        `select count(*)::int as n from audit_event where event_code = 'auth.device.revoked' and related_ids ->> 'principal_id' = $1`,
        [arranged.row.accountId],
      ),
    ).toEqual([{ n: 2 }]);
  });

  it('clears a vendor’s lock, and the vendor signs in from the browser the recovery registered (AC-SLICE-000-106)', async () => {
    const arranged = await routes.vendor();
    await routes.admin.query(
      `update vendor_credential set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '15 minutes'
        where vendor_account_id = $1`,
      [arranged.row.accountId],
    );
    const link = await linkFor('VENDOR', arranged.row.accountIdentifier, arranged.row.accountId);
    const completing = routes.browser();
    expect((await complete(completing, link.token, NEW_SECRET)).status).toBe(204);
    expect(
      await rows(
        `select failed_attempt_count, locked_until from vendor_credential where vendor_account_id = $1`,
        [arranged.row.accountId],
      ),
    ).toEqual([{ failed_attempt_count: 0, locked_until: null }]);
    expect(
      (await routes.signIn(completing, arranged.row.accountIdentifier, NEW_SECRET)).status,
    ).toBe(200);
  });

  it('replaces a suspended account’s secret, ends its sessions, and the account stays suspended (AC-SLICE-000-24)', async () => {
    const arranged = await routes.vendor();
    const browser = routes.browser(arranged.device.credential.token);
    expect(
      (await routes.signIn(browser, arranged.row.accountIdentifier, arranged.secret)).status,
    ).toBe(200);
    await routes.admin.query(`update vendor_account set status = 'SUSPENDED' where id = $1`, [
      arranged.row.accountId,
    ]);
    const link = await linkFor('VENDOR', arranged.row.accountIdentifier, arranged.row.accountId);
    const completing = routes.browser();

    expect((await complete(completing, link.token, NEW_SECRET)).status).toBe(204);

    expect(
      await rows(`select status from vendor_account where id = $1`, [arranged.row.accountId]),
    ).toEqual([{ status: 'SUSPENDED' }]);
    expect(
      (await sessionsOf(arranged.row.accountId)).map((session) => session.termination_reason),
    ).toEqual(['CREDENTIAL_CHANGED']);
    const signIn = await routes.signIn(completing, arranged.row.accountIdentifier, NEW_SECRET);
    expect([signIn.status, codeOf(signIn)]).toEqual([422, 'INVALID_CREDENTIALS']);
  });
});

describe('a link that cannot be used is one answer (AC-SLICE-000-103)', () => {
  // Break caught: an answer that says which way a link was dead (and so that a consumed link had been used), or a dead link that changes
  // a credential, a lock or a session.
  it('refuses a malformed, unknown, expired, consumed and superseded link alike, and changes nothing', async () => {
    const staff = await routes.staffMember();
    const first = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    await age(first.id, 61);
    const second = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    // The second completes, which consumes it and supersedes the first.
    expect((await complete(routes.opsBrowser(), second.token, NEW_PASSWORD)).status).toBe(204);
    const other = await routes.staffMember();
    const lapsed = await linkFor('STAFF', other.row.workEmail, other.row.id);
    await age(lapsed.id, 31 * 60);
    expect((await staffSignIn(other.row.workEmail, other.password)).status).toBe(200);

    const answers = [];
    for (const token of [
      'not a token at all',
      randomBytes(32).toString('base64url'),
      lapsed.token,
      second.token,
      first.token,
    ]) {
      const answer = await complete(routes.opsBrowser(), token, 'yet another password');
      expect([answer.status, codeOf(answer)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
      answers.push(withoutRequest(answer));
    }
    for (const answer of answers) expect(answer).toEqual(answers[0]);
    expect(
      await rows(`select credential_generation from staff_identity where id = $1`, [other.row.id]),
    ).toEqual([{ credential_generation: '1' }]);
    expect((await sessionsOf(other.row.id)).map((session) => session.termination_reason)).toEqual([
      null,
    ]);
    expect(await rows(`select state from recovery_request where id = $1`, [first.id])).toEqual([
      { state: 'SUPERSEDED' },
    ]);
  });

  // Break caught: a link carried to the other surface's page completing there (a vendor's browser credential given to an Ops page).
  it('refuses a link presented from the other surface as an invalid link, and leaves it usable', async () => {
    const staff = await routes.staffMember();
    const vendor = await routes.vendor();
    const staffLink = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    const vendorLink = await linkFor('VENDOR', vendor.row.accountIdentifier, vendor.row.accountId);
    for (const [client, token] of [
      [routes.browser(), staffLink.token],
      [routes.opsBrowser(), vendorLink.token],
    ] as const) {
      const answer = await complete(client, token, 'yet another password');
      expect([answer.status, codeOf(answer)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
      expect(answer.setCookies).toEqual([]);
    }
    expect((await complete(routes.opsBrowser(), staffLink.token, NEW_PASSWORD)).status).toBe(204);
  });

  // Break caught: a new credential refused after the link was spent, a value echoed, or a bound judged only as sent (AC-SLICE-000-87, -97).
  it('holds the new credential to its bounds before the link is spent, naming the field and never the value', async () => {
    const staff = await routes.staffMember();
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    for (const value of [
      'a'.repeat(11),
      'a'.repeat(129),
      'ﬃ'.repeat(4),
      'e\u0301'.repeat(6),
      `abcdefghijk\uD800`,
    ]) {
      const answer = await complete(routes.opsBrowser(), link.token, value);
      expect([answer.status, codeOf(answer)], JSON.stringify(value)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
      expect(answer.text).not.toContain(value);
      expect(answer.text).toContain('/new_credential');
    }
    expect(await rows(`select state from recovery_request where id = $1`, [link.id])).toEqual([
      { state: 'PENDING' },
    ]);
    // Twelve lower-case letters, and 128 characters with spaces, are each a credential.
    expect((await complete(routes.opsBrowser(), link.token, 'abcdefghijkl')).status).toBe(204);
    const vendor = await routes.vendor();
    const vendorLink = await linkFor('VENDOR', vendor.row.accountIdentifier, vendor.row.accountId);
    expect(
      (
        await complete(
          routes.browser(),
          vendorLink.token,
          `${'secret words '.repeat(9)}abcdefghijk`.slice(0, 128),
        )
      ).status,
    ).toBe(204);
  });

  // Break caught: a link that lapsed while the completion waited for its row answered as an error (the statement's `where` was judged
  // before the wait, the table's guard after it), or the guard's refusal of something else mistaken for that lapse.
  it('answers a link the guard finds lapsed after the wait as an invalid link, and changes nothing', async () => {
    const staff = await routes.staffMember();
    const query = async (statement: string) =>
      (await routes.admin.query<Record<string, unknown>>(statement)).rows;
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    const lapsed = await refuseConsumption(query, 'recovery_request', 'reason=RECOVERY_EXPIRED');
    try {
      const answer = await complete(routes.opsBrowser(), link.token, NEW_PASSWORD);
      expect([answer.status, codeOf(answer)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
      expect(await lapsed.hits()).toBe(1);
      expect(
        await rows(`select credential_generation from staff_identity where id = $1`, [
          staff.row.id,
        ]),
      ).toEqual([{ credential_generation: '1' }]);
    } finally {
      await lapsed.remove();
    }
    // The refusal rolled the completion back: the link is still pending, and a refusal that is not the lapse is not answered as one.
    const other = await refuseConsumption(query, 'recovery_request', null);
    try {
      const answer = await complete(routes.opsBrowser(), link.token, NEW_PASSWORD);
      expect(answer.status).toBe(500);
    } finally {
      await other.remove();
    }
    expect(await rows(`select state from recovery_request where id = $1`, [link.id])).toEqual([
      { state: 'PENDING' },
    ]);
  });

  it('limits the completion to ten a minute for a token, a made-up one included (AC-SLICE-000-125)', async () => {
    const made = randomBytes(32).toString('base64url');
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await complete(routes.opsBrowser(), made, NEW_PASSWORD)).status).toBe(422);
    }
    const limited = await complete(routes.opsBrowser(), made, NEW_PASSWORD);
    expect([limited.status, codeOf(limited)]).toEqual([429, 'RATE_LIMITED']);
    // Another token has a key of its own.
    expect(
      (await complete(routes.opsBrowser(), randomBytes(32).toString('base64url'), NEW_PASSWORD))
        .status,
    ).toBe(422);
  });
});

describe('completing recovery ends every outstanding link (AC-SLICE-000-121, completion half)', () => {
  // Break caught: a second live link left usable after a recovery completed, or its message left to be sent.
  it('supersedes the other live link and cancels its message, so it can no longer complete', async () => {
    const staff = await routes.staffMember();
    const first = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    await age(first.id, 61);
    const second = await linkFor('STAFF', staff.row.workEmail, staff.row.id);

    expect((await complete(routes.opsBrowser(), first.token, NEW_PASSWORD)).status).toBe(204);

    expect(await routes.requestsOf(staff.row.id)).toEqual([
      expect.objectContaining({ id: first.id, state: 'CONSUMED', job: 'CANCELLED' }),
      expect.objectContaining({ id: second.id, state: 'SUPERSEDED', job: 'CANCELLED' }),
    ]);
    const late = await complete(routes.opsBrowser(), second.token, 'yet another password');
    expect([late.status, codeOf(late)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
  });
});

describe('a completion racing the end of the principal’s access (GBT-B15, completion half)', () => {
  /** Holds a row's lock in a second connection, changes it while the completion waits, and commits; returns the completion's answer. */
  async function whileHeld(
    lock: string,
    change: string,
    id: string,
    waitingOn: RegExp,
    send: () => Promise<TestResponse>,
  ) {
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(lock, [id]);
      const pending = send();
      await waitUntilBlocked(routes.admin, routes.database.name, waitingOn);
      await holder.query(change, [id]);
      await holder.query('commit');
      return await pending;
    } finally {
      await holder.end();
    }
  }

  async function signedInStaff(): Promise<ArrangedStaff> {
    const staff = await routes.staffMember();
    expect((await staffSignIn(staff.row.workEmail, staff.password)).status).toBe(200);
    return staff;
  }

  // Break caught: the identity judged before its lock, so a completion that waited for an offboarding still sets a credential.
  it('refuses a completion whose identity was offboarded while it waited, and touches nothing', async () => {
    const staff = await signedInStaff();
    await routes.admin.query(`update staff_identity set failed_attempt_count = 3 where id = $1`, [
      staff.row.id,
    ]);
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    const answer = await whileHeld(
      `select 1 from staff_identity where id = $1 for update`,
      `update staff_identity set status = 'OFFBOARDED' where id = $1`,
      staff.row.id,
      /from staff_identity where id = .* for no key update/,
      () => complete(routes.opsBrowser(), link.token, NEW_PASSWORD),
    );
    expect([answer.status, codeOf(answer)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
    expect(
      await rows(
        `select credential_generation, failed_attempt_count from staff_identity where id = $1`,
        [staff.row.id],
      ),
    ).toEqual([{ credential_generation: '1', failed_attempt_count: 3 }]);
    expect((await sessionsOf(staff.row.id)).map((session) => session.termination_reason)).toEqual([
      null,
    ]);
    expect(await rows(`select state from recovery_request where id = $1`, [link.id])).toEqual([
      { state: 'PENDING' },
    ]);
  });

  // The other order: the completion commits first, and leaves the identity no usable link, live session or pending message to end.
  it('leaves nothing usable when the completion commits before the offboarding', async () => {
    const staff = await signedInStaff();
    const first = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    await age(first.id, 61);
    await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    expect((await complete(routes.opsBrowser(), first.token, NEW_PASSWORD)).status).toBe(204);
    await routes.admin.query(`update staff_identity set status = 'OFFBOARDED' where id = $1`, [
      staff.row.id,
    ]);
    expect(
      await rows(`select id from recovery_request where principal_id = $1 and state = 'PENDING'`, [
        staff.row.id,
      ]),
    ).toEqual([]);
    expect(
      await rows(`select id from session where principal_id = $1 and terminated_at is null`, [
        staff.row.id,
      ]),
    ).toEqual([]);
    expect(
      await rows(
        `select j.id from credential_delivery_job j join recovery_request r on r.id = j.redemption_record_id
          where r.principal_id = $1 and j.state in ('QUEUED', 'LEASED', 'RETRYABLE')`,
        [staff.row.id],
      ),
    ).toEqual([]);
  });

  // Break caught: a suspension that commits while a completion waits taken for ineligibility (or lifted by the completion).
  it('replaces the credential when a suspension commits while the completion waits, and the suspension stands', async () => {
    const staff = await signedInStaff();
    const link = await linkFor('STAFF', staff.row.workEmail, staff.row.id);
    const answer = await whileHeld(
      `select 1 from staff_identity where id = $1 for update`,
      `update staff_identity set status = 'SUSPENDED' where id = $1`,
      staff.row.id,
      /from staff_identity where id = .* for no key update/,
      () => complete(routes.opsBrowser(), link.token, NEW_PASSWORD),
    );
    expect(answer.status).toBe(204);
    expect(
      await rows(`select status, credential_generation from staff_identity where id = $1`, [
        staff.row.id,
      ]),
    ).toEqual([{ status: 'SUSPENDED', credential_generation: '2' }]);
  });

  it('refuses a completion whose vendor organisation was terminated while it waited for the account lock', async () => {
    const arranged = await routes.vendor();
    const link = await linkFor('VENDOR', arranged.row.accountIdentifier, arranged.row.accountId);
    const answer = await whileHeld(
      `select 1 from vendor_account where id = $1 for update`,
      `update vendor_organization set operational_status = 'TERMINATED'
        where id = (select vendor_organization_id from vendor_account where id = $1)`,
      arranged.row.accountId,
      /from vendor_account where id = .* for no key update/,
      () => complete(routes.browser(), link.token, NEW_SECRET),
    );
    expect([answer.status, codeOf(answer)]).toEqual([422, 'RECOVERY_TOKEN_INVALID']);
    expect(answer.setCookies).toEqual([]);
    expect(
      await rows(
        `select credential_generation from vendor_credential where vendor_account_id = $1`,
        [arranged.row.accountId],
      ),
    ).toEqual([{ credential_generation: '1' }]);
    expect(
      await rows(`select status from registered_device where principal_id = $1`, [
        arranged.row.accountId,
      ]),
    ).toEqual([{ status: 'ACTIVE' }]);
  });
});

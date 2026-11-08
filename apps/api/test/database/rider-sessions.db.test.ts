import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  AttestationEvidence,
  AttestationVerdict,
  AttestationVerifier,
} from '../../src/platform/auth/ports/attestation-verifier.port.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import type { TestClient } from '../../src/test-support/test-client.js';
import {
  SESSION_URL,
  attempt,
  enrolledRider,
  native,
  post,
  freshChallenge,
  signChallenge,
  type Enrolled,
} from './support/rider-sign-in.js';
import { deviceKey } from './support/riders.js';
import { insertVendor, vendorRow } from './support/vendors.js';
import {
  API,
  HUB_A,
  codeOf,
  startStaffRoutes,
  uuid,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.59c and S0.59d, what a rider's session is once the sign-in has issued it, against the real application and a real PostgreSQL
 * (`AC-SLICE-000-10`, `-35`, `-54`, `-26`, `-29`, `-44`, `-82`, `-83`, `-102`, `-132` for the Rider; rider-authentication.md sections 5.1 and 5.3;
 * SECURITY_DESIGN.md section 15.3). Every session here is issued by the real sign-in protocol, with a signature made in the test; the verifier
 * is one that is **down**, so that nothing a rider does after signing in can be shown to depend on it.
 */
const OPS_RIDERS = `${API}/ops/riders`;
const OPS_VENDORS = `${API}/ops/vendors`;
const REASONS = `${API}/reason-definitions`;

/** A verifier whose trust data is stale, always: the outage of AC-SLICE-000-54. It records what it was asked. */
class DownVerifier implements AttestationVerifier {
  readonly calls: AttestationEvidence[] = [];
  verify(evidence: AttestationEvidence): Promise<AttestationVerdict> {
    this.calls.push(evidence);
    return Promise.resolve({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_DATA_STALE' });
  }
}

const verifier = new DownVerifier();
let routes: StaffRoutes;
let hasher: Hasher;

beforeAll(async () => {
  routes = await startStaffRoutes({ attestationVerifier: verifier });
  hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

interface Signed {
  readonly subject: Enrolled;
  readonly token: string;
  readonly sessionId: string;
  readonly client: TestClient;
}

/** A rider who has signed in through the real protocol, with a bearer client for the credential it was given. */
async function signedIn(subject?: Enrolled): Promise<Signed> {
  const enrolled = subject ?? (await enrolledRider(routes, hasher));
  const { response } = await attempt(routes, {
    phone: enrolled.rider.phone,
    pin: enrolled.pin,
    ...(enrolled.device === null ? {} : { key: enrolled.device.key.privateKey }),
  });
  expect(response.status).toBe(200);
  const body = response.json() as { access_token: string; session: { id: string } };
  return {
    subject: enrolled,
    token: body.access_token,
    sessionId: body.session.id,
    client: native(routes).bearer(body.access_token),
  };
}

const sessionRow = async (id: string) =>
  (
    await rows<{
      terminated_at: Date | null;
      termination_reason: string | null;
      last_activity_at: Date;
      expires_at: Date;
    }>(
      'select terminated_at, termination_reason, last_activity_at, expires_at from session where id = $1',
      [id],
    )
  )[0];

/**
 * Runs `change` with the guards of the session table stood aside: they keep a session's activity and expiry from moving back, which is what a
 * test must do to reach an idle or an absolute end by changing the data and not by waiting. The administrator's hands, never an operation's.
 */
async function arranged(change: () => Promise<unknown>): Promise<void> {
  for (const guard of ['session_guard', 'session_self_end_guard']) {
    await routes.admin.query(`alter table session disable trigger ${guard}`);
  }
  try {
    await change();
  } finally {
    for (const guard of ['session_guard', 'session_self_end_guard']) {
      await routes.admin.query(`alter table session enable trigger ${guard}`);
    }
  }
}

/** An answer without its request id, which differs between two requests that were answered alike. */
function answerOf(response: { status: number; json: () => unknown }): unknown {
  const body = { ...(response.json() as Record<string, unknown>) };
  delete body.request_id;
  return { status: response.status, ...body };
}

const liveSessionsOf = async (riderId: string) =>
  Number(
    (
      await rows<{ n: string }>(
        `select count(*) as n from session where principal_type = 'RIDER' and principal_id = $1 and terminated_at is null`,
        [riderId],
      )
    )[0]?.n,
  );

const terminationEvents = (riderId: string) =>
  rows<{
    object_id: string;
    reason_code: string | null;
    related_ids: Record<string, unknown> | null;
    actor_type: string;
  }>(
    `select object_id::text, reason_code, related_ids, actor_type from audit_event
      where event_code = 'auth.session.terminated' and (actor_id = $1::uuid or related_ids->>'principal_id' = $1::text)
      order by recorded_at, id`,
    [riderId],
  );

describe('one live session per rider (AC-SLICE-000-10)', () => {
  // Break caught: a second sign-in that leaves the first session live (two handsets in custody), ends it with the vendor's displacement reason, or
  // tells the displaced handset anything but an ordinary invalid session.
  it('ends the earlier session as REPLACED_BY_NEW_SESSION, and tells the displaced handset SESSION_INVALID and never SESSION_SUPERSEDED', async () => {
    const first = await signedIn();

    const second = await signedIn(first.subject);
    const displaced = await first.client.get(SESSION_URL);
    const current = await second.client.get(SESSION_URL);

    expect([displaced.status, codeOf(displaced)]).toEqual([401, 'SESSION_INVALID']);
    expect(displaced.text).not.toContain('SESSION_SUPERSEDED');
    expect(current.status).toBe(200);
    expect(await sessionRow(first.sessionId)).toMatchObject({
      termination_reason: 'REPLACED_BY_NEW_SESSION',
    });
    expect((await sessionRow(first.sessionId))?.terminated_at).not.toBeNull();
    expect((await sessionRow(second.sessionId))?.terminated_at).toBeNull();
    expect(await liveSessionsOf(first.subject.rider.id)).toBe(1);
    // The catalogue's event for it: an ordinary termination with its reason, and never `auth.session.superseded`, which is the vendor's.
    const ended = (await terminationEvents(first.subject.rider.id)).filter(
      (event) => event.object_id === first.sessionId,
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({
      reason_code: 'REPLACED_BY_NEW_SESSION',
      related_ids: { replaced_by_session_id: second.sessionId },
      actor_type: 'RIDER',
    });
    const superseded = await rows(
      `select 1 from audit_event where event_code = 'auth.session.superseded' and related_ids->>'superseded_by_session_id' = $1`,
      [second.sessionId],
    );
    expect(superseded).toEqual([]);
  });

  // Break caught: two sign-ins of one rider at once ending up with two live sessions (the unique index is the backstop, not the mechanism: a
  // violation would be a 500).
  it('leaves exactly one live session when the rider signs in twice at once', async () => {
    const subject = await enrolledRider(routes, hasher);
    const key = subject.device?.key.privateKey ?? deviceKey().privateKey;
    const challenges = await Promise.all([
      freshChallenge(routes, subject.rider.phone),
      freshChallenge(routes, subject.rider.phone),
    ]);

    const answers = await Promise.all(
      challenges.map((challenge) =>
        post(routes, {
          phone: subject.rider.phone,
          pin: subject.pin,
          challenge,
          device_signature: signChallenge(key, challenge),
          client_root_signal: 'NOT_DETECTED',
        }),
      ),
    );

    expect(answers.map((each) => each.status)).toEqual([200, 200]);
    expect(await liveSessionsOf(subject.rider.id)).toBe(1);
    const all = await rows<{ termination_reason: string | null }>(
      `select termination_reason from session where principal_type = 'RIDER' and principal_id = $1 order by issued_at, id`,
      [subject.rider.id],
    );
    expect(all.map((each) => each.termination_reason)).toEqual(['REPLACED_BY_NEW_SESSION', null]);
  });
});

describe('a rider session has no idle rule, and an absolute end (AC-SLICE-000-35)', () => {
  // Break caught: the idle limit of a browser tier applied to the rider (a rider between stops, with no signal, signed out at a customer's door).
  it('stays valid after days without a request, where a browser session would have ended after minutes', async () => {
    const rider = await signedIn();
    // Twenty-three hours without a request, thirty minutes before the end of the day's lifetime: the longest silence a rider session can have.
    await arranged(() =>
      routes.admin.query(
        `update session set issued_at = clock_timestamp() - interval '23 hours 30 minutes',
                            expires_at = clock_timestamp() + interval '30 minutes',
                            last_activity_at = clock_timestamp() - interval '23 hours'
          where id = $1`,
        [rider.sessionId],
      ),
    );

    const read = await rider.client.get(SESSION_URL);

    expect(read.status).toBe(200);
    expect((await sessionRow(rider.sessionId))?.terminated_at).toBeNull();
  });

  // Break caught: a rider session that never ends, or one that ends with another reason than the lifetime's.
  it('ends at its lifetime: the next request is SESSION_INVALID and the session is terminated as EXPIRED', async () => {
    const rider = await signedIn();
    await arranged(() =>
      routes.admin.query(
        `update session set issued_at = clock_timestamp() - interval '25 hours', expires_at = clock_timestamp() - interval '1 hour',
                            last_activity_at = clock_timestamp() - interval '2 hours'
          where id = $1`,
        [rider.sessionId],
      ),
    );

    const late = await rider.client.get(SESSION_URL);

    expect([late.status, codeOf(late)]).toEqual([401, 'SESSION_INVALID']);
    expect(await sessionRow(rider.sessionId)).toMatchObject({ termination_reason: 'EXPIRED' });
    expect(await liveSessionsOf(rider.subject.rider.id)).toBe(0);
  });
});

describe('the current session and the end of it, for a rider (AC-SLICE-000-82, -83; GBT-W7, GBT-W12)', () => {
  // Break caught: a credential, a hash, a token or the contents of a bundle in the read; a CSRF value on a native client.
  it('reads the caller’s own session: the principal, the hubs, the expiry and the permission keys, and no credential', async () => {
    const rider = await signedIn();

    const read = await rider.client.get(SESSION_URL);

    expect(read.status).toBe(200);
    const body = read.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      id: rider.sessionId,
      principal_type: 'RIDER',
      principal_id: rider.subject.rider.id,
      state: 'ACTIVE',
      authorized_hub_ids: [rider.subject.rider.hubId],
      principal_display_name: rider.subject.rider.fullName,
    });
    expect(Array.isArray(body.permissions)).toBe(true);
    const text = read.text;
    expect(text).not.toContain(rider.token);
    expect(text).not.toContain(
      createHash('sha256').update(Buffer.from(rider.token, 'base64url')).digest('hex'),
    );
    expect(Object.keys(body).some((key) => /token|hash|csrf|snapshot|bundle/i.test(key))).toBe(
      false,
    );
    expect(read.setCookies).toEqual([]);
  });

  // Break caught (GBT-W7, GBT-W12): a rider request refused for want of a synchronizer token or an `Origin`, which a native client never carries;
  // a session that survives its sign-out, or a second sign-out that is not refused.
  it('ends with signOut, needing no CSRF token and no Origin: 204, terminated SIGNED_OUT, the next request and a second signOut SESSION_INVALID', async () => {
    const rider = await signedIn();

    const first = await rider.client.delete(SESSION_URL);
    const next = await rider.client.get(SESSION_URL);
    const second = await rider.client.delete(SESSION_URL);

    expect(first.status).toBe(204);
    expect([next.status, codeOf(next)]).toEqual([401, 'SESSION_INVALID']);
    expect([second.status, codeOf(second)]).toEqual([401, 'SESSION_INVALID']);
    expect(await sessionRow(rider.sessionId)).toMatchObject({ termination_reason: 'SIGNED_OUT' });
    const ended = (await terminationEvents(rider.subject.rider.id)).filter(
      (event) => event.object_id === rider.sessionId,
    );
    expect(ended).toHaveLength(1);
    expect(ended[0]?.reason_code).toBe('SIGNED_OUT');
    expect(JSON.stringify(ended)).not.toContain(rider.token);
    // The rider can sign in again, and nothing of the earlier session stands.
    expect((await signedIn(rider.subject)).sessionId).not.toBe(rider.sessionId);
  });

  // Break caught: a rider reached by a cookie (a browser session cookie accepted for a rider, or a rider credential accepted as a cookie).
  it('is not reached by a cookie, and a staff session is not a rider’s', async () => {
    const rider = await signedIn();
    const asCookie = routes.kit.client.fork();

    const bearerAsCookie = await asCookie.get(SESSION_URL, {
      headers: { cookie: `melarc_session=${rider.token}` },
    });

    expect([bearerAsCookie.status, codeOf(bearerAsCookie)]).toEqual([401, 'SESSION_INVALID']);
    expect((await rider.client.get(SESSION_URL)).status).toBe(200);
  });
});

describe('the surface and permission gates, for a rider (AC-SLICE-000-26, -29, -44, -102, -132)', () => {
  // Break caught (AC-26, -44; S0.25, GBT-W12): an Ops operation that takes a rider's bearer credential, or that tells by its answer what it is. A
  // browser-only operation takes no bearer credential (the mode is how the credential arrived, never what the caller says it is), and the answer
  // is the one of a request with no usable session, so it says nothing of the operation. Finding for the Product Owner: AC-SLICE-000-26 and -102
  // word this refusal as PERMISSION_DENIED for a Rider session, and the build answers 401 (plan section 7.47).
  it.each([
    ['listRiders', OPS_RIDERS],
    ['listVendorAccounts', OPS_VENDORS],
  ])(
    'answers a rider’s bearer credential on the browser-only operation %s as a request with no session: 401 SESSION_INVALID',
    async (_name, path) => {
      const rider = await signedIn();

      const refused = await rider.client.get(path);
      const missing = await native(routes).get(path);

      expect([refused.status, codeOf(refused)]).toEqual([401, 'SESSION_INVALID']);
      expect(answerOf(refused)).toEqual(answerOf(missing));
      // The credential is still good for what it is for, and the refusal did not end the session.
      expect((await rider.client.get(SESSION_URL)).status).toBe(200);
    },
  );

  // Break caught (AC-29, AC-44): an operation open to the rider's credential that refuses it with an authentication code, or with the code of a
  // missing session when the session is the matter of the refusal.
  it('refuses a rider the operation that does take its credential, and no permission it holds names, with PERMISSION_DENIED', async () => {
    const rider = await signedIn();

    const refused = await rider.client.get(REASONS);
    const missing = await native(routes).get(REASONS);

    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([missing.status, codeOf(missing)]).toEqual([401, 'SESSION_INVALID']);
    // Authorization returns its own codes only, and never an authentication code from a business operation (AC-29).
    expect(['SESSION_INVALID', 'MFA_REQUIRED']).not.toContain(codeOf(refused));
  });

  // Break caught (AC-102): a rider told whether a vendor account exists (NOT_FOUND for one account and another answer for another).
  it('tells a rider nothing of whether a vendor account exists: the same refusal for an account and for none', async () => {
    const rider = await signedIn();
    const vendor = await insertVendor(routes.admin, vendorRow({ hubId: HUB_A }));

    const unknown = await rider.client.get(`${OPS_VENDORS}/${uuid()}`);
    const known = await rider.client.get(`${OPS_VENDORS}/${vendor.accountId}`);

    expect([unknown.status, codeOf(unknown)]).toEqual([401, 'SESSION_INVALID']);
    expect(answerOf(known)).toEqual(answerOf(unknown));
  });

  // Break caught (AC-132): the reason catalogue readable by a rider who has no assigned stop or run (the assignment-based scope is false then).
  it('refuses a rider the reason catalogue while no stop or run is assigned: PERMISSION_DENIED', async () => {
    const rider = await signedIn();

    const refused = await rider.client.get(
      `${REASONS}?operation=resetStaffMfa&branch=FACTOR_ACTIVE`,
    );
    const unfiltered = await rider.client.get(REASONS);

    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([unfiltered.status, codeOf(unfiltered)]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('a signed-in rider is never stranded by an attestation outage (AC-SLICE-000-54)', () => {
  // Break caught: a sign-in, a read of the session or a sign-out that asks the verifier (a rider with parcels in custody refused for want of a
  // third party), or a live session ended because the trust data went stale.
  it('signs in, reads its session and signs out while the trust data is unavailable, and asks the verifier for nothing', async () => {
    verifier.calls.length = 0;
    const rider = await signedIn();

    const during = await rider.client.get(SESSION_URL);
    const again = await rider.client.get(SESSION_URL);
    const out = await rider.client.delete(SESSION_URL);

    expect([during.status, again.status, out.status]).toEqual([200, 200, 204]);
    expect(verifier.calls).toEqual([]);
    expect(await sessionRow(rider.sessionId)).toMatchObject({ termination_reason: 'SIGNED_OUT' });
  });

  // Break caught: the outage reported to a rider as a failure of the device (an integrity failure, or a 503), where the sign-in waits on nothing.
  it('never reports the outage to the rider: a sign-in is never DEVICE_INTEGRITY_FAILED or TRUST_DATA_UNAVAILABLE', async () => {
    const subject = await enrolledRider(routes, hasher);

    const good = await attempt(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      key: subject.device?.key.privateKey,
    });
    const bad = await attempt(routes, { phone: subject.rider.phone, pin: subject.pin });

    expect(good.response.status).toBe(200);
    expect([bad.response.status, codeOf(bad.response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    for (const response of [good.response, bad.response]) {
      expect(response.text).not.toMatch(/INTEGRITY|TRUST_DATA|UNSUPPORTED/);
    }
  });
});

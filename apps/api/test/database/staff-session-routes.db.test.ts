import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeRoleBundle } from '../../src/platform/authorization/policy-change/policy-change.js';
import {
  AUTH_POLICY_BUNDLE,
  bundleLockKey,
} from '../../src/platform/database/policy-lock/lock-keys.js';
import { MIGRATION_ROLE } from '../../src/tools/database/safety.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { insertSessionRow, sessionRow, type SessionRow } from './support/identities.js';
import {
  API,
  HUB_A,
  HUB_B,
  OPS,
  outcomeOf,
  startStaffRoutes,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';

/**
 * S0.37, `listSessions` and `revokeSession` against the real application and a real PostgreSQL (`AC-SLICE-000-05` first evidence, `-29`,
 * `-114`; `GBT-B14`'s lock clause): another principal's live sessions, found at the tier of the principal's type; ended with
 * `ADMIN_REVOKED` by the key that revokes, at the tier of the session's own principal type; and the next request on the ended session is
 * refused, because the row is the state. A Vendor's and a Rider's sessions are arranged rows: their sign-ins are S0.48 and S0.59.
 */
let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
});

afterAll(async () => {
  await routes.stop();
});

const LIST = (type: string, id: string) =>
  `${API}/auth/sessions?principal_type=${type}&principal_id=${id}`;
const REVOKE = (id: string) => `${API}/auth/sessions/${id}/revoke`;
const REASON = { reason_code: 'SESSION_SECURITY_CONCERN' };

interface SessionBody {
  readonly id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly state: string;
  readonly authorized_hub_ids: string[];
  readonly registered_device_id: string | null;
  readonly issued_at: string;
  readonly expires_at: string;
  readonly last_activity_at: string;
  readonly termination_reason: string | null;
}

const revoke = (officer: Actor, id: string, body: Record<string, unknown> = REASON) =>
  officer.client.post(REVOKE(id), body, { origin: OPS });

/** A live session of a Vendor or a Rider, arranged: the principal and the hubs it was issued for. */
function arranged(
  type: 'VENDOR' | 'RIDER',
  hubs: readonly string[],
  principalId: string = randomUUID(),
): Promise<SessionRow> {
  return insertSessionRow(
    routes.admin,
    sessionRow({
      principalType: type,
      principalId,
      authorizedHubIds: hubs,
      registeredDeviceId: randomUUID(),
      policyRevision: 1,
      bundleId: type === 'VENDOR' ? BUNDLE_IDS.vendor : BUNDLE_IDS.rider,
    }),
  );
}

describe('listSessions (AC-SLICE-000-29, -114)', () => {
  // Break caught: the list returning a token, a hash, the bundle, the permissions or a display field; a terminated or lapsed session as
  // active; the order not newest first.
  it('lists the live sessions of a staff member, newest first, in the ordinary projection and nothing that could present one', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const second = await routes.machinery.issuer.issue({
      principal: { type: 'STAFF', id: target.identity.id },
      correlationId: 'second-session',
      verifiedCredentialGeneration: 1,
    });
    const ended = await routes.machinery.issuer.issue({
      principal: { type: 'STAFF', id: target.identity.id },
      correlationId: 'ended-session',
      verifiedCredentialGeneration: 1,
    });
    await routes.admin.query(
      `update session set terminated_at = now(), termination_reason = 'SIGNED_OUT' where id = $1`,
      [ended.session.id],
    );
    const lapsed = await routes.machinery.issuer.issue({
      principal: { type: 'STAFF', id: target.identity.id },
      correlationId: 'lapsed-session',
      verifiedCredentialGeneration: 1,
    });
    await routes.admin.query('alter table session disable trigger user');
    try {
      await routes.admin.query(
        `update session set issued_at = now() - interval '9 hours', last_activity_at = now() - interval '9 hours', expires_at = now() - interval '1 hour' where id = $1`,
        [lapsed.session.id],
      );
    } finally {
      await routes.admin.query('alter table session enable trigger user');
    }

    const response = await staffAdmin.client.get(LIST('STAFF', target.identity.id));

    expect(response.status).toBe(200);
    const items = (response.json() as { items: SessionBody[] }).items;
    expect(items.map((item) => item.id)).toEqual([second.session.id, target.sessionId]);
    for (const item of items) {
      expect(item).toMatchObject({
        principal_type: 'STAFF',
        principal_id: target.identity.id,
        state: 'ACTIVE',
        termination_reason: null,
      });
      expect(Object.keys(item).toSorted()).toEqual([
        'authorized_hub_ids',
        'expires_at',
        'id',
        'issued_at',
        'last_activity_at',
        'principal_id',
        'principal_type',
        'registered_device_id',
        'state',
        'termination_reason',
      ]);
    }
    expect(response.text).not.toContain(target.token);
    expect(response.text).not.toContain(second.token);
    expect(response.text).not.toMatch(/token|hash|bundle|permissions/i);
  });

  // Break caught (AC-SLICE-000-114): the tier of the principal's type not asked, or asked after the principal was looked up.
  it('asks the tier of the principal’s type first: Senior Ops holds the key and not the tier for staff and vendors', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const target = await routes.seniorOps(HUB_A);
    const vendor = await arranged('VENDOR', []);

    const staffList = await senior.client.get(LIST('STAFF', target.identity.id));
    const vendorList = await senior.client.get(LIST('VENDOR', vendor.principalId));
    const nobody = await senior.client.get(LIST('STAFF', randomUUID()));

    expect(outcomeOf(staffList)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(vendorList)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(nobody)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
  });

  // Break caught (the adversarial review): a browser session past its idle limit listed as live, though its next request would end it
  // (`SESSION_INVALID`): the list judges a session as the authenticator does (session-judgement.ts), idle limit of its tier included.
  it('lists only the sessions that can still be used: a browser session past its idle limit is not live, and a rider has no idle rule', async () => {
    const staffAdmin = await routes.platformAdmin();
    const privilegedTarget = await routes.seniorOps(HUB_A);
    const standardTarget = await routes.opsStaff(HUB_A);
    const rider = await arranged('RIDER', [HUB_A]);
    // The table never lets a session's activity move back or precede its issue, so the arrangement ages both, with the ordinary triggers
    // set aside for this one transaction (and put back whatever happens).
    const idleFor = async (sessionId: string, minutes: number) => {
      await routes.admin.query('begin');
      try {
        await routes.admin.query('set local session_replication_role = replica');
        await routes.admin.query(
          `update session set issued_at = now() - make_interval(mins => $2 + 1), last_activity_at = now() - make_interval(mins => $2)
            where id = $1`,
          [sessionId, minutes],
        );
        await routes.admin.query('commit');
      } catch (error) {
        await routes.admin.query('rollback');
        throw error;
      }
    };
    const listed = async (type: string, principalId: string) =>
      (
        (await staffAdmin.client.get(LIST(type, principalId))).json() as { items: SessionBody[] }
      ).items.map((item) => item.id);

    // The privileged tier lets 15 minutes pass, the standard tier 30 (session_idle_timeout_minutes); a rider has no rule.
    await idleFor(privilegedTarget.sessionId, 14);
    expect(await listed('STAFF', privilegedTarget.identity.id)).toEqual([
      privilegedTarget.sessionId,
    ]);
    await idleFor(privilegedTarget.sessionId, 16);
    expect(await listed('STAFF', privilegedTarget.identity.id)).toEqual([]);
    await idleFor(standardTarget.sessionId, 29);
    expect(await listed('STAFF', standardTarget.identity.id)).toEqual([standardTarget.sessionId]);
    await idleFor(standardTarget.sessionId, 31);
    expect(await listed('STAFF', standardTarget.identity.id)).toEqual([]);
    await idleFor(rider.id, 600);
    expect(await listed('RIDER', rider.principalId)).toEqual([rider.id]);

    // A snapshot that does not say whether its bundle is privileged is judged by the stricter tier (15 minutes, not 30): a missing fact of
    // authority is not read as the weaker one. Break caught: that default turned round, which would list as live a session the strict
    // tier has already let go.
    const unlabelled = await routes.opsStaff(HUB_A);
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `update session set bundle_snapshot = bundle_snapshot - 'privileged' where id = $1`,
        [unlabelled.sessionId],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback');
      throw error;
    }
    await idleFor(unlabelled.sessionId, 20);
    expect(await listed('STAFF', unlabelled.identity.id)).toEqual([]);
  });

  it('lists a rider’s sessions for Senior Ops of its hub, and reads a rider of another hub as absent', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const staffAdmin = await routes.platformAdmin();
    const here = await arranged('RIDER', [HUB_A]);
    const there = await arranged('RIDER', [HUB_B]);

    const own = await senior.client.get(LIST('RIDER', here.principalId));
    const elsewhere = await senior.client.get(LIST('RIDER', there.principalId));
    const everywhere = await staffAdmin.client.get(LIST('RIDER', there.principalId));

    expect(own.status).toBe(200);
    expect((own.json() as { items: SessionBody[] }).items.map((item) => item.id)).toEqual([
      here.id,
    ]);
    expect(outcomeOf(elsewhere)).toEqual([404, 'NOT_FOUND']);
    expect(everywhere.status).toBe(200);
  });

  // Break caught: a principal that does not exist answered as an empty list; a staff member of another hub answered as absent.
  it('answers a principal that does not exist NOT_FOUND, and a staff member of another hub HUB_SCOPE_VIOLATION', async () => {
    const staffAdmin = await routes.platformAdmin();
    const vendor = await arranged('VENDOR', []);

    const absentStaff = await staffAdmin.client.get(LIST('STAFF', randomUUID()));
    const absentVendor = await staffAdmin.client.get(LIST('VENDOR', randomUUID()));
    const wrongType = await staffAdmin.client.get(LIST('STAFF', vendor.principalId));
    const vendorOk = await staffAdmin.client.get(LIST('VENDOR', vendor.principalId));

    expect(outcomeOf(absentStaff)).toEqual([404, 'NOT_FOUND']);
    expect(outcomeOf(absentVendor)).toEqual([404, 'NOT_FOUND']);
    expect(outcomeOf(wrongType)).toEqual([404, 'NOT_FOUND']);
    expect(vendorOk.status).toBe(200);
    expect((vendorOk.json() as { items: SessionBody[] }).items.map((item) => item.id)).toEqual([
      vendor.id,
    ]);
  });

  // Break caught (AC-SLICE-000-29): the list answering a code that is not the authorization layer's, or reaching a caller without the key.
  it('refuses a caller without staff.read, one with no session, a Rider’s bearer, and a malformed query', async () => {
    const staff = await routes.opsStaff(HUB_A);
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const rider = await arranged('RIDER', [HUB_A]);

    const noKey = await staff.client.get(LIST('STAFF', target.identity.id));
    const anonymous = await routes.kit.client.fork().get(LIST('STAFF', target.identity.id));
    const bearer = await routes.kit.client
      .fork()
      .bearer('not-a-session-credential')
      .get(LIST('STAFF', target.identity.id));
    const missing = await staffAdmin.client.get(`${API}/auth/sessions`);
    const badType = await staffAdmin.client.get(LIST('ROBOT', target.identity.id));
    const badId = await staffAdmin.client.get(LIST('STAFF', 'not-a-uuid'));

    expect(outcomeOf(noKey)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(anonymous)[0]).toBe(401);
    expect(outcomeOf(bearer)[0]).toBe(401);
    expect(outcomeOf(missing)).toEqual([400, 'VALIDATION_FAILED']);
    expect(outcomeOf(badType)).toEqual([400, 'VALIDATION_FAILED']);
    expect(outcomeOf(badId)).toEqual([400, 'VALIDATION_FAILED']);
    expect(rider.principalType).toBe('RIDER');
  });
});

describe('revokeSession (AC-SLICE-000-29, -114)', () => {
  // Break caught: the revocation not ending the session, not with ADMIN_REVOKED, not in one transaction with its event; the next request
  // on the revoked session still served.
  it('ends a staff member’s session with ADMIN_REVOKED, writes the enhanced event, and the next request on it is SESSION_INVALID', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);

    const response = await revoke(staffAdmin, target.sessionId);

    expect(response.status).toBe(200);
    expect(response.json()).toMatchObject({
      id: target.sessionId,
      principal_type: 'STAFF',
      principal_id: target.identity.id,
      state: 'TERMINATED',
      termination_reason: 'ADMIN_REVOKED',
    });
    expect(response.text).not.toMatch(/token|hash|bundle|permissions/i);
    expect(outcomeOf(await target.client.get(`${API}/auth/session`))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
    const events = await routes.rows<{
      actor_id: string;
      enhanced: boolean;
      reason_code: string;
      previous_state: string;
      resulting_state: string;
      detail: Record<string, unknown>;
    }>(
      `select actor_id, enhanced, reason_code, previous_state, resulting_state, detail from audit_event where event_code = 'auth.session.terminated' and object_id = $1`,
      [target.sessionId],
    );
    expect(events).toEqual([
      {
        actor_id: staffAdmin.identity.id,
        enhanced: true,
        reason_code: 'SESSION_SECURITY_CONCERN',
        previous_state: 'ACTIVE',
        resulting_state: 'TERMINATED',
        detail: { cause: 'ADMIN_REVOKED', principal_type: 'STAFF' },
      },
    ]);
  });

  // Break caught (AC-SLICE-000-114): Senior Ops revoking a staff or vendor session; the answer a code of the authentication layer.
  it('is INSUFFICIENT_AUTHORITY for Senior Ops naming a staff or vendor session, and ends nothing', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const target = await routes.seniorOps(HUB_A);
    const vendor = await arranged('VENDOR', []);

    const staffSession = await revoke(senior, target.sessionId);
    const vendorSession = await revoke(senior, vendor.id);

    expect(outcomeOf(staffSession)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect(outcomeOf(vendorSession)).toEqual([403, 'INSUFFICIENT_AUTHORITY']);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);
    expect(
      await routes.rows('select 1 from session where id = $1 and terminated_at is null', [
        vendor.id,
      ]),
    ).toHaveLength(1);
  });

  // F06 of 23 October 2026: a session of a hub the caller does not reach is told from one that is not there, as every hub-scoped record
  // is (data-scope-registry section 3, AC-SLICE-000-30): `HUB_SCOPE_VIOLATION` for the existing one, `NOT_FOUND` for the absent one.
  // Break caught: the hub-set probe removed or classifying nothing, so that both read as absent again; or classifying everything as outside.
  it('lets Senior Ops end a rider’s session of its hub, refuses another hub’s as outside its hubs and an absent one as not found, and lets a Platform Admin end a vendor’s', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const staffAdmin = await routes.platformAdmin();
    const here = await arranged('RIDER', [HUB_A]);
    const there = await arranged('RIDER', [HUB_B]);
    const vendor = await arranged('VENDOR', []);

    const own = await revoke(senior, here.id);
    const elsewhere = await revoke(senior, there.id);
    const absent = await revoke(senior, randomUUID());
    const vendorEnded = await revoke(staffAdmin, vendor.id);

    expect(own.status).toBe(200);
    expect(own.json()).toMatchObject({ state: 'TERMINATED', termination_reason: 'ADMIN_REVOKED' });
    expect(outcomeOf(elsewhere)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcomeOf(absent)).toEqual([404, 'NOT_FOUND']);
    expect(
      await routes.rows('select 1 from session where id = $1 and terminated_at is null', [
        there.id,
      ]),
    ).toHaveLength(1);
    expect(vendorEnded.status).toBe(200);
    const events = await routes.rows<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where event_code = 'auth.session.terminated' and object_id = any($1::uuid[]) order by recorded_at`,
      [[here.id, vendor.id]],
    );
    expect(events.map((event) => event.detail.principal_type)).toEqual(['RIDER', 'VENDOR']);
  });

  // The decision accepted on 24 October 2026: a session with no hub is outside nobody's hubs, so a caller of a set of hubs is not told it
  // exists (`NOT_FOUND`, never `HUB_SCOPE_VIOLATION`); the all-hub scope reaches every session. Stated here by name and not only as a clause of a
  // larger test, because it is a decision and a reviewer should be able to find the test that pins it.
  // Break caught: "no hub" read as "outside every hub", which would tell a hub-restricted caller that the session exists.
  it('reads a session with no hub as absent to a caller of a set of hubs: NOT_FOUND, no identifier in the answer, and the session stays live', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const hubless = await arranged('RIDER', []);

    const answer = await revoke(senior, hubless.id);

    expect(outcomeOf(answer)).toEqual([404, 'NOT_FOUND']);
    expect(JSON.stringify(answer.json())).not.toContain(hubless.id);
    expect(
      await routes.rows('select 1 from session where id = $1 and terminated_at is null', [
        hubless.id,
      ]),
    ).toHaveLength(1);
  });

  // Break caught: the all-hub scope losing a session because it names no hub, so that a Platform Admin could not end it.
  it('reaches a session with no hub through the all-hub scope: a Platform Admin ends it', async () => {
    const staffAdmin = await routes.platformAdmin();
    const hubless = await arranged('RIDER', []);

    const answer = await revoke(staffAdmin, hubless.id);

    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({
      state: 'TERMINATED',
      termination_reason: 'ADMIN_REVOKED',
    });
  });

  // The same decision as the list sees it: the principal of a hub-less session is not shown to a caller of a set of hubs either.
  // Break caught: the list answering what the revocation refuses to, so that the two operations disagree about what exists.
  it('lists a rider whose only session has no hub as absent to a caller of a set of hubs, and shows it to the all-hub scope', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const staffAdmin = await routes.platformAdmin();
    const hubless = await arranged('RIDER', []);

    const restricted = await senior.client.get(LIST('RIDER', hubless.principalId));
    const everywhere = await staffAdmin.client.get(LIST('RIDER', hubless.principalId));

    expect(outcomeOf(restricted)).toEqual([404, 'NOT_FOUND']);
    expect(everywhere.status).toBe(200);
    expect((everywhere.json() as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(
      [hubless.id],
    );
  });

  // F06 of 23 October 2026: a session carries several hubs, and it is outside the caller's when it has hubs and the caller reaches none of
  // them (the overlap the policy of the key applies). A session with no hub is not outside anyone's hubs: it is not shown to a caller of a
  // set of hubs and so reads as absent (a Vendor's is the global master a Platform Admin reaches; a Rider with no hub is an arranged edge).
  // Break caught: the overlap read as "first hub only", "all hubs" or "any hub of the caller's"; a session with no hub told as outside.
  it('reaches a session of several hubs through one it shares, tells one of other hubs from an absent one, and reads a rider with no hub as absent', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const staffAdmin = await routes.platformAdmin();
    const shared = await arranged('RIDER', [HUB_B, HUB_A]);
    const foreign = await arranged('RIDER', [HUB_B, randomUUID()]);
    const hubless = await arranged('RIDER', []);
    const everywhere = await arranged('RIDER', [HUB_B]);

    const viaShared = await revoke(senior, shared.id);
    const viaForeign = await revoke(senior, foreign.id);
    const viaHubless = await revoke(senior, hubless.id);
    const absent = await revoke(senior, randomUUID());
    const byAdmin = await revoke(staffAdmin, everywhere.id);
    const byAdminAbsent = await revoke(staffAdmin, randomUUID());

    expect(viaShared.status).toBe(200);
    expect(outcomeOf(viaForeign)).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(outcomeOf(viaHubless)).toEqual([404, 'NOT_FOUND']);
    expect(outcomeOf(absent)).toEqual([404, 'NOT_FOUND']);
    expect(byAdmin.status).toBe(200);
    expect(outcomeOf(byAdminAbsent)).toEqual([404, 'NOT_FOUND']);
    const live = await routes.rows<{ id: string }>(
      `select id from session where id = any($1::uuid[]) and terminated_at is null order by id`,
      [[foreign.id, hubless.id]],
    );
    expect(live.map((row) => row.id).toSorted()).toEqual([foreign.id, hubless.id].toSorted());
    // The refusal says no more than the code: no hub, session or principal identifier of the record in the body.
    expect(JSON.stringify(viaForeign.json())).not.toContain(HUB_B);
    expect(JSON.stringify(viaForeign.json())).not.toContain(foreign.id);
  });

  // Break caught: the reason not required, or one of another domain accepted.
  it('requires a reason of its domain: REASON_REQUIRED, REASON_NOT_ACTIVE', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);

    const none = await revoke(staffAdmin, target.sessionId, { reason_code: '' });
    const foreign = await revoke(staffAdmin, target.sessionId, {
      reason_code: 'MFA_ENROLMENT_EXPIRED',
    });
    const unknown = await revoke(staffAdmin, target.sessionId, { reason_code: 'NO_SUCH_REASON' });
    const missing = await revoke(staffAdmin, target.sessionId, {});

    expect(outcomeOf(none)).toEqual([422, 'REASON_REQUIRED']);
    expect(outcomeOf(foreign)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(unknown)).toEqual([422, 'REASON_NOT_ACTIVE']);
    expect(outcomeOf(missing)).toEqual([400, 'VALIDATION_FAILED']);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);
  });

  // Break caught: the note a caller sends never reaching the reason rule, so that a reason whose metadata makes a note mandatory could never
  // be given, or one without it be accepted.
  it('judges the note against a reason that requires one: refused without it, accepted with it', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const code = REASON.reason_code;

    await routes.admin.query('update reason_code set requires_note = true where code = $1', [code]);
    try {
      const without = await revoke(staffAdmin, target.sessionId);
      const given = await revoke(staffAdmin, target.sessionId, {
        ...REASON,
        note: 'The laptop was reported stolen',
      });

      expect(outcomeOf(without)).toEqual([422, 'REASON_REQUIRED']);
      expect(given.status).toBe(200);
    } finally {
      await routes.admin.query('update reason_code set requires_note = false where code = $1', [
        code,
      ]);
    }
  });

  // Break caught (AC-SLICE-000-29): a session that does not exist or is not the caller's to see answered otherwise.
  it('answers a session that does not exist NOT_FOUND, a caller without the key PERMISSION_DENIED, and one with no session 401', async () => {
    const staffAdmin = await routes.platformAdmin();
    const staff = await routes.opsStaff(HUB_A);
    const target = await routes.seniorOps(HUB_A);

    const absent = await revoke(staffAdmin, randomUUID());
    const noKey = await revoke(staff, target.sessionId);
    const anonymous = await routes.kit.client
      .fork()
      .post(REVOKE(target.sessionId), REASON, { origin: OPS });
    const noToken = await routes.kit.client.fork().post(REVOKE(target.sessionId), REASON, {
      origin: OPS,
      csrf: 'omit',
      headers: { cookie: `melarc_session=${staffAdmin.token}` },
    });

    expect(outcomeOf(absent)).toEqual([404, 'NOT_FOUND']);
    expect(outcomeOf(noKey)).toEqual([403, 'PERMISSION_DENIED']);
    expect(outcomeOf(anonymous)[0]).toBe(401);
    expect(outcomeOf(noToken)).toEqual([403, 'CSRF_VALIDATION_FAILED']);
  });

  // Break caught: a session that ended since answered as a conflict the contract has no code for, or a second event for one act.
  it('returns a session that has already ended as it ended, and writes no second event', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const first = await revoke(staffAdmin, target.sessionId);

    const again = await revoke(staffAdmin, target.sessionId);

    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.json()).toEqual(first.json());
    expect(
      await routes.rows(
        `select 1 from audit_event where event_code = 'auth.session.terminated' and object_id = $1`,
        [target.sessionId],
      ),
    ).toHaveLength(1);
  });

  // Break caught: the revocation not atomic: the session ended and the ledger refusing the event.
  it('leaves the session as it was when the event cannot be recorded', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const broken = await routes.kit.admin.breakWrites('audit_event');

    const response = await revoke(staffAdmin, target.sessionId);
    await broken.mend();

    expect(response.status).toBe(500);
    expect((await target.client.get(`${API}/auth/session`)).status).toBe(200);
  });
});

describe('the authority of a session and the locks of a revocation', () => {
  // Break caught (AC-SLICE-000-05, first evidence): a bundle reduced by the S0.27 primitive leaving a session usable, or ending it with
  // another reason, or the next request served from the session's snapshot.
  it('ends the sessions of a bundle the primitive reduces with AUTHORITY_CHANGED, and the next request is SESSION_INVALID', async () => {
    const holder = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    expect((await holder.client.get(`${API}/auth/session`)).status).toBe(200);
    const migration = clientFor(routes.database.urlFor(MIGRATION_ROLE));
    await migration.connect();
    const seeded = GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.finance).map((grant) => ({
      permissionKey: grant.permissionKey,
      hubScope: grant.hubScope,
      ownershipScope: grant.ownershipScope,
      tier: grant.tier,
    }));
    try {
      const result = await changeRoleBundle(migration, {
        bundleId: BUNDLE_IDS.finance,
        grants: [],
        correlationId: 'ac-05-reduction',
      });
      expect(result.kind).toBe('REDUCTION');
      expect(result.endedSessionIds).toEqual([holder.sessionId]);

      expect(outcomeOf(await holder.client.get(`${API}/auth/session`))).toEqual([
        401,
        'SESSION_INVALID',
      ]);
      const ended = await routes.rows<{ termination_reason: string }>(
        'select termination_reason from session where id = $1',
        [holder.sessionId],
      );
      expect(ended).toEqual([{ termination_reason: 'AUTHORITY_CHANGED' }]);
      const events = await routes.rows(
        'select 1 from audit_event where event_code = $1 and object_id = $2',
        ['auth.session.authority_revoked', holder.sessionId],
      );
      expect(events).toHaveLength(1);
    } finally {
      await changeRoleBundle(migration, {
        bundleId: BUNDLE_IDS.finance,
        grants: seeded,
        correlationId: 'ac-05-restored',
      });
      await migration.end();
    }
  });

  // Break caught (GBT-B14's clause of section 13.10a, 12): a revocation taking a policy lock for the sake of the target's sessions, so that
  // a reduction waiting on the target's bundle would hold up the revocation of one of its sessions.
  it('takes no policy lock for the target’s sessions: a revocation is not held by an exclusive lock on the target’s bundle', async () => {
    const staffAdmin = await routes.platformAdmin();
    const target = await routes.seniorOps(HUB_A);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      // What a reduction of the target's bundle holds while it works: the exclusive lock of that bundle's key.
      await holder.query('select pg_advisory_xact_lock($1, $2)', [
        AUTH_POLICY_BUNDLE,
        bundleLockKey(BUNDLE_IDS.seniorOps),
      ]);

      const started = Date.now();
      const response = await revoke(staffAdmin, target.sessionId);
      const took = Date.now() - started;

      expect(response.status).toBe(200);
      expect(took).toBeLessThan(5_000);
      await holder.query('rollback');
    } finally {
      await holder.end();
    }
    expect(outcomeOf(await target.client.get(`${API}/auth/session`))).toEqual([
      401,
      'SESSION_INVALID',
    ]);
  });
});

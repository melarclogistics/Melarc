import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { substituteChain } from '../../src/platform/auth/attestation/substitute.attestation-verifier.adapter.js';
import { parseEnrolmentUri } from '../../src/platform/auth/rider/enrolment-uri.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession } from './support/http-sessions.js';
import { ScriptedVerifier } from './support/scripted-verifier.js';
import {
  SOME_PIN_HASH,
  deviceKey,
  insertRider,
  insertRiderDevice,
  riderRow,
  type RiderRow,
} from './support/riders.js';
import {
  API,
  HUB_A,
  HUB_B,
  OPS,
  codeOf,
  startStaffRoutes,
  uuid,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.58, `revokeRiderDevice` against the real application and a real PostgreSQL (`AC-SLICE-000-46`, `-74`, `-112`, `-124`; rider-authentication.md
 * sections 4.2 and 5.3; SECURITY_DESIGN.md sections 13.6 and 15.3): the report of a lost or stolen handset ends the rider's `ACTIVE` device
 * as `REVOKED` and the live session on it as `DEVICE_REVOKED`, in one transaction and with nothing checked first, inside the actor's hubs. It
 * grants nothing: a revoked rider is bound again only by `reregisterRiderDevice`, in person, and a revoked device stays revoked through that
 * replacement.
 */
const REVOKE = (id: string) => `${API}/ops/riders/${id}/device/revoke`;
const REGISTER = (id: string) => `${API}/ops/riders/${id}/device/register`;
const REREGISTER = (id: string) => `${API}/ops/riders/${id}/device/reregister`;
const ONE = (id: string) => `${API}/ops/riders/${id}`;
const ENROL = `${API}/auth/rider/device/enrol`;
const SESSION = `${API}/auth/session`;
const REASON = 'RIDER_DEVICE_SECURITY_CONCERN';

const verifier = new ScriptedVerifier();
let routes: StaffRoutes;
let counter = 0;

beforeAll(async () => {
  routes = await startStaffRoutes({ attestationVerifier: verifier });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

beforeEach(() => {
  verifier.calls.length = 0;
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

/** A rider of a hub with a PIN, and a device that is `ACTIVE` with a live session on it, as a rider on the road is. */
async function onTheRoad(hubId: string = HUB_A): Promise<{
  readonly rider: RiderRow;
  readonly device: Awaited<ReturnType<typeof insertRiderDevice>>;
  readonly session: Awaited<ReturnType<typeof arrangedFixedSession>>;
}> {
  counter += 1;
  const rider = await insertRider(
    routes.admin,
    riderRow({ fullName: `Revocation rider ${String(counter)}`, hubId, pinHash: SOME_PIN_HASH }),
  );
  const device = await insertRiderDevice(routes.admin, rider.id);
  const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
    principalId: rider.id,
    registeredDeviceId: device.id,
  });
  return { rider, device, session };
}

const revoke = (
  actor: Actor,
  riderId: string,
  body: Record<string, unknown> | undefined = { reason_code: REASON },
): Promise<TestResponse> => actor.client.post(REVOKE(riderId), body, { origin: OPS });

const devicesOf = (riderId: string) =>
  rows<{ id: string; status: string; ended_at: Date | null }>(
    `select id, status, ended_at from registered_device where rider_identity_id = $1 order by registered_at, id`,
    [riderId],
  );
const sessionsOf = (riderId: string) =>
  rows<{ id: string; terminated_at: Date | null; termination_reason: string | null }>(
    `select id, terminated_at, termination_reason from session where principal_type = 'RIDER' and principal_id = $1 order by issued_at, id`,
    [riderId],
  );
interface EventRow {
  readonly event_code: string;
  readonly enhanced: boolean;
  readonly outcome: string;
  readonly actor_type: string;
  readonly actor_id: string | null;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly responsible_hub_id: string | null;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly reason_code: string | null;
  readonly reason_label: string | null;
  readonly before_after: Record<string, unknown> | null;
  readonly related_ids: Record<string, unknown> | null;
}
const eventsAbout = (riderId: string) =>
  rows<EventRow>(
    `select event_code, enhanced, outcome, actor_type, actor_id::text, object_type, object_id::text, responsible_hub_id::text,
            previous_state, resulting_state, reason_code, reason_label, before_after, related_ids
       from audit_event
      where event_code in ('auth.device.revoked', 'auth.session.terminated') and related_ids->>'principal_id' = $1
      order by recorded_at, id`,
    [riderId],
  );
const codesOf = (events: readonly EventRow[]): string[] =>
  events.map((event) => event.event_code).toSorted();

describe('revokeRiderDevice: the report of a lost or stolen handset (AC-SLICE-000-46)', () => {
  // Break caught: a revocation that leaves the device ACTIVE or marks it REPLACED, a session left live (a stolen handset that still works), a
  // session ended with another reason (SUPERSEDED_BY_NEW_LOGIN would make it a second sign-in), or the two not in one act.
  it('ends the ACTIVE device as REVOKED and its live session as DEVICE_REVOKED, answers 204, and the rider’s next request is refused', async () => {
    const { rider, device, session } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);
    const bearer = routes.kit.client.bearer(session.token);
    expect((await bearer.get(SESSION)).status).toBe(200);

    const response = await revoke(officer, rider.id);

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => [each.id, each.status])).toEqual([[device.id, 'REVOKED']]);
    expect(devices[0]?.ended_at).not.toBeNull();
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, termination_reason: 'DEVICE_REVOKED' }),
    ]);
    expect((await sessionsOf(rider.id))[0]?.terminated_at).not.toBeNull();
    // There is no interval in which the old token works: the very next request is refused, as any invalid session is (AC-46).
    const next = await bearer.get(SESSION);
    expect([next.status, codeOf(next)]).toEqual([401, 'SESSION_INVALID']);
    // The PIN is untouched: a revocation grants nothing and changes no credential.
    expect(
      await rows(`select credential_generation::int from rider_identity where id = $1`, [rider.id]),
    ).toEqual([{ credential_generation: 1 }]);
  });

  // Break caught: a revocation recorded as an ordinary event, recorded without its reason or by someone other than the officer, or a session
  // end recorded as an administrator's revocation (it is the device's, and ordinary).
  it('records auth.device.revoked as an enhanced event by the officer with the reason, and the session end as an ordinary one', async () => {
    const { rider, device, session } = await onTheRoad();
    const officer = await routes.seniorOps(HUB_A);

    expect((await revoke(officer, rider.id)).status).toBe(204);

    const events = await eventsAbout(rider.id);
    expect(codesOf(events)).toEqual(['auth.device.revoked', 'auth.session.terminated']);
    const revoked = events.find((event) => event.event_code === 'auth.device.revoked');
    expect(revoked).toMatchObject({
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor_type: 'STAFF',
      actor_id: officer.identity.id,
      object_type: 'RegisteredDevice',
      object_id: device.id,
      responsible_hub_id: HUB_A,
      previous_state: 'ACTIVE',
      resulting_state: 'REVOKED',
      reason_code: REASON,
      reason_label: 'Device security concern',
      before_after: { status: { before: 'ACTIVE', after: 'REVOKED' } },
    });
    expect(revoked?.related_ids).toMatchObject({
      principal_id: rider.id,
      ended_session_ids: [session.row.id],
    });
    const ended = events.find((event) => event.event_code === 'auth.session.terminated');
    expect(ended).toMatchObject({
      enhanced: false,
      object_type: 'Session',
      object_id: session.row.id,
      reason_code: 'DEVICE_REVOKED',
    });
  });

  // Break caught: a revocation that waits for a version (reporting a stolen handset slower), or for an identity check.
  it('takes no If-Match and no verification: it works with only the reason, and with a stale version it is not asked for', async () => {
    const { rider } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);

    const response = await officer.client.post(
      REVOKE(rider.id),
      { reason_code: REASON },
      { origin: OPS, headers: { 'if-match': '"stale"' } },
    );

    expect(response.status).toBe(204);
    expect((await devicesOf(rider.id)).map((each) => each.status)).toEqual(['REVOKED']);
  });

  // Break caught: a repeated report answered with an error the contract does not declare, or an event for a revocation that did not happen.
  it('answers 204 again for a rider with no ACTIVE device, and changes and records nothing', async () => {
    const { rider } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);
    expect((await revoke(officer, rider.id)).status).toBe(204);
    const [first] = await devicesOf(rider.id);
    const before = (await eventsAbout(rider.id)).length;

    const again = await revoke(officer, rider.id);
    const never = await fresh();
    const other = await revoke(officer, never.id);

    expect(again.status).toBe(204);
    expect(other.status).toBe(204);
    expect(await devicesOf(rider.id)).toEqual([first]);
    expect(await eventsAbout(rider.id)).toHaveLength(before);
    expect(await devicesOf(never.id)).toEqual([]);
    expect(await eventsAbout(never.id)).toEqual([]);
  });

  // Break caught: a revocation that reaches another rider's device or sessions.
  it('ends the one rider’s device and sessions and no other’s', async () => {
    const mine = await onTheRoad();
    const theirs = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);

    expect((await revoke(officer, mine.rider.id)).status).toBe(204);

    expect((await devicesOf(theirs.rider.id)).map((each) => each.status)).toEqual(['ACTIVE']);
    expect((await sessionsOf(theirs.rider.id))[0]?.terminated_at).toBeNull();
  });

  // Break caught (rider-authentication.md section 4.3): a replaced device ended again as revoked ("REVOKED never becomes REPLACED", and the
  // reverse), or the earlier devices of the rider disturbed by the report.
  it('ends only the ACTIVE device: a device that was replaced stays replaced', async () => {
    counter += 1;
    const rider = await insertRider(
      routes.admin,
      riderRow({ fullName: `Revocation rider ${String(counter)}`, hubId: HUB_A }),
    );
    const replaced = await insertRiderDevice(routes.admin, rider.id, { status: 'REPLACED' });
    const active = await insertRiderDevice(routes.admin, rider.id);
    const officer = await routes.opsStaff(HUB_A);

    expect((await revoke(officer, rider.id)).status).toBe(204);

    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [replaced.id, 'REPLACED'],
      [active.id, 'REVOKED'],
    ]);
  });
});

async function fresh(hubId: string = HUB_A): Promise<RiderRow> {
  counter += 1;
  return insertRider(
    routes.admin,
    riderRow({ fullName: `Revocation rider ${String(counter)}`, hubId }),
  );
}

describe('revokeRiderDevice: who may revoke, and where (AC-SLICE-000-112)', () => {
  // Break caught: a revocation across the hub boundary, a boundary answered as a missing rider (or the reverse), the key not required, or any
  // effect of a refused call on the device or its session.
  it('refuses an officer of another hub with HUB_SCOPE_VIOLATION, an id that names nothing with NOT_FOUND, and leaves the device and the session', async () => {
    const { rider, device, session } = await onTheRoad(HUB_B);
    const officer = await routes.opsStaff(HUB_A);

    const outside = await revoke(officer, rider.id);
    const absent = await revoke(officer, uuid());

    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, terminated_at: null }),
    ]);
    expect(await eventsAbout(rider.id)).toEqual([]);
  });

  it('refuses a user who does not hold staff.device.revoke with PERMISSION_DENIED', async () => {
    const { rider, device } = await onTheRoad();
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);

    const response = await revoke(finance, rider.id);

    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
  });

  it('lets Senior Ops and a Platform Admin of the rider’s hub revoke, and not a Platform Admin whose grant reaches no hub', async () => {
    const seniorsRider = await onTheRoad();
    const adminsRider = await onTheRoad();
    const hubless = await routes.platformAdmin();

    const senior = await revoke(await routes.seniorOps(HUB_A), seniorsRider.rider.id);
    const ofTheHub = await revoke(
      await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A),
      adminsRider.rider.id,
    );
    const none = await onTheRoad();
    const blind = await revoke(hubless, none.rider.id);

    expect([senior.status, ofTheHub.status]).toEqual([204, 204]);
    expect([blind.status, codeOf(blind)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect((await devicesOf(none.rider.id)).map((each) => each.status)).toEqual(['ACTIVE']);
  });

  // Break caught: a Rider bearer, which holds dispatch.read and which a default-security POST authenticates, allowed to call a staff operation.
  it('refuses a Rider session with PERMISSION_DENIED and leaves the device', async () => {
    const { rider, device, session } = await onTheRoad();

    const response = await routes.kit.client
      .bearer(session.token)
      .post(REVOKE(rider.id), { reason_code: REASON });

    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
  });

  // Break caught: a browser mutation that skips the synchronizer token or the Ops origin.
  it('refuses a call without the synchronizer token and one from another origin', async () => {
    const { rider } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);

    // The persona's client always echoes the token it was issued, so the two refusals are asked of a client that holds the credential by value.
    const holder = routes.kit.client.fork();
    const cookie = `melarc_session=${officer.token}`;
    const noToken = await holder.post(
      REVOKE(rider.id),
      { reason_code: REASON },
      { origin: OPS, csrf: 'omit', headers: { cookie } },
    );
    const foreign = await holder.post(
      REVOKE(rider.id),
      { reason_code: REASON },
      { origin: 'https://evil.example', csrf: officer.csrf ?? 'omit', headers: { cookie } },
    );

    expect([noToken.status, codeOf(noToken)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect([foreign.status, codeOf(foreign)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect((await devicesOf(rider.id)).map((each) => each.status)).toEqual(['ACTIVE']);
  });
});

describe('revokeRiderDevice: the reason (domain RIDER_DEVICE_REVOCATION)', () => {
  // Break caught: a reason that is judged after the act, taken from another domain (a replacement reason on a revocation), or one that
  // is empty and accepted; and a refused request that already ended the device.
  it.each([
    ['an empty reason', { reason_code: '' }, 422, 'REASON_REQUIRED'],
    ['an unknown code', { reason_code: 'NOT_A_REASON' }, 422, 'REASON_NOT_ACTIVE'],
    [
      'a code of another domain (a replacement reason)',
      { reason_code: 'RIDER_HANDSET_CHANGED' },
      422,
      'REASON_NOT_ACTIVE',
    ],
    ['no reason at all', {}, 400, 'VALIDATION_FAILED'],
    ['a reason that is not text', { reason_code: 7 }, 400, 'VALIDATION_FAILED'],
    [
      'a member the contract has no place for',
      { reason_code: REASON, device_identifier: 'x' },
      400,
      'VALIDATION_FAILED',
    ],
    [
      'a replacement device (the schema offers none)',
      { reason_code: REASON, replacement: { public_key: 'x' } },
      400,
      'VALIDATION_FAILED',
    ],
  ])('refuses %s and ends nothing', async (_label, body, status, code) => {
    const { rider, device, session } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);

    const response = await revoke(officer, rider.id, body);

    expect([response.status, codeOf(response)]).toEqual([status, code]);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, terminated_at: null }),
    ]);
    expect(await eventsAbout(rider.id)).toEqual([]);
  });

  it('judges the reason even where there is nothing to revoke', async () => {
    const never = await fresh();
    const officer = await routes.opsStaff(HUB_A);

    const response = await revoke(officer, never.id, { reason_code: 'NOT_A_REASON' });

    expect([response.status, codeOf(response)]).toEqual([422, 'REASON_NOT_ACTIVE']);
  });

  it('accepts the other reason of the domain', async () => {
    const { rider } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);

    const response = await revoke(officer, rider.id, {
      reason_code: 'RIDER_DEVICE_NO_LONGER_AUTHORISED',
    });

    expect(response.status).toBe(204);
    expect(
      (await eventsAbout(rider.id)).find((event) => event.event_code === 'auth.device.revoked')
        ?.reason_code,
    ).toBe('RIDER_DEVICE_NO_LONGER_AUTHORISED');
  });
});

describe('revokeRiderDevice: one act (atomicity)', () => {
  // Break caught: a failure part-way (the event of the revocation refused) that leaves the device revoked with its session live, or the
  // session ended with the device still ACTIVE: a stolen handset that works, or a rider locked out of a device nobody revoked.
  it('rolls the device and the session back together when the act fails', async () => {
    const { rider, device, session } = await onTheRoad();
    const officer = await routes.opsStaff(HUB_A);
    await routes.admin.query(`
      create function public.zz_refuse_revoked() returns trigger language plpgsql as $$
      begin raise exception 'the event of the revocation is refused for the test'; end $$;
      create trigger zz_refuse_revoked before insert on audit_event
        for each row when (new.event_code = 'auth.device.revoked') execute function public.zz_refuse_revoked();`);
    let response: TestResponse;
    try {
      response = await revoke(officer, rider.id);
    } finally {
      await routes.admin.query(
        `drop trigger zz_refuse_revoked on audit_event; drop function public.zz_refuse_revoked();`,
      );
    }

    expect(response.status).toBe(500);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, terminated_at: null }),
    ]);
    expect(await eventsAbout(rider.id)).toEqual([]);
    // With the fault gone the same report works.
    expect((await revoke(officer, rider.id)).status).toBe(204);
  });
});

describe('after a revocation (AC-SLICE-000-124, -74)', () => {
  const nativeEnrol = (body: Record<string, unknown>): Promise<TestResponse> =>
    routes.kit.client.fork().post(ENROL, body, { origin: null });

  /** The enrolment URI the officer's screen shows after `reregisterRiderDevice`, for a rider the officer has just read. */
  async function reregistration(officer: Actor, riderId: string) {
    const read = await officer.client.get(ONE(riderId));
    expect(read.status).toBe(200);
    const etag = read.header('etag');
    if (etag === null) throw new Error('the read carries no ETag');
    const response = await officer.client.post(
      REREGISTER(riderId),
      {
        reason_code: 'RIDER_HANDSET_UNAVAILABLE',
        verification_note:
          'The rider came to the hub with their staff card and was checked in person',
      },
      { origin: OPS, headers: { 'if-match': etag } },
    );
    return response;
  }

  // Break caught (AC-124): a revoked rider bound again by the first-binding operation, which would skip the verified, in-person act.
  it('does not let registerRiderDevice bind a rider again, and lets reregisterRiderDevice issue the grant', async () => {
    const { rider } = await onTheRoad();
    const officer = await routes.seniorOps(HUB_A);
    expect((await revoke(officer, rider.id)).status).toBe(204);

    const register = await officer.client.post(REGISTER(rider.id), undefined, {
      origin: OPS,
      headers: { 'idempotency-key': uuid() },
    });
    const reregister = await reregistration(officer, rider.id);

    expect([register.status, codeOf(register)]).toEqual([409, 'STATE_CONFLICT']);
    expect(reregister.status).toBe(200);
    expect(
      await rows(
        `select 1 from setup_grant where principal_id = $1 and purpose = 'RIDER_DEVICE_ENROLMENT'`,
        [rider.id],
      ),
    ).toEqual([]);
  });

  // Break caught (AC-74): the revoked device brought back or marked replaced when the replacement completes, a replacement event written
  // for a device that was not replaced, or the new device not ACTIVE.
  it('keeps the revoked device revoked when the replacement completes, and writes no replacement event', async () => {
    const { rider, device } = await onTheRoad();
    const officer = await routes.seniorOps(HUB_A);
    expect((await revoke(officer, rider.id)).status).toBe(204);
    const grant = await reregistration(officer, rider.id);
    const parsed = parseEnrolmentUri((grant.json() as { enrolment_uri: string }).enrolment_uri);
    if (parsed === null) throw new Error('no enrolment URI');

    const completed = await nativeEnrol({
      setup_token: parsed.token,
      public_key: deviceKey().publicKey,
      pin: '381925',
      key_attestation: { certificate_chain: [...substituteChain('VERIFIED')] },
    });

    expect(completed.status).toBe(200);
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => each.status)).toEqual(['REVOKED', 'ACTIVE']);
    expect(devices[0]?.id).toBe(device.id);
    expect(
      await rows(
        `select 1 from audit_event where event_code = 'auth.device.replaced' and related_ids->>'principal_id' = $1`,
        [rider.id],
      ),
    ).toEqual([]);
  });
});

describe('a revocation against a replacement (OB-17): the rider’s lock puts them in an order', () => {
  async function replacementGrant(officer: Actor, riderId: string) {
    const read = await officer.client.get(ONE(riderId));
    const etag = read.header('etag') ?? '';
    const response = await officer.client.post(
      REREGISTER(riderId),
      {
        reason_code: 'RIDER_HANDSET_CHANGED',
        verification_note: 'Checked the rider’s staff card and face in person at the hub',
      },
      { origin: OPS, headers: { 'if-match': etag } },
    );
    expect(response.status).toBe(200);
    const parsed = parseEnrolmentUri((response.json() as { enrolment_uri: string }).enrolment_uri);
    if (parsed === null) throw new Error('no enrolment URI');
    return parsed.token;
  }
  const complete = (token: string): Promise<TestResponse> =>
    routes.kit.client.fork().post(
      ENROL,
      {
        setup_token: token,
        public_key: deviceKey().publicKey,
        pin: '472951',
        key_attestation: { certificate_chain: [...substituteChain('VERIFIED')] },
      },
      { origin: null },
    );

  // Break caught: a replacement judged before the verifier answered and not again under the rider's lock: a device revoked meanwhile
  // would then be recorded as replaced, and `REVOKED` would turn into `REPLACED`.
  it('records a device revoked while the replacement was being evaluated as revoked, never as replaced', async () => {
    const { rider, device, session } = await onTheRoad();
    const officer = await routes.seniorOps(HUB_A);
    const token = await replacementGrant(officer, rider.id);
    const held = verifier.holdNext();
    const completion = complete(token);
    await held.arrived;

    expect((await revoke(officer, rider.id)).status).toBe(204);
    held.release();
    const completed = await completion;

    expect(completed.status).toBe(200);
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => each.status)).toEqual(['REVOKED', 'ACTIVE']);
    expect(devices[0]?.id).toBe(device.id);
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, termination_reason: 'DEVICE_REVOKED' }),
    ]);
    expect(
      await rows(
        `select 1 from audit_event where event_code = 'auth.device.replaced' and related_ids->>'principal_id' = $1`,
        [rider.id],
      ),
    ).toEqual([]);
  });

  // Break caught: the other order, in which the revocation meets the device the replacement has just made ACTIVE: it revokes that one (the
  // binding that is current), never the replaced one, and the rider never holds two.
  it('revokes the new device when the replacement came first, and leaves the replaced one replaced', async () => {
    const { rider, device } = await onTheRoad();
    const officer = await routes.seniorOps(HUB_A);
    const token = await replacementGrant(officer, rider.id);
    expect((await complete(token)).status).toBe(200);

    expect((await revoke(officer, rider.id)).status).toBe(204);

    expect((await devicesOf(rider.id)).map((each) => each.status)).toEqual(['REPLACED', 'REVOKED']);
    expect((await devicesOf(rider.id))[0]?.id).toBe(device.id);
  });

  // Break caught: the two acts not ordered by one lock, so that an outcome exists in which a device is both replaced and revoked, a session
  // is left live on an ended device, or the rider holds two ACTIVE devices. Whichever goes first, the invariants hold.
  it('leaves a consistent rider whichever of the two acts the lock lets go first', async () => {
    for (let round = 0; round < 3; round += 1) {
      const { rider, device, session } = await onTheRoad();
      const officer = await routes.seniorOps(HUB_A);
      const token = await replacementGrant(officer, rider.id);

      const [revocation, completion] = await Promise.all([
        revoke(officer, rider.id),
        complete(token),
      ]);

      expect(revocation.status).toBe(204);
      expect(completion.status).toBe(200);
      const devices = await devicesOf(rider.id);
      expect(devices.filter((each) => each.status === 'ACTIVE').length).toBeLessThanOrEqual(1);
      expect(devices.find((each) => each.id === device.id)?.status).toMatch(/^(REVOKED|REPLACED)$/);
      expect((await sessionsOf(rider.id)).every((each) => each.terminated_at !== null)).toBe(true);
      expect(await sessionsOf(rider.id)).toEqual([expect.objectContaining({ id: session.row.id })]);
    }
  });
});

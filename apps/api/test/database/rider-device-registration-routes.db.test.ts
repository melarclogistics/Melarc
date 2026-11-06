import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseEnrolmentUri } from '../../src/platform/auth/rider/enrolment-uri.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import {
  SOME_PIN_HASH,
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
 * S0.53b and S0.53c, `registerRiderDevice` and `reregisterRiderDevice` against the real application and a real PostgreSQL
 * (`AC-SLICE-000-13`, `-23`, `-40`, `-76`, `-108`, `-124`; rider-authentication.md sections 4.2 and 4.3; SECURITY_DESIGN.md section 14.16):
 * the in-person start of a rider's device binding. The grant travels as a QR code (a 127-character enrolment URI, `no-store`) and never as a
 * message; the officer learns no PIN, key or session; the first registration is the one operation whose replay returns a secret, sealed, and
 * only while the grant is still usable; the replacement takes the rider's ETag and a verification note; and the scope of each key is the
 * catalogue's (both may reach every hub for a Platform Admin whose grant says so, and stay at their own hub for Senior Ops; replacement was held at the Platform Admin's own hub until the decision of 6 November 2026).
 */
const REGISTER = (id: string) => `${API}/ops/riders/${id}/device/register`;
const REREGISTER = (id: string) => `${API}/ops/riders/${id}/device/reregister`;
const ONE = (id: string) => `${API}/ops/riders/${id}`;

let routes: StaffRoutes;
let tag: string;
let counter = 0;

beforeAll(async () => {
  routes = await startStaffRoutes();
  tag = `Zd${uuid().slice(0, 6)}`;
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

/** A rider of a hub, arranged: `ACTIVE`, with no PIN and no device unless the test says otherwise. */
function fresh(overrides: Partial<RiderRow> = {}): Promise<RiderRow> {
  counter += 1;
  return insertRider(
    routes.admin,
    riderRow({ fullName: `${tag} ${String(counter)}`, hubId: HUB_A, ...overrides }),
  );
}

const register = (officer: Actor, riderId: string, key: string = uuid()): Promise<TestResponse> =>
  officer.client.post(REGISTER(riderId), undefined, {
    origin: OPS,
    headers: { 'idempotency-key': key },
  });

const reregister = (
  officer: Actor,
  riderId: string,
  etag: string | undefined,
  body: Record<string, unknown> = {
    reason_code: 'RIDER_HANDSET_CHANGED',
    verification_note: 'Checked the rider’s staff card and face in person at the hub',
  },
): Promise<TestResponse> =>
  officer.client.post(REREGISTER(riderId), body, {
    origin: OPS,
    headers: etag === undefined ? {} : { 'if-match': etag },
  });

/** The version a reader sees of a rider: the ETag that `reregisterRiderDevice` takes back in `If-Match`. */
async function versionOf(reader: Actor, riderId: string): Promise<string> {
  const response = await reader.client.get(ONE(riderId));
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
}

interface Grant {
  readonly enrolment_uri: string;
  readonly expires_at: string;
  readonly rider_id: string;
}
const grantOf = (response: TestResponse): Grant => {
  expect(response.status).toBe(200);
  return response.json() as Grant;
};

interface GrantRow {
  readonly id: string;
  readonly purpose: string;
  readonly state: string;
  readonly issued_by: string | null;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly token_hash: string;
  readonly challenge_hash: string | null;
  readonly idempotency_record_id: string | null;
  readonly supersedes_grant_id: string | null;
}
const grantsOf = (riderId: string) =>
  routes.rows<GrantRow>(
    `select id, purpose, state, issued_by::text, issued_at, expires_at, encode(token_hash, 'hex') as token_hash,
            encode(attestation_challenge_hash, 'hex') as challenge_hash, idempotency_record_id::text, supersedes_grant_id::text
       from setup_grant where principal_type = 'RIDER' and principal_id = $1 order by issued_at, id`,
    [riderId],
  );
const devicesOf = (riderId: string) =>
  routes.rows<{ id: string; status: string }>(
    `select id, status from registered_device where rider_identity_id = $1 order by registered_at, id`,
    [riderId],
  );
const sha256Hex = (base64url: string): string =>
  createHash('sha256').update(Buffer.from(base64url, 'base64url')).digest('hex');

interface EventRow {
  readonly event_code: string;
  readonly actor_id: string | null;
  readonly object_type: string;
  readonly object_id: string | null;
  readonly responsible_hub_id: string | null;
  readonly previous_state: string | null;
  readonly resulting_state: string | null;
  readonly reason_code: string | null;
  readonly reason_label: string | null;
  readonly note: string | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown> | null;
  readonly enhanced: boolean;
  readonly outcome: string;
}
const eventsFor = (grantIds: readonly string[]) =>
  routes.rows<EventRow>(
    `select event_code, actor_id::text, object_type, object_id::text, responsible_hub_id::text, previous_state, resulting_state,
            reason_code, reason_label, note, related_ids, detail, enhanced, outcome
       from audit_event where object_type = 'SetupGrant' and object_id = any($1::uuid[]) order by recorded_at, id`,
    [grantIds],
  );

/** Every place a secret could be left in the database in the clear: the ledger, the saved answers and the grants. */
async function storedText(): Promise<string> {
  // One after the other: the observer is one connection.
  const texts: string[] = [];
  for (const statement of [
    `select coalesce(string_agg(a::text, ' '), '') as t from audit_event a`,
    `select coalesce(string_agg(convert_from(response_body, 'UTF8') || ' ' || coalesce(encode(sealed_ciphertext, 'escape'), ''), ' '), '') as t
       from idempotency_record where response_body is not null`,
    `select coalesce(string_agg(g::text, ' '), '') as t from setup_grant g`,
    `select coalesce(string_agg(j::text, ' '), '') as t from credential_delivery_job j`,
  ]) {
    texts.push((await routes.rows<{ t: string }>(statement))[0]?.t ?? '');
  }
  return texts.join(' ');
}

describe('registerRiderDevice: the first binding, in person (AC-SLICE-000-40, -76, -124)', () => {
  // Break caught: a grant that is not rider-bound, a URI that is not the version-1 form, a token or challenge kept in the clear, or a message
  // queued for a grant that travels as a QR code.
  it('issues a RIDER_DEVICE_ENROLMENT grant and answers the 127-character enrolment URI, no-store, with no PIN, key or session', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();

    const response = await register(officer, rider.id);

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['enrolment_uri', 'expires_at', 'rider_id']);
    expect(body.rider_id).toBe(rider.id);
    const uri = String(body.enrolment_uri);
    expect(uri).toHaveLength(127);
    const parsed = parseEnrolmentUri(uri);
    if (parsed === null) throw new Error('the answer is not a version-1 enrolment URI');

    const [grant, ...others] = await grantsOf(rider.id);
    expect(others).toEqual([]);
    if (grant === undefined) throw new Error('no grant was issued');
    expect(grant).toMatchObject({
      purpose: 'RIDER_DEVICE_ENROLMENT',
      state: 'PENDING',
      issued_by: officer.identity.id,
      supersedes_grant_id: null,
    });
    // Only the hashes of the token and of the challenge are kept, and the challenge is not the token.
    expect(grant.token_hash).toBe(sha256Hex(parsed.token));
    expect(grant.challenge_hash).toBe(sha256Hex(parsed.challenge));
    expect(parsed.token).not.toBe(parsed.challenge);
    expect(grant.idempotency_record_id).not.toBeNull();
    // The ordinary lifetime of a grant (recovery_link_ttl_minutes, 30), read from the database's clock.
    expect(grant.expires_at.getTime() - grant.issued_at.getTime()).toBe(30 * 60_000);
    expect(body.expires_at).toBe(grant.expires_at.toISOString());

    // No device, no PIN, no session and no message: the rider scans the code, and the handset does the rest.
    expect(await devicesOf(rider.id)).toEqual([]);
    const row = await routes.rows<{ credential_generation: string }>(
      `select credential_generation::text from rider_identity where id = $1`,
      [rider.id],
    );
    expect(row[0]?.credential_generation).toBe('0');
    expect(
      await routes.rows(
        `select 1 from session where principal_type = 'RIDER' and principal_id = $1`,
        [rider.id],
      ),
    ).toEqual([]);
    expect(
      await routes.rows(`select 1 from credential_delivery_job where principal_id = $1`, [
        rider.id,
      ]),
    ).toEqual([]);
  });

  // Break caught (the hash-only rule): the token, the challenge or the URI left in the ledger, in a saved answer or in the grant.
  it('keeps the token, the challenge and the URI nowhere in the clear: not in the ledger, the saved answer, the grant or a message', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const uri = grantOf(await register(officer, rider.id)).enrolment_uri;
    const parsed = parseEnrolmentUri(uri);
    if (parsed === null) throw new Error('the answer is not a version-1 enrolment URI');
    const text = await storedText();
    for (const secret of [parsed.token, parsed.challenge, uri]) {
      expect(secret.length).toBeGreaterThanOrEqual(43);
      expect(text.includes(secret)).toBe(false);
    }
    expect(text.includes('melarc-rider://')).toBe(false);
    // What the saved answer holds apart from the sealed secret is the answer without it.
    const saved = await routes.rows<{ body: string; sealed: boolean }>(
      `select convert_from(response_body, 'UTF8') as body, sealed_ciphertext is not null as sealed
         from idempotency_record where operation_id = 'registerRiderDevice' and principal_id = $1`,
      [officer.identity.id],
    );
    expect(saved.length).toBeGreaterThan(0);
    for (const row of saved) {
      expect(row.sealed).toBe(true);
      expect(Object.keys(JSON.parse(row.body) as object).toSorted()).toEqual([
        'expires_at',
        'rider_id',
      ]);
    }
  });

  // Break caught (§14.16): a replay that is not the original answer, or that issues a second grant.
  it('replays the original answer, the URI included, for the same key and request while the grant is usable, and issues nothing again', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();

    const first = await register(officer, rider.id, key);
    const second = await register(officer, rider.id, key);
    const third = await register(officer, rider.id, key);

    expect(first.status).toBe(200);
    for (const replay of [second, third]) {
      expect(replay.status).toBe(200);
      expect(replay.json()).toEqual(first.json());
      expect(replay.header('cache-control')).toBe('no-store');
    }
    expect(await grantsOf(rider.id)).toHaveLength(1);
    // The replay is one answer, not one ledger entry each.
    const [grant] = await grantsOf(rider.id);
    expect(
      (await eventsFor([grant?.id ?? ''])).filter(
        (event) => event.event_code === 'auth.setup_grant.issued',
      ).length,
    ).toBe(1);
  });

  // Break caught: the key shared across requests, so one rider's enrolment secret is replayed to a call for another rider.
  it('refuses the same key for a different request with IDEMPOTENCY_KEY_CONFLICT, and discloses nothing of the first', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const one = await fresh();
    const other = await fresh();
    const key = uuid();
    const first = await register(officer, one.id, key);
    expect(first.status).toBe(200);

    const conflict = await register(officer, other.id, key);

    expect([conflict.status, codeOf(conflict)]).toEqual([409, 'IDEMPOTENCY_KEY_CONFLICT']);
    expect(JSON.stringify(conflict.json())).not.toContain('melarc-rider');
    expect(await grantsOf(other.id)).toEqual([]);
  });

  // Break caught: a key that belongs to the text and not to the principal: another officer's identical key replaying this officer's secret.
  it('keeps a key to one officer: another officer’s identical key is a separate namespace and issues a grant of its own', async () => {
    const first = await routes.seniorOps(HUB_A);
    const second = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();

    const one = grantOf(await register(first, rider.id, key));
    const two = grantOf(await register(second, rider.id, key));

    expect(two.enrolment_uri).not.toBe(one.enrolment_uri);
    const grants = await grantsOf(rider.id);
    expect(grants.map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
    expect(grants[1]?.supersedes_grant_id).toBe(grants[0]?.id);
    // The older answer can no longer be shown: the grant it holds was ended, in the statement that ended it.
    const replay = await register(first, rider.id, key);
    expect([replay.status, codeOf(replay)]).toEqual([409, 'STATE_CONFLICT']);
    expect(JSON.stringify(replay.json())).not.toContain('melarc-rider');
  });

  // Break caught: a second request with a new key leaving two live grants, or the older answer still replayable (a secret outliving its grant).
  it('supersedes the earlier pending grant when it is registered again with a new key, and ends the replay of the earlier answer', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const firstKey = uuid();
    const first = grantOf(await register(officer, rider.id, firstKey));

    const second = grantOf(await register(officer, rider.id));

    expect(second.enrolment_uri).not.toBe(first.enrolment_uri);
    const grants = await grantsOf(rider.id);
    expect(grants.map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
    const sealed = await routes.rows<{ sealed: boolean; unavailable: boolean }>(
      `select sealed_ciphertext is not null as sealed, replay_unavailable_at is not null as unavailable
         from idempotency_record where operation_id = 'registerRiderDevice' and idempotency_key = $1`,
      [firstKey],
    );
    expect(sealed).toEqual([{ sealed: false, unavailable: true }]);
    const replay = await register(officer, rider.id, firstKey);
    expect([replay.status, codeOf(replay)]).toEqual([409, 'STATE_CONFLICT']);
    // The event for the end of the older grant names the newer, and neither carries a token.
    const events = await eventsFor(grants.map((grant) => grant.id));
    expect(events.map((event) => event.event_code)).toEqual([
      'auth.setup_grant.issued',
      'auth.setup_grant.superseded',
      'auth.setup_grant.issued',
    ]);
    expect(events[1]).toMatchObject({
      object_id: grants[0]?.id,
      previous_state: 'PENDING',
      resulting_state: 'SUPERSEDED',
      related_ids: { principal_id: rider.id, superseded_by: grants[1]?.id },
    });
  });

  // Break caught (§14.16: "consumed, superseded or revoked ends the window"): a consumed grant's secret still shown, or run again.
  it('answers STATE_CONFLICT with no secret once the grant is consumed, erases the sealed fields, and executes nothing again', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();
    expect((await register(officer, rider.id, key)).status).toBe(200);
    const [grant] = await grantsOf(rider.id);
    await routes.admin.query(
      `update setup_grant set state = 'CONSUMED', consumed_at = clock_timestamp() where id = $1`,
      [grant?.id],
    );

    const replay = await register(officer, rider.id, key);

    expect([replay.status, codeOf(replay)]).toEqual([409, 'STATE_CONFLICT']);
    expect(JSON.stringify(replay.json())).not.toContain('melarc-rider');
    expect(await grantsOf(rider.id)).toHaveLength(1);
    const record = await routes.rows<{ sealed: boolean; unavailable: boolean }>(
      `select sealed_ciphertext is not null as sealed, replay_unavailable_at is not null as unavailable
         from idempotency_record where operation_id = 'registerRiderDevice' and idempotency_key = $1`,
      [key],
    );
    expect(record).toEqual([{ sealed: false, unavailable: true }]);
  });

  // Break caught: the window judged on the application's clock or not at all, so a delayed clean-up extends the life of a secret.
  it('answers STATE_CONFLICT once the window of the saved secret has closed, judged on the database’s clock', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();
    expect((await register(officer, rider.id, key)).status).toBe(200);
    // Age the window by SQL, as the database sees it. The guard refuses any change of the sealed fields but their erasure, so the
    // administrator switches it off for the one statement, as a test of time must (`idempotency-record.db.test.ts` does the same).
    await routes.admin.query(
      'alter table idempotency_record disable trigger idempotency_record_guard',
    );
    try {
      await routes.admin.query(
        `update idempotency_record set sealed_expires_at = sealed_expires_at - interval '2 hours'
          where operation_id = 'registerRiderDevice' and idempotency_key = $1`,
        [key],
      );
    } finally {
      await routes.admin.query(
        'alter table idempotency_record enable trigger idempotency_record_guard',
      );
    }

    const replay = await register(officer, rider.id, key);

    expect([replay.status, codeOf(replay)]).toEqual([409, 'STATE_CONFLICT']);
    expect(JSON.stringify(replay.json())).not.toContain('melarc-rider');
    expect(await grantsOf(rider.id)).toHaveLength(1);
  });

  // Break caught (§14.16: "a caller who has lost authority gets the current refusal before any replay").
  it('refuses a caller who has lost authority before any replay: the rider moved out of the officer’s hub, or the session ended', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();
    expect((await register(officer, rider.id, key)).status).toBe(200);

    await routes.admin.query(`update rider_identity set primary_hub_id = $2 where id = $1`, [
      rider.id,
      HUB_B,
    ]);
    const moved = await register(officer, rider.id, key);
    expect([moved.status, codeOf(moved)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(JSON.stringify(moved.json())).not.toContain('melarc-rider');

    await routes.admin.query(`update rider_identity set primary_hub_id = $2 where id = $1`, [
      rider.id,
      HUB_A,
    ]);
    await routes.admin.query(
      `update session set terminated_at = clock_timestamp(), termination_reason = 'ADMIN_REVOKED' where id = $1`,
      [officer.sessionId],
    );
    const ended = await register(officer, rider.id, key);
    expect([ended.status, codeOf(ended)]).toEqual([401, 'SESSION_INVALID']);
    expect(JSON.stringify(ended.json())).not.toContain('melarc-rider');
  });

  // Break caught (AC-76): a second ACTIVE device bound by a first-registration grant, or a grant issued that the table would refuse.
  it('refuses a rider who has an ACTIVE device with STATE_CONFLICT: no grant, the device untouched, and the key free for another rider', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const bound = await fresh({ pinHash: SOME_PIN_HASH });
    const device = await insertRiderDevice(routes.admin, bound.id);
    const key = uuid();

    const refused = await register(officer, bound.id, key);

    expect([refused.status, codeOf(refused)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(bound.id)).toEqual([]);
    expect(await devicesOf(bound.id)).toEqual([{ id: device.id, status: 'ACTIVE' }]);
    // The refusal rolled back with its idempotency record: the same key is free for a rider who can be registered.
    const other = await fresh();
    expect((await register(officer, other.id, key)).status).toBe(200);
  });

  // Break caught (AC-124): a revoked rider registered again by the first-binding operation, which would bypass the verification note.
  it('refuses a rider whose device was revoked with STATE_CONFLICT, and the re-registration with the ETag and a note issues the grant', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const revoked = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, revoked.id, { status: 'REVOKED' });

    const refused = await register(officer, revoked.id);

    expect([refused.status, codeOf(refused)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(revoked.id)).toEqual([]);
    const etag = await versionOf(officer, revoked.id);
    const replaced = await reregister(officer, revoked.id, etag);
    expect(replaced.status).toBe(200);
    expect((await grantsOf(revoked.id)).map((grant) => [grant.purpose, grant.state])).toEqual([
      ['RIDER_DEVICE_REREGISTRATION', 'PENDING'],
    ]);
  });

  it('registers a rider who has had a replaced device only through re-registration, and a rider who never had one through the first binding', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const never = await fresh();
    expect((await register(officer, never.id)).status).toBe(200);
    const replacedOnly = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, replacedOnly.id, { status: 'REPLACED' });
    await insertRiderDevice(routes.admin, replacedOnly.id);
    const refused = await register(officer, replacedOnly.id);
    expect([refused.status, codeOf(refused)]).toEqual([409, 'STATE_CONFLICT']);
  });

  // Break caught: a credential given to a rider whose access has ended (suspended, offboarded), or withheld from one who is merely unavailable.
  it('gives no credential to a rider whose access has ended, and binds a rider who is inactive or temporarily unavailable', async () => {
    const officer = await routes.seniorOps(HUB_A);
    for (const status of ['SUSPENDED', 'OFFBOARDED']) {
      const ended = await fresh({ status });
      const refused = await register(officer, ended.id);
      expect([status, refused.status, codeOf(refused)]).toEqual([status, 409, 'STATE_CONFLICT']);
      expect(await grantsOf(ended.id)).toEqual([]);
    }
    for (const status of ['INACTIVE', 'TEMPORARILY_UNAVAILABLE', 'ACTIVE']) {
      const bindable = await fresh({ status });
      const granted = await register(officer, bindable.id);
      expect([status, granted.status]).toEqual([status, 200]);
    }
  });

  // Break caught: a key that is not the store's accepted, a missing key accepted, or a key beyond the contract's bound.
  it('requires an Idempotency-Key that the store can keep, and refuses a missing, an over-long and a control-character key', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();

    const missing = await officer.client.post(REGISTER(rider.id), undefined, { origin: OPS });
    const tooLong = await register(officer, rider.id, 'k'.repeat(129));
    const control = await register(officer, rider.id, 'a\u0085b');
    const longest = await register(officer, rider.id, 'k'.repeat(128));

    for (const refused of [missing, tooLong, control]) {
      expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(longest.status).toBe(200);
    expect(await grantsOf(rider.id)).toHaveLength(1);
  });

  it('refuses a path that is not a rider id with VALIDATION_FAILED, and one that names no rider with NOT_FOUND', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const malformed = await register(officer, 'not-a-uuid');
    const absent = await register(officer, uuid());
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('who may start a first binding (AC-SLICE-000-23, GBT-GS13)', () => {
  // Break caught: Ops Staff holding the act that grants access, or Platform Admin status read as a bypass (a bundle at the Platform Admin's tier
  // that holds the replacement key at every hub and not the registration key is refused).
  it('refuses Ops Staff and a bundle without the key with PERMISSION_DENIED, whatever the hub or the tier', async () => {
    const rider = await fresh();
    const adminTierWithoutTheKey = await newBundle(routes.admin, [
      grant('staff.device.reregister', 'all', 'any', 'P'),
      grant('staff.read', 'all', 'any', 'P'),
    ]);
    for (const bundle of [BUNDLE_IDS.opsStaff, BUNDLE_IDS.finance, adminTierWithoutTheKey]) {
      const refused = await register(await routes.actor(bundle, HUB_A), rider.id);
      expect([bundle, refused.status, codeOf(refused)]).toEqual([bundle, 403, 'PERMISSION_DENIED']);
    }
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  // Break caught: a Senior Ops reaching another hub's riders, or a hub violation told as absent.
  it('keeps a Senior Ops to the riders of their own hub: another hub is HUB_SCOPE_VIOLATION, an unknown rider NOT_FOUND', async () => {
    const inB = await fresh({ hubId: HUB_B });
    const refused = await register(await routes.seniorOps(HUB_A), inB.id);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    expect(await grantsOf(inB.id)).toEqual([]);
    const granted = await register(await routes.seniorOps(HUB_B), inB.id);
    expect(granted.status).toBe(200);
  });

  // Break caught: the wider scope of first registration lost for a Platform Admin whose grant says so (the catalogue: all hubs).
  it('lets a Platform Admin whose grant is all-hub register a first device at any hub', async () => {
    const admin = await routes.platformAdmin();
    const inA = await fresh({ hubId: HUB_A });
    const inB = await fresh({ hubId: HUB_B });
    for (const rider of [inA, inB]) {
      const response = await register(admin, rider.id);
      expect([rider.hubId, response.status]).toEqual([rider.hubId, 200]);
    }
    const grants = await grantsOf(inB.id);
    expect(grants[0]?.issued_by).toBe(admin.identity.id);
  });

  // Break caught: the browser's guard letting an unsafe request through without the synchronizer token.
  it('refuses a request without the synchronizer token with CSRF_VALIDATION_FAILED, and a caller with no session with SESSION_INVALID', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const bare = presenting(routes.kit, officer.token);
    const noToken = await bare.post(REGISTER(rider.id), undefined, {
      origin: OPS,
      headers: { 'idempotency-key': uuid() },
    });
    const anonymous = await routes.kit.client.fork().post(REGISTER(rider.id), undefined, {
      origin: OPS,
      headers: { 'idempotency-key': uuid() },
    });
    expect([noToken.status, codeOf(noToken)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  // Break caught: a Vendor, or a handset, reaching an officer's act. Both are authenticated (the operation takes a browser session or a
  // Rider's, as every state-changing operation of the default posture does) and refused by the surface gate: the Ops Portal is the only
  // surface the act serves.
  it('refuses a Vendor session and a Rider’s bearer credential with PERMISSION_DENIED', async () => {
    const rider = await fresh();
    const vendor = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR');
    const handset = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');

    const asVendor = await presenting(routes.kit, vendor.token, vendor.csrf).post(
      REGISTER(rider.id),
      undefined,
      { origin: 'http://127.0.0.1:5174', headers: { 'idempotency-key': uuid() } },
    );
    const asRider = await routes.kit.client
      .bearer(handset.token)
      .post(REGISTER(rider.id), undefined, { headers: { 'idempotency-key': uuid() } });

    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([asRider.status, codeOf(asRider)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await grantsOf(rider.id)).toEqual([]);
  });
});

describe('registerRiderDevice under concurrency (AC-SLICE-000-76)', () => {
  // Break caught: two parallel calls leaving two live grants or a second command run under one key.
  it('answers two parallel calls with one key as one command and its replay, and leaves one grant', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh();
    const key = uuid();

    const [one, two] = await Promise.all([
      register(officer, rider.id, key),
      register(officer, rider.id, key),
    ]);

    expect([one.status, two.status]).toEqual([200, 200]);
    expect(one.json()).toEqual(two.json());
    expect(await grantsOf(rider.id)).toHaveLength(1);
  });

  it('leaves exactly one pending grant when two officers register the same rider at once', async () => {
    const first = await routes.seniorOps(HUB_A);
    const second = await routes.seniorOps(HUB_A);
    const rider = await fresh();

    const answers = await Promise.all([register(first, rider.id), register(second, rider.id)]);

    expect(answers.map((answer) => answer.status)).toEqual([200, 200]);
    const grants = await grantsOf(rider.id);
    expect(grants).toHaveLength(2);
    expect(grants.filter((grant) => grant.state === 'PENDING')).toHaveLength(1);
    expect(grants.filter((grant) => grant.state === 'SUPERSEDED')).toHaveLength(1);
  });
});

describe('reregisterRiderDevice: the replacement handset, in person (AC-SLICE-000-108, -23, -13)', () => {
  const NOTE = 'Checked the rider’s staff card and face in person at the hub';

  // Break caught: a replacement that touches the old device before the new handset enrols, or shows the officer anything but the QR.
  it('issues a RIDER_DEVICE_REREGISTRATION grant as an enrolment URI and changes nothing about the device or the PIN', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    const device = await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(officer, rider.id);

    const response = await reregister(officer, rider.id, etag);

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(['enrolment_uri', 'expires_at', 'rider_id']);
    const parsed = parseEnrolmentUri(String(body.enrolment_uri));
    if (parsed === null) throw new Error('the answer is not a version-1 enrolment URI');
    const [grant, ...others] = await grantsOf(rider.id);
    expect(others).toEqual([]);
    expect(grant).toMatchObject({
      purpose: 'RIDER_DEVICE_REREGISTRATION',
      state: 'PENDING',
      issued_by: officer.identity.id,
      idempotency_record_id: null,
      token_hash: sha256Hex(parsed.token),
      challenge_hash: sha256Hex(parsed.challenge),
    });
    expect(grant?.expires_at.getTime()).toBe((grant?.issued_at.getTime() ?? 0) + 30 * 60_000);
    // Nothing changes until the new handset's enrolment succeeds: the old device is as it was, and so is the rider's version.
    expect(await devicesOf(rider.id)).toEqual([{ id: device.id, status: 'ACTIVE' }]);
    expect(await versionOf(officer, rider.id)).toBe(etag);
    expect(
      await routes.rows(`select 1 from credential_delivery_job where principal_id = $1`, [
        rider.id,
      ]),
    ).toEqual([]);
  });

  // Break caught (AC-108: "records why, and how identity was verified"): an event without the reason or the note, or with the token.
  it('records the reason and the verification note on the event, and the token and challenge nowhere', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);

    const response = await reregister(officer, rider.id, await versionOf(officer, rider.id));
    const parsed = parseEnrolmentUri(grantOf(response).enrolment_uri);
    if (parsed === null) throw new Error('the answer is not a version-1 enrolment URI');

    const [grant] = await grantsOf(rider.id);
    const events = await eventsFor([grant?.id ?? '']);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_code: 'auth.setup_grant.issued',
      actor_id: officer.identity.id,
      enhanced: false,
      outcome: 'SUCCEEDED',
      responsible_hub_id: HUB_A,
      reason_code: 'RIDER_HANDSET_CHANGED',
      reason_label: 'Rider handset changed',
      note: NOTE,
      related_ids: { principal_id: rider.id, issued_by: officer.identity.id },
      detail: { purpose: 'RIDER_DEVICE_REREGISTRATION', channel: 'QR', principal_type: 'RIDER' },
    });
    const text = await storedText();
    for (const secret of [parsed.token, parsed.challenge, 'melarc-rider://']) {
      expect(text.includes(secret), secret).toBe(false);
    }
  });

  // Break caught (AC-108): a replacement without how identity was verified.
  it('refuses a missing, an empty, a blank, an over-long and a control-character verification_note with VALIDATION_FAILED', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(officer, rider.id);
    const reason_code = 'RIDER_HANDSET_CHANGED';

    for (const body of [
      { reason_code },
      { reason_code, verification_note: '' },
      { reason_code, verification_note: '   ' },
      { reason_code, verification_note: 'x'.repeat(1001) },
      { reason_code, verification_note: 'line one\nline two' },
      { reason_code, verification_note: NOTE, extra: true },
    ]) {
      const refused = await reregister(officer, rider.id, etag, body);
      expect([JSON.stringify(body).slice(0, 60), refused.status, codeOf(refused)]).toEqual([
        JSON.stringify(body).slice(0, 60),
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  // Break caught: the reason of another family, a retired or an unknown one accepted, or an empty one read as a code.
  it('refuses an empty reason with REASON_REQUIRED and an unknown, foreign-domain or malformed reason with REASON_NOT_ACTIVE', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(officer, rider.id);
    const verification_note = NOTE;

    const empty = await reregister(officer, rider.id, etag, { reason_code: '', verification_note });
    expect([empty.status, codeOf(empty)]).toEqual([422, 'REASON_REQUIRED']);
    for (const reason_code of [
      'NOT_A_REASON',
      'RIDER_DEVICE_SECURITY_CONCERN',
      'lower_case',
      'SESSION_REVOKED_BY_ADMIN',
    ]) {
      const refused = await reregister(officer, rider.id, etag, { reason_code, verification_note });
      expect([reason_code, refused.status, codeOf(refused)]).toEqual([
        reason_code,
        422,
        'REASON_NOT_ACTIVE',
      ]);
    }
    // A reason that was retired is not active for any operation.
    await routes.admin.query(
      `update reason_code set active = false where code = 'RIDER_HANDSET_CHANGED'`,
    );
    try {
      const retired = await reregister(officer, rider.id, etag);
      expect([retired.status, codeOf(retired)]).toEqual([422, 'REASON_NOT_ACTIVE']);
    } finally {
      await routes.admin.query(
        `update reason_code set active = true where code = 'RIDER_HANDSET_CHANGED'`,
      );
    }
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  // Break caught (AC-108): a stale ETag accepted, so a replacement is issued against a rider that has changed since the officer read it.
  it('refuses a stale ETag and a missing If-Match with STATE_CONFLICT, and issues nothing', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(officer, rider.id);
    await routes.admin.query(`update rider_identity set status = 'INACTIVE' where id = $1`, [
      rider.id,
    ]);

    const stale = await reregister(officer, rider.id, etag);
    const wrongForm = await reregister(officer, rider.id, `W/${etag}`);

    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    expect([wrongForm.status, codeOf(wrongForm)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(rider.id)).toEqual([]);
    // The version the officer reads now is the one that works.
    expect((await reregister(officer, rider.id, await versionOf(officer, rider.id))).status).toBe(
      200,
    );
  });

  it('answers a request with no If-Match as the contract’s required-header refusal and issues nothing', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);

    const missing = await reregister(officer, rider.id, undefined);

    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(missing.status).toBeLessThan(500);
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  // Break caught: a replacement for a rider who has held no device (that is the first binding's), or for one whose access has ended.
  it('refuses a rider who has held no device, and one whose access has ended, with STATE_CONFLICT', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const never = await fresh();
    const refusedNever = await reregister(officer, never.id, await versionOf(officer, never.id));
    expect([refusedNever.status, codeOf(refusedNever)]).toEqual([409, 'STATE_CONFLICT']);

    const suspended = await fresh({ status: 'SUSPENDED', pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, suspended.id);
    const refusedSuspended = await reregister(
      officer,
      suspended.id,
      await versionOf(officer, suspended.id),
    );
    expect([refusedSuspended.status, codeOf(refusedSuspended)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await grantsOf(never.id)).toEqual([]);
    expect(await grantsOf(suspended.id)).toEqual([]);
  });

  // Break caught: the newer grant not superseding the older, so two handsets could complete at once.
  it('supersedes the earlier pending replacement grant, and the older one is ended with an event naming the newer', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(officer, rider.id);

    const first = grantOf(await reregister(officer, rider.id, etag));
    const second = grantOf(await reregister(officer, rider.id, etag));

    expect(second.enrolment_uri).not.toBe(first.enrolment_uri);
    const grants = await grantsOf(rider.id);
    expect(grants.map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
    expect(grants[1]?.supersedes_grant_id).toBe(grants[0]?.id);
    const events = await eventsFor(grants.map((grant) => grant.id));
    expect(events.map((event) => event.event_code)).toEqual([
      'auth.setup_grant.issued',
      'auth.setup_grant.superseded',
      'auth.setup_grant.issued',
    ]);
  });

  // Break caught (AC-23, GBT-GS13; the decision of 6 November 2026): Senior Ops allowed past their own hub, the Platform Admin held at its own hub
  // again (a Platform Admin with no hub, or with another hub, refused), Ops Staff let in, or the act made without the grant of its key.
  it('holds Senior Ops to their own hub, lets a Platform Admin replace at every hub, and refuses Ops Staff', async () => {
    const rider = await fresh({ pinHash: SOME_PIN_HASH, hubId: HUB_A });
    await insertRiderDevice(routes.admin, rider.id);
    const reader = await routes.seniorOps(HUB_A);
    const etag = await versionOf(reader, rider.id);

    const opsStaff = await reregister(await routes.opsStaff(HUB_A), rider.id, etag);
    const seniorElsewhere = await reregister(await routes.seniorOps(HUB_B), rider.id, etag);
    expect([opsStaff.status, codeOf(opsStaff)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([seniorElsewhere.status, codeOf(seniorElsewhere)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    // A refusal issues nothing.
    expect(await grantsOf(rider.id)).toEqual([]);

    // A Platform Admin holds the key at every hub: the seeded one with no hub, one of another hub and one of the rider's own all replace it.
    const adminNoHub = await reregister(await routes.platformAdmin(), rider.id, etag);
    const adminElsewhere = await reregister(
      await routes.actor(BUNDLE_IDS.platformAdmin, HUB_B),
      rider.id,
      etag,
    );
    const adminHere = await reregister(
      await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A),
      rider.id,
      etag,
    );
    const senior = await reregister(reader, rider.id, etag);
    expect([adminNoHub.status, adminElsewhere.status, adminHere.status, senior.status]).toEqual([
      200, 200, 200, 200,
    ]);
    // Each replaces the grant of the one before, as the act always did.
    expect((await grantsOf(rider.id)).map((grant) => grant.state)).toEqual([
      'SUPERSEDED',
      'SUPERSEDED',
      'SUPERSEDED',
      'PENDING',
    ]);
  });

  // Break caught (AC-23, AC-108; decision D14: the hub of an act is the record’s, never the actor’s): the audit event of a Platform Admin’s
  // replacement filed under the administrator’s hub (or under none, for one with no hub), or the reason and the verification note left optional for
  // that actor because the check was kept for the Senior Ops path alone.
  it('files a Platform Admin’s replacement under the rider’s hub with the actor, the reason and the note, and refuses it without them', async () => {
    const rider = await fresh({ pinHash: SOME_PIN_HASH, hubId: HUB_A });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(await routes.seniorOps(HUB_A), rider.id);
    const administrators = [
      await routes.platformAdmin(),
      await routes.actor(BUNDLE_IDS.platformAdmin, HUB_B),
    ];

    for (const who of administrators) {
      const noNote = await reregister(who, rider.id, etag, {
        reason_code: 'RIDER_HANDSET_CHANGED',
      });
      const noReason = await reregister(who, rider.id, etag, {
        reason_code: '',
        verification_note: NOTE,
      });
      expect([noNote.status, codeOf(noNote)]).toEqual([400, 'VALIDATION_FAILED']);
      expect([noReason.status, codeOf(noReason)]).toEqual([422, 'REASON_REQUIRED']);
    }
    expect(await grantsOf(rider.id)).toEqual([]);

    for (const who of administrators) {
      expect((await reregister(who, rider.id, etag)).status).toBe(200);
      const grants = await grantsOf(rider.id);
      const issued = (await eventsFor([grants[grants.length - 1]?.id ?? ''])).find(
        (each) => each.event_code === 'auth.setup_grant.issued',
      );
      expect(issued).toMatchObject({
        actor_id: who.identity.id,
        responsible_hub_id: HUB_A,
        reason_code: 'RIDER_HANDSET_CHANGED',
        note: NOTE,
        related_ids: { principal_id: rider.id, issued_by: who.identity.id },
      });
    }
  });

  // Break caught (AC-23; the decision of 6 November 2026): a bypass of the hub for these two keys that reads the tier as "every hub". The seeded
  // Platform Admin now holds both keys at every hub, so only a bundle arranged at its own hub can show that a grant of tier P is still held to it.
  it('holds a grant of tier P at its own hub to that hub, for the replacement and for the first registration', async () => {
    const own = await newBundle(routes.admin, [
      grant('staff.device.reregister', 'own', 'any', 'P'),
      grant('staff.device.register', 'own', 'any', 'P'),
      grant('staff.read', 'own', 'any', 'P'),
    ]);
    const replaced = await fresh({ pinHash: SOME_PIN_HASH, hubId: HUB_A });
    await insertRiderDevice(routes.admin, replaced.id);
    const first = await fresh({ hubId: HUB_A });
    const etag = await versionOf(await routes.seniorOps(HUB_A), replaced.id);

    const elsewhere = await routes.actor(own, HUB_B);
    const refusedReplacement = await reregister(elsewhere, replaced.id, etag);
    const refusedRegistration = await register(elsewhere, first.id);
    expect([refusedReplacement.status, codeOf(refusedReplacement)]).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect([refusedRegistration.status, codeOf(refusedRegistration)]).toEqual([
      403,
      'HUB_SCOPE_VIOLATION',
    ]);
    expect(await grantsOf(replaced.id)).toEqual([]);
    expect(await grantsOf(first.id)).toEqual([]);

    const here = await routes.actor(own, HUB_A);
    expect((await reregister(here, replaced.id, etag)).status).toBe(200);
    expect((await register(here, first.id)).status).toBe(200);
  });

  // Break caught: the role name read as a bypass for replacement. A bundle at the Platform Admin's tier that holds the registration key at every
  // hub and not the replacement key is refused, as Finance's is: the authority is the grant of the key, never the tier or the name.
  it('refuses a bundle that does not hold the key, whatever its tier, the hub or the registration grant', async () => {
    const rider = await fresh({ pinHash: SOME_PIN_HASH, hubId: HUB_A });
    await insertRiderDevice(routes.admin, rider.id);
    const etag = await versionOf(await routes.seniorOps(HUB_A), rider.id);
    const adminTierWithoutTheKey = await routes.actor(
      await newBundle(routes.admin, [
        grant('staff.device.register', 'all', 'any', 'P'),
        grant('staff.read', 'all', 'any', 'P'),
      ]),
      HUB_A,
    );

    const finance = await reregister(await routes.actor(BUNDLE_IDS.finance, HUB_A), rider.id, etag);
    const adminTier = await reregister(adminTierWithoutTheKey, rider.id, etag);

    for (const refused of [finance, adminTier]) {
      expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect(await grantsOf(rider.id)).toEqual([]);
  });

  it('answers a rider that does not exist NOT_FOUND, and a path that is not an id VALIDATION_FAILED', async () => {
    const officer = await routes.seniorOps(HUB_A);
    const absent = await reregister(officer, uuid(), '"x"');
    const malformed = await reregister(officer, 'not-a-uuid', '"x"');
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught (AC-13): a path that lets a rider re-register themself, or a handset's bearer credential reaching the officer's act.
  it('has no path for a rider or a Vendor: a Rider’s bearer credential and a Vendor’s session are both PERMISSION_DENIED', async () => {
    const rider = await fresh({ pinHash: SOME_PIN_HASH });
    await insertRiderDevice(routes.admin, rider.id);
    const handset = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const vendor = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR');
    const body = { reason_code: 'RIDER_HANDSET_CHANGED', verification_note: NOTE };

    const asRider = await routes.kit.client
      .bearer(handset.token)
      .post(REREGISTER(rider.id), body, { headers: { 'if-match': '"x"' } });
    const asVendor = await presenting(routes.kit, vendor.token, vendor.csrf).post(
      REREGISTER(rider.id),
      body,
      { origin: 'http://127.0.0.1:5174', headers: { 'if-match': '"x"' } },
    );

    expect([asRider.status, codeOf(asRider)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect(await grantsOf(rider.id)).toEqual([]);
  });
});

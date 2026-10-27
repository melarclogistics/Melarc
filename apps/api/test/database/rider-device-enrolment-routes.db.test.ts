import { createHash } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { substituteChain } from '../../src/platform/auth/attestation/substitute.attestation-verifier.adapter.js';
import {
  ATTESTATION_INTEGRITY_CAUSES,
  ATTESTATION_UNAVAILABLE_CAUSES,
} from '../../src/platform/auth/ports/attestation-verifier.port.js';
import {
  HASH_ADMISSION,
  type HashAdmission,
  type HashSlot,
} from '../../src/platform/auth/ports/hash-admission.port.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import { parseEnrolmentUri } from '../../src/platform/auth/rider/enrolment-uri.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { refuseConsumption } from './support/guard-race.js';
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
  OPS,
  codeOf,
  startStaffRoutes,
  uuid,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.57, `completeRiderDeviceEnrolment` against the real application and a real PostgreSQL (`AC-SLICE-000-13`, `-40`, `-60` to `-73`, `-75`,
 * `-76`, `-125`; rider-authentication.md sections 4.2 and 4.3; SECURITY_DESIGN.md section 15.2): the rider's handset completes the binding the
 * officer started, with the grant of the QR code, the public half of its key, the PIN its rider chose and the attestation of the key. Every request
 * goes through HTTP as the native app sends it (no `Origin`, no cookie, no credential); what the application did is read from a second connection.
 *
 * The verifier here is the application's **substitute** behind a recorder: it yields each verdict a directive asks for, deterministically
 * (`AC-SLICE-000-75`), so this file proves how the API handles each verdict (*fixture/platform verified*). That the real policy gives those verdicts
 * for the evidence of a real handset is the JVM service's, against independently generated chains (`rider-device-enrolment-attested.db.test.ts`, S0.57 J).
 */
const ENROL = `${API}/auth/rider/device/enrol`;
const REGISTER = (id: string) => `${API}/ops/riders/${id}/device/register`;
const REREGISTER = (id: string) => `${API}/ops/riders/${id}/device/reregister`;
const ONE = (id: string) => `${API}/ops/riders/${id}`;
const PIN = '739204';
const NEW_PIN = '518340';

const verifier = new ScriptedVerifier();
let routes: StaffRoutes;
let hasher: Hasher;
let counter = 0;

beforeAll(async () => {
  routes = await startStaffRoutes({ attestationVerifier: verifier });
  hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

beforeEach(() => {
  verifier.calls.length = 0;
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);
const sha256Hex = (base64url: string): string =>
  createHash('sha256').update(Buffer.from(base64url, 'base64url')).digest('hex');

/** A rider of the hub, `ACTIVE`, with no PIN and no device unless the test says otherwise. */
function fresh(overrides: Partial<RiderRow> = {}): Promise<RiderRow> {
  counter += 1;
  return insertRider(
    routes.admin,
    riderRow({ fullName: `Enrolment rider ${String(counter)}`, hubId: HUB_A, ...overrides }),
  );
}

/** What the officer's screen holds after the in-person start of a binding: the two halves of the QR code, and the grant they name. */
interface Started {
  readonly rider: RiderRow;
  readonly officer: Actor;
  readonly token: string;
  readonly challenge: string;
  readonly grantId: string;
}

async function pendingGrant(riderId: string, purpose: string): Promise<string> {
  const [grant] = await rows<{ id: string }>(
    `select id from setup_grant where principal_id = $1 and purpose = $2 and state = 'PENDING' order by issued_at desc limit 1`,
    [riderId, purpose],
  );
  if (grant === undefined) throw new Error(`no pending ${purpose} grant`);
  return grant.id;
}

function startedFrom(
  rider: RiderRow,
  officer: Actor,
  response: TestResponse,
  grantId: string,
): Started {
  const uri = (response.json() as { enrolment_uri: string }).enrolment_uri;
  const parsed = parseEnrolmentUri(uri);
  if (parsed === null) throw new Error('the officer was not given a version-1 enrolment URI');
  return { rider, officer, token: parsed.token, challenge: parsed.challenge, grantId };
}

/** The first binding, started by Senior Ops in person (`registerRiderDevice`). */
async function startFirstBinding(overrides: Partial<RiderRow> = {}): Promise<Started> {
  const rider = await fresh(overrides);
  const officer = await routes.seniorOps(HUB_A);
  const response = await officer.client.post(REGISTER(rider.id), undefined, {
    origin: OPS,
    headers: { 'idempotency-key': uuid() },
  });
  expect(response.status).toBe(200);
  return startedFrom(
    rider,
    officer,
    response,
    await pendingGrant(rider.id, 'RIDER_DEVICE_ENROLMENT'),
  );
}

/** A replacement, started by Senior Ops in person (`reregisterRiderDevice`, which takes the rider's version and the verification note). */
async function startReplacement(rider: RiderRow, officer?: Actor): Promise<Started> {
  const by = officer ?? (await routes.seniorOps(HUB_A));
  const read = await by.client.get(ONE(rider.id));
  expect(read.status).toBe(200);
  const etag = read.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  const response = await by.client.post(
    REREGISTER(rider.id),
    {
      reason_code: 'RIDER_HANDSET_CHANGED',
      verification_note: 'Checked the rider’s staff card and face in person at the hub',
    },
    { origin: OPS, headers: { 'if-match': etag } },
  );
  expect(response.status).toBe(200);
  return startedFrom(
    rider,
    by,
    response,
    await pendingGrant(rider.id, 'RIDER_DEVICE_REREGISTRATION'),
  );
}

/** A rider as the replacement assumes one: a PIN, and a device that is `ACTIVE`, with a live session on it. */
async function riderWithDevice(
  status: 'ACTIVE' | 'REVOKED' = 'ACTIVE',
): Promise<{ rider: RiderRow; device: Awaited<ReturnType<typeof insertRiderDevice>> }> {
  const rider = await fresh({ pinHash: SOME_PIN_HASH });
  const device = await insertRiderDevice(routes.admin, rider.id, { status });
  return { rider, device };
}

interface Body {
  setup_token: string;
  public_key: string;
  pin: string;
  key_attestation: { certificate_chain: string[] };
}

function bodyFor(
  started: Pick<Started, 'token'>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Body = {
    setup_token: started.token,
    public_key: deviceKey().publicKey,
    pin: PIN,
    key_attestation: { certificate_chain: [...substituteChain('VERIFIED')] },
  };
  return { ...body, ...overrides };
}

/** The Rider app's request: a client of its own with no cookie, no credential and no `Origin`, as the native client sends it. */
const enrolBody = (body: Record<string, unknown>): Promise<TestResponse> =>
  routes.kit.client.fork().post(ENROL, body, { origin: null });
const enrol = (
  started: Pick<Started, 'token'>,
  overrides: Record<string, unknown> = {},
): Promise<TestResponse> => enrolBody(bodyFor(started, overrides));
const chainOf = (directive: string) => ({
  key_attestation: { certificate_chain: [...substituteChain(directive)] },
});

const devicesOf = (riderId: string) =>
  rows<{
    id: string;
    status: string;
    public_key: string;
    registered_by: string | null;
    ended_at: Date | null;
  }>(
    `select id, status, public_key, registered_by::text, ended_at from registered_device where rider_identity_id = $1 order by registered_at, id`,
    [riderId],
  );
const riderOf = (riderId: string) =>
  rows<{
    pin_hash: string | null;
    credential_generation: number;
    failed_attempt_count: number;
    locked_until: Date | null;
  }>(
    `select pin_hash, credential_generation::int, failed_attempt_count, locked_until from rider_identity where id = $1`,
    [riderId],
  ).then((found) => found[0]);
const grantState = async (id: string): Promise<{ state: string; consumed_at: Date | null }> => {
  const [grant] = await rows<{ state: string; consumed_at: Date | null }>(
    `select state, consumed_at from setup_grant where id = $1`,
    [id],
  );
  if (grant === undefined) throw new Error('no such grant');
  return grant;
};
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
  readonly before_after: Record<string, unknown> | null;
  readonly related_ids: Record<string, unknown> | null;
  readonly detail: Record<string, unknown>;
}
/** What the rider's side of an act wrote: the events that name the rider as the actor (the officer's own are the staff member's). */
const eventsOfRider = (riderId: string) =>
  rows<EventRow>(
    `select event_code, enhanced, outcome, actor_type, actor_id::text, object_type, object_id::text, responsible_hub_id::text,
            previous_state, resulting_state, reason_code, before_after, related_ids, detail
       from audit_event where actor_type = 'RIDER' and actor_id = $1 order by recorded_at, id`,
    [riderId],
  );
const codesOf = (events: readonly EventRow[]): string[] =>
  events.map((event) => event.event_code).toSorted();
const sessionsOf = (riderId: string) =>
  rows<{ id: string; terminated_at: Date | null; termination_reason: string | null }>(
    `select id, terminated_at, termination_reason from session where principal_type = 'RIDER' and principal_id = $1`,
    [riderId],
  );

/** Every place a secret could be left in the database in the clear: the ledger, the saved answers and the grants. */
async function storedText(): Promise<string> {
  const texts: string[] = [];
  for (const statement of [
    `select coalesce(string_agg(a::text, ' '), '') as t from audit_event a`,
    `select coalesce(string_agg(convert_from(response_body, 'UTF8') || ' ' || coalesce(encode(sealed_ciphertext, 'escape'), ''), ' '), '') as t
       from idempotency_record where response_body is not null`,
    `select coalesce(string_agg(g::text, ' '), '') as t from setup_grant g`,
    `select coalesce(string_agg(j::text, ' '), '') as t from credential_delivery_job j`,
  ]) {
    texts.push((await rows<{ t: string }>(statement))[0]?.t ?? '');
  }
  return texts.join(' ');
}

describe('completeRiderDeviceEnrolment: the first binding (AC-SLICE-000-60)', () => {
  // Break caught: a device that is not ACTIVE or not bound to the rider, a grant left open, a PIN not set (or set in the clear), a session
  // issued by an operation that only establishes credentials, or an authorising officer lost from the record.
  it('registers the device ACTIVE, consumes the grant, sets the PIN and issues no session', async () => {
    const started = await startFirstBinding();
    const key = deviceKey();

    const response = await enrol(started, { public_key: key.publicKey });

    expect(response.status).toBe(200);
    expect(response.header('set-cookie')).toBeNull();
    const body = response.json() as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual([
      'device_kind',
      'id',
      'principal_id',
      'principal_type',
      'registered_at',
      'registered_by',
      'status',
    ]);
    expect(body).toMatchObject({
      principal_type: 'RIDER',
      principal_id: started.rider.id,
      device_kind: 'RIDER_ANDROID_KEYPAIR',
      status: 'ACTIVE',
      registered_by: started.officer.identity.id,
    });
    expect(response.text).not.toContain(key.publicKey);

    const devices = await devicesOf(started.rider.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({
      id: body.id,
      status: 'ACTIVE',
      public_key: key.publicKey,
      registered_by: started.officer.identity.id,
      ended_at: null,
    });
    expect(await grantState(started.grantId)).toMatchObject({ state: 'CONSUMED' });
    expect((await grantState(started.grantId)).consumed_at).not.toBeNull();
    // The PIN is set, privately and in one form only: an Argon2id hash that verifies the PIN the rider chose and no other.
    const rider = await riderOf(started.rider.id);
    expect(rider?.pin_hash).toMatch(/^\$argon2id\$/);
    expect(rider?.credential_generation).toBe(1);
    expect(rider?.failed_attempt_count).toBe(0);
    expect((await hasher.verify('RIDER_PIN', PIN, rider?.pin_hash ?? '')).matches).toBe(true);
    expect((await hasher.verify('RIDER_PIN', NEW_PIN, rider?.pin_hash ?? '')).matches).toBe(false);
    // Enrolment establishes credentials and authenticates nobody.
    expect(await sessionsOf(started.rider.id)).toEqual([]);
  });

  // Break caught: the evidence asked about for another grant's challenge, the hash of the token passed as the challenge's, or the key the
  // handset submitted not the key the verifier was asked about.
  it('asks the verifier about the challenge issued with the grant, the chain and the submitted key, once', async () => {
    const started = await startFirstBinding();
    const key = deviceKey();

    await enrol(started, { public_key: key.publicKey });

    expect(verifier.calls).toHaveLength(1);
    const asked = verifier.calls[0];
    expect(Buffer.from(asked?.expectedChallengeSha256 ?? []).toString('hex')).toBe(
      sha256Hex(started.challenge),
    );
    expect(asked?.devicePublicKey).toBe(key.publicKey);
    expect(asked?.certificateChain).toEqual([...substituteChain('VERIFIED')]);
    // The challenge is not the token: handing the verifier the hash of the token would let any grant's evidence pass for another's.
    expect(sha256Hex(started.token)).not.toBe(sha256Hex(started.challenge));
  });

  // Break caught (AC-60, audit.md section 5.4): a registration recorded as an ordinary event, the attestation summary missing, the chain,
  // the challenge, the token or the PIN in the ledger, or the authorising officer missing from an event that exists to name them.
  it('records the binding as an enhanced event with the attestation summary and the officer, and no secret anywhere', async () => {
    const started = await startFirstBinding();

    const response = await enrol(started);

    expect(response.status).toBe(200);
    const device = (response.json() as { id: string }).id;
    const events = await eventsOfRider(started.rider.id);
    expect(codesOf(events)).toEqual([
      'auth.credential.changed',
      'auth.device.registered',
      'auth.setup_grant.consumed',
    ]);
    const registered = events.find((event) => event.event_code === 'auth.device.registered');
    expect(registered).toMatchObject({
      enhanced: true,
      outcome: 'SUCCEEDED',
      actor_type: 'RIDER',
      actor_id: started.rider.id,
      object_type: 'RegisteredDevice',
      object_id: device,
      responsible_hub_id: HUB_A,
      resulting_state: 'ACTIVE',
      before_after: { status: { before: null, after: 'ACTIVE' } },
    });
    expect(registered?.related_ids).toEqual({
      principal_id: started.rider.id,
      setup_grant_id: started.grantId,
      authorised_by: started.officer.identity.id,
    });
    expect(registered?.detail).toMatchObject({
      device_kind: 'RIDER_ANDROID_KEYPAIR',
      purpose: 'RIDER_DEVICE_ENROLMENT',
      attested: true,
      security_level: 'TRUSTED_ENVIRONMENT',
      verified_boot_state: 'VERIFIED',
      device_locked: true,
      package_name: 'substitute.attestation',
      signer_fingerprints: '0'.repeat(16),
    });
    const pin = events.find((event) => event.event_code === 'auth.credential.changed');
    expect(pin).toMatchObject({
      enhanced: false,
      before_after: { credential_generation: { before: 0, after: 1 } },
      detail: { cause: 'ENROLMENT', credential_kind: 'RIDER_PIN' },
    });
    const text = `${await storedText()} ${routes.kit.app.logs.text()}`;
    for (const secret of [started.token, started.challenge, 'substitute:VERIFIED']) {
      expect(text, secret).not.toContain(secret);
    }
    expect(text).not.toContain(`"${PIN}"`);
    expect(text).not.toMatch(/"pin"/);
  });

  // Break caught (OB-105; SECURITY_DESIGN.md section 14.16): a consumed grant that leaves the sealed secret of the officer's answer replayable.
  it('ends the replay of the officer’s answer: the same registration, retried, is STATE_CONFLICT and discloses nothing', async () => {
    const rider = await fresh();
    const officer = await routes.seniorOps(HUB_A);
    const key = uuid();
    const first = await officer.client.post(REGISTER(rider.id), undefined, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });
    const started = startedFrom(
      rider,
      officer,
      first,
      await pendingGrant(rider.id, 'RIDER_DEVICE_ENROLMENT'),
    );
    expect((await enrol(started)).status).toBe(200);

    const retried = await officer.client.post(REGISTER(rider.id), undefined, {
      origin: OPS,
      headers: { 'idempotency-key': key },
    });

    expect([retried.status, codeOf(retried)]).toEqual([409, 'STATE_CONFLICT']);
    expect(retried.text).not.toContain(started.token);
    expect(retried.text).not.toContain(started.challenge);
    const sealed = await rows<{ sealed: number }>(
      `select count(*)::int as sealed from idempotency_record where operation_id = 'registerRiderDevice' and sealed_ciphertext is not null`,
    );
    expect(sealed[0]?.sealed).toBe(0);
  });

  // Break caught: the rider's own status the only thing standing between a handset and a device (INACTIVE and TEMPORARILY_UNAVAILABLE are
  // availability states, set by hand, and a rider in either is still bound so that the handset is ready when the status is lifted).
  it.each(['INACTIVE', 'TEMPORARILY_UNAVAILABLE'] as const)(
    'binds a rider who is %s, as the officer could issue the grant',
    async (status) => {
      const started = await startFirstBinding({ status });

      expect((await enrol(started)).status).toBe(200);
      expect(await devicesOf(started.rider.id)).toHaveLength(1);
    },
  );
});

describe('completeRiderDeviceEnrolment: what the schema refuses (AC-SLICE-000-68, -111, -40)', () => {
  // Break caught: a request accepted without its evidence, with a member the contract has no place for (a private key above all), a chain
  // beyond its bound or a PIN of another shape; and a grant spent by a request that was never valid.
  it.each([
    ['no key_attestation (AC-68)', { key_attestation: undefined }],
    ['an empty chain', { key_attestation: { certificate_chain: [] } }],
    [
      'a chain of eleven',
      { key_attestation: { certificate_chain: Array.from({ length: 11 }, () => 'AAAA') } },
    ],
    [
      'a key_attestation with a member of its own',
      { key_attestation: { certificate_chain: ['AAAA'], extra: 1 } },
    ],
    ['a private key (the schema has no place for one)', { private_key: 'MIGH' }],
    ['a device identifier', { device_identifier: 'abc' }],
    ['a PIN of five digits', { pin: '12345' }],
    ['a PIN of seven digits', { pin: '1234567' }],
    ['a PIN that is not digits', { pin: '12a456' }],
    ['a PIN with a space', { pin: ' 12345' }],
    ['no PIN', { pin: undefined }],
    ['no key', { public_key: undefined }],
    ['a key of the wrong length', { public_key: 'AAAA' }],
    ['a key with a spare bit set', { public_key: `${deviceKey().publicKey.slice(0, 121)}B==` }],
  ])(
    'refuses %s with VALIDATION_FAILED, calls nobody and leaves the grant open',
    async (_label, overrides) => {
      const started = await startFirstBinding();

      const response = await enrol(started, overrides);

      expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      expect(verifier.calls).toEqual([]);
      expect(await devicesOf(started.rider.id)).toEqual([]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect((await riderOf(started.rider.id))?.credential_generation).toBe(0);
      // The grant is not spent: the same handset completes the same enrolment.
      expect((await enrol(started)).status).toBe(200);
    },
  );

  // Break caught: a key the pattern accepts and the crypto stack does not (a point that is not on the curve), enrolled because only its
  // spelling was looked at.
  it('refuses a key that is shaped right and is not a P-256 key, without calling the verifier', async () => {
    const started = await startFirstBinding();
    const der = Buffer.from(deviceKey().publicKey, 'base64');
    der[40] = (der[40] ?? 0) ^ 0xff;
    der[70] = (der[70] ?? 0) ^ 0xff;

    const response = await enrol(started, { public_key: der.toString('base64') });

    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(verifier.calls).toEqual([]);
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
  });

  it('is a native operation: it needs no Origin and takes no cookie or credential, and a request for another origin is no different', async () => {
    const started = await startFirstBinding();

    // A browser's Origin makes it no less an enrolment, and no cookie or bearer is looked at.
    const response = await routes.kit.client.fork().post(ENROL, bodyFor(started), {
      origin: OPS,
      headers: { authorization: 'Bearer nonsense' },
    });

    expect(response.status).toBe(200);
  });
});

describe('completeRiderDeviceEnrolment: a grant that cannot be used is refused before any evidence is read (AC-SLICE-000-67)', () => {
  // Break caught: evidence evaluated for a grant that is not usable (the verifier called, an event written about a device that was never at
  // issue), or one answer that tells which way a grant was unusable.
  it('refuses an unknown token, a malformed token and a token of another kind with one answer, calling nobody', async () => {
    const started = await startFirstBinding();

    const answers = await Promise.all(
      ['A'.repeat(43), 'not-a-token', ` ${started.token}`, started.challenge].map((token) =>
        enrol({ ...started, token }),
      ),
    );

    for (const answer of answers) {
      expect([answer.status, codeOf(answer)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    }
    expect(
      new Set(answers.map((answer) => answer.text.replace(/"request_id":"[^"]*"/, ''))).size,
    ).toBe(1);
    expect(verifier.calls).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
  });

  it.each([
    [
      'an expired grant',
      async (started: Started) => {
        await routes.admin.query(
          'alter table setup_grant disable trigger setup_grant_update_guard',
        );
        try {
          await routes.admin.query(
            `update setup_grant set issued_at = issued_at - interval '31 minutes', expires_at = expires_at - interval '31 minutes' where id = $1`,
            [started.grantId],
          );
        } finally {
          await routes.admin.query(
            'alter table setup_grant enable trigger setup_grant_update_guard',
          );
        }
      },
    ],
    [
      'a consumed grant',
      async (started: Started) => {
        expect((await enrol(started)).status).toBe(200);
        verifier.calls.length = 0;
      },
    ],
    [
      'a superseded grant',
      async (started: Started) => {
        const response = await started.officer.client.post(REGISTER(started.rider.id), undefined, {
          origin: OPS,
          headers: { 'idempotency-key': uuid() },
        });
        expect(response.status).toBe(200);
      },
    ],
  ])(
    'refuses %s with SETUP_GRANT_INVALID, and the attestation is not evaluated',
    async (_label, spoil) => {
      const started = await startFirstBinding();
      await spoil(started);

      const response = await enrol(started);

      expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
      expect(verifier.calls).toEqual([]);
      const events = await eventsOfRider(started.rider.id);
      expect(codesOf(events).filter((code) => code === 'auth.device.attestation_failed')).toEqual(
        [],
      );
    },
  );

  // Break caught: a rider whose access has ended given a device because the grant was issued before it ended.
  it.each(['SUSPENDED', 'OFFBOARDED'] as const)(
    'refuses a grant issued to a rider who has since become %s, calling nobody',
    async (status) => {
      const started = await startFirstBinding();
      await routes.admin.query(`update rider_identity set status = $2 where id = $1`, [
        started.rider.id,
        status,
      ]);

      const response = await enrol(started);

      expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
      expect(verifier.calls).toEqual([]);
      expect(await devicesOf(started.rider.id)).toEqual([]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
    },
  );
});

describe('completeRiderDeviceEnrolment: evidence the verifier rejected (AC-SLICE-000-61 to -66, -72, -75)', () => {
  // Break caught (AC-61): a handset below TrustedEnvironment enrolled, told the wrong thing, or leaving a device, a spent grant or a PIN.
  it('refuses a handset that cannot hold a hardware-backed key with DEVICE_SECURITY_UNSUPPORTED, and creates and consumes nothing', async () => {
    const started = await startFirstBinding();

    const response = await enrol(started, chainOf('UNSUPPORTED'));

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_SECURITY_UNSUPPORTED']);
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
    const rider = await riderOf(started.rider.id);
    expect([rider?.pin_hash, rider?.credential_generation]).toEqual([null, 0]);
    expect(await sessionsOf(started.rider.id)).toEqual([]);
    const failed = (await eventsOfRider(started.rider.id)).filter(
      (event) => event.event_code === 'auth.device.attestation_failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      enhanced: false,
      outcome: 'REJECTED',
      actor_type: 'RIDER',
      object_type: 'RiderIdentity',
      object_id: started.rider.id,
      responsible_hub_id: HUB_A,
      detail: { verdict: 'DEVICE_SECURITY_UNSUPPORTED', purpose: 'RIDER_DEVICE_ENROLMENT' },
    });
    expect(failed[0]?.detail).not.toHaveProperty('cause');
    expect(failed[0]?.related_ids).toEqual({
      principal_id: started.rider.id,
      setup_grant_id: started.grantId,
      authorised_by: started.officer.identity.id,
    });
  });

  // Break caught (AC-62 to -66): a failure class answered differently, the cause class lost from the ledger or told to the caller, a refusal
  // that leaves a device, a spent grant or a PIN, or evidence that cannot be tried again with the same grant.
  it.each(ATTESTATION_INTEGRITY_CAUSES.map((cause) => [cause] as const))(
    'refuses evidence that fails at %s with DEVICE_INTEGRITY_FAILED, records the cause class and creates and consumes nothing',
    async (cause) => {
      const started = await startFirstBinding();

      const response = await enrol(started, chainOf(`INTEGRITY:${cause}`));

      expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_INTEGRITY_FAILED']);
      // The caller is told the class of refusal and never the step that failed.
      expect(Object.keys(response.json() as object).toSorted()).toEqual([
        'code',
        'message',
        'request_id',
      ]);
      expect(response.text).not.toContain(cause);
      expect(await devicesOf(started.rider.id)).toEqual([]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect((await riderOf(started.rider.id))?.pin_hash).toBeNull();
      const failed = (await eventsOfRider(started.rider.id)).filter(
        (event) => event.event_code === 'auth.device.attestation_failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.detail).toMatchObject({ verdict: 'DEVICE_INTEGRITY_FAILED', cause });
      // The grant is still good for a handset that can be verified.
      expect((await enrol(started)).status).toBe(200);
    },
  );

  // Break caught (OBS: "repeated attempts show up as a rate"): a refusal that writes no event, or one event for many attempts.
  it('records one event for each refused attempt, so that a rate of them shows', async () => {
    const started = await startFirstBinding();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await enrol(started, chainOf('INTEGRITY:CHALLENGE_MISMATCH'))).status).toBe(422);
    }

    const failed = (await eventsOfRider(started.rider.id)).filter(
      (event) => event.event_code === 'auth.device.attestation_failed',
    );
    expect(failed).toHaveLength(3);
    expect(verifier.calls).toHaveLength(3);
  });

  // Break caught: the substitute's deterministic outcomes (AC-75) given a different answer on a second ask.
  it('gives the same answer to the same evidence every time (AC-75)', async () => {
    const started = await startFirstBinding();

    const answers = await Promise.all(
      [1, 2, 3].map(() => enrol(started, chainOf('INTEGRITY:KEY_MISMATCH'))),
    );

    expect(
      new Set(answers.map((answer) => `${String(answer.status)} ${String(codeOf(answer))}`)),
    ).toEqual(new Set(['422 DEVICE_INTEGRITY_FAILED']));
  });

  // Break caught: evidence that is not a directive of the substitute, a real chain included, accepted as if it had been understood.
  it('never lets the substitute wave through evidence it did not understand', async () => {
    const started = await startFirstBinding();

    const response = await enrol(started, {
      key_attestation: { certificate_chain: ['MIIB'.repeat(100)] },
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_INTEGRITY_FAILED']);
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect(
      (await eventsOfRider(started.rider.id)).find(
        (event) => event.event_code === 'auth.device.attestation_failed',
      )?.detail,
    ).toMatchObject({ cause: 'EVIDENCE_MALFORMED' });
  });
});

describe('completeRiderDeviceEnrolment: a verifier that cannot decide (AC-SLICE-000-69)', () => {
  // Break caught: an unavailable verifier read as a verdict about the device, a cause class told to the caller, a Retry-After missing, an event
  // written about a device nobody evaluated, or a grant spent by an enrolment that did not happen.
  it.each(ATTESTATION_UNAVAILABLE_CAUSES.map((cause) => [cause] as const))(
    'answers 503 TRUST_DATA_UNAVAILABLE with a Retry-After for %s, writes nothing and leaves the grant good',
    async (cause) => {
      const started = await startFirstBinding();
      const before = (await eventsOfRider(started.rider.id)).length;

      const response = await enrol(started, chainOf(`UNAVAILABLE:${cause}`));

      expect([response.status, codeOf(response)]).toEqual([503, 'TRUST_DATA_UNAVAILABLE']);
      expect(response.header('retry-after')).toBe('60');
      expect(response.text).not.toContain(cause);
      expect(response.text).not.toMatch(/INTEGRITY|UNSUPPORTED/);
      expect(await devicesOf(started.rider.id)).toEqual([]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect((await riderOf(started.rider.id))?.pin_hash).toBeNull();
      expect(await eventsOfRider(started.rider.id)).toHaveLength(before);
      // The cause is in the log and nowhere else; no secret goes with it.
      const log = routes.kit.app.logs.text();
      expect(log).toContain(cause);
      expect(log).not.toContain(started.token);
      // The same completion succeeds once the data is available.
      expect((await enrol(started)).status).toBe(200);
    },
  );

  // Break caught: the verifier asked in a transaction (a verifier that is slow holding a connection and a lock), seen as a rider's row locked
  // while the call is in flight.
  it('holds no transaction and no lock across the call to the verifier', async () => {
    const started = await startFirstBinding();
    const held = verifier.holdNext();

    const pending = enrol(started);
    await held.arrived;
    const idle = await rows<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and usename = 'melarc_api_runtime' and state = 'idle in transaction'`,
    );
    const locks = await rows<{ n: number }>(
      `select count(*)::int as n from pg_locks l
         join pg_class c on c.oid = l.relation
         join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.usename = 'melarc_api_runtime'
          and c.relname in ('rider_identity', 'setup_grant', 'registered_device')`,
    );
    held.release();
    const response = await pending;

    expect(idle[0]?.n).toBe(0);
    expect(locks[0]?.n).toBe(0);
    expect(response.status).toBe(200);
  });
});

describe('completeRiderDeviceEnrolment: a verifier that breaks its interface is a defect (SECURITY_DESIGN.md section 15.2.3)', () => {
  // Break caught: an answer that breaks the interface, or says VERIFIED for another key than the one asked about, read as a verdict on the
  // device (a 422 to a rider whose phone is fine) or enrolled (the attested key and the registered key not the same key).
  it.each([
    ['an answer the port does not know', 'BROKEN'],
    ['a VERIFIED for another key than the one it was asked about', 'VERIFIED_OTHER_KEY'],
  ])(
    'answers a 500 for %s, enrols nothing and writes no event about the device',
    async (_label, directive) => {
      const started = await startFirstBinding();
      const before = (await eventsOfRider(started.rider.id)).length;

      const response = await enrol(started, chainOf(directive));

      expect(response.status).toBe(500);
      // The platform's generic failure: it carries no code of the catalogue, and so no verdict about the device.
      expect(codeOf(response)).toBeUndefined();
      expect(await devicesOf(started.rider.id)).toEqual([]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect((await riderOf(started.rider.id))?.pin_hash).toBeNull();
      expect(await eventsOfRider(started.rider.id)).toHaveLength(before);
    },
  );
});

describe('completeRiderDeviceEnrolment: the replacement (AC-SLICE-000-71, -72, -74, -13)', () => {
  // Break caught (AC-71): the old device left ACTIVE, two ACTIVE at once, the session on the old device left live, the two events written apart
  // or not naming both devices, the old PIN left, or the officer missing.
  it('supersedes the old device atomically: old REPLACED, new ACTIVE, the session ended DEVICE_REPLACED, the PIN replaced, both events written', async () => {
    const { rider, device } = await riderWithDevice();
    const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: rider.id,
      registeredDeviceId: device.id,
    });
    await routes.admin.query(
      `update rider_identity set failed_attempt_count = 4, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [rider.id],
    );
    const started = await startReplacement(rider);
    const key = deviceKey();

    const response = await enrol(started, { public_key: key.publicKey, pin: NEW_PIN });

    expect(response.status).toBe(200);
    const created = (response.json() as { id: string }).id;
    expect(created).not.toBe(device.id);
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => [each.id, each.status])).toEqual([
      [device.id, 'REPLACED'],
      [created, 'ACTIVE'],
    ]);
    expect(devices[0]?.ended_at).not.toBeNull();
    expect(devices[1]).toMatchObject({
      public_key: key.publicKey,
      registered_by: started.officer.identity.id,
    });
    // Never two ACTIVE at once: the table's index is the last word, and the count is one.
    expect(devices.filter((each) => each.status === 'ACTIVE')).toHaveLength(1);
    expect(await grantState(started.grantId)).toMatchObject({ state: 'CONSUMED' });
    // The session of the old handset ended in the same act, with the reason.
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, termination_reason: 'DEVICE_REPLACED' }),
    ]);
    expect((await sessionsOf(rider.id))[0]?.terminated_at).not.toBeNull();
    // The new PIN replaced the old: its generation went up and its count and lock were cleared; the old one no longer verifies.
    const after = await riderOf(rider.id);
    expect(after?.credential_generation).toBe(2);
    expect(after?.failed_attempt_count).toBe(0);
    expect(after?.locked_until).toBeNull();
    expect((await hasher.verify('RIDER_PIN', NEW_PIN, after?.pin_hash ?? '')).matches).toBe(true);
    expect((await hasher.verify('RIDER_PIN', PIN, after?.pin_hash ?? '')).matches).toBe(false);

    const events = await eventsOfRider(rider.id);
    expect(codesOf(events)).toEqual([
      'auth.credential.changed',
      'auth.device.registered',
      'auth.device.replaced',
      'auth.session.terminated',
      'auth.setup_grant.consumed',
    ]);
    const registered = events.find((event) => event.event_code === 'auth.device.registered');
    expect(registered?.related_ids).toMatchObject({
      replaces_device_id: device.id,
      authorised_by: started.officer.identity.id,
    });
    // The new device has no state before it: what it replaced is the other event's object (`auth.device.replaced`), named here by id.
    expect(registered?.previous_state).toBeNull();
    const replaced = events.find((event) => event.event_code === 'auth.device.replaced');
    expect(replaced).toMatchObject({
      enhanced: true,
      object_type: 'RegisteredDevice',
      object_id: device.id,
      previous_state: 'ACTIVE',
      resulting_state: 'REPLACED',
      before_after: { status: { before: 'ACTIVE', after: 'REPLACED' } },
      detail: { sessions_ended: 1 },
    });
    expect(replaced?.related_ids).toEqual({
      principal_id: rider.id,
      new_device_id: created,
      setup_grant_id: started.grantId,
      authorised_by: started.officer.identity.id,
      ended_session_ids: [session.row.id],
    });
    expect(events.find((event) => event.event_code === 'auth.session.terminated')).toMatchObject({
      enhanced: false,
      reason_code: 'DEVICE_REPLACED',
      object_id: session.row.id,
    });
    expect(
      events.find((event) => event.event_code === 'auth.credential.changed')?.detail,
    ).toMatchObject({ cause: 'REPLACEMENT' });
  });

  // Break caught (AC-72): a replacement refused by the evidence that has already touched the old device, its session, its key or the grant.
  it.each([
    ['DEVICE_SECURITY_UNSUPPORTED', 'UNSUPPORTED'],
    ['DEVICE_INTEGRITY_FAILED', 'INTEGRITY:KEY_MISMATCH'],
  ])(
    'leaves the existing device exactly as it was when the new handset fails with %s',
    async (code, directive) => {
      const { rider, device } = await riderWithDevice();
      const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
        principalId: rider.id,
        registeredDeviceId: device.id,
      });
      const before = await riderOf(rider.id);
      const started = await startReplacement(rider);

      const response = await enrol(started, chainOf(directive));

      expect([response.status, codeOf(response)]).toEqual([422, code]);
      const devices = await devicesOf(rider.id);
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({ id: device.id, status: 'ACTIVE', ended_at: null });
      expect(devices[0]?.public_key).toBe(
        (
          await rows<{ public_key: string }>(
            `select public_key from registered_device where id = $1`,
            [device.id],
          )
        )[0]?.public_key,
      );
      expect(await sessionsOf(rider.id)).toEqual([
        expect.objectContaining({
          id: session.row.id,
          terminated_at: null,
          termination_reason: null,
        }),
      ]);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect(await riderOf(rider.id)).toEqual(before);
      expect(codesOf(await eventsOfRider(rider.id))).toEqual(['auth.device.attestation_failed']);
    },
  );

  // Break caught (AC-72, atomicity): a failure part-way (here the second event of the act) that leaves the old device ended, the session
  // ended, the new device in, the grant spent or the PIN changed.
  it('rolls the whole act back when anything in it fails, the old device included', async () => {
    const { rider, device } = await riderWithDevice();
    const session = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER', {
      principalId: rider.id,
      registeredDeviceId: device.id,
    });
    const before = await riderOf(rider.id);
    const started = await startReplacement(rider);
    await routes.admin.query(`
      create function public.zz_refuse_replaced() returns trigger language plpgsql as $$
      begin raise exception 'the event of the replacement is refused for the test'; end $$;
      create trigger zz_refuse_replaced before insert on audit_event
        for each row when (new.event_code = 'auth.device.replaced') execute function public.zz_refuse_replaced();`);
    let response: TestResponse;
    try {
      response = await enrol(started, { pin: NEW_PIN });
    } finally {
      await routes.admin.query(
        `drop trigger zz_refuse_replaced on audit_event; drop function public.zz_refuse_replaced();`,
      );
    }

    expect(response.status).toBe(500);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
    expect(await sessionsOf(rider.id)).toEqual([
      expect.objectContaining({ id: session.row.id, terminated_at: null }),
    ]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
    expect(await riderOf(rider.id)).toEqual(before);
    expect(codesOf(await eventsOfRider(rider.id))).toEqual([]);
    // With the fault gone the same grant completes.
    expect((await enrol(started, { pin: NEW_PIN })).status).toBe(200);
  });

  // Break caught (AC-74): a revoked device brought back or marked REPLACED, a replacement event written for a device that was not replaced.
  it('leaves a revoked device revoked through a replacement, and writes no replacement event', async () => {
    const { rider, device } = await riderWithDevice('REVOKED');
    const started = await startReplacement(rider);
    const [revokedBefore] = await devicesOf(rider.id);

    const response = await enrol(started, { pin: NEW_PIN });

    expect(response.status).toBe(200);
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => [each.id, each.status])).toEqual([
      [device.id, 'REVOKED'],
      [(response.json() as { id: string }).id, 'ACTIVE'],
    ]);
    expect(devices[0]?.ended_at).toEqual(revokedBefore?.ended_at);
    const events = await eventsOfRider(rider.id);
    expect(codesOf(events)).toEqual([
      'auth.credential.changed',
      'auth.device.registered',
      'auth.setup_grant.consumed',
    ]);
    expect(
      events.find((event) => event.event_code === 'auth.device.registered')?.related_ids,
    ).not.toHaveProperty('replaces_device_id');
    expect(
      events.find((event) => event.event_code === 'auth.device.registered')?.previous_state,
    ).toBeNull();
  });

  // Break caught (AC-13): a path by which a rider re-registers themselves: a handset binding a replacement with no grant an officer issued, a
  // request that can name the rider it is for, or an enhanced event that does not name the officer who authorised the binding.
  it('offers a rider no way to bind a replacement without the grant an officer issued in person', async () => {
    const { rider, device } = await riderWithDevice();
    const other = await startFirstBinding();

    // No grant, a made-up one, and a replacement attempted with the first-binding grant of another rider: none of them can name this rider,
    // because the request has no member to name one by, and a grant binds the rider it was issued to and no other.
    const none = await enrolBody(bodyFor({ token: 'B'.repeat(43) }));
    const named = await enrol(other, { principal_id: rider.id, rider_id: rider.id });
    const theirs = await enrol(other);

    expect(none.status).toBe(422);
    expect([named.status, codeOf(named)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(theirs.status).toBe(200);
    expect((await devicesOf(rider.id)).map((each) => [each.id, each.status])).toEqual([
      [device.id, 'ACTIVE'],
    ]);
    expect((await devicesOf(other.rider.id)).map((each) => each.status)).toEqual(['ACTIVE']);
    expect(
      (await eventsOfRider(other.rider.id)).find(
        (event) => event.event_code === 'auth.device.registered',
      ),
    ).toMatchObject({
      enhanced: true,
      related_ids: expect.objectContaining({ authorised_by: other.officer.identity.id }) as unknown,
    });
  });
});

describe('completeRiderDeviceEnrolment: one winner (AC-SLICE-000-73, -76)', () => {
  // Break caught (AC-73): a read-then-write consumption, so that two handsets both register, or the loser's key is the one that is stored.
  it('lets exactly one of two handsets complete one replacement grant, and refuses the other with SETUP_GRANT_INVALID', async () => {
    const { rider, device } = await riderWithDevice();
    const started = await startReplacement(rider);
    const first = deviceKey();
    const second = deviceKey();

    const [a, b] = await Promise.all([
      enrol(started, { public_key: first.publicKey, pin: PIN }),
      enrol(started, { public_key: second.publicKey, pin: NEW_PIN }),
    ]);
    const third = await enrol(started);

    expect([a.status, b.status].toSorted()).toEqual([200, 422]);
    const loser = a.status === 200 ? b : a;
    expect(codeOf(loser)).toBe('SETUP_GRANT_INVALID');
    expect([third.status, codeOf(third)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    const devices = await devicesOf(rider.id);
    expect(devices.map((each) => each.status)).toEqual(['REPLACED', 'ACTIVE']);
    expect(devices[0]?.id).toBe(device.id);
    const winnerKey = a.status === 200 ? first : second;
    const winnerPin = a.status === 200 ? PIN : NEW_PIN;
    const loserPin = a.status === 200 ? NEW_PIN : PIN;
    expect(devices[1]?.public_key).toBe(winnerKey.publicKey);
    const stored = await riderOf(rider.id);
    expect(stored?.credential_generation).toBe(2);
    expect((await hasher.verify('RIDER_PIN', winnerPin, stored?.pin_hash ?? '')).matches).toBe(
      true,
    );
    expect((await hasher.verify('RIDER_PIN', loserPin, stored?.pin_hash ?? '')).matches).toBe(
      false,
    );
    expect(
      codesOf(await eventsOfRider(rider.id)).filter((code) => code === 'auth.device.registered'),
    ).toHaveLength(1);
  });

  it('lets exactly one of two handsets complete one first-binding grant', async () => {
    const started = await startFirstBinding();

    const answers = await Promise.all([enrol(started), enrol(started)]);

    expect(answers.map((answer) => answer.status).toSorted()).toEqual([200, 422]);
    expect((await devicesOf(started.rider.id)).map((each) => each.status)).toEqual(['ACTIVE']);
  });

  // Break caught (AC-73): an older grant that still completes after a newer one was issued.
  it('lets only the latest of two grants of one purpose complete', async () => {
    const { rider } = await riderWithDevice();
    const older = await startReplacement(rider);
    const newer = await startReplacement(rider, older.officer);

    const refused = await enrol(older);
    const accepted = await enrol(newer);

    expect([refused.status, codeOf(refused)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(accepted.status).toBe(200);
    expect((await grantState(older.grantId)).state).toBe('SUPERSEDED');
    expect((await grantState(newer.grantId)).state).toBe('CONSUMED');
  });

  // Break caught: a completion that judged the grant before the verifier was asked and not again after, so that a grant consumed by another
  // handset while the first was being verified still wrote a second device.
  it('refuses a handset whose grant another handset consumed while its own evidence was being evaluated', async () => {
    const started = await startFirstBinding();
    const held = verifier.holdNext();
    const slow = enrol(started, { public_key: deviceKey().publicKey });
    await held.arrived;

    const quick = await enrol(started, { public_key: deviceKey().publicKey });
    held.release();
    const late = await slow;

    expect(quick.status).toBe(200);
    expect([late.status, codeOf(late)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(await devicesOf(started.rider.id)).toHaveLength(1);
    expect(
      (await eventsOfRider(started.rider.id)).filter(
        (event) => event.event_code === 'auth.device.attestation_failed',
      ),
    ).toEqual([]);
  });

  // Break caught: the rider's authority judged before the verifier and not under the lock after it.
  it('refuses a handset whose rider was suspended while its evidence was being evaluated', async () => {
    const started = await startFirstBinding();
    const held = verifier.holdNext();
    const slow = enrol(started);
    await held.arrived;

    await routes.admin.query(`update rider_identity set status = 'SUSPENDED' where id = $1`, [
      started.rider.id,
    ]);
    held.release();
    const late = await slow;

    expect([late.status, codeOf(late)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
    expect((await riderOf(started.rider.id))?.pin_hash).toBeNull();
  });

  // Break caught: the rider's devices counted before the verifier and not under the lock: a device registered some other way in between
  // would then be joined by a second, or a first-binding grant would bind a rider who holds one.
  it('refuses a first-binding grant once the rider holds an ACTIVE device, and never makes a second', async () => {
    const started = await startFirstBinding();
    const held = verifier.holdNext();
    const slow = enrol(started);
    await held.arrived;
    const intruder = await insertRiderDevice(routes.admin, started.rider.id);
    held.release();
    const late = await slow;

    expect([late.status, codeOf(late)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect((await devicesOf(started.rider.id)).map((each) => [each.id, each.status])).toEqual([
      [intruder.id, 'ACTIVE'],
    ]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
  });
});

describe('completeRiderDeviceEnrolment: what changed before the act is read again under the lock', () => {
  // Break caught: a look that judges the grant and not the rider's devices, so that evidence is evaluated for a first binding the rider
  // can no longer take (the grant outlived the state it assumes).
  it('spares the verifier a first-binding grant whose rider already holds an ACTIVE device', async () => {
    const started = await startFirstBinding();
    const held = await insertRiderDevice(routes.admin, started.rider.id);

    const response = await enrol(started);

    expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(verifier.calls).toEqual([]);
    expect((await devicesOf(started.rider.id)).map((each) => [each.id, each.status])).toEqual([
      [held.id, 'ACTIVE'],
    ]);
  });

  // The same, for a replacement grant of a rider who holds no device that is ACTIVE or REVOKED (only REPLACED ones, which cannot be, but a
  // grant is judged against the state it assumes and not against what the officer's screen could produce).
  it('spares the verifier a replacement grant whose rider holds no ACTIVE or REVOKED device', async () => {
    const { rider, device } = await riderWithDevice();
    const started = await startReplacement(rider);
    await routes.admin.query(
      'alter table registered_device disable trigger registered_device_guard',
    );
    try {
      await routes.admin.query(
        `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
        [device.id],
      );
    } finally {
      await routes.admin.query(
        'alter table registered_device enable trigger registered_device_guard',
      );
    }

    const response = await enrol(started);

    expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(verifier.calls).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
  });

  // Break caught: a refusal of evidence recorded against a grant that another handset has consumed meanwhile (an event about an enrolment that
  // can no longer be made), or the late handset told about its evidence when what it holds is a grant that is spent.
  it('answers SETUP_GRANT_INVALID, and records nothing, to a handset with bad evidence whose grant was consumed while it was evaluated', async () => {
    const started = await startFirstBinding();
    const held = verifier.holdNext();
    const slow = enrol(started, chainOf('INTEGRITY:SIGNER_NOT_APPROVED'));
    await held.arrived;

    expect((await enrol(started)).status).toBe(200);
    held.release();
    const late = await slow;

    expect([late.status, codeOf(late)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(
      (await eventsOfRider(started.rider.id)).filter(
        (event) => event.event_code === 'auth.device.attestation_failed',
      ),
    ).toEqual([]);
    expect(await devicesOf(started.rider.id)).toHaveLength(1);
  });

  // Break caught (the audit of 21 October 2026, A06, for this operation): a grant that lapsed while the act waited for its lock, and the
  // table's own guard refused to consume it, answered as a server error; or any other refusal of the guard mistaken for that lapse.
  it('answers a grant the guard finds lapsed after the wait as an invalid grant, and changes nothing', async () => {
    const started = await startFirstBinding();
    const query = async (statement: string) =>
      (await routes.admin.query<Record<string, unknown>>(statement)).rows;
    const lapsed = await refuseConsumption(query, 'setup_grant', 'reason=GRANT_EXPIRED');
    try {
      const response = await enrol(started);

      expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
      expect(await lapsed.hits()).toBe(1);
    } finally {
      await lapsed.remove();
    }
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
    expect((await riderOf(started.rider.id))?.pin_hash).toBeNull();
    const other = await refuseConsumption(query, 'setup_grant', null);
    try {
      expect((await enrol(started)).status).toBe(500);
    } finally {
      await other.remove();
    }
    expect(await devicesOf(started.rider.id)).toEqual([]);
    expect((await grantState(started.grantId)).state).toBe('PENDING');
    // With nothing in the way the same grant completes.
    expect((await enrol(started)).status).toBe(200);
  });
});

describe('the limits in front of completeRiderDeviceEnrolment (AC-SLICE-000-125)', () => {
  // Break caught: a key that is the token itself, is not qualified by the operation, or is taken only when the token resolves (an invented
  // token buys a fresh key).
  it('counts each presented token under a key of its own, a made-up one included, and refuses the eleventh in a minute', async () => {
    const started = await startFirstBinding();
    const made = 'C'.repeat(43);

    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await enrol({ ...started, token: made })).status).toBe(422);
    }
    const refused = await enrol({ ...started, token: made });

    expect([refused.status, codeOf(refused)]).toEqual([429, 'RATE_LIMITED']);
    expect(refused.header('retry-after')).toBeNull();
    // Another value has a key of its own, and the real grant is untouched by the count of an invented one.
    expect((await enrol({ ...started, token: 'D'.repeat(43) })).status).toBe(422);
    expect((await enrol(started)).status).toBe(200);
    // The limiter stores a pseudonym, never the token.
    const stored = await rows<{ n: number }>(
      `select count(*)::int as n from rate_limit_admission where position(convert_to($1::text, 'UTF8') in key_digest) > 0`,
      [made],
    );
    expect(stored[0]?.n ?? 0).toBe(0);
  });

  // Break caught: hashing before the grant is judged (a made-up token would cost a hash), or a full set of slots turned into a refusal of a
  // request that needs no hash, or a grant spent by a request that was refused for want of a slot.
  it('answers a made-up token and a refused handset without a hash when every slot is taken, and a verified one RATE_LIMITED without consuming the grant', async () => {
    const admission = routes.kit.app.app.get<HashAdmission>(HASH_ADMISSION, { strict: false });
    const started = await startFirstBinding();
    const held: HashSlot[] = [];
    for (let slot = admission.tryAdmit(); slot !== null; slot = admission.tryAdmit())
      held.push(slot);
    try {
      const unknown = await enrol({ ...started, token: 'E'.repeat(43) });
      const refusedHandset = await enrol(started, chainOf('UNSUPPORTED'));
      const verified = await enrol(started);

      expect(unknown.status).toBe(422);
      expect([refusedHandset.status, codeOf(refusedHandset)]).toEqual([
        422,
        'DEVICE_SECURITY_UNSUPPORTED',
      ]);
      expect([verified.status, codeOf(verified)]).toEqual([429, 'RATE_LIMITED']);
      expect((await grantState(started.grantId)).state).toBe('PENDING');
      expect(await devicesOf(started.rider.id)).toEqual([]);
    } finally {
      for (const slot of held) slot.release();
    }
    // The slots are back, and the same grant now works.
    expect((await enrol(started)).status).toBe(200);
  });
});

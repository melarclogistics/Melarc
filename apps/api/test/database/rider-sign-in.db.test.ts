import { createHash, randomBytes } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  HASH_ADMISSION,
  type HashAdmission,
  type HashSlot,
} from '../../src/platform/auth/ports/hash-admission.port.js';
import { Argon2Hasher } from '../../src/platform/auth/crypto/argon2.hasher.adapter.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import { phoneBinding } from '../../src/platform/auth/rider/rider-challenge-binding.js';
import { RIDER_SIGN_IN_SERVICE } from '../../src/platform/auth/rider/rider-sign-in-providers.js';
import type { RiderSignInService } from '../../src/platform/auth/rider/rider-sign-in.service.js';
import type { AppConfig } from '../../src/platform/config/load-config.js';
import { ApiException } from '../../src/platform/http/api-exception.js';
import { APP_CONFIG } from '../../src/platform/platform.tokens.js';
import { sameShape } from '../../src/test-support/work-shape.js';
import { deviceKey } from './support/riders.js';
import {
  PIN,
  SESSION_URL,
  SIGN_IN_URL,
  WRONG_PIN,
  anotherDevice,
  attempt,
  challengeOf,
  enrolledRider,
  freshChallenge,
  native,
  nonceHashOf,
  post,
  requestChallenge,
  signChallenge,
  type Enrolled,
} from './support/rider-sign-in.js';
import { codeOf, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';

/**
 * S0.59b and S0.59c, `riderSignIn` against the real application and a real PostgreSQL (`AC-SLICE-000-08` to `-11`, `-38`, `-47` to `-53`, `-56` to
 * `-59`, `-109` to `-111`; rider-authentication.md sections 4.1, 5.1, 5.3 and 5.5; SECURITY_DESIGN.md sections 13.4b and 13.6): the phone, the PIN and
 * the registered device's signature over a fresh challenge, decided in the order the contract fixes. Every request goes through HTTP as the native app
 * sends it; the signatures are made in this file from the protocol's published words, and what the application did is read from a second connection.
 */
/** An older cost than the write profile's (65536 KiB, 2 passes), accepted by the application's configuration. */
const OLDER_COST = '8192:2:1';

let routes: StaffRoutes;
let hasher: Hasher;

beforeAll(async () => {
  // Three slots, the most the thread pool of the process allows (one thread is reserved): the races of this file present up to three requests at
  // once, and a request with no slot is RATE_LIMITED (which another test holds).
  routes = await startStaffRoutes({
    // One older cost is accepted, so that a PIN hash made at it is verified and then replaced (OB-39).
    env: { HASH_ADMISSION_SLOTS: '3', ARGON2_ACCEPTED_PROFILES: OLDER_COST },
  });
  hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

const credentialOf = async (riderId: string) =>
  (
    await rows<{
      failed_attempt_count: number;
      locked_until: Date | null;
      credential_generation: string;
    }>(
      'select failed_attempt_count, locked_until, credential_generation::text from rider_identity where id = $1',
      [riderId],
    )
  )[0];

interface SessionRow {
  id: string;
  terminated_at: Date | null;
  termination_reason: string | null;
  registered_device_id: string;
  client_root_signal: string;
  policy_revision: number;
  issued_at: Date;
  expires_at: Date;
  token_hash: Buffer;
  authorized_hub_ids: string[];
}

const sessionsOf = (riderId: string) =>
  rows<SessionRow>(
    `select id::text, terminated_at, termination_reason, registered_device_id::text, client_root_signal, policy_revision,
            issued_at, expires_at, token_hash, authorized_hub_ids::text[] as authorized_hub_ids
       from session where principal_type = 'RIDER' and principal_id = $1 order by issued_at, id`,
    [riderId],
  );

interface EventRow {
  event_code: string;
  outcome: string;
  enhanced: boolean;
  actor_type: string;
  actor_id: string | null;
  object_type: string;
  object_id: string | null;
  detail: Record<string, unknown>;
  related_ids: Record<string, unknown> | null;
  device_context: Record<string, unknown> | null;
  reason_code: string | null;
}

const eventsFor = (riderId: string, ...codes: string[]) =>
  rows<EventRow>(
    `select event_code, outcome, enhanced, actor_type, actor_id::text, object_type, object_id::text, detail, related_ids, device_context, reason_code
       from audit_event
      where ($2::text[] = '{}' or event_code = any($2::text[]))
        and (object_id = $1::uuid or related_ids->>'principal_id' = $1::text or actor_id = $1::uuid)
      order by recorded_at, id`,
    [riderId, `{${codes.join(',')}}`],
  );

const failuresOf = async (riderId: string) =>
  (await eventsFor(riderId, 'auth.session.failed')).map((event) => event.detail);

const challengeState = async (challenge: string): Promise<string | undefined> =>
  (
    await rows<{ state: string }>(
      'select state from rider_sign_in_challenge where nonce_hash = $1',
      [nonceHashOf(challenge)],
    )
  )[0]?.state;

/** The time of a challenge moved into the past, as the clock would have: the guard that keeps a challenge's lifetime is stood aside for it. */
async function age(challenge: string): Promise<void> {
  await routes.admin.query(
    'alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard',
  );
  try {
    await routes.admin.query(
      `update rider_sign_in_challenge set issued_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
        where nonce_hash = $1`,
      [nonceHashOf(challenge)],
    );
  } finally {
    await routes.admin.query(
      'alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard',
    );
  }
}

const subjectOf = (enrolled: Enrolled) => ({
  phone: enrolled.rider.phone,
  pin: enrolled.pin,
  ...(enrolled.device === null ? {} : { key: enrolled.device.key.privateKey }),
});

const answer = (response: { status: number; json: () => unknown }) => ({
  status: response.status,
  body: stripRequestId(response.json()),
});

function stripRequestId(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body;
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.request_id;
  return rest;
}

describe('a sign-in that succeeds (AC-SLICE-000-08, -47, -56, -58)', () => {
  // Break caught: a session not bound to the device, a credential returned twice or kept in clear, a cookie set for a native client, a response
  // that can be cached, or an authority the rider's bundle does not hold.
  it('issues a session bound to the registered device and answers the bearer credential once, no-store and with no cookie', async () => {
    const subject = await enrolledRider(routes, hasher);

    const { response, challenge } = await attempt(routes, subjectOf(subject), {
      client_root_signal: 'NOT_DETECTED',
    });

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    expect(response.setCookies).toEqual([]);
    const body = response.json() as {
      session: Record<string, unknown>;
      access_token: string;
      token_type: string;
    };
    expect(Object.keys(body).toSorted()).toEqual(['access_token', 'session', 'token_type']);
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.session).toMatchObject({
      principal_type: 'RIDER',
      principal_id: subject.rider.id,
      state: 'ACTIVE',
      authorized_hub_ids: [subject.rider.hubId],
      principal_display_name: subject.rider.fullName,
    });
    expect(JSON.stringify(body.session)).not.toContain(body.access_token);

    const [stored, ...others] = await sessionsOf(subject.rider.id);
    expect(others).toEqual([]);
    expect(stored).toMatchObject({
      terminated_at: null,
      registered_device_id: subject.device?.id,
      client_root_signal: 'NOT_DETECTED',
      policy_revision: 1,
      authorized_hub_ids: [subject.rider.hubId],
    });
    expect(stored?.id).toBe((body.session as { id: string }).id);
    // Only the hash of the credential is kept, and the lifetime is the rider tier's.
    expect(
      stored?.token_hash.equals(
        createHash('sha256').update(Buffer.from(body.access_token, 'base64url')).digest(),
      ),
    ).toBe(true);
    const lifetime = (
      await rows<{ value: { rider: number } }>(
        `select value from setting where key = 'session_lifetime_minutes'`,
      )
    )[0]?.value.rider;
    expect((stored?.expires_at.getTime() ?? 0) - (stored?.issued_at.getTime() ?? 0)).toBe(
      (lifetime ?? 0) * 60_000,
    );
    // The permission keys are the rider bundle's and nothing else.
    const held = (
      await rows<{ permission_key: string }>(
        `select g.permission_key from role_bundle_grant g join role_bundle b on b.id = g.bundle_id where b.audience = 'RIDER'`,
      )
    ).map((grant) => grant.permission_key);
    expect(new Set((body.session.permissions ?? []) as string[])).toEqual(new Set(held));
    // The challenge is spent, the count is as it was, and the credential works as a bearer.
    expect(await challengeState(challenge)).toBe('CONSUMED');
    expect(await credentialOf(subject.rider.id)).toMatchObject({
      failed_attempt_count: 0,
      locked_until: null,
    });
    const read = await native(routes).bearer(body.access_token).get(SESSION_URL);
    expect(read.status).toBe(200);
    expect((read.json() as { id: string }).id).toBe(stored?.id);
  });

  // Break caught (audit.md 5.4): an issue event that does not name the device or the root signal, one that holds the PIN, the signature, the
  // nonce or the token, or a failure event written for a success.
  it('records auth.session.issued with the device and the root signal, and holds no PIN, signature, nonce or token anywhere', async () => {
    const subject = await enrolledRider(routes, hasher);
    const { response, challenge } = await attempt(routes, subjectOf(subject), {
      client_root_signal: 'UNKNOWN',
    });
    expect(response.status).toBe(200);
    const token = (response.json() as { access_token: string }).access_token;

    const events = await eventsFor(subject.rider.id);

    const issued = events.filter((event) => event.event_code === 'auth.session.issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      outcome: 'SUCCEEDED',
      actor_type: 'RIDER',
      actor_id: subject.rider.id,
      object_type: 'Session',
      device_context: { registered_device_id: subject.device?.id },
      detail: { client_root_signal: 'UNKNOWN' },
    });
    expect(events.filter((event) => event.event_code === 'auth.session.failed')).toEqual([]);
    const everything = JSON.stringify(
      (await rows<Record<string, unknown>>('select * from audit_event')).map((each) =>
        JSON.stringify(each),
      ),
    );
    for (const secret of [
      subject.pin,
      token,
      challenge,
      Buffer.from(challenge, 'base64url').toString('base64'),
      subject.rider.phone,
    ]) {
      expect(everything).not.toContain(secret);
    }
  });

  // Break caught (AC-56, -58): a root signal that blocks, delays or rewrites sign-in, or one converted to another value.
  it.each(['DETECTED', 'UNKNOWN', 'NOT_DETECTED'] as const)(
    'signs in with the root signal %s and records exactly that value',
    async (signal) => {
      const subject = await enrolledRider(routes, hasher);

      const { response } = await attempt(routes, subjectOf(subject), {
        client_root_signal: signal,
      });

      expect(response.status).toBe(200);
      expect((await sessionsOf(subject.rider.id))[0]?.client_root_signal).toBe(signal);
    },
  );

  // Break caught (AC-47): a field, a header or a check that refers to where the app was installed from.
  it('has no field, header or check about how the app was installed', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    const body = {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    };

    const stray = await post(routes, { ...body, installer_package: 'com.android.vending' });
    const bare = await post(routes, body);

    // The closed body has no such field; the same body without it signs in, whatever the headers say.
    expect([stray.status, codeOf(stray)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(bare.status).toBe(200);
  });
});

describe('the challenge is judged first, and any presentation ends it (AC-SLICE-000-52, -53)', () => {
  // Break caught: a nonce that survives a presentation (a replayed request signs in twice), pass or fail, or a replay answered as anything but
  // "this challenge is finished".
  it('refuses a replay of a request that succeeded, and of one that failed, as CHALLENGE_UNUSABLE', async () => {
    const subject = await enrolledRider(routes, hasher);

    const first = await attempt(routes, subjectOf(subject));
    const replay = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: first.challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        first.challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });
    const failed = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });
    const afterFailure = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: failed.challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        failed.challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect(first.response.status).toBe(200);
    expect([replay.status, codeOf(replay)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect([failed.response.status, codeOf(failed.response)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect([afterFailure.status, codeOf(afterFailure)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(await sessionsOf(subject.rider.id)).toHaveLength(1);
  });

  it('refuses a challenge nobody issued as CHALLENGE_UNUSABLE', async () => {
    const subject = await enrolledRider(routes, hasher);
    const unknown = randomBytes(32).toString('base64url');

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: unknown,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        unknown,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    const [event] = await failuresOf(subject.rider.id);
    expect(event).toMatchObject({ cause: 'CHALLENGE_UNUSABLE', factor: 'NONE' });
  });

  // Break caught (AC-53): an expired challenge accepted, or reported as unusable ("start again" is the whole of the difference), or left PENDING.
  it('refuses a challenge past its time as CHALLENGE_EXPIRED, marks it so, and a fresh one then works', async () => {
    const subject = await enrolledRider(routes, hasher);
    const requested = await freshChallenge(routes, subject.rider.phone);
    await age(requested);

    const late = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: requested,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        requested,
      ),
      client_root_signal: 'NOT_DETECTED',
    });
    const again = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: requested,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        requested,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([late.status, codeOf(late)]).toEqual([422, 'CHALLENGE_EXPIRED']);
    expect(await challengeState(requested)).toBe('EXPIRED');
    // An expired challenge stays expired: a second presentation is told so again, and nothing was counted.
    expect([again.status, codeOf(again)]).toEqual([422, 'CHALLENGE_EXPIRED']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
    expect((await attempt(routes, subjectOf(subject))).response.status).toBe(200);
  });

  // Break caught: an expiry checked after the signature (a bad signature on an expired challenge answered as a bad signature) or a challenge
  // judged after the rider is looked up.
  it('judges the challenge before the signature and the PIN: an expired challenge with a bad signature is expired', async () => {
    const subject = await enrolledRider(routes, hasher);
    const requested = await freshChallenge(routes, subject.rider.phone);
    await age(requested);

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: WRONG_PIN,
      challenge: requested,
      device_signature: signChallenge(deviceKey().privateKey, requested),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_EXPIRED']);
  });

  // Break caught (SECURITY_DESIGN 13.4b: "bound to the phone number it was issued for … CHALLENGE_UNUSABLE for every number alike"): a challenge
  // carried to another number that is accepted, that tells a rider's number from a stranger's, or that survives the attempt.
  it('refuses a challenge presented with another number as CHALLENGE_UNUSABLE for every number alike, and ends it', async () => {
    const owner = await enrolledRider(routes, hasher);
    const other = await enrolledRider(routes, hasher);
    const nobody = '+99955500101';
    const challenge = await freshChallenge(routes, owner.rider.phone);
    const signed = signChallenge(owner.device?.key.privateKey ?? deviceKey().privateKey, challenge);
    const presented = async (phone: string, pin: string) =>
      post(routes, {
        phone,
        pin,
        challenge,
        device_signature: signed,
        client_root_signal: 'NOT_DETECTED',
      });

    const withOther = await presented(other.rider.phone, other.pin);
    const stillPending = await challengeState(challenge);
    // It is finished by the first wrong presentation: the right number is told the same afterwards.
    const withOwner = await presented(owner.rider.phone, owner.pin);

    expect([withOther.status, codeOf(withOther)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(stillPending).toBe('UNUSABLE');
    expect([withOwner.status, codeOf(withOwner)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(answer(await presented(nobody, PIN))).toEqual(answer(withOther));
    expect(await sessionsOf(owner.rider.id)).toEqual([]);
    expect(await sessionsOf(other.rider.id)).toEqual([]);
  });

  // Break caught: a challenge issued by another environment or service accepted (the audience is part of what it is bound to).
  it('refuses a challenge issued for another service as CHALLENGE_UNUSABLE', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    await routes.admin.query(
      'alter table rider_sign_in_challenge disable trigger rider_sign_in_challenge_update_guard',
    );
    await routes.admin.query(
      `update rider_sign_in_challenge set audience = 'melarc-api/production' where nonce_hash = $1`,
      [nonceHashOf(challenge)],
    );
    await routes.admin.query(
      'alter table rider_sign_in_challenge enable trigger rider_sign_in_challenge_update_guard',
    );

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
  });

  // Break caught (SECURITY_DESIGN 13.6: "sign-in and enrolment challenge namespaces stay separate"): the challenge of an enrolment grant
  // accepted as a sign-in challenge.
  it('knows nothing of the challenge of an enrolment grant', async () => {
    const subject = await enrolledRider(routes, hasher);
    const [grant] = await rows<{ attestation_challenge_hash: Buffer }>(
      `select attestation_challenge_hash from setup_grant where attestation_challenge_hash is not null limit 1`,
    );
    // A grant exists only after an officer started a binding; with none in this database the namespace is empty and so a made-up one is unknown.
    const enrolmentChallenge = randomBytes(32).toString('base64url');

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge: enrolmentChallenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        enrolmentChallenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(grant === undefined || grant.attestation_challenge_hash.length === 32).toBe(true);
  });

  // Break caught: a challenge issued before a handset replaced the rider's device used with the replacement (the device context is bound).
  it('refuses a valid signature of the replacement over a challenge issued for the replaced handset as DEVICE_PROOF_INVALID', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    await routes.admin.query(
      `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
      [subject.device?.id],
    );
    const replacement = await anotherDevice(routes, subject.rider.id);

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(replacement.key.privateKey, challenge),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });
});

describe('the signature is decided before the PIN is looked at (AC-SLICE-000-38, -50, -57, -110)', () => {
  // Break caught: a PIN examined, or a failure counted, for a caller who cannot sign; the attacker who knows a phone and a PIN locking the rider
  // out or guessing the PIN; CREDENTIAL_LOCKED told to a request with no valid signature.
  it('refuses any number of signatures that do not verify as DEVICE_PROOF_INVALID, counts nothing, locks nothing, and the handset still signs in', async () => {
    const subject = await enrolledRider(routes, hasher);
    const verify = vi.spyOn(hasher, 'verify');

    const answers: [number, string | undefined][] = [];
    for (let index = 0; index < 8; index += 1) {
      const { response } = await attempt(routes, {
        phone: subject.rider.phone,
        pin: index % 2 === 0 ? subject.pin : WRONG_PIN,
      });
      answers.push([response.status, codeOf(response)]);
    }

    expect(answers).toEqual(Array.from({ length: 8 }, () => [422, 'DEVICE_PROOF_INVALID']));
    // The PIN is not examined: no verification against the stored hash was made for any of the eight.
    expect(verify).not.toHaveBeenCalled();
    expect(await credentialOf(subject.rider.id)).toMatchObject({
      failed_attempt_count: 0,
      locked_until: null,
    });
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    vi.restoreAllMocks();
    expect((await attempt(routes, subjectOf(subject))).response.status).toBe(200);
  });

  // Break caught (audit.md 5.4): a failed signature recorded once only, or without the device, or with the signature in it.
  it('records each failed signature as auth.session.failed and auth.device.proof_failed, once each, and neither holds a signature', async () => {
    const subject = await enrolledRider(routes, hasher);
    const { response, challenge } = await attempt(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
    });
    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);

    const events = await eventsFor(
      subject.rider.id,
      'auth.session.failed',
      'auth.device.proof_failed',
    );

    expect(events.map((event) => event.event_code).toSorted()).toEqual([
      'auth.device.proof_failed',
      'auth.session.failed',
    ]);
    const failed = events.find((event) => event.event_code === 'auth.session.failed');
    expect(failed).toMatchObject({
      outcome: 'REJECTED',
      object_type: 'RiderIdentity',
      object_id: subject.rider.id,
      detail: { cause: 'DEVICE_PROOF_INVALID', factor: 'NONE' },
    });
    const proof = events.find((event) => event.event_code === 'auth.device.proof_failed');
    expect(proof).toMatchObject({
      outcome: 'REJECTED',
      enhanced: false,
      object_type: 'RegisteredDevice',
      object_id: subject.device?.id,
      related_ids: { principal_id: subject.rider.id },
    });
    expect(JSON.stringify(events)).not.toContain(challenge);
    expect(await challengeState(challenge)).toBe('CONSUMED');
  });

  // Break caught (AC-50): another rider's handset able to sign in as this rider, or a session issued to either.
  it('refuses the phone and PIN of one rider with the signature of another rider’s handset', async () => {
    const first = await enrolledRider(routes, hasher);
    const second = await enrolledRider(routes, hasher);

    const { response } = await attempt(routes, {
      phone: first.rider.phone,
      pin: first.pin,
      key: second.device?.key.privateKey ?? deviceKey().privateKey,
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect(await sessionsOf(first.rider.id)).toEqual([]);
    expect(await sessionsOf(second.rider.id)).toEqual([]);
  });

  // Break caught (AC-57): a check skipped or relaxed because the app says the device is not rooted.
  it.each(['NOT_DETECTED', 'DETECTED', 'UNKNOWN'] as const)(
    'refuses a signature that does not verify whatever the root signal says (%s)',
    async (signal) => {
      const subject = await enrolledRider(routes, hasher);

      const { response } = await attempt(
        routes,
        { phone: subject.rider.phone, pin: subject.pin },
        { client_root_signal: signal },
      );

      expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
      expect(await sessionsOf(subject.rider.id)).toEqual([]);
    },
  );

  // Break caught (SECURITY_DESIGN 13.6, the published vectors): a verifier that accepts a signature of another message, another form or another
  // hashing: a double hash, the IEEE P1363 form, a signature of the challenge without its prefix, a signature made for another challenge.
  it('accepts only the signature of the protocol: a double hash, a raw signature, an unprefixed or another challenge’s are DEVICE_PROOF_INVALID', async () => {
    const subject = await enrolledRider(routes, hasher);
    const key = subject.device?.key.privateKey ?? deviceKey().privateKey;
    const { sign, createHash: hash } = await import('node:crypto');
    const forms: Record<string, (challenge: string, other: string) => string> = {
      'a prehashed message': (challenge) =>
        sign(
          'sha256',
          hash('sha256')
            .update(Buffer.from(`MELARC-RIDER-SIGNIN-V1\n${challenge}`))
            .digest(),
          {
            key,
            dsaEncoding: 'der',
          },
        ).toString('base64'),
      'the IEEE P1363 form': (challenge) =>
        sign('sha256', Buffer.from(`MELARC-RIDER-SIGNIN-V1\n${challenge}`), {
          key,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64'),
      'the challenge without the prefix': (challenge) =>
        sign('sha256', Buffer.from(challenge), { key, dsaEncoding: 'der' }).toString('base64'),
      'a changed prefix': (challenge) =>
        sign('sha256', Buffer.from(`MELARC-RIDER-SIGNIN-V2\n${challenge}`), {
          key,
          dsaEncoding: 'der',
        }).toString('base64'),
      'a trailing newline': (challenge) =>
        sign('sha256', Buffer.from(`MELARC-RIDER-SIGNIN-V1\n${challenge}\n`), {
          key,
          dsaEncoding: 'der',
        }).toString('base64'),
      'a space for the separator': (challenge) =>
        sign('sha256', Buffer.from(`MELARC-RIDER-SIGNIN-V1 ${challenge}`), {
          key,
          dsaEncoding: 'der',
        }).toString('base64'),
      'another challenge': (_challenge, other) => signChallenge(key, other),
    };

    for (const [name, make] of Object.entries(forms)) {
      const challenge = await freshChallenge(routes, subject.rider.phone);
      const response = await post(routes, {
        phone: subject.rider.phone,
        pin: subject.pin,
        challenge,
        device_signature: make(challenge, randomBytes(32).toString('base64url')),
        client_root_signal: 'NOT_DETECTED',
      });
      expect([response.status, codeOf(response)], name).toEqual([422, 'DEVICE_PROOF_INVALID']);
    }
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });

  // Break caught (AC-49): a replaced handset still able to sign in, or its record deleted instead of kept.
  it('refuses the old handset of a replaced device as DEVICE_PROOF_INVALID, and keeps its record as REPLACED', async () => {
    const subject = await enrolledRider(routes, hasher);
    await routes.admin.query(
      `update registered_device set status = 'REPLACED', ended_at = clock_timestamp() where id = $1`,
      [subject.device?.id],
    );
    const replacement = await anotherDevice(routes, subject.rider.id);

    const old = await attempt(routes, subjectOf(subject));
    const current = await attempt(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      key: replacement.key.privateKey,
    });

    expect([old.response.status, codeOf(old.response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect(current.response.status).toBe(200);
    const devices = await rows<{ id: string; status: string }>(
      'select id::text, status from registered_device where rider_identity_id = $1 order by registered_at, id',
      [subject.rider.id],
    );
    expect(devices.map((device) => device.status).toSorted()).toEqual(['ACTIVE', 'REPLACED']);
    expect((await sessionsOf(subject.rider.id))[0]?.registered_device_id).toBe(replacement.id);
  });

  // Break caught (AC-48): a revoked device that signs in, or is told the rider has nothing to enrol (only the PIN's holder is told).
  it('tells a rider whose device was revoked and who has not been re-registered DEVICE_NOT_ENROLLED for the right PIN and nothing else for a wrong one', async () => {
    const subject = await enrolledRider(routes, hasher, { device: 'REVOKED' });
    const key = subject.device?.key.privateKey ?? deviceKey().privateKey;

    const right = await attempt(routes, { phone: subject.rider.phone, pin: subject.pin, key });
    const wrong = await attempt(routes, { phone: subject.rider.phone, pin: WRONG_PIN, key });
    const badKeyRight = await attempt(routes, { phone: subject.rider.phone, pin: subject.pin });

    expect([right.response.status, codeOf(right.response)]).toEqual([422, 'DEVICE_NOT_ENROLLED']);
    expect([wrong.response.status, codeOf(wrong.response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect([badKeyRight.response.status, codeOf(badKeyRight.response)]).toEqual([
      422,
      'DEVICE_NOT_ENROLLED',
    ]);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect(await credentialOf(subject.rider.id)).toMatchObject({
      failed_attempt_count: 0,
      locked_until: null,
    });
    const causes = (await failuresOf(subject.rider.id)).map((detail) => [
      detail.cause,
      detail.factor,
    ]);
    expect(causes).toEqual([
      ['NO_ACTIVE_DEVICE', 'PIN'],
      ['NO_ACTIVE_DEVICE', 'NONE'],
      ['NO_ACTIVE_DEVICE', 'PIN'],
    ]);
  });

  // Break caught (AC-09): an answer, a status or a statement that tells an unknown number from a rider who never enrolled from one whose only
  // device was revoked, or a count, or a session left as a fallback.
  it('answers an unknown number, a rider who never enrolled and a rider whose only device was revoked alike, counting nothing', async () => {
    const never = await enrolledRider(routes, hasher, { device: null });
    const revoked = await enrolledRider(routes, hasher, { device: 'REVOKED' });
    const unknownPhone = '+99955500201';
    const traced = async (phone: string, pin: string) => {
      const { result, statements } = await routes.kit.trace(() => attempt(routes, { phone, pin }));
      return { response: result.response, statements };
    };

    const unknown = await traced(unknownPhone, WRONG_PIN);
    const neverEnrolled = await traced(never.rider.phone, WRONG_PIN);
    const revokedOnly = await traced(revoked.rider.phone, WRONG_PIN);

    for (const [name, each] of Object.entries({ unknown, neverEnrolled, revokedOnly })) {
      expect(answer(each.response), name).toEqual({
        status: 422,
        body: expect.objectContaining({ code: 'DEVICE_PROOF_INVALID' }) as unknown,
      });
    }
    expect(answer(neverEnrolled.response)).toEqual(answer(unknown.response));
    expect(answer(revokedOnly.response)).toEqual(answer(unknown.response));
    // What the database was asked does not tell them apart either, from the challenge request to the refusal.
    const strip = (statements: string[]) =>
      statements.filter((statement) => !statement.includes('rate_limit'));
    expect(sameShape(strip(neverEnrolled.statements), strip(unknown.statements))).toBe(true);
    expect(sameShape(strip(revokedOnly.statements), strip(unknown.statements))).toBe(true);
    for (const subject of [never, revoked]) {
      expect(await credentialOf(subject.rider.id)).toMatchObject({ failed_attempt_count: 0 });
      expect(await sessionsOf(subject.rider.id)).toEqual([]);
    }
  });
});

describe('the PIN, its lockout and the standing of the rider (AC-SLICE-000-09, -11, -109)', () => {
  // Break caught: a lock at another count, a sixth attempt that is verified, counted or extends the lock, an event for every wrong PIN, a PIN in
  // the lock event, or a lock that never ends.
  it('locks the PIN at the fifth wrong PIN from the registered handset, tells that handset so, and opens again after the lock', async () => {
    const subject = await enrolledRider(routes, hasher);
    const verify = vi.spyOn(hasher, 'verify');

    const wrongs = [];
    for (let index = 0; index < 5; index += 1) {
      const { response } = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });
      wrongs.push([response.status, codeOf(response)]);
      expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(index + 1);
    }

    expect(wrongs).toEqual(Array.from({ length: 5 }, () => [422, 'INVALID_CREDENTIALS']));
    const locked = await credentialOf(subject.rider.id);
    expect(locked?.locked_until).not.toBeNull();
    const minutes = (
      await rows<{ value: number }>(
        `select value from setting where key = 'signin_lockout_minutes'`,
      )
    )[0]?.value;
    const remaining = ((locked?.locked_until?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(remaining).toBeGreaterThan((minutes ?? 0) - 1);
    // The database's clock and the process's differ by a moment (a container's clock runs apart from the host's).
    expect(remaining).toBeLessThan((minutes ?? 0) + 1);
    expect(verify).toHaveBeenCalledTimes(5);

    // The sixth carries a valid signature and the right PIN: told the lock, not verified, not counted, not extended.
    const sixth = await attempt(routes, subjectOf(subject));
    expect([sixth.response.status, codeOf(sixth.response)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    expect(verify).toHaveBeenCalledTimes(5);
    expect(await credentialOf(subject.rider.id)).toEqual(locked);
    // A request that has not produced a valid signature is never told the lock.
    const unsigned = await attempt(routes, { phone: subject.rider.phone, pin: subject.pin });
    expect([unsigned.response.status, codeOf(unsigned.response)]).toEqual([
      422,
      'DEVICE_PROOF_INVALID',
    ]);

    const events = await eventsFor(subject.rider.id, 'auth.lockout.applied', 'auth.session.failed');
    const lockouts = events.filter((event) => event.event_code === 'auth.lockout.applied');
    expect(lockouts).toHaveLength(1);
    expect(lockouts[0]).toMatchObject({
      outcome: 'SUCCEEDED',
      object_type: 'RiderIdentity',
      object_id: subject.rider.id,
      detail: { factor: 'PIN' },
    });
    expect(JSON.stringify(lockouts)).not.toContain(WRONG_PIN);
    expect(JSON.stringify(events)).not.toContain(subject.pin);
    const causes = events
      .filter((event) => event.event_code === 'auth.session.failed')
      .map((event) => [event.detail.cause, event.detail.factor]);
    expect(causes).toEqual([
      ...Array.from({ length: 5 }, () => ['WRONG_PIN', 'PIN']),
      ['LOCKED_OUT', 'PIN'],
      ['DEVICE_PROOF_INVALID', 'NONE'],
    ]);

    // The lock ends by itself; the first attempt after it is verified normally and the count restarts.
    await routes.admin.query(
      `update rider_identity set locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [subject.rider.id],
    );
    const afterLock = await attempt(routes, subjectOf(subject));
    expect(afterLock.response.status).toBe(200);
    expect(await credentialOf(subject.rider.id)).toMatchObject({
      failed_attempt_count: 0,
      locked_until: null,
    });
  });

  it('restarts the count at one for the first wrong PIN after a lock has run out', async () => {
    const subject = await enrolledRider(routes, hasher);
    for (let index = 0; index < 5; index += 1) {
      await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });
    }
    await routes.admin.query(
      `update rider_identity set locked_until = clock_timestamp() - interval '1 second' where id = $1`,
      [subject.rider.id],
    );

    const { response } = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });

    expect([response.status, codeOf(response)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await credentialOf(subject.rider.id)).toMatchObject({
      failed_attempt_count: 1,
      locked_until: null,
    });
  });

  // Break caught: a correct PIN that does not reset the count (the next four wrong ones would lock a rider who has just signed in).
  it('resets the count with a correct PIN', async () => {
    const subject = await enrolledRider(routes, hasher);
    for (let index = 0; index < 3; index += 1) {
      await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });
    }
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(3);

    const { response } = await attempt(routes, subjectOf(subject));

    expect(response.status).toBe(200);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });

  // Break caught (AC-11, AC-109 last clause): a standing other than ACTIVE told apart from a wrong PIN, counted, or announced as a lock.
  it.each(['INACTIVE', 'TEMPORARILY_UNAVAILABLE', 'SUSPENDED', 'OFFBOARDED'])(
    'refuses a %s rider from the registered handset as INVALID_CREDENTIALS, like a wrong PIN, counting nothing and announcing no lock',
    async (status) => {
      const subject = await enrolledRider(routes, hasher, { status });
      const reference = await enrolledRider(routes, hasher);
      const wrongPin = await attempt(routes, { ...subjectOf(reference), pin: WRONG_PIN });

      const correct = await attempt(routes, subjectOf(subject));
      const wrong = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });
      // A lock in force is not announced to a rider who is not ACTIVE either: the factor has not been reached.
      await routes.admin.query(
        `update rider_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
        [subject.rider.id],
      );
      const lockedToo = await attempt(routes, subjectOf(subject));

      expect(answer(correct.response)).toEqual(answer(wrongPin.response));
      expect(answer(wrong.response)).toEqual(answer(wrongPin.response));
      expect(answer(lockedToo.response)).toEqual(answer(wrongPin.response));
      expect(wrongPin.response.status).toBe(422);
      expect(codeOf(wrongPin.response)).toBe('INVALID_CREDENTIALS');
      expect(await sessionsOf(subject.rider.id)).toEqual([]);
      expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(5);
      const causes = (await failuresOf(subject.rider.id)).map((detail) => [
        detail.cause,
        detail.factor,
      ]);
      expect(causes).toEqual(Array.from({ length: 3 }, () => ['INELIGIBLE_PRINCIPAL', 'NONE']));
    },
  );

  // Break caught: a work shape that tells a wrong PIN from a suspended rider before the answer (a wrong PIN counts, and nothing else more).
  it('does the same work for a suspended rider as for a wrong PIN, but for the count', async () => {
    const suspended = await enrolledRider(routes, hasher, { status: 'SUSPENDED' });
    const reference = await enrolledRider(routes, hasher);
    const traced = async (subject: Enrolled, pin: string) =>
      (await routes.kit.trace(() => attempt(routes, { ...subjectOf(subject), pin }))).statements;

    const inactive = await traced(suspended, WRONG_PIN);
    const counted = await traced(reference, WRONG_PIN);

    const extra = counted.filter((statement) => !inactive.includes(statement));
    expect(inactive.length).toBeGreaterThan(0);
    expect(
      extra.filter(
        (statement) => statement.includes('failed_attempt_count') && statement.startsWith('update'),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  // Break caught (SECURITY_DESIGN 13.4b, "Timing"): a branch that does no verification (a request that is cheaper when the rider is unknown, or
  // when the signature is bad) or two (a request that is dearer for a correct PIN than a wrong one by more than the one rehash).
  it('verifies exactly once on every branch that is admitted to hashing: the real hash where the PIN decides, the dummy elsewhere', async () => {
    const holder = await enrolledRider(routes, hasher);
    const never = await enrolledRider(routes, hasher, { device: null });
    const revoked = await enrolledRider(routes, hasher, { device: 'REVOKED' });
    const suspended = await enrolledRider(routes, hasher, { status: 'SUSPENDED' });
    const lockedOut = await enrolledRider(routes, hasher);
    await routes.admin.query(
      `update rider_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [lockedOut.rider.id],
    );
    const verify = vi.spyOn(hasher, 'verify');
    const dummy = vi.spyOn(hasher, 'verifyAgainstDummy');
    const make = vi.spyOn(hasher, 'hash');
    const counts = async (work: () => Promise<unknown>) => {
      verify.mockClear();
      dummy.mockClear();
      make.mockClear();
      await work();
      return {
        real: verify.mock.calls.length,
        dummy: dummy.mock.calls.length,
        hash: make.mock.calls.length,
      };
    };
    const expiredChallenge = async () => {
      const challenge = await freshChallenge(routes, holder.rider.phone);
      await age(challenge);
      return post(routes, {
        phone: holder.rider.phone,
        pin: holder.pin,
        challenge,
        device_signature: signChallenge(
          holder.device?.key.privateKey ?? deviceKey().privateKey,
          challenge,
        ),
        client_root_signal: 'NOT_DETECTED',
      });
    };

    const results = {
      correct: await counts(() => attempt(routes, subjectOf(holder))),
      wrongPin: await counts(() => attempt(routes, { ...subjectOf(holder), pin: WRONG_PIN })),
      unknownNumber: await counts(() => attempt(routes, { phone: '+99955500301', pin: PIN })),
      neverEnrolled: await counts(() => attempt(routes, { phone: never.rider.phone, pin: PIN })),
      revokedRight: await counts(() =>
        attempt(routes, { ...subjectOf(revoked), pin: revoked.pin }),
      ),
      revokedWrong: await counts(() => attempt(routes, { ...subjectOf(revoked), pin: WRONG_PIN })),
      badSignature: await counts(() =>
        attempt(routes, { phone: holder.rider.phone, pin: holder.pin }),
      ),
      suspended: await counts(() => attempt(routes, subjectOf(suspended))),
      locked: await counts(() => attempt(routes, subjectOf(lockedOut))),
      expired: await counts(expiredChallenge),
    };

    expect(results).toEqual({
      correct: { real: 1, dummy: 0, hash: 0 },
      wrongPin: { real: 1, dummy: 0, hash: 0 },
      unknownNumber: { real: 0, dummy: 1, hash: 0 },
      neverEnrolled: { real: 0, dummy: 1, hash: 0 },
      revokedRight: { real: 1, dummy: 0, hash: 0 },
      revokedWrong: { real: 1, dummy: 0, hash: 0 },
      badSignature: { real: 0, dummy: 1, hash: 0 },
      suspended: { real: 0, dummy: 1, hash: 0 },
      locked: { real: 0, dummy: 1, hash: 0 },
      expired: { real: 0, dummy: 1, hash: 0 },
    });
  });

  // Break caught (SECURITY_DESIGN 13.4c): a request with no slot that hashes, counts or consumes the challenge.
  it('answers RATE_LIMITED when no hash slot is free, hashing nothing, counting nothing and leaving the challenge unspent', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    const admission = routes.kit.app.app.get<HashAdmission>(HASH_ADMISSION, { strict: false });
    const held: HashSlot[] = [];
    for (let slot = admission.tryAdmit(); slot !== null; slot = admission.tryAdmit())
      held.push(slot);
    const verify = vi.spyOn(hasher, 'verify');
    const dummy = vi.spyOn(hasher, 'verifyAgainstDummy');
    const body = {
      phone: subject.rider.phone,
      pin: WRONG_PIN,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    };
    try {
      const refused = await post(routes, body);

      expect([refused.status, codeOf(refused)]).toEqual([429, 'RATE_LIMITED']);
      expect(verify).not.toHaveBeenCalled();
      expect(dummy).not.toHaveBeenCalled();
      expect(await challengeState(challenge)).toBe('PENDING');
      expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
    } finally {
      for (const slot of held) slot.release();
    }
    // The slots are back, and the same challenge now works.
    expect((await post(routes, { ...body, pin: subject.pin })).status).toBe(200);
  });
});

describe('the request schema (AC-SLICE-000-51, -59, -111)', () => {
  const valid = async (subject: Enrolled) => {
    const challenge = await freshChallenge(routes, subject.rider.phone);
    return {
      challenge,
      body: {
        phone: subject.rider.phone,
        pin: subject.pin,
        challenge,
        device_signature: signChallenge(
          subject.device?.key.privateKey ?? deviceKey().privateKey,
          challenge,
        ),
        client_root_signal: 'NOT_DETECTED',
      } as Record<string, unknown>,
    };
  };

  // Break caught: a sign-in that is answered without a signature, a root signal, a PIN, a number or a challenge (a PIN alone must never
  // authenticate a rider), or that spends the challenge on the refusal.
  it.each(['phone', 'pin', 'challenge', 'device_signature', 'client_root_signal'])(
    'refuses a request with no %s as VALIDATION_FAILED, issues no session and spends no challenge',
    async (field) => {
      const subject = await enrolledRider(routes, hasher);
      const { challenge, body } = await valid(subject);
      const without = { ...body };
      Reflect.deleteProperty(without, field);

      const response = await post(routes, without);

      expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      expect(await sessionsOf(subject.rider.id)).toEqual([]);
      expect(await challengeState(challenge)).toBe('PENDING');
    },
  );

  // Break caught (AC-111): a PIN that is not six decimal digits reaching the hasher, at sign-in.
  it.each([
    ['five digits', '12345'],
    ['seven digits', '1234567'],
    ['letters', 'abcdef'],
    ['with a space', '123 56'],
    ['padded', '123456 '],
    ['Arabic-Indic digits', '١٢٣٤٥٦'],
    ['full-width digits', '１２３４５６'],
    ['empty', ''],
    ['a number', 123456],
  ])(
    'refuses a PIN of %s as VALIDATION_FAILED, issues no session and spends no challenge',
    async (_name, pin) => {
      const subject = await enrolledRider(routes, hasher);
      const { challenge, body } = await valid(subject);
      const verify = vi.spyOn(hasher, 'verify');

      const response = await post(routes, { ...body, pin });

      expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      expect(verify).not.toHaveBeenCalled();
      expect(await sessionsOf(subject.rider.id)).toEqual([]);
      expect(await challengeState(challenge)).toBe('PENDING');
    },
  );

  // Break caught: a signature, a challenge or a number that is not in its one canonical spelling reaching the verifier, or a field the contract does
  // not have (a device identifier, an installer) accepted.
  it.each([
    // The signature of a request is random in length, so the malformed ones are written out and not derived from it.
    ['a signature in base64url', () => '-_-_-_-_-_-_'],
    [
      'a signature with its padding removed',
      () => Buffer.alloc(70, 1).toString('base64').replace(/=+$/, ''),
    ],
    ['a signature of eleven characters', () => 'AAAAAAAAAAA'],
    ['a signature of ninety-seven characters', () => `${'A'.repeat(96)}=`],
    ['a signature with a space', (s: string) => ` ${s}`],
    ['a signature that is not text', () => 12],
  ])('refuses %s as VALIDATION_FAILED', async (_name, change) => {
    const subject = await enrolledRider(routes, hasher);
    const { challenge, body } = await valid(subject);

    const response = await post(routes, {
      ...body,
      device_signature: change(body.device_signature as string),
    });

    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await challengeState(challenge)).toBe('PENDING');
  });

  it('refuses a challenge that is not the canonical text of 32 bytes, a number that is not E.164, an unknown root signal and any other field', async () => {
    const subject = await enrolledRider(routes, hasher);
    const { challenge, body } = await valid(subject);
    // 43 characters whose last one carries bits that 32 bytes do not (B is 000001): it decodes, and does not encode back to itself.
    const spare = `${challenge.slice(0, 42)}B`;
    const bad: Record<string, unknown>[] = [
      { challenge: `${challenge}A` },
      { challenge: challenge.slice(1) },
      { challenge: challenge.replace(/.$/, '+') },
      { challenge: spare },
      { phone: '233200000001' },
      { phone: `${subject.rider.phone} ` },
      { client_root_signal: 'MAYBE' },
      { client_root_signal: 'detected' },
      { device_identifier: 'abc' },
      { installer_package: 'com.android.vending' },
      { extra: true },
    ];

    for (const change of bad) {
      const response = await post(routes, { ...body, ...change });
      expect([response.status, codeOf(response)], JSON.stringify(Object.keys(change))).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect(await challengeState(challenge)).toBe('PENDING');
  });

  // Break caught: a body that is not JSON of the right shape reaching the service.
  it('refuses a body that is not an object', async () => {
    for (const body of ['a text', 12, null, [], undefined]) {
      const response = await native(routes).post(SIGN_IN_URL, body, { origin: null });
      expect([response.status, codeOf(response)], JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
  });
});

describe('races: what the sign-in meets between the examination and the session', () => {
  /** Runs `during` once, in the middle of the first real PIN verification: after the reads, before the session. */
  function meanwhile(during: () => Promise<void>) {
    const original = hasher.verify.bind(hasher);
    return vi.spyOn(hasher, 'verify').mockImplementationOnce(async (kind, secret, hash) => {
      await during();
      return original(kind, secret, hash);
    });
  }

  /** Runs `during` once, in the middle of the first derivation against the dummy hash: where a request that never reaches the PIN spends its time. */
  function meanwhileDummy(during: () => Promise<void>) {
    const original = hasher.verifyAgainstDummy.bind(hasher);
    return vi.spyOn(hasher, 'verifyAgainstDummy').mockImplementationOnce(async (kind, secret) => {
      await during();
      return original(kind, secret);
    });
  }

  // Break caught: two requests that present one challenge each signing in, or each told something else than that it is finished.
  it('lets one of two parallel presentations of a challenge sign in and refuses the other as CHALLENGE_UNUSABLE', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    const body = {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    };

    const answers = await Promise.all([post(routes, body), post(routes, body), post(routes, body)]);

    expect(answers.filter((each) => each.status === 200)).toHaveLength(1);
    for (const refused of answers.filter((each) => each.status !== 200)) {
      expect([refused.status, codeOf(refused)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    }
    expect(await sessionsOf(subject.rider.id)).toHaveLength(1);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });

  // Break caught (SECURITY_DESIGN 13.4b, "Concurrency"): wrong PINs that step over the threshold without setting the lock, a count that loses an
  // increment, two lock events, or a correct PIN that signs in on a lock.
  it('counts parallel wrong PINs exactly, sets the lock once and writes one lock event', async () => {
    const subject = await enrolledRider(routes, hasher);
    // Nine challenges and nine sign-ins are eighteen requests of the twenty of a number's minute; three at a time, the most the slots admit.
    const challenges = await Promise.all(
      Array.from({ length: 9 }, () => freshChallenge(routes, subject.rider.phone)),
    );
    const key = subject.device?.key.privateKey ?? deviceKey().privateKey;
    const wrongPin = (challenge: string) =>
      post(routes, {
        phone: subject.rider.phone,
        pin: WRONG_PIN,
        challenge,
        device_signature: signChallenge(key, challenge),
        client_root_signal: 'NOT_DETECTED',
      });

    const codes: (string | undefined)[] = [];
    for (let batch = 0; batch < 3; batch += 1) {
      const answers = await Promise.all(
        challenges.slice(batch * 3, batch * 3 + 3).map((challenge) => wrongPin(challenge)),
      );
      codes.push(...answers.map((each) => codeOf(each)));
    }

    // The fifth wrong PIN sets the lock, whichever request it was, and every request after it meets the lock: none counts, none extends it.
    expect(codes.filter((code) => code === 'INVALID_CREDENTIALS')).toHaveLength(5);
    expect(codes.filter((code) => code === 'CREDENTIAL_LOCKED')).toHaveLength(4);
    expect(await credentialOf(subject.rider.id)).toMatchObject({ failed_attempt_count: 5 });
    expect((await credentialOf(subject.rider.id))?.locked_until).not.toBeNull();
    expect(await eventsFor(subject.rider.id, 'auth.lockout.applied')).toHaveLength(1);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
  });

  // Break caught: a session issued on a device that was revoked or replaced while the PIN was being verified.
  it('answers DEVICE_PROOF_INVALID, and issues nothing, when the device is revoked while the PIN is being verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    const spy = meanwhile(async () => {
      await routes.admin.query(
        `update registered_device set status = 'REVOKED', ended_at = clock_timestamp() where id = $1`,
        [subject.device?.id],
      );
    });

    const { response, challenge } = await attempt(routes, subjectOf(subject));

    expect(spy).toHaveBeenCalledTimes(1);
    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect(await challengeState(challenge)).toBe('CONSUMED');
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });

  // Break caught: a lock set by another request while the PIN was verified, cleared by the success that did not know of it.
  it('honours a lock set while the PIN is being verified: CREDENTIAL_LOCKED, no session, and the lock is kept', async () => {
    const subject = await enrolledRider(routes, hasher);
    const spy = meanwhile(async () => {
      await routes.admin.query(
        `update rider_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
        [subject.rider.id],
      );
    });

    const { response } = await attempt(routes, subjectOf(subject));

    expect(spy).toHaveBeenCalledTimes(1);
    expect([response.status, codeOf(response)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(5);
    expect((await credentialOf(subject.rider.id))?.locked_until).not.toBeNull();
  });

  // Break caught (the audit of 21 October 2026, A03): a PIN verified against the credential that was replaced counted against the one that replaced
  // it, or a session issued on the strength of the old one.
  it('counts nothing against, and issues no session on, a PIN that was replaced while the old one was being verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    const replacement = await hasher.hash('RIDER_PIN', '246810');
    const wrong = meanwhile(async () => {
      await routes.admin.query(
        `update rider_identity set pin_hash = $2, credential_generation = credential_generation + 1, failed_attempt_count = 0, locked_until = null where id = $1`,
        [subject.rider.id, replacement],
      );
    });

    const counted = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });

    expect(wrong).toHaveBeenCalledTimes(1);
    expect([counted.response.status, codeOf(counted.response)]).toEqual([
      422,
      'INVALID_CREDENTIALS',
    ]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
    vi.restoreAllMocks();

    const right = meanwhile(async () => {
      await routes.admin.query(
        `update rider_identity set credential_generation = credential_generation + 1 where id = $1`,
        [subject.rider.id],
      );
    });
    const issued = await attempt(routes, { ...subjectOf(subject), pin: '246810' });
    expect(right).toHaveBeenCalledTimes(1);
    expect([issued.response.status, codeOf(issued.response)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
  });

  // Break caught (SECURITY_DESIGN 13.4b, "a failure that completes after the lock is set neither counts nor moves locked_until"): a wrong PIN
  // that was verified before the lock was set counted after it, or extended it, or told as a wrong PIN where the lock is the matter.
  it('answers CREDENTIAL_LOCKED, counting nothing and moving nothing, to a wrong PIN verified just before the lock was set', async () => {
    const subject = await enrolledRider(routes, hasher);
    meanwhile(async () => {
      await routes.admin.query(
        `update rider_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
        [subject.rider.id],
      );
    });

    const { response } = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });

    const kept = await credentialOf(subject.rider.id);
    expect([response.status, codeOf(response)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    expect(kept?.failed_attempt_count).toBe(5);
    expect(await eventsFor(subject.rider.id, 'auth.lockout.applied')).toEqual([]);
    const [event] = await failuresOf(subject.rider.id);
    expect(event).toMatchObject({ cause: 'LOCKED_OUT', factor: 'PIN' });
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
  });

  // Break caught (the mutation run of 27 October 2026): a request that met the lock, whose PIN was never verified, counted as a wrong PIN once the
  // lock ran out while it was in flight: the count would restart from one for a PIN nobody looked at.
  it('counts nothing for a request that met the lock, though the lock runs out while it is in flight: its PIN was never verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    await routes.admin.query(
      `update rider_identity set failed_attempt_count = 5, locked_until = clock_timestamp() + interval '10 minutes' where id = $1`,
      [subject.rider.id],
    );
    const spy = meanwhileDummy(async () => {
      await routes.admin.query(
        `update rider_identity set locked_until = clock_timestamp() - interval '1 second' where id = $1`,
        [subject.rider.id],
      );
    });

    const { response } = await attempt(routes, { ...subjectOf(subject), pin: WRONG_PIN });

    expect(spy).toHaveBeenCalledTimes(1);
    expect([response.status, codeOf(response)]).toEqual([422, 'CREDENTIAL_LOCKED']);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(5);
    expect(await eventsFor(subject.rider.id, 'auth.lockout.applied')).toEqual([]);
    const [event] = await failuresOf(subject.rider.id);
    expect(event).toMatchObject({ cause: 'LOCKED_OUT', factor: 'PIN' });
  });

  // Break caught: a session issued to a rider who was suspended while the PIN was being verified.
  it('issues no session to a rider suspended while the PIN is being verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    meanwhile(async () => {
      await routes.admin.query(`update rider_identity set status = 'SUSPENDED' where id = $1`, [
        subject.rider.id,
      ]);
    });

    const { response } = await attempt(routes, subjectOf(subject));

    expect([response.status, codeOf(response)]).toEqual([422, 'INVALID_CREDENTIALS']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });

  // Break caught (the audit of 21 October 2026, A06): a challenge that lapses while the sign-in is in flight consumed after its time, or reported
  // as anything but expired.
  it('answers CHALLENGE_EXPIRED when the challenge lapses while the PIN is being verified, issuing no session', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    meanwhile(() => age(challenge));

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_EXPIRED']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect(await challengeState(challenge)).toBe('EXPIRED');
  });

  // Break caught: a challenge spent by another request while the PIN was being verified used again by this one.
  it('answers CHALLENGE_UNUSABLE when another request spends the challenge while the PIN is being verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    meanwhile(async () => {
      await routes.admin.query(
        `update rider_sign_in_challenge set state = 'CONSUMED' where nonce_hash = $1`,
        [nonceHashOf(challenge)],
      );
    });

    const response = await post(routes, {
      phone: subject.rider.phone,
      pin: subject.pin,
      challenge,
      device_signature: signChallenge(
        subject.device?.key.privateKey ?? deviceKey().privateKey,
        challenge,
      ),
      client_root_signal: 'NOT_DETECTED',
    });

    expect([response.status, codeOf(response)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect(await sessionsOf(subject.rider.id)).toEqual([]);
    expect((await credentialOf(subject.rider.id))?.failed_attempt_count).toBe(0);
  });
});

describe('the service holds the form of a request itself (defence in depth behind the schema)', () => {
  // Break caught: a service that relies on the schema alone, so that a caller that reaches it another way (a job, a test, a later route) can hand
  // it a number, a PIN, a challenge or a signature that is not in its one form: nothing is looked up, hashed or counted for it.
  it.each([
    ['a number that is not E.164', { phone: '0200000001' }, '/phone'],
    ['a PIN that is not six digits', { pin: '12345' }, '/pin'],
    [
      'a challenge that is not the canonical text of 32 bytes',
      { challenge: 'short' },
      '/challenge',
    ],
    [
      'a signature that is not canonical base64',
      { deviceSignature: 'not base64!' },
      '/device_signature',
    ],
    [
      'a root signal that is none of the three',
      { clientRootSignal: 'MAYBE' },
      '/client_root_signal',
    ],
  ])('refuses %s as VALIDATION_FAILED before it does anything', async (_name, change, pointer) => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = await freshChallenge(routes, subject.rider.phone);
    const service = routes.kit.app.app.get<RiderSignInService>(RIDER_SIGN_IN_SERVICE, {
      strict: false,
    });
    const verify = vi.spyOn(hasher, 'verify');
    const dummy = vi.spyOn(hasher, 'verifyAgainstDummy');

    const refusal = await service
      .signIn({
        phone: subject.rider.phone,
        pin: subject.pin,
        challenge,
        deviceSignature: signChallenge(
          subject.device?.key.privateKey ?? deviceKey().privateKey,
          challenge,
        ),
        clientRootSignal: 'NOT_DETECTED',
        ...change,
      } as Parameters<RiderSignInService['signIn']>[0])
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(ApiException);
    expect((refusal as ApiException).getStatus()).toBe(400);
    expect((refusal as ApiException).code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify((refusal as ApiException).details)).toContain(pointer);
    expect(verify).not.toHaveBeenCalled();
    expect(dummy).not.toHaveBeenCalled();
    expect(await challengeState(challenge)).toBe('PENDING');
  });
});

describe('what a sign-in does not do', () => {
  // Break caught: PIN, signature or nonce text in a response of a refusal, or a refusal that names the factor that failed.
  it('names no factor in a refusal and repeats nothing the caller sent', async () => {
    const subject = await enrolledRider(routes, hasher);
    const { response, challenge } = await attempt(routes, { ...subjectOf(subject), pin: '918273' });

    const text = response.text;

    expect(response.status).toBe(422);
    for (const sent of [subject.rider.phone, '918273', challenge]) expect(text).not.toContain(sent);
    expect(Object.keys(response.json() as object).toSorted()).toEqual([
      'code',
      'message',
      'request_id',
    ]);
  });

  // Break caught: an operation that consults the clock of the application for a lifetime, or that shortens or extends a lock with the time of the
  // request (the database's clock decides every instant).
  it('keeps its instants on the database’s clock', async () => {
    const subject = await enrolledRider(routes, hasher);
    const before = Date.now();

    const { response } = await attempt(routes, subjectOf(subject));
    const [stored] = await sessionsOf(subject.rider.id);

    expect(response.status).toBe(200);
    expect(Math.abs((stored?.issued_at.getTime() ?? 0) - before)).toBeLessThan(30_000);
  });

  it('is bound to the digest of the number the challenge was requested for', async () => {
    const subject = await enrolledRider(routes, hasher);
    const challenge = challengeOf(await requestChallenge(routes, subject.rider.phone));
    const [row] = await rows<{ phone_hash: Buffer }>(
      'select phone_hash from rider_sign_in_challenge where nonce_hash = $1',
      [nonceHashOf(challenge)],
    );

    expect(row?.phone_hash.equals(phoneBinding(subject.rider.phone))).toBe(true);
  });
});

describe('the stored PIN hash moves forward only (SECURITY_DESIGN.md section 13.4; the audit of 21 October 2026, A01)', () => {
  /** A PIN hash made at the older cost the application accepts: what a rider enrolled under an earlier profile holds. */
  function olderHash(pin: string): Promise<string> {
    const config = routes.kit.app.app.get<AppConfig>(APP_CONFIG, { strict: false });
    return new Argon2Hasher(config.keys, { memoryKiB: 8192, passes: 2, parallelism: 1 }).hash(
      'RIDER_PIN',
      pin,
    );
  }
  // The administrator reads the column: no statement under the application's login can (migration 0040).
  const hashOf = async (riderId: string) =>
    (
      await routes.admin.query<{ hash: string; generation: string; established: Date }>(
        'select pin_hash as hash, credential_generation::text as generation, pin_established_at as established from rider_identity where id = $1',
        [riderId],
      )
    ).rows[0];

  // Break caught: a stored hash that stays at the old cost for ever, one rewritten as a new credential (the generation or the moment moved: the
  // session of the rider would end), or the verification run twice.
  it('rewrites the hash at the write profile after a correct PIN, as the same credential', async () => {
    const subject = await enrolledRider(routes, hasher, { pinHash: await olderHash(PIN) });
    const before = await hashOf(subject.rider.id);
    const verify = vi.spyOn(hasher, 'verify');
    const make = vi.spyOn(hasher, 'hash');

    const { response } = await attempt(routes, subjectOf(subject));

    expect(response.status).toBe(200);
    const after = await hashOf(subject.rider.id);
    expect(before?.hash).toMatch(/m=8192,/);
    expect(after?.hash).toMatch(/m=65536,/);
    expect(after?.generation).toBe(before?.generation);
    expect(after?.established.getTime()).toBe(before?.established.getTime());
    // One verification derivation, and the rehash that the hasher advised adds one, in the same slot.
    expect(verify).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledTimes(1);
    expect((await hasher.verify('RIDER_PIN', PIN, after?.hash ?? '')).matches).toBe(true);
  });

  // Break caught: a hash rewritten after a wrong PIN, or one already at the write profile rewritten for nothing.
  it('leaves the hash as it was after a wrong PIN, and for a hash already at the write profile', async () => {
    const wrong = await enrolledRider(routes, hasher, { pinHash: await olderHash(PIN) });
    const current = await enrolledRider(routes, hasher);
    const stored = (await hashOf(wrong.rider.id))?.hash;
    const currentStored = (await hashOf(current.rider.id))?.hash;
    const make = vi.spyOn(hasher, 'hash');

    await attempt(routes, { ...subjectOf(wrong), pin: WRONG_PIN });
    await attempt(routes, subjectOf(current));

    expect((await hashOf(wrong.rider.id))?.hash).toBe(stored);
    expect((await hashOf(current.rider.id))?.hash).toBe(currentStored);
    expect(make).not.toHaveBeenCalled();
  });

  // Break caught (A01): a rewrite conditional on the generation alone. A rehash does not move the generation, so two instances that verified the
  // same hash and each computed an upgrade wrote in whatever order they got the rider's lock, and the older upgrade could replace the newer.
  it.each([
    ['a larger cost', '$argon2id$v=19$m=131072,t=3,p=1$bmV3ZXI$aGFzaA'],
    ['a newer pepper', '$argon2id$v=19$m=65536,t=2,p=1,pv=2$bmV3ZXI$aGFzaA'],
  ])(
    'keeps the hash that another instance upgraded after this request verified the old one (%s)',
    async (_kind, newer) => {
      const subject = await enrolledRider(routes, hasher, { pinHash: await olderHash(PIN) });
      const before = await hashOf(subject.rider.id);
      const original = hasher.hash.bind(hasher);
      vi.spyOn(hasher, 'hash').mockImplementationOnce(async (...args) => {
        const own = await original(...args);
        // The other instance's upgrade commits first, on the same generation.
        await routes.admin.query('update rider_identity set pin_hash = $2 where id = $1', [
          subject.rider.id,
          newer,
        ]);
        return own;
      });

      const { response } = await attempt(routes, subjectOf(subject));

      expect(response.status).toBe(200);
      const after = await hashOf(subject.rider.id);
      expect(after?.hash).toBe(newer);
      expect(after?.generation).toBe(before?.generation);
    },
  );
});

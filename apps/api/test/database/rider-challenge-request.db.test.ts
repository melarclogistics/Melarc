import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import {
  deviceContextBinding,
  phoneBinding,
  riderChallengeAudience,
} from '../../src/platform/auth/rider/rider-challenge-binding.js';
import { sameShape } from '../../src/test-support/work-shape.js';
import {
  CHALLENGE_URL,
  PIN,
  challengeOf,
  enrolledRider,
  native,
  nonceHashOf,
  post,
  requestChallenge,
  type Enrolled,
} from './support/rider-sign-in.js';
import { codeOf, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';

/**
 * S0.59a, `requestRiderSignInChallenge` against the real application and a real PostgreSQL (`AC-SLICE-000-39`, `-52`, `-53`; rider-authentication.md
 * sections 4.1 and 5.1; SECURITY_DESIGN.md sections 13.4b and 13.6): the first step of a rider's sign-in issues a short-lived, single-use nonce, the
 * same way whether or not the number belongs to anyone. Every request goes through HTTP as the native app sends it (no `Origin`, no cookie, no
 * credential); what the application did is read from a second connection.
 */
let routes: StaffRoutes;
let hasher: Hasher;

beforeAll(async () => {
  routes = await startStaffRoutes();
  hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

interface ChallengeRow {
  id: string;
  rider_identity_id: string | null;
  state: string;
  issued_at: Date;
  expires_at: Date;
  nonce_hash: Buffer;
  phone_hash: Buffer;
  purpose: string;
  audience: string;
  device_context_hash: Buffer | null;
}

const challengeRowFor = async (challenge: string): Promise<ChallengeRow | undefined> =>
  (
    await rows<ChallengeRow>(
      `select id, rider_identity_id::text, state, issued_at, expires_at, nonce_hash, phone_hash, purpose, audience, device_context_hash
         from rider_sign_in_challenge where nonce_hash = $1`,
      [nonceHashOf(challenge)],
    )
  )[0];

const countAll = async (): Promise<number> =>
  Number((await rows<{ n: string }>('select count(*) as n from rider_sign_in_challenge'))[0]?.n);

describe('what a challenge is (AC-SLICE-000-39, -52, -53)', () => {
  // Break caught: a nonce that is not 32 random bytes in the canonical unpadded base64url, one that is the same twice, or an expiry that is not
  // the lifetime of `authentication_challenge_ttl_minutes` (5).
  it('is the canonical unpadded base64url of 32 random bytes, different every time, that ends five minutes after it was issued', async () => {
    const subject = await enrolledRider(routes, hasher);

    const first = await requestChallenge(routes, subject.rider.phone);
    const second = await requestChallenge(routes, subject.rider.phone);

    expect(first.status).toBe(200);
    const issued = first.json() as { challenge: string; expires_at: string };
    expect(Object.keys(issued).toSorted()).toEqual(['challenge', 'expires_at']);
    expect(issued.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(issued.challenge, 'base64url')).toHaveLength(32);
    expect(Buffer.from(issued.challenge, 'base64url').toString('base64url')).toBe(issued.challenge);
    expect(challengeOf(second)).not.toBe(issued.challenge);
    const row = await challengeRowFor(issued.challenge);
    expect(row?.expires_at.toISOString()).toBe(issued.expires_at);
    expect((row?.expires_at.getTime() ?? 0) - (row?.issued_at.getTime() ?? 0)).toBe(5 * 60_000);
  });

  // Break caught: a nonce kept in clear (a leak of the table would be a leak of every live challenge), a number kept as typed, or a binding to
  // nothing (a challenge the sign-in cannot tell from another number's).
  it('is kept as hashes only, bound to the number, the purpose, the service and the device of the rider', async () => {
    const subject = await enrolledRider(routes, hasher);

    const response = await requestChallenge(routes, subject.rider.phone);

    const challenge = challengeOf(response);
    const row = await challengeRowFor(challenge);
    expect(row).toMatchObject({
      state: 'PENDING',
      rider_identity_id: subject.rider.id,
      purpose: 'RIDER_SIGN_IN',
      audience: riderChallengeAudience('local'),
    });
    expect(row?.phone_hash.equals(phoneBinding(subject.rider.phone))).toBe(true);
    expect(row?.device_context_hash?.equals(deviceContextBinding(subject.device?.id ?? ''))).toBe(
      true,
    );
    const everything = JSON.stringify(
      (await rows<Record<string, unknown>>('select * from rider_sign_in_challenge')).map((each) =>
        Object.values(each).map((value) =>
          Buffer.isBuffer(value) ? value.toString('base64') : String(value),
        ),
      ),
    );
    expect(everything).not.toContain(challenge);
    expect(everything).not.toContain(Buffer.from(challenge, 'base64url').toString('base64'));
    expect(everything).not.toContain(subject.rider.phone);
  });
});

describe('the endpoint is not an enumeration oracle (AC-SLICE-000-39)', () => {
  // Break caught: an answer that differs by what the number is: a status, a field, a header, an expiry, a nonce in another shape, or
  // statements the database was asked that tell a rider from nobody.
  it('answers a number that belongs to nobody, a rider with a device, a rider with none and a suspended rider alike, in shape, status, headers and work', async () => {
    const withDevice = await enrolledRider(routes, hasher);
    const withoutDevice = await enrolledRider(routes, hasher, { device: null });
    const revoked = await enrolledRider(routes, hasher, { device: 'REVOKED' });
    const suspended = await enrolledRider(routes, hasher, { status: 'SUSPENDED' });
    const nobody = '+99955500001';

    const traced = async (phone: string) => {
      const { result, statements } = await routes.kit.trace(() => requestChallenge(routes, phone));
      return { response: result, statements };
    };
    const unknown = await traced(nobody);
    const others = {
      withDevice: await traced(withDevice.rider.phone),
      withoutDevice: await traced(withoutDevice.rider.phone),
      revoked: await traced(revoked.rider.phone),
      suspended: await traced(suspended.rider.phone),
    };

    const shapeOf = (response: Awaited<ReturnType<typeof traced>>['response']) => ({
      status: response.status,
      keys: Object.keys(response.json() as object).toSorted(),
      // The headers a response of this operation could differ by.
      headers: ['content-type', 'cache-control', 'etag', 'retry-after', 'set-cookie'].map((name) =>
        response.header(name),
      ),
    });
    expect(unknown.response.status).toBe(200);
    expect(unknown.statements.length).toBeGreaterThan(0);
    for (const [name, each] of Object.entries(others)) {
      expect(shapeOf(each.response), name).toEqual(shapeOf(unknown.response));
      expect(sameShape(each.statements, unknown.statements), name).toBe(true);
      const body = each.response.json() as { challenge: string; expires_at: string };
      expect(Object.keys(body).toSorted(), name).toEqual(['challenge', 'expires_at']);
    }
    // The record tells which, to the server alone: no rider and no device for the number nobody holds.
    const nobodyRow = await challengeRowFor(challengeOf(unknown.response));
    expect(nobodyRow).toMatchObject({ rider_identity_id: null, device_context_hash: null });
    const holderRow = await challengeRowFor(challengeOf(others.withDevice.response));
    expect(holderRow?.rider_identity_id).toBe(withDevice.rider.id);
  });

  // Break caught: a response that carries the rider's name, hub, status, device state or the number back.
  it('carries no name, hub, device state or status', async () => {
    const subject = await enrolledRider(routes, hasher, { fullName: 'Ama Boateng Distinct' });

    const response = await requestChallenge(routes, subject.rider.phone);

    const text = response.text;
    expect(text).not.toContain('Ama Boateng');
    expect(text).not.toContain(subject.rider.id);
    expect(text).not.toContain(subject.rider.hubId);
    expect(text).not.toContain(subject.rider.phone);
    expect(text).not.toMatch(/device|status|hub|rider/i);
  });

  // Break caught: a challenge that only a rider with a device can use to get as far as the PIN, or a number nobody holds refused earlier than
  // the rest (a number that gets a different answer at the next step is the oracle).
  it('gives a number that belongs to nobody a challenge that behaves like any other: it is consumed by a presentation', async () => {
    const nobody = '+99955500002';
    const challenge = challengeOf(await requestChallenge(routes, nobody));

    const first = await post(routes, {
      phone: nobody,
      pin: PIN,
      challenge,
      device_signature: 'AAAAAAAAAAAA',
      client_root_signal: 'UNKNOWN',
    });
    const replay = await post(routes, {
      phone: nobody,
      pin: PIN,
      challenge,
      device_signature: 'AAAAAAAAAAAA',
      client_root_signal: 'UNKNOWN',
    });

    expect([first.status, codeOf(first)]).toEqual([422, 'DEVICE_PROOF_INVALID']);
    expect([replay.status, codeOf(replay)]).toEqual([422, 'CHALLENGE_UNUSABLE']);
    expect((await challengeRowFor(challenge))?.state).toBe('CONSUMED');
  });
});

describe('what the request is held to', () => {
  // Break caught: a text that is not an E.164 number accepted (it would be hashed, bound and stored as a number nobody can hold), or an
  // answer about the rider where the text is the matter.
  it.each([
    ['no plus sign', '233200000001'],
    ['spaces inside', '+233 200 000 001'],
    ['letters', '+23320000000a'],
    ['too short', '+1234567'],
    ['too long', '+1234567890123456'],
    ['a leading zero after the plus', '+0123456789'],
    ['empty', ''],
    ['padded', ' +99900000001'],
  ])('refuses %s as VALIDATION_FAILED and issues nothing', async (_name, phone) => {
    const before = await countAll();

    const response = await requestChallenge(routes, phone);

    expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await countAll()).toBe(before);
  });

  it('refuses a body that is not exactly a number, and a number that is not text', async () => {
    const before = await countAll();
    const bodies: unknown[] = [
      {},
      { phone: 233200000001 },
      { phone: null },
      { phone: '+99900000001', device_identifier: 'abc' },
      { phone: '+99900000001', installer: 'com.android.vending' },
      'a text',
      [],
    ];

    for (const body of bodies) {
      const response = await native(routes).post(CHALLENGE_URL, body, { origin: null });
      expect([response.status, codeOf(response)], JSON.stringify(body)).toEqual([
        400,
        'VALIDATION_FAILED',
      ]);
    }
    expect(await countAll()).toBe(before);
  });

  // Break caught: a challenge that needs the browser's `Origin` or a cookie (the native app sends neither), or one that refuses a browser
  // origin it has no reason to (the operation is the Rider app's, and a stray origin does not change it).
  it('needs no Origin, no cookie and no credential, and is not a browser operation', async () => {
    const subject: Enrolled = await enrolledRider(routes, hasher);

    const bare = await native(routes).post(
      CHALLENGE_URL,
      { phone: subject.rider.phone },
      { origin: null },
    );

    expect(bare.status).toBe(200);
    expect(bare.setCookies).toEqual([]);
  });
});

describe('the rate limit (settings.md section 7.5, rate_limit_rider_challenge, 20 a minute)', () => {
  // Break caught: a limit keyed on the network address or on the rider that exists (the answer would then say whether the number is a rider's),
  // one that counts the refused request, or one that is not 20.
  it('refuses the twenty-first request for a number in a minute, keyed on the number and not on whether it is anybody’s', async () => {
    const holder = await enrolledRider(routes, hasher);
    const nobody = '+99955500003';

    const limited = async (phone: string) => {
      const answers: number[] = [];
      for (let index = 0; index < 21; index += 1) {
        answers.push((await requestChallenge(routes, phone)).status);
      }
      return answers;
    };
    const forHolder = await limited(holder.rider.phone);
    const forNobody = await limited(nobody);

    expect(forHolder.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 200));
    expect(forHolder[20]).toBe(429);
    expect(forNobody).toEqual(forHolder);
    // Another number is not limited by the first, and the limited request wrote nothing.
    const other = await enrolledRider(routes, hasher);
    expect((await requestChallenge(routes, other.rider.phone)).status).toBe(200);
    const stored = Number(
      (
        await rows<{ n: string }>(
          'select count(*) as n from rider_sign_in_challenge where phone_hash = $1',
          [phoneBinding(holder.rider.phone)],
        )
      )[0]?.n,
    );
    expect(stored).toBe(20);
  });

  // Break caught: a sign-in with its own bucket (the number would then get 20 challenge requests and 20 sign-ins), or one that is not limited
  // before it hashes anything.
  it('is one bucket with the sign-in that follows: a sign-in after twenty requests is refused before anything is verified', async () => {
    const subject = await enrolledRider(routes, hasher);
    for (let index = 0; index < 20; index += 1) {
      expect((await requestChallenge(routes, subject.rider.phone)).status).toBe(200);
    }
    const challenge = challengeOf(
      await native(routes).post(CHALLENGE_URL, { phone: '+99955500004' }, { origin: null }),
    );

    const refused = await post(routes, {
      phone: subject.rider.phone,
      pin: PIN,
      challenge,
      device_signature: 'AAAAAAAAAAAA',
      client_root_signal: 'UNKNOWN',
    });

    expect([refused.status, codeOf(refused)]).toEqual([429, 'RATE_LIMITED']);
    // Not verified and not counted: the challenge it presented is untouched.
    expect((await challengeRowFor(challenge))?.state).toBe('PENDING');
  });
});

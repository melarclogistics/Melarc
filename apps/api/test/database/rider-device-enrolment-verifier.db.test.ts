import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { parseEnrolmentUri } from '../../src/platform/auth/rider/enrolment-uri.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { deviceKey, insertRider, riderRow, type RiderRow } from './support/riders.js';
import {
  API,
  HUB_A,
  OPS,
  codeOf,
  startStaffRoutes,
  uuid,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.57 (AC-SLICE-000-55, -69): `completeRiderDeviceEnrolment` through the **production** verifier adapter (`ATTESTATION_VERIFIER=service`),
 * against a stand-in for the private service on a loopback port. What this proves is the application's, on the wire: that a verifier which is
 * unreachable, overloaded, late or stale is `503 TRUST_DATA_UNAVAILABLE` with a `Retry-After`, nothing written and the grant not consumed
 * (*in a deployed environment*, with the adapter a deployment is given and not the substitute); that what the service decided is returned as it
 * decided it; that the request to the service holds the evidence and nothing else (no token, no PIN); and that a handset is enrolled when, and
 * only when, the service says `VERIFIED` for the key it was asked about. That the service decides correctly is the JVM's, against chains it
 * did not make itself (`rider-device-enrolment-attested.db.test.ts`).
 */
const ENROL = `${API}/auth/rider/device/enrol`;
const REGISTER = (id: string) => `${API}/ops/riders/${id}/device/register`;
const PIN = '264817';

interface Seen {
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}
type Behaviour = (seen: Seen, request: IncomingMessage, response: ServerResponse) => void;

const servers: Server[] = [];
const hung: ServerResponse[] = [];
let behaviour: Behaviour = () => undefined;
const requests: Seen[] = [];
let routes: StaffRoutes;
let metrics: BoundedMetrics;
let counter = 0;

async function stand(): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const seen: Seen = {
        url: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>,
      };
      requests.push(seen);
      behaviour(seen, request, response);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};
const answering =
  (status: number, body: unknown): Behaviour =>
  (_seen, _request, response) => {
    json(response, status, body);
  };
const verdict = (body: Record<string, unknown>): Behaviour =>
  answering(200, { version: 1, ...body });
const SUMMARY = {
  security_level: 'STRONG_BOX',
  attestation_version: 300,
  key_mint_version: 300,
  package_name: 'com.melarc.rider',
  signer_digests: ['ab'.repeat(32)],
};
const verified: Behaviour = (seen, _request, response) => {
  json(response, 200, {
    version: 1,
    verdict: 'VERIFIED',
    attested_public_key: seen.body.device_public_key,
    summary: SUMMARY,
  });
};

beforeAll(async () => {
  const port = await stand();
  metrics = new BoundedMetrics({ policy: 'throw', clock: new SystemClock() });
  routes = await startStaffRoutes({
    metrics,
    env: {
      ATTESTATION_VERIFIER: 'service',
      ATTESTATION_VERIFIER_URL: `http://127.0.0.1:${String(port)}`,
      ATTESTATION_VERIFIER_TIMEOUT_MS: '1500',
    },
  });
}, 120_000);

afterAll(async () => {
  for (const response of hung.splice(0)) response.destroy();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
    ),
  );
  await routes.stop();
});

beforeEach(() => {
  requests.length = 0;
  behaviour = verified;
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);
const counts = (): Record<string, number> =>
  Object.fromEntries(
    metrics
      .snapshot()
      .counters.map((each) => [
        `${each.name}{${Object.values(each.labels).join(',')}}`,
        each.value,
      ]),
  );

interface Started {
  readonly rider: RiderRow;
  readonly token: string;
  readonly challenge: string;
  readonly grantId: string;
}
async function started(): Promise<Started> {
  counter += 1;
  const rider = await insertRider(
    routes.admin,
    riderRow({ fullName: `Verifier rider ${String(counter)}`, hubId: HUB_A }),
  );
  const officer = await routes.seniorOps(HUB_A);
  const response = await officer.client.post(REGISTER(rider.id), undefined, {
    origin: OPS,
    headers: { 'idempotency-key': uuid() },
  });
  expect(response.status).toBe(200);
  const parsed = parseEnrolmentUri((response.json() as { enrolment_uri: string }).enrolment_uri);
  if (parsed === null) throw new Error('no enrolment URI');
  const [grant] = await rows<{ id: string }>(
    `select id from setup_grant where principal_id = $1 and state = 'PENDING'`,
    [rider.id],
  );
  return { rider, token: parsed.token, challenge: parsed.challenge, grantId: grant?.id ?? '' };
}
const enrol = (
  grant: Started,
  key = deviceKey().publicKey,
  chain: readonly string[] = ['MIIB-leaf', 'MIIB-intermediate', 'MIIB-root'],
): Promise<TestResponse> =>
  routes.kit.client.fork().post(
    ENROL,
    {
      setup_token: grant.token,
      public_key: key,
      pin: PIN,
      key_attestation: { certificate_chain: [...chain] },
    },
    { origin: null },
  );
const devicesOf = (riderId: string) =>
  rows<{ id: string; status: string; public_key: string }>(
    `select id, status, public_key from registered_device where rider_identity_id = $1`,
    [riderId],
  );
const grantState = async (id: string): Promise<string | undefined> =>
  (await rows<{ state: string }>(`select state from setup_grant where id = $1`, [id]))[0]?.state;
const eventDetail = async (riderId: string, code: string): Promise<Record<string, unknown>> =>
  (
    await rows<{ detail: Record<string, unknown> }>(
      `select detail from audit_event where actor_type = 'RIDER' and actor_id = $1 and event_code = $2`,
      [riderId, code],
    )
  )[0]?.detail ?? {};

/** Nothing changed for the rider: no device, a grant that is still good, no PIN, no event about a device. */
async function expectUntouched(grant: Started): Promise<void> {
  expect(await devicesOf(grant.rider.id)).toEqual([]);
  expect(await grantState(grant.grantId)).toBe('PENDING');
  expect(
    (
      await rows<{ pin_hash: string | null }>(`select pin_hash from rider_identity where id = $1`, [
        grant.rider.id,
      ])
    )[0]?.pin_hash,
  ).toBeNull();
  expect(
    await rows(
      `select 1 from audit_event where actor_type = 'RIDER' and actor_id = $1 and event_code = 'auth.device.attestation_failed'`,
      [grant.rider.id],
    ),
  ).toEqual([]);
}

describe('what the application asks of the private service', () => {
  // Break caught: the request to the service carrying more than the evidence (the token, the PIN), the challenge itself, a member the
  // service does not know, or the wrong hash of the challenge.
  it('sends the chain, the submitted key and the hash of the issued challenge, and nothing else', async () => {
    const grant = await started();
    const key = deviceKey().publicKey;

    const response = await enrol(grant, key, ['AAAA', 'BBBB']);

    expect(response.status).toBe(200);
    expect(requests).toHaveLength(1);
    const asked = requests[0];
    expect(asked?.url).toBe('/v1/verify');
    expect(Object.keys(asked?.body ?? {}).toSorted()).toEqual([
      'certificate_chain',
      'device_public_key',
      'expected_challenge_sha256',
      'version',
    ]);
    expect(asked?.body).toMatchObject({
      version: 1,
      certificate_chain: ['AAAA', 'BBBB'],
      device_public_key: key,
      expected_challenge_sha256: createHash('sha256')
        .update(Buffer.from(grant.challenge, 'base64url'))
        .digest('hex'),
    });
    const sent = JSON.stringify(asked?.body);
    for (const secret of [grant.token, grant.challenge, PIN]) expect(sent).not.toContain(secret);
    // A local run on loopback holds no caller secret, and sends no Authorization (a deployment's requires one: load-config.test.ts).
    expect(asked?.headers.authorization).toBeUndefined();
    expect(counts()['attestation_verifier_calls_total{VERIFIED}']).toBeGreaterThanOrEqual(1);
  });
});

describe('what the service decided is the answer, as it decided it', () => {
  // Break caught: a verdict relabelled on its way (an integrity failure told as an unsupported handset or as unavailable), the cause class
  // lost from the ledger or told to the caller, or a refusal that leaves a device, a spent grant, a PIN.
  it.each([
    [
      'DEVICE_INTEGRITY_FAILED',
      { verdict: 'DEVICE_INTEGRITY_FAILED', cause: 'CHALLENGE_MISMATCH' },
      'CHALLENGE_MISMATCH',
    ],
    ['DEVICE_SECURITY_UNSUPPORTED', { verdict: 'DEVICE_SECURITY_UNSUPPORTED' }, null],
  ])('answers %s as 422, records it and leaves the grant good', async (code, body, cause) => {
    const grant = await started();
    behaviour = verdict(body);

    const response = await enrol(grant);

    expect([response.status, codeOf(response)]).toEqual([422, code]);
    expect(await devicesOf(grant.rider.id)).toEqual([]);
    expect(await grantState(grant.grantId)).toBe('PENDING');
    const detail = await eventDetail(grant.rider.id, 'auth.device.attestation_failed');
    expect(detail).toMatchObject({ verdict: code });
    if (cause !== null) {
      expect(detail).toMatchObject({ cause });
      expect(response.text).not.toContain(cause);
    }
  });

  // Break caught (the decision recorded in SECURITY_DESIGN.md section 15.2.3): a chain too big for the service to read, which the caller
  // chooses up to the API's own body limit, answered as a fault of ours (a 500 for anyone who asks) and not as the malformed evidence it is.
  it('answers a chain the service will not read for its size as a malformed chain, not as a fault', async () => {
    const grant = await started();
    behaviour = answering(413, { version: 1, error: 'REQUEST_TOO_LARGE', field: 'body' });

    const response = await enrol(
      grant,
      deviceKey().publicKey,
      Array.from({ length: 10 }, () => 'A'.repeat(9_000)),
    );

    expect([response.status, codeOf(response)]).toEqual([422, 'DEVICE_INTEGRITY_FAILED']);
    expect(await eventDetail(grant.rider.id, 'auth.device.attestation_failed')).toMatchObject({
      cause: 'EVIDENCE_MALFORMED',
    });
    expect(await devicesOf(grant.rider.id)).toEqual([]);
    expect(await grantState(grant.grantId)).toBe('PENDING');
  });

  // Break caught: a service that breaks its interface read as a verdict about the handset, or enrolled; the break not counted as one.
  it.each([
    ['a refusal of the request itself', answering(400, { version: 1, error: 'BAD' })],
    ['an answer that is not a verdict', answering(200, { hello: 'world' })],
    [
      'a VERIFIED for another key than the one it was asked about',
      answering(200, {
        version: 1,
        verdict: 'VERIFIED',
        attested_public_key: deviceKey().publicKey,
        summary: SUMMARY,
      }),
    ],
  ])('answers a 500 for %s, enrols nothing and counts a broken interface', async (_label, make) => {
    const grant = await started();
    behaviour = make;
    const before = counts()['attestation_verifier_calls_total{INTERFACE_BROKEN}'] ?? 0;

    const response = await enrol(grant);

    expect(response.status).toBe(500);
    expect(codeOf(response)).toBeUndefined();
    await expectUntouched(grant);
    expect(counts()['attestation_verifier_calls_total{INTERFACE_BROKEN}']).toBe(before + 1);
  });

  // Break caught: a handset enrolled on anything but the service's VERIFIED for the key it submitted, or a summary taken from the request.
  it('registers the key the service verified, and records the summary of the service’s answer', async () => {
    const grant = await started();
    const key = deviceKey().publicKey;

    const response = await enrol(grant, key);

    expect(response.status).toBe(200);
    expect((await devicesOf(grant.rider.id)).map((each) => each.public_key)).toEqual([key]);
    expect(await eventDetail(grant.rider.id, 'auth.device.registered')).toMatchObject({
      security_level: 'STRONG_BOX',
      package_name: 'com.melarc.rider',
      signer_fingerprints: 'ab'.repeat(8),
    });
  });
});

describe('a deployed environment whose verifier cannot decide: 503 TRUST_DATA_UNAVAILABLE, nothing written, the grant not consumed', () => {
  // Break caught (AC-55, AC-69): a verifier that cannot answer read as a verdict about the device, or an enrolment that goes through without
  // it; or a refusal that leaves a device, a spent grant, a PIN or an event.
  it.each([
    [
      'overloaded (the service’s own refusal)',
      answering(503, {
        version: 1,
        verdict: 'TRUST_DATA_UNAVAILABLE',
        cause: 'VERIFIER_OVERLOADED',
      }),
      'VERIFIER_OVERLOADED',
    ],
    [
      'holding stale trust data',
      verdict({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_DATA_STALE' }),
      'TRUST_DATA_STALE',
    ],
    [
      'holding no trust data yet',
      verdict({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_DATA_NOT_LOADED' }),
      'TRUST_DATA_NOT_LOADED',
    ],
    [
      'unable to load its accepted roots',
      verdict({ verdict: 'TRUST_DATA_UNAVAILABLE', cause: 'TRUST_ROOTS_UNLOADABLE' }),
      'TRUST_ROOTS_UNLOADABLE',
    ],
    [
      'behind a gateway that answers 502',
      (_seen: Seen, _request: IncomingMessage, response: ServerResponse) => {
        response.writeHead(502, { 'Content-Type': 'text/html' });
        response.end('<html>bad gateway</html>');
      },
      'VERIFIER_UNREACHABLE',
    ],
    [
      'late (it does not answer inside the time-out)',
      (_seen: Seen, _request: IncomingMessage, response: ServerResponse) => {
        hung.push(response);
      },
      'VERIFIER_TIMEOUT',
    ],
  ])(
    'answers 503 when the verifier is %s',
    async (_label, make, cause) => {
      const grant = await started();
      behaviour = make;

      const response = await enrol(grant);

      expect([response.status, codeOf(response)]).toEqual([503, 'TRUST_DATA_UNAVAILABLE']);
      expect(response.header('retry-after')).toBe('60');
      expect(response.text).not.toContain(cause);
      await expectUntouched(grant);
      expect(counts()[`attestation_verifier_unavailable_total{${cause}}`]).toBeGreaterThanOrEqual(
        1,
      );
      // And once the service can decide, the same completion succeeds with the same grant.
      behaviour = verified;
      expect((await enrol(grant)).status).toBe(200);
    },
    30_000,
  );

  // This one stops the stand-in, so it is the last: the application is bound to its port, and a refused connection is that port with nobody
  // listening.
  it('answers 503 when nobody is listening where the verifier is meant to be', async () => {
    const grant = await started();
    const only = servers[0];
    await new Promise<void>((done) => {
      only?.closeAllConnections();
      only?.close(() => {
        done();
      });
    });

    const response = await enrol(grant);

    expect([response.status, codeOf(response)]).toEqual([503, 'TRUST_DATA_UNAVAILABLE']);
    expect(response.header('retry-after')).toBe('60');
    await expectUntouched(grant);
    expect(
      counts()['attestation_verifier_unavailable_total{VERIFIER_UNREACHABLE}'],
    ).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

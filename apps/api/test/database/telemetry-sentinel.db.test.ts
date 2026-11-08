import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SystemClock } from '../../src/platform/auth/clock/system.clock.adapter.js';
import { normaliseNewCredential } from '../../src/platform/auth/credentials/credential-rule.js';
import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import { BoundedMetrics } from '../../src/platform/metrics/bounded.metrics.adapter.js';
import { renderExposition } from '../../src/platform/metrics/exposition.js';
import { TestClient, type TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow } from './support/identities.js';
import { attempt, enrolledRider } from './support/rider-sign-in.js';
import { API, codeOf, OPS, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { insertDevice, insertVendor, vendorRow } from './support/vendors.js';

/**
 * The Family U sentinel across the sinks this slice has (S0.66; standards/security-test-matrix.md section 23: `GBT-U1`, `GBT-U2`, `GBT-U3`,
 * `GBT-U4`, `GBT-U5`, `GBT-U6`, `GBT-U7` and `GBT-U10`; plan
 * OB-23): secrets are sent in requests that succeed and in requests that fail, and the secrets the API itself issues (a session credential
 * and its synchronizer token) are collected, and **no sink holds any of them**: the API's log, the audit ledger, the metrics the private
 * endpoint serves, and every error answer (which may not even repeat the secret its own request carried).
 *
 * The other sinks are held where they live: the delivery worker's log and its stderr (`delivery-worker-runtime.test.ts`,
 * `delivery-worker.process.test.ts`), the stored rows (`secret-columns.db.test.ts`, the stores' own tests), the source archive
 * (`scripts/package-source.test.ts`) and the browser (`secret-hygiene.test.tsx`, `evidence-canary.secret.test.ts`). This slice has no
 * tracing (no span or APM agent is composed), so there is no trace to search; the capture sink of a local run holds each message whole by
 * design (the stand-in for a provider) and is not a sink of telemetry.
 */

const token = (): string => randomBytes(32).toString('base64url');
const PASSWORD_RIGHT = `Sentinel-pass-${token().slice(0, 12)}`;
const PASSWORD_WRONG = `Sentinel-wrong-${token().slice(0, 12)}`;
const VENDOR_SECRET = `Sentinel-vendor-${token().slice(0, 12)}`;
const PLANTED = {
  setupToken: token(),
  setupPassword: `Sentinel-setup-${token().slice(0, 12)}`,
  recoveryToken: token(),
  recoveryCredential: `Sentinel-recovery-${token().slice(0, 12)}`,
  csrf: token(),
  bearer: token(),
  vendorDevice: token(),
  vendorWrongSecret: `Sentinel-vendor-wrong-${token().slice(0, 8)}`,
  totp: '914372',
  /** A wrong PIN, sent with a signature that is right. */
  pin: '583961',
  /** The PIN the rider holds, sent when the sign-in is meant to succeed. */
  riderPin: '739204',
};
const VENDOR_ORIGIN = 'http://127.0.0.1:5174';

let routes: StaffRoutes;
const metrics = new BoundedMetrics({ policy: 'throw', clock: new SystemClock() });
/** Every answer a request that failed was given, with the secrets its request carried. */
const failures: { readonly response: TestResponse; readonly carried: readonly string[] }[] = [];
/** The secrets that went somewhere a sink could have copied them: planted, set by a person, or issued by the API. */
const secrets: string[] = [
  PASSWORD_RIGHT,
  PASSWORD_WRONG,
  VENDOR_SECRET,
  ...Object.values(PLANTED),
];

/**
 * Whether `text` holds `secret`. A long secret is looked for as it is. A short one (a PIN, a code of six digits) is looked for as a whole
 * token: six digits are in a timestamp or an identifier by chance often enough to fail a run, and a leak of one looks like a token
 * (`"pin":"583961"`, `pin=583961`), with something that is not a letter or a digit on each side.
 */
const holds = (text: string, secret: string): boolean =>
  secret.length >= 16
    ? text.includes(secret)
    : new RegExp(
        `(?<![0-9A-Za-z])${secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9A-Za-z])`,
      ).test(text);

/**
 * A request that was meant to fail, with the refusal it is meant to fail with: a request that failed for the wrong reason (a body the
 * validation refused before any code looked at the secret) searched nothing.
 */
const failed = (
  response: TestResponse,
  carried: readonly string[],
  expected: readonly [status: number, code: string],
): void => {
  expect([response.status, codeOf(response)], 'the request was meant to fail like this').toEqual(
    expected,
  );
  failures.push({ response, carried });
};

beforeAll(async () => {
  routes = await startStaffRoutes({ metrics });
  const hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
  const ops = (): TestClient => new TestClient({ baseUrl: routes.kit.app.baseUrl, origin: OPS });

  // Staff sign-in, both outcomes (U1, U3, U7), and an unsafe request with the right and the wrong synchronizer token (U2).
  const checked = normaliseNewCredential(PASSWORD_RIGHT);
  if (!checked.ok) throw new Error('the arranged password is not one a person could set');
  const member = await insertStaff(
    routes.admin,
    staffRow({
      roleBundleId: BUNDLE_IDS.opsStaff,
      credentialHash: await hasher.hash('STAFF_PASSWORD', checked.credential),
    }),
  );
  failed(
    await ops().post(`${API}/auth/staff/sign-in`, {
      email: member.workEmail,
      password: PASSWORD_WRONG,
    }),
    [PASSWORD_WRONG],
    [422, 'INVALID_CREDENTIALS'],
  );
  const browser = ops();
  const signedIn = await browser.post(`${API}/auth/staff/sign-in`, {
    email: member.workEmail,
    password: PASSWORD_RIGHT,
  });
  expect(signedIn.status).toBe(200);
  const session = browser.cookie('melarc_session');
  const csrf = browser.cookie('melarc_csrf');
  if (session === undefined || csrf === undefined) throw new Error('the sign-in set no session');
  secrets.push(session, csrf);
  expect((await browser.get(`${API}/auth/session`)).status).toBe(200);
  failed(
    await browser.delete(`${API}/auth/session`, { csrf: PLANTED.csrf }),
    [PLANTED.csrf, session],
    [403, 'CSRF_VALIDATION_FAILED'],
  );
  expect((await browser.delete(`${API}/auth/session`)).status).toBe(204);

  // A bearer credential that is no session (U1, U7), a second factor (U4), credential setup and recovery (U3, U5). These four are
  // refused requests only: a second factor, a setup grant and a recovery request that are valid need the arrangements of their own
  // journeys, which do not search the sinks (the matrix, section 31.2a, says so).
  failed(
    await new TestClient({ baseUrl: routes.kit.app.baseUrl })
      .bearer(PLANTED.bearer)
      .get(`${API}/auth/session`),
    [PLANTED.bearer],
    [401, 'SESSION_INVALID'],
  );
  failed(
    await ops().post(`${API}/auth/staff/sign-in/mfa`, {
      challenge_id: randomUUID(),
      code: PLANTED.totp,
    }),
    [PLANTED.totp],
    [422, 'CHALLENGE_UNUSABLE'],
  );
  failed(
    await ops().post(`${API}/auth/staff/setup/credential`, {
      setup_token: PLANTED.setupToken,
      password: PLANTED.setupPassword,
    }),
    [PLANTED.setupToken, PLANTED.setupPassword],
    [422, 'SETUP_GRANT_INVALID'],
  );
  failed(
    await ops().post(`${API}/auth/recovery/complete`, {
      token: PLANTED.recoveryToken,
      new_credential: PLANTED.recoveryCredential,
    }),
    [PLANTED.recoveryToken, PLANTED.recoveryCredential],
    [422, 'RECOVERY_TOKEN_INVALID'],
  );

  // Vendor sign-in, both outcomes (U6, U3, U7).
  const vendorChecked = normaliseNewCredential(VENDOR_SECRET);
  if (!vendorChecked.ok) throw new Error('the arranged secret is not one a vendor could set');
  const vendor = await insertVendor(
    routes.admin,
    vendorRow({ secretHash: await hasher.hash('VENDOR_SECRET', vendorChecked.credential) }),
  );
  const device = await insertDevice(routes.admin, vendor.accountId);
  secrets.push(device.credential.token);
  const stranger = new TestClient({ baseUrl: routes.kit.app.baseUrl, origin: VENDOR_ORIGIN });
  stranger.seed('melarc_vendor_device', PLANTED.vendorDevice);
  failed(
    await stranger.post(`${API}/auth/vendor/sign-in`, {
      account_identifier: vendor.accountIdentifier,
      secret: PLANTED.vendorWrongSecret,
    }),
    [PLANTED.vendorDevice, PLANTED.vendorWrongSecret],
    [422, 'INVALID_CREDENTIALS'],
  );
  const registered = new TestClient({ baseUrl: routes.kit.app.baseUrl, origin: VENDOR_ORIGIN });
  registered.seed('melarc_vendor_device', device.credential.token);
  const vendorIn = await registered.post(`${API}/auth/vendor/sign-in`, {
    account_identifier: vendor.accountIdentifier,
    secret: VENDOR_SECRET,
  });
  expect(vendorIn.status).toBe(200);
  const vendorSession = registered.cookie('melarc_session');
  if (vendorSession !== undefined) secrets.push(vendorSession);

  // Rider sign-in, both outcomes (U3, U10), from a device whose key never leaves the test. The signature is a real one, made here from the
  // protocol's published words, so that the PIN is judged: a wrong PIN under a right signature is refused as the PIN, and the right PIN
  // under it signs in, and the bearer credential the sign-in answers once is a secret like the others.
  const enrolled = await enrolledRider(routes, hasher, { pin: PLANTED.riderPin });
  const riderKey = enrolled.device?.key.privateKey;
  if (riderKey === undefined) throw new Error('the arranged rider holds a device');
  secrets.push(riderKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'));
  const subject = { phone: enrolled.rider.phone, key: riderKey };
  const refusedRider = await attempt(routes, { ...subject, pin: PLANTED.pin });
  failed(refusedRider.response, [PLANTED.pin], [422, 'INVALID_CREDENTIALS']);
  const riderIn = await attempt(routes, { ...subject, pin: PLANTED.riderPin });
  expect(riderIn.response.status).toBe(200);
  const { access_token: riderToken } = riderIn.response.json() as { access_token: string };
  secrets.push(riderToken);
});

afterAll(async () => {
  await routes.stop();
});

describe('no sink holds a secret, whether the request succeeded or failed (Family U)', () => {
  it('was given secrets of every kind to look for, and requests that succeeded and failed to carry them', () => {
    expect(secrets.length).toBeGreaterThanOrEqual(18);
    expect(failures.length).toBe(8);
  });

  // Break caught: a search that cannot find what it looks for, so that every sink below is "clean" because the search is blind.
  it('finds a secret where a leak would put it, and a short one only as a token', () => {
    expect(holds(`{"pin":"${PLANTED.pin}"}`, PLANTED.pin)).toBe(true);
    expect(holds(`pin=${PLANTED.pin}&x=1`, PLANTED.pin)).toBe(true);
    expect(holds(`Cookie: melarc_session=${PASSWORD_RIGHT}`, PASSWORD_RIGHT)).toBe(true);
    expect(holds(`2026-10-28T17:30:12.${PLANTED.pin}Z`, PLANTED.pin)).toBe(false);
    expect(holds(`17616702125${PLANTED.pin}`, PLANTED.pin)).toBe(false);
    expect(holds('nothing of the kind', PASSWORD_RIGHT)).toBe(false);
  });

  // Break caught: a logger that writes a body, a header or a cookie as it arrived, on either outcome.
  it('the API’s log', () => {
    const log = routes.kit.app.logs.text();
    expect(log.length).toBeGreaterThan(0);
    for (const secret of secrets) expect(holds(log, secret), 'a secret in the log').toBe(false);
  });

  // Break caught: an audit event that records what was typed, a token, or a credential in its facts or its before and after.
  it('the audit ledger', async () => {
    const rows = await routes.rows<{ text: string | null }>(
      `select string_agg(to_jsonb(a)::text, chr(10)) as text from audit_event a`,
    );
    const ledger = rows[0]?.text ?? '';
    expect(ledger.length).toBeGreaterThan(0);
    for (const secret of secrets)
      expect(holds(ledger, secret), 'a secret in the audit ledger').toBe(false);
  });

  it('the metrics the private endpoint serves', () => {
    const exposition = renderExposition(metrics.snapshot(), []);
    for (const secret of secrets)
      expect(holds(exposition, secret), 'a secret in the metrics').toBe(false);
  });

  // Break caught: an error answer that repeats what the request carried (a validation detail quoting a value, a message built from input).
  it('every error answer, which repeats nothing its request carried', () => {
    for (const { response, carried } of failures) {
      const answer = `${String(response.status)}\n${JSON.stringify(response.headerEntries())}\n${response.text}`;
      for (const secret of [...carried, ...secrets]) {
        expect(
          holds(answer, secret),
          `the answer of a ${String(response.status)} repeats a secret`,
        ).toBe(false);
      }
    }
  });
});

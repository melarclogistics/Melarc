import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { codeOf, OPS } from './support/staff-routes.js';
import {
  HUB_A,
  VENDOR,
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S0.49, the vendor's own browsers, against the real application and a real PostgreSQL (`AC-SLICE-000-45`, `-100`): a signed-in browser asks
 * for a grant that registers another, which travels to the delivery channel with the account identifier; the new browser consumes it and is
 * given its own credential and no session; the vendor lists every browser it has held and revokes one it is not using, with the version it
 * read. The grant's limit is the authenticated account's, in the recovery bucket. Every request goes through HTTP from the Vendor origin;
 * what the application did is read from a second connection.
 */
const GRANT = '/api/v1/auth/vendor/device/grant';
const ENROL = '/api/v1/auth/vendor/device/enrol';
const DEVICES = '/api/v1/auth/vendor/devices';
const REVOKE = (id: string) => `${DEVICES}/${id}/revoke`;

let routes: VendorRoutes;

beforeAll(async () => {
  routes = await startVendorRoutes();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

async function signedIn(overrides = {}): Promise<{ vendor: ArrangedVendor; client: TestClient }> {
  const vendor = await routes.vendor(overrides);
  const client = routes.browser(vendor.device.credential.token);
  const response = await routes.signIn(client, vendor.row.accountIdentifier, vendor.secret);
  expect(response.status).toBe(200);
  return { vendor, client };
}

const requestGrant = (client: TestClient, key: string = randomUUID()): Promise<TestResponse> =>
  client.post(GRANT, undefined, { headers: { 'Idempotency-Key': key } });

async function grantsOf(vendor: ArrangedVendor): Promise<{ id: string; state: string }[]> {
  return rows(
    `select id, state from setup_grant where principal_id = $1 and purpose = 'VENDOR_DEVICE_ENROLMENT' order by issued_at`,
    [vendor.row.accountId],
  );
}

const sessionsOf = (vendor: ArrangedVendor) =>
  rows<{ registered_device_id: string; termination_reason: string | null }>(
    `select registered_device_id, termination_reason from session where principal_id = $1 order by issued_at`,
    [vendor.row.accountId],
  );

describe('another browser, without a new secret (AC-SLICE-000-45)', () => {
  // Break caught: a grant delivered anywhere but the registered channel, without the identifier, or one that ends the session asking.
  it('queues a grant to the delivery channel with the account identifier, and leaves the asking session alone', async () => {
    const { vendor, client } = await signedIn();

    const answer = await requestGrant(client);

    expect(answer.status).toBe(202);
    expect(answer.text).toBe('');
    const [grant] = await grantsOf(vendor);
    expect(grant?.state).toBe('PENDING');
    const message = await routes.deliveredFor(routes.admin, grant?.id ?? '');
    expect(message?.destination).toBe(vendor.row.recoveryEmail);
    expect(message?.accountIdentifier).toBe(vendor.row.accountIdentifier);
    expect(message?.link.startsWith(`${VENDOR}/setup/device#`)).toBe(true);
    expect(
      await rows(`select kind from credential_delivery_job where redemption_record_id = $1`, [
        grant?.id,
      ]),
    ).toEqual([{ kind: 'DEVICE_GRANT' }]);
    expect((await client.get('/api/v1/auth/session')).status).toBe(200);
    expect(
      await rows(
        `select actor_type from audit_event where event_code = 'auth.setup_grant.issued' and object_id = $1`,
        [grant?.id],
      ),
    ).toEqual([{ actor_type: 'VENDOR_ACCOUNT' }]);
  });

  // Break caught: a retried request issuing a second grant (and superseding the first, which the vendor may already be using).
  it('answers a retry with the same key as the first answer, and issues nothing more', async () => {
    const { vendor, client } = await signedIn();
    const key = randomUUID();
    expect((await requestGrant(client, key)).status).toBe(202);
    expect((await requestGrant(client, key)).status).toBe(202);
    expect(await grantsOf(vendor)).toHaveLength(1);
    // A new key is a new request: it supersedes the earlier grant.
    expect((await requestGrant(client)).status).toBe(202);
    expect((await grantsOf(vendor)).map((grant) => grant.state)).toEqual(['SUPERSEDED', 'PENDING']);
  });

  it('registers the new browser with its own credential and no session, and lets it sign in, displacing the first', async () => {
    const { vendor, client } = await signedIn();
    expect((await requestGrant(client)).status).toBe(202);
    const [grant] = await grantsOf(vendor);
    const message = await routes.deliveredFor(routes.admin, grant?.id ?? '');
    const fresh = routes.browser();

    const enrolled = await fresh.post(ENROL, { setup_token: message?.token });

    expect(enrolled.status).toBe(200);
    const device = enrolled.json() as { id: string; status: string; principal_id: string };
    expect(device).toMatchObject({ status: 'ACTIVE', principal_id: vendor.row.accountId });
    const cookie = enrolled.setCookies.find((each) => each.name === 'melarc_vendor_device');
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, maxAge: 34_560_000 });
    expect(enrolled.setCookies.map((each) => each.name)).toEqual(['melarc_vendor_device']);
    expect(await sessionsOf(vendor)).toEqual([
      { registered_device_id: vendor.device.id, termination_reason: null },
    ]);
    expect((await client.get('/api/v1/auth/session')).status).toBe(200);
    // The secret is the same one.
    expect(
      await rows(
        `select credential_generation from vendor_credential where vendor_account_id = $1`,
        [vendor.row.accountId],
      ),
    ).toEqual([{ credential_generation: '1' }]);

    const signIn = await routes.signIn(fresh, vendor.row.accountIdentifier, vendor.secret);
    expect(signIn.status).toBe(200);
    expect((await sessionsOf(vendor)).map((session) => session.termination_reason)).toEqual([
      'SUPERSEDED_BY_NEW_LOGIN',
      null,
    ]);
    const again = await routes.browser().post(ENROL, { setup_token: message?.token });
    expect([again.status, codeOf(again)]).toEqual([422, 'SETUP_GRANT_INVALID']);
  });

  it('limits the grant to ten a minute for the account, every request counted', async () => {
    const { client } = await signedIn();
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      expect((await requestGrant(client)).status).toBe(202);
    }
    const limited = await requestGrant(client);
    expect([limited.status, codeOf(limited)]).toEqual([429, 'RATE_LIMITED']);
    // The vendor holds a session, so this refusal tells it when to come back like every other one it can be given (A2 of the audit; AC-SLICE-000-131):
    // whole seconds inside the 60-second window, and never nought.
    const wait = limited.header('retry-after');
    expect(wait).toMatch(/^[1-9][0-9]?$/);
    expect(Number(wait)).toBeLessThanOrEqual(60);
  });

  it('refuses a request with no Idempotency-Key, one without the synchronizer token, and one from another origin', async () => {
    const { client } = await signedIn();
    const noKey = await client.post(GRANT);
    expect([noKey.status, codeOf(noKey)]).toEqual([400, 'VALIDATION_FAILED']);
    const noToken = await client.post(GRANT, undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
      csrf: 'omit',
    });
    expect([noToken.status, codeOf(noToken)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
    const foreign = await client.post(GRANT, undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
      origin: OPS,
    });
    expect([foreign.status, codeOf(foreign)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
  });

  it('refuses a staff session at the surface', async () => {
    const admin = await routes.platformAdmin();
    const answer = await admin.client.post(GRANT, undefined, {
      headers: { 'Idempotency-Key': randomUUID() },
      origin: OPS,
    });
    expect([answer.status, codeOf(answer)]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('the vendor’s browsers (AC-SLICE-000-100)', () => {
  async function listed(
    client: TestClient,
  ): Promise<{ devices: { id: string; status: string }[]; etag: string }> {
    const response = await client.get(DEVICES);
    expect(response.status).toBe(200);
    const etag = response.header('etag');
    if (etag === null) throw new Error('the list carries no ETag');
    return { devices: response.json() as { id: string; status: string }[], etag };
  }

  it('lists every browser it has held, an ended one included, with the version of the set', async () => {
    const { vendor, client } = await signedIn();
    const second = await routes.anotherDevice(vendor);
    const ended = await routes.anotherDevice(vendor, { status: 'REVOKED' });
    const { devices, etag } = await listed(client);
    expect(devices.map((device) => device.id).toSorted()).toEqual(
      [vendor.device.id, second.id, ended.id].toSorted(),
    );
    expect(etag).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(JSON.stringify(devices)).not.toContain(vendor.device.credential.token);
  });

  // Break caught: a revocation that rotates the secret, ends the caller, takes a stale version, or reaches another vendor's browser.
  it('revokes another browser with the version it read, and leaves the secret and the session in use', async () => {
    const { vendor, client } = await signedIn();
    const second = await routes.anotherDevice(vendor);
    const { etag } = await listed(client);

    const revoked = await client.post(REVOKE(second.id), undefined, {
      headers: { 'If-Match': etag },
    });

    expect(revoked.status).toBe(200);
    expect(revoked.json()).toMatchObject({ id: second.id, status: 'REVOKED' });
    expect(revoked.header('etag')).not.toBe(etag);
    expect(revoked.header('etag')).toBe((await listed(client)).etag);
    expect(await rows(`select status from registered_device where id = $1`, [second.id])).toEqual([
      { status: 'REVOKED' },
    ]);
    expect((await client.get('/api/v1/auth/session')).status).toBe(200);
    expect(
      await rows(
        `select enhanced, actor_type from audit_event where event_code = 'auth.device.revoked' and object_id = $1`,
        [second.id],
      ),
    ).toEqual([{ enhanced: true, actor_type: 'VENDOR_ACCOUNT' }]);
    // The revoked browser can no longer sign in.
    const after = await routes.signIn(
      routes.browser(second.credential.token),
      vendor.row.accountIdentifier,
      vendor.secret,
    );
    expect([after.status, codeOf(after)]).toEqual([422, 'INVALID_CREDENTIALS']);
  });

  it('refuses the browser in use, a stale version and a browser already ended with STATE_CONFLICT', async () => {
    const { vendor, client } = await signedIn();
    const ended = await routes.anotherDevice(vendor, { status: 'REVOKED' });
    const { etag } = await listed(client);
    for (const [id, version] of [
      [vendor.device.id, etag],
      [ended.id, etag],
      [vendor.device.id, '"stale"'],
    ] as const) {
      const answer = await client.post(REVOKE(id), undefined, { headers: { 'If-Match': version } });
      expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    }
    expect(
      await rows(`select status from registered_device where id = $1`, [vendor.device.id]),
    ).toEqual([{ status: 'ACTIVE' }]);
  });

  // Break caught: a revocation that compares no version, so a vendor acting on a list another browser has since changed ends the wrong one.
  it('refuses a browser it could revoke when the version is stale, and ends nothing', async () => {
    const { vendor, client } = await signedIn();
    const second = await routes.anotherDevice(vendor);
    const { etag: before } = await listed(client);
    await routes.anotherDevice(vendor);

    const answer = await client.post(REVOKE(second.id), undefined, {
      headers: { 'If-Match': before },
    });

    expect([answer.status, codeOf(answer)]).toEqual([409, 'STATE_CONFLICT']);
    expect(await rows(`select status from registered_device where id = $1`, [second.id])).toEqual([
      { status: 'ACTIVE' },
    ]);
  });

  it('answers another vendor’s browser exactly as one that does not exist', async () => {
    const { client } = await signedIn();
    const { etag } = await listed(client);
    const theirs = await client.post(REVOKE((await routes.vendor()).device.id), undefined, {
      headers: { 'If-Match': etag },
    });
    const none = await client.post(REVOKE(randomUUID()), undefined, {
      headers: { 'If-Match': etag },
    });
    expect([theirs.status, codeOf(theirs)]).toEqual([404, 'NOT_FOUND']);
    expect({ ...(theirs.json() as object), request_id: undefined }).toEqual({
      ...(none.json() as object),
      request_id: undefined,
    });
  });

  it('refuses a staff session at the surface', async () => {
    const senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
    const answer = await senior.client.get(DEVICES);
    expect([answer.status, codeOf(answer)]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

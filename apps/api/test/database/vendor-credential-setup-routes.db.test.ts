import { createHash, randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HASHER, type Hasher } from '../../src/platform/auth/ports/hasher.port.js';
import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
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
import { waitUntilBlocked } from './support/policy-fixtures.js';
import { clientFor } from './support/test-database.js';
import { SOME_SECRET_HASH, insertVendor, vendorRow, type VendorRow } from './support/vendors.js';

/**
 * S0.47b, `reissueVendorCredentialSetup` and `completeVendorCredentialSetup` against the real application and a real PostgreSQL
 * (`AC-SLICE-000-42`, `-101`, `-97`, the grant half of `-98`): Senior Ops of the vendor's hub re-issues the setup grant of an approved
 * account that holds no secret; the message, which carries the account identifier, is queued for the credential's delivery channel and
 * an earlier pending grant is superseded; the vendor sets its own secret from the Vendor origin and its browser receives a device
 * credential in a real `Set-Cookie`. **No staff operation returns the secret, the token or the address**, and the secret is kept only as
 * an Argon2id hash. Every request goes through HTTP; what the application did is read from a second connection.
 */
const VENDOR = 'http://127.0.0.1:5174';
const REISSUE = (id: string) => `${API}/ops/vendors/${id}/credential/setup/reissue`;
const SETUP = `${API}/auth/vendor/setup/credential`;
const REASON = { reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE' };
const SECRET = 'our shared secret';

let routes: StaffRoutes;

beforeAll(async () => {
  routes = await startStaffRoutes();
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const vendor = (overrides: Partial<VendorRow> = {}): Promise<VendorRow> =>
  insertVendor(routes.admin, vendorRow({ hubId: HUB_A, ...overrides }));

async function etagOf(reader: Actor, id: string): Promise<string> {
  const response = await reader.client.get(`${API}/ops/vendors/${id}`);
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
}

async function reissue(
  actor: Actor,
  account: VendorRow,
  body: object = REASON,
): Promise<TestResponse> {
  const reader = await routes.platformAdmin();
  return actor.client.post(REISSUE(account.accountId), body, {
    origin: OPS,
    headers: { 'If-Match': await etagOf(reader, account.accountId) },
  });
}

/** A browser of the Vendor PWA: its own cookie jar, and the Vendor origin on every request. */
function browser(): TestClient {
  return routes.kit.client.fork();
}
const setUp = (
  client: TestClient,
  body: object,
  origin: string | null = VENDOR,
): Promise<TestResponse> => client.post(SETUP, body, { origin });

const rows = <T extends object>(text: string, values: unknown[] = []) =>
  routes.rows<T>(text, values);

describe('reissueVendorCredentialSetup (AC-SLICE-000-101)', () => {
  // Break caught: a re-issue that is not the approval authority's act at the vendor's hub, or whose message goes anywhere but the
  // registered delivery channel, or without the identifier the vendor signs in with.
  it('issues a fresh grant to the delivery channel, with the account identifier beside the link, and supersedes the earlier one', async () => {
    const account = await vendor();
    const senior = await routes.seniorOps(HUB_A);

    const first = await reissue(senior, account);
    expect(first.status).toBe(200);
    const grant = first.json() as Record<string, unknown>;
    expect(grant).toMatchObject({
      principal_type: 'VENDOR',
      principal_id: account.accountId,
      purpose: 'VENDOR_CREDENTIAL_SETUP',
      state: 'PENDING',
      consumed_at: null,
    });
    expect(Date.parse(String(grant.expires_at)) - Date.parse(String(grant.issued_at))).toBe(
      30 * 60_000,
    );
    // Nothing secret in the answer: no token, no address.
    expect(first.text).not.toContain(account.recoveryEmail ?? '');
    expect(Object.keys(grant).toSorted()).toEqual([
      'consumed_at',
      'expires_at',
      'id',
      'issued_at',
      'principal_id',
      'principal_type',
      'purpose',
      'state',
    ]);

    const message = await routes.deliveredFor(routes.admin, String(grant.id));
    expect(message?.destination).toBe(account.recoveryEmail);
    expect(message?.accountIdentifier).toBe(account.accountIdentifier);
    expect(message?.link.startsWith(`${VENDOR}/setup/credential#`)).toBe(true);
    const [job] = await rows<{ channel: string; principal_type: string; state: string }>(
      `select channel, principal_type, state from credential_delivery_job where redemption_record_id = $1`,
      [grant.id],
    );
    expect(job).toEqual({ channel: 'EMAIL', principal_type: 'VENDOR', state: 'QUEUED' });

    const second = await reissue(senior, account);
    expect(second.status).toBe(200);
    const next = second.json() as { id: string };
    expect(
      await rows(`select id, state from setup_grant where principal_id = $1 order by issued_at`, [
        account.accountId,
      ]),
    ).toEqual([
      { id: grant.id, state: 'SUPERSEDED' },
      { id: next.id, state: 'PENDING' },
    ]);
    expect(
      (
        await rows<{ state: string }>(
          `select state from credential_delivery_job where redemption_record_id = $1`,
          [grant.id],
        )
      )[0],
    ).toEqual({ state: 'CANCELLED' });
    const events = await rows<{ event_code: string; actor_id: string; reason_code: string | null }>(
      `select event_code, actor_id::text, reason_code from audit_event
        where object_id in ($1, $2) and event_code like 'auth.setup_grant.%' order by occurred_at, event_code`,
      [grant.id, next.id],
    );
    expect(events.map((event) => event.event_code)).toEqual([
      'auth.setup_grant.issued',
      'auth.setup_grant.issued',
      'auth.setup_grant.superseded',
    ]);
    expect(events.every((event) => event.actor_id === senior.identity.id)).toBe(true);
  });

  it('queues to the phone when the delivery channel is the phone', async () => {
    const account = await vendor({ recoveryPhone: '+233200000077', deliveryChannel: 'PHONE' });
    const response = await reissue(await routes.seniorOps(HUB_A), account);
    expect(response.status).toBe(200);
    const message = await routes.deliveredFor(routes.admin, (response.json() as { id: string }).id);
    expect(message?.destination).toBe('+233200000077');
    const [job] = await rows<{ channel: string }>(
      `select channel from credential_delivery_job where redemption_record_id = $1`,
      [(response.json() as { id: string }).id],
    );
    expect(job?.channel).toBe('SMS');
  });

  // Break caught (the guard "the secret IS NULL"): a re-issue that would let a setup grant replace a secret that exists.
  it('refuses an account that holds a secret with STATE_CONFLICT, and writes nothing', async () => {
    const account = await vendor({ secretHash: SOME_SECRET_HASH });
    const response = await reissue(await routes.seniorOps(HUB_A), account);
    expect([response.status, codeOf(response)]).toEqual([409, 'STATE_CONFLICT']);
    expect(
      await rows(`select id from setup_grant where principal_id = $1`, [account.accountId]),
    ).toEqual([]);
  });

  it.each([
    ['a suspended account', { accountStatus: 'SUSPENDED' }],
    ['a terminated organisation', { organizationStatus: 'TERMINATED' }],
  ] as const)('refuses %s with STATE_CONFLICT', async (_name, overrides) => {
    const account = await vendor(overrides);
    const response = await reissue(await routes.seniorOps(HUB_A), account);
    expect([response.status, codeOf(response)]).toEqual([409, 'STATE_CONFLICT']);
  });

  it('refuses an account with no delivery channel chosen with CREDENTIAL_DELIVERY_FAILED, and writes nothing', async () => {
    const account = await vendor({ deliveryChannel: null });
    const response = await reissue(await routes.seniorOps(HUB_A), account);
    expect([response.status, codeOf(response)]).toEqual([422, 'CREDENTIAL_DELIVERY_FAILED']);
    expect(
      await rows(`select id from setup_grant where principal_id = $1`, [account.accountId]),
    ).toEqual([]);
  });

  // Break caught: the refusal order (permission-enforcement.md section 5.1): the key, then the scope before the version.
  it('refuses Ops Staff, who lack the key, with PERMISSION_DENIED', async () => {
    const account = await vendor();
    const response = await reissue(await routes.opsStaff(HUB_A), account);
    expect([response.status, codeOf(response)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('tells an officer of another hub HUB_SCOPE_VIOLATION before the version, and an id that names nothing NOT_FOUND', async () => {
    const account = await vendor();
    const elsewhere = await routes.seniorOps(HUB_B);
    const outside = await elsewhere.client.post(REISSUE(account.accountId), REASON, {
      origin: OPS,
      headers: { 'If-Match': '"stale"' },
    });
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const absent = await elsewhere.client.post(REISSUE(uuid()), REASON, {
      origin: OPS,
      headers: { 'If-Match': '"stale"' },
    });
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
  });

  // The Platform Admin's grant of the key is own-hub: one whose primary hub is the vendor's acts, one with no primary hub reaches none.
  it('lets a Platform Admin of the vendor’s hub re-issue, and not one whose grant reaches no hub', async () => {
    const account = await vendor();
    const ofTheHub = await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A);
    expect((await reissue(ofTheHub, account)).status).toBe(200);
    const other = await vendor();
    const hubless = await routes.platformAdmin();
    const response = await hubless.client.post(REISSUE(other.accountId), REASON, {
      origin: OPS,
      headers: { 'If-Match': await etagOf(hubless, other.accountId) },
    });
    expect([response.status, codeOf(response)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
  });

  it('refuses a stale ETag with STATE_CONFLICT, an empty reason with REASON_REQUIRED and an unknown one with REASON_NOT_ACTIVE', async () => {
    const account = await vendor();
    const senior = await routes.seniorOps(HUB_A);
    const stale = await senior.client.post(REISSUE(account.accountId), REASON, {
      origin: OPS,
      headers: { 'If-Match': '"stale"' },
    });
    expect([stale.status, codeOf(stale)]).toEqual([409, 'STATE_CONFLICT']);
    const empty = await reissue(senior, account, { reason_code: '' });
    expect([empty.status, codeOf(empty)]).toEqual([422, 'REASON_REQUIRED']);
    const unknown = await reissue(senior, account, { reason_code: 'NOT_A_REASON' });
    expect([unknown.status, codeOf(unknown)]).toEqual([422, 'REASON_NOT_ACTIVE']);
    const malformed = await reissue(senior, account, {
      reason_code: 'CREDENTIAL_SETUP_LINK_UNUSABLE',
      purpose: 'X',
    });
    expect([malformed.status, codeOf(malformed)]).toEqual([400, 'VALIDATION_FAILED']);
    expect(
      await rows(`select id from setup_grant where principal_id = $1`, [account.accountId]),
    ).toEqual([]);
  });
});

describe('completeVendorCredentialSetup (AC-SLICE-000-42, -97)', () => {
  async function issued(account: VendorRow): Promise<string> {
    const response = await reissue(await routes.seniorOps(HUB_A), account);
    expect(response.status).toBe(200);
    const message = await routes.deliveredFor(routes.admin, (response.json() as { id: string }).id);
    if (message === undefined) throw new Error('no message was queued');
    return message.token;
  }

  // Break caught (AC-SLICE-000-42): the secret set by anyone but the vendor, kept as anything but an Argon2id hash, or a browser
  // registered without the credential reaching it in a real cookie.
  it('stores the vendor’s own secret as an Argon2id hash, registers this browser and gives it a device credential in a cookie', async () => {
    const account = await vendor();
    const token = await issued(account);
    const client = browser();

    const response = await setUp(client, { setup_token: token, secret: SECRET });

    expect(response.status).toBe(200);
    expect(response.header('cache-control')).toBe('no-store');
    const device = response.json() as Record<string, unknown>;
    expect(device).toMatchObject({
      principal_type: 'VENDOR',
      principal_id: account.accountId,
      device_kind: 'VENDOR_BROWSER_CREDENTIAL',
      status: 'ACTIVE',
      registered_by: null,
    });
    const cookies = response.setCookies.filter((cookie) => cookie.name === 'melarc_vendor_device');
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0];
    expect(cookie).toMatchObject({
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: 34_560_000,
    });
    expect(response.setCookies.map((each) => each.name)).toEqual(['melarc_vendor_device']);
    expect(response.text).not.toContain(cookie?.value ?? 'x');

    const [stored] = await rows<{
      secret_hash: string;
      credential_generation: string;
      failed_attempt_count: number;
    }>(
      `select secret_hash, credential_generation, failed_attempt_count from vendor_credential where vendor_account_id = $1`,
      [account.accountId],
    );
    expect(stored?.secret_hash.startsWith('$argon2id$')).toBe(true);
    expect(stored?.credential_generation).toBe('1');
    const hasher = routes.kit.app.app.get<Hasher>(HASHER, { strict: false });
    expect((await hasher.verify('VENDOR_SECRET', SECRET, stored?.secret_hash ?? '')).matches).toBe(
      true,
    );

    const raw = Buffer.from(cookie?.value ?? '', 'base64url');
    expect(raw).toHaveLength(32);
    const [registered] = await rows<{ id: string; status: string }>(
      `select id, status from registered_device where device_credential_hash = $1`,
      [createHash('sha256').update(raw).digest()],
    );
    expect(registered).toEqual({ id: device.id, status: 'ACTIVE' });
    expect(
      await rows(`select id from session where principal_id = $1`, [account.accountId]),
    ).toEqual([]);

    const events = await rows<{ event_code: string; actor_type: string; actor_id: string }>(
      `select event_code, actor_type, actor_id::text from audit_event
        where event_code in ('auth.setup_grant.consumed', 'auth.credential.changed', 'auth.device.registered')
          and actor_id = $1 order by event_code`,
      [account.accountId],
    );
    expect(events).toEqual([
      {
        event_code: 'auth.credential.changed',
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: account.accountId,
      },
      {
        event_code: 'auth.device.registered',
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: account.accountId,
      },
      {
        event_code: 'auth.setup_grant.consumed',
        actor_type: 'VENDOR_ACCOUNT',
        actor_id: account.accountId,
      },
    ]);
    // An Ops reader sees that a secret exists and never what it is.
    const read = await (
      await routes.platformAdmin()
    ).client.get(`${API}/ops/vendors/${account.accountId}`);
    expect(
      (read.json() as { account: { credential_established: boolean } }).account
        .credential_established,
    ).toBe(true);
    expect(read.text).not.toContain(stored?.secret_hash ?? 'x');
  });

  // Break caught: a grant used twice, or the refusals told apart.
  it('answers a spent, an unknown and another purpose’s token with one SETUP_GRANT_INVALID', async () => {
    const account = await vendor();
    const token = await issued(account);
    expect((await setUp(browser(), { setup_token: token, secret: SECRET })).status).toBe(200);
    const again = await setUp(browser(), { setup_token: token, secret: SECRET });
    const unknown = await setUp(browser(), { setup_token: 'A'.repeat(43), secret: SECRET });
    // A live grant of the other vendor purpose (a browser grant of an account that has a secret): not this operation's.
    const established = await vendor({ secretHash: SOME_SECRET_HASH });
    const bytes = randomBytes(32);
    await routes.admin.query(
      `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
       values ($1, 'VENDOR', $2, 'VENDOR_DEVICE_ENROLMENT', $3, clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING')`,
      [uuid(), established.accountId, createHash('sha256').update(bytes).digest()],
    );
    const otherPurpose = await setUp(browser(), {
      setup_token: bytes.toString('base64url'),
      secret: SECRET,
    });
    for (const response of [again, unknown, otherPurpose]) {
      expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
      expect(response.setCookies).toEqual([]);
    }
    // One answer: the bodies differ in nothing but the request's own identifier.
    const withoutRequest = (response: TestResponse) => ({
      ...(response.json() as object),
      request_id: undefined,
    });
    expect(withoutRequest(again)).toEqual(withoutRequest(unknown));
    expect(withoutRequest(otherPurpose)).toEqual(withoutRequest(unknown));
    expect(
      (
        await rows<{ secret_hash: string }>(
          `select secret_hash from vendor_credential where vendor_account_id = $1`,
          [established.accountId],
        )
      )[0]?.secret_hash,
    ).toBe(SOME_SECRET_HASH);
  });

  // Break caught: the setup judged on what the cheap look before the hash saw, not on the account as it stands under its lock: an account
  // suspended (or given a secret another way) while the request was hashing or waiting would still be set up.
  it('refuses the setup of an account suspended while the request waited for its lock, and writes nothing', async () => {
    const account = await vendor();
    const token = await issued(account);
    const holder = clientFor(routes.database.urlFor('postgres'));
    await holder.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from vendor_account where id = $1 for update`, [
        account.accountId,
      ]);
      const pending = setUp(browser(), { setup_token: token, secret: SECRET });
      await waitUntilBlocked(
        routes.admin,
        routes.database.name,
        /from vendor_account where id = .* for no key update/,
      );
      await holder.query(`update vendor_account set status = 'SUSPENDED' where id = $1`, [
        account.accountId,
      ]);
      await holder.query('commit');
      const response = await pending;
      expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
      expect(response.setCookies).toEqual([]);
    } finally {
      await holder.end();
    }
    expect(
      await rows(
        `select secret_hash, credential_generation from vendor_credential where vendor_account_id = $1`,
        [account.accountId],
      ),
    ).toEqual([{ secret_hash: null, credential_generation: '0' }]);
    expect(
      await rows(`select id from registered_device where principal_id = $1`, [account.accountId]),
    ).toEqual([]);
    expect(
      (
        await rows<{ state: string }>(`select state from setup_grant where principal_id = $1`, [
          account.accountId,
        ])
      )[0]?.state,
    ).toBe('PENDING');
  });

  // Break caught: a grant of the other vendor purpose taken for a setup. The database never issues a browser grant to an account with no
  // secret (migration 0035), so the arrangement sets the table's guard aside to make one: the setup must refuse it on its own purpose.
  it('refuses a browser grant presented as a setup grant, whatever the account', async () => {
    const account = await vendor();
    const bytes = randomBytes(32);
    await routes.admin.query('begin');
    try {
      await routes.admin.query('set local session_replication_role = replica');
      await routes.admin.query(
        `insert into setup_grant (id, principal_type, principal_id, purpose, token_hash, issued_at, expires_at, state)
         values ($1, 'VENDOR', $2, 'VENDOR_DEVICE_ENROLMENT', $3, clock_timestamp(), clock_timestamp() + interval '30 minutes', 'PENDING')`,
        [uuid(), account.accountId, createHash('sha256').update(bytes).digest()],
      );
      await routes.admin.query('commit');
    } catch (error) {
      await routes.admin.query('rollback');
      throw error;
    }
    const response = await setUp(browser(), {
      setup_token: bytes.toString('base64url'),
      secret: SECRET,
    });
    expect([response.status, codeOf(response)]).toEqual([422, 'SETUP_GRANT_INVALID']);
    expect(
      await rows(`select secret_hash from vendor_credential where vendor_account_id = $1`, [
        account.accountId,
      ]),
    ).toEqual([{ secret_hash: null }]);
  });

  // AC-SLICE-000-97: both bounds, the field named and the value never echoed.
  it.each([
    ['11 characters', 'a'.repeat(11)],
    ['129 characters', 'a'.repeat(129)],
    ['four ligatures (4 as sent, 12 after NFKC)', 'ﬃ'.repeat(4)],
    ['12 as sent that normalise to 6', 'Å'.repeat(6)],
  ])(
    'refuses a secret of %s with VALIDATION_FAILED, naming the field and not the value',
    async (_name, secret) => {
      const account = await vendor();
      const token = await issued(account);
      const response = await setUp(browser(), { setup_token: token, secret });
      expect([response.status, codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      expect(response.text).toContain('/secret');
      expect(response.text).not.toContain(secret);
      expect(
        (
          await rows<{ state: string }>(`select state from setup_grant where principal_id = $1`, [
            account.accountId,
          ])
        )[0]?.state,
      ).toBe('PENDING');
    },
  );

  it.each([
    ['12 characters with spaces', 'a b c d e fg'],
    ['128 characters with spaces', `${'ab '.repeat(42)}cd`],
  ])('accepts a secret of %s, with no composition rule', async (_name, secret) => {
    const account = await vendor();
    const token = await issued(account);
    expect((await setUp(browser(), { setup_token: token, secret })).status).toBe(200);
  });

  // Break caught: a page of another surface, a foreign page or no Origin consuming the vendor's grant.
  it.each([
    ['the Ops origin', OPS],
    ['a foreign origin', 'https://evil.example'],
    ['no origin', null],
  ])(
    'refuses %s with CSRF_VALIDATION_FAILED before the grant is examined',
    async (_name, origin) => {
      const account = await vendor();
      const token = await issued(account);
      const response = await setUp(browser(), { setup_token: token, secret: SECRET }, origin);
      expect([response.status, codeOf(response)]).toEqual([403, 'CSRF_VALIDATION_FAILED']);
      expect(
        (
          await rows<{ state: string }>(`select state from setup_grant where principal_id = $1`, [
            account.accountId,
          ])
        )[0]?.state,
      ).toBe('PENDING');
    },
  );
});

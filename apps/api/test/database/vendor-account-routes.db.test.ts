import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import {
  API,
  HUB_A,
  HUB_B,
  codeOf,
  startStaffRoutes,
  uuid,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';
import {
  SOME_SECRET_HASH,
  insertDevice,
  insertVendor,
  vendorRow,
  type VendorRow,
} from './support/vendors.js';

/**
 * S0.47a, `listVendorAccounts` and `getVendorAccount` against the real application and a real PostgreSQL (the staff clauses of
 * `AC-SLICE-000-102`): what a staff reader sees of a vendor account follows the hubs of its grant, through the organisation's responsible
 * hub; the read of one tells an account outside them (`HUB_SCOPE_VIOLATION`) from one that does not exist (`NOT_FOUND`); a read of another
 * hub is audited without contents; the ETag moves with the account's status, credential and browsers and never with a failed sign-in; and
 * **no response carries a hash, a secret or a recovery address**. The second hub's vendor is a test fixture the Staging seed does not carry.
 */
const LIST = `${API}/ops/vendors`;
const ONE = (id: string) => `${API}/ops/vendors/${id}`;

let routes: StaffRoutes;
let tag: string;
let inA: VendorRow;
let inB: VendorRow;
let established: VendorRow;
let suspended: VendorRow;

interface Summary {
  readonly id: string;
  readonly account_identifier: string;
  readonly vendor_organization_id: string;
  readonly legal_name: string;
  readonly responsible_hub_id: string;
  readonly status: string;
  readonly credential_established: boolean;
  readonly active_device_count: number;
  readonly has_recovery_email: boolean;
  readonly has_recovery_phone: boolean;
  readonly delivery_channel: string | null;
}
interface Device {
  readonly id: string;
  readonly principal_type: string;
  readonly principal_id: string;
  readonly device_kind: string;
  readonly status: string;
  readonly registered_at: string;
  readonly registered_by: string | null;
}
interface Page {
  readonly items: Summary[];
  readonly next_page_token: string | null;
}

beforeAll(async () => {
  routes = await startStaffRoutes();
  tag = `Zv${uuid().slice(0, 6)}`;
  const named = (name: string, overrides: Partial<VendorRow>) =>
    insertVendor(routes.admin, vendorRow({ legalName: `${tag} ${name}`, ...overrides }));
  inA = await named('Alpha', { hubId: HUB_A });
  inB = await named('Bravo', { hubId: HUB_B });
  established = await named('Charlie', {
    hubId: HUB_A,
    secretHash: SOME_SECRET_HASH,
    recoveryPhone: '+233200000001',
    deliveryChannel: 'PHONE',
  });
  suspended = await named('Delta', { hubId: HUB_A, accountStatus: 'SUSPENDED' });
  await insertDevice(routes.admin, established.accountId);
  await insertDevice(routes.admin, established.accountId, { status: 'REVOKED' });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const pageOf = (response: TestResponse): Page => {
  expect(response.status).toBe(200);
  return response.json() as Page;
};
const listed = async (reader: Actor, query = ''): Promise<string[]> =>
  pageOf(await reader.client.get(`${LIST}?q=${tag}${query}`))
    .items.map((item) => item.id)
    .toSorted();
const ids = (...rows: readonly VendorRow[]): string[] =>
  rows.map((row) => row.accountId).toSorted();

/** Every string anywhere in a body: what a test searches for a value that must never be there. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsOf);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, each]) => [key, ...stringsOf(each)]);
  }
  return [];
}

async function crossingsOf(
  actor: Actor,
): Promise<{ object_type: string; object_id: string; responsible_hub_id: string }[]> {
  return routes.rows(
    `select object_type, object_id::text, responsible_hub_id::text from audit_event
      where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by object_id`,
    [actor.identity.id],
  );
}

describe('listVendorAccounts (AC-SLICE-000-102, staff clauses)', () => {
  // Break caught: a hub's staff listing the vendors another hub serves.
  it('shows Ops Staff and Senior Ops of a hub the accounts whose organisation that hub is responsible for, and no other', async () => {
    for (const reader of [await routes.opsStaff(HUB_A), await routes.seniorOps(HUB_A)]) {
      expect(await listed(reader)).toEqual(ids(inA, established, suspended));
    }
    expect(await listed(await routes.seniorOps(HUB_B))).toEqual(ids(inB));
  });

  it('shows Platform Admin and Finance, whose grant reaches every hub, every account', async () => {
    expect(await listed(await routes.platformAdmin())).toEqual(
      ids(inA, inB, established, suspended),
    );
    expect(await listed(await routes.actor(BUNDLE_IDS.finance, HUB_A))).toEqual(
      ids(inA, inB, established, suspended),
    );
  });

  // Break caught: `hub_id` widening what the caller may read, or a hub outside the grant answered other than with an empty page.
  it('narrows by hub_id and never widens: a hub outside the grant is an empty page, never a refusal', async () => {
    const senior = await routes.seniorOps(HUB_A);
    expect(await listed(senior, `&hub_id=${HUB_B}`)).toEqual([]);
    expect(await listed(senior, `&hub_id=${HUB_A}`)).toEqual(ids(inA, established, suspended));
    expect(await listed(await routes.platformAdmin(), `&hub_id=${HUB_B}`)).toEqual(ids(inB));
  });

  it('filters by status, and finds an account by its organisation’s name or its identifier, in any case', async () => {
    const admin = await routes.platformAdmin();
    expect(await listed(admin, '&status=SUSPENDED')).toEqual(ids(suspended));
    const byName = pageOf(
      await admin.client.get(`${LIST}?q=${encodeURIComponent(`${tag} Bravo`)}`),
    ).items;
    expect(byName.map((item) => item.id)).toEqual([inB.accountId]);
    const byIdentifier = pageOf(
      await admin.client.get(`${LIST}?q=${inA.accountIdentifier.toLowerCase()}`),
    ).items;
    expect(byIdentifier.map((item) => item.id)).toEqual([inA.accountId]);
  });

  // Break caught: a credential value, a hash or an address in a list (the summary says *whether*, never *where*).
  it('says of each account whether it has a secret and a channel and how many browsers are active, and carries no secret or address', async () => {
    const response = await (await routes.platformAdmin()).client.get(`${LIST}?q=${tag}`);
    const page = pageOf(response);
    const charlie = page.items.find((item) => item.id === established.accountId);
    expect(charlie).toEqual({
      id: established.accountId,
      account_identifier: established.accountIdentifier,
      vendor_organization_id: established.organizationId,
      legal_name: established.legalName,
      responsible_hub_id: HUB_A,
      status: 'ACTIVE',
      credential_established: true,
      active_device_count: 1,
      has_recovery_email: true,
      has_recovery_phone: true,
      delivery_channel: 'PHONE',
    });
    const text = stringsOf(response.json());
    for (const secret of [
      established.recoveryEmail,
      established.recoveryPhone,
      SOME_SECRET_HASH,
      inA.recoveryEmail,
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(response.header('etag')).toBeNull();
  });

  it('pages in a stable order with an opaque token, and refuses a token that is not one', async () => {
    const admin = await routes.platformAdmin();
    const first = pageOf(await admin.client.get(`${LIST}?q=${tag}&page_size=3`));
    expect(first.items).toHaveLength(3);
    expect(first.next_page_token).not.toBeNull();
    const second = pageOf(
      await admin.client.get(
        `${LIST}?q=${tag}&page_size=3&page_token=${first.next_page_token ?? ''}`,
      ),
    );
    expect([...first.items, ...second.items].map((item) => item.id).toSorted()).toEqual(
      ids(inA, inB, established, suspended),
    );
    expect(second.next_page_token).toBeNull();
    const refused = await admin.client.get(`${LIST}?page_token=not-a-position`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // audit.md section 5.4: one bounded event for each foreign hub a list represents, naming the hub and the operation.
  it('records one crossing for each hub a list shows that is not the reader’s own, and none for its own', async () => {
    const finance = await routes.actor(BUNDLE_IDS.finance, HUB_A);
    await listed(finance);
    expect(await crossingsOf(finance)).toEqual([
      { object_type: 'HUB', object_id: HUB_B, responsible_hub_id: HUB_B },
    ]);
    const senior = await routes.seniorOps(HUB_A);
    await listed(senior);
    expect(await crossingsOf(senior)).toEqual([]);
  });
});

describe('getVendorAccount (AC-SLICE-000-102, staff clauses)', () => {
  // Break caught: an account of another hub read, or answered as absent when it exists (staff are told which, as for a staff identity).
  it('tells a reader outside the account’s hub HUB_SCOPE_VIOLATION, and an id that names nothing NOT_FOUND', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const outside = await senior.client.get(ONE(inB.accountId));
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const absent = await senior.client.get(ONE(uuid()));
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
  });

  it('returns the account with every browser it has held, newest first, the ETag, and no hash or address', async () => {
    const response = await (await routes.seniorOps(HUB_A)).client.get(ONE(established.accountId));
    expect(response.status).toBe(200);
    expect(response.header('etag')).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    const body = response.json() as { account: Summary; devices: Device[] };
    expect(body.account.id).toBe(established.accountId);
    expect(body.devices.map((device) => device.status).toSorted()).toEqual(['ACTIVE', 'REVOKED']);
    for (const device of body.devices) {
      expect(Object.keys(device).toSorted()).toEqual([
        'device_kind',
        'id',
        'principal_id',
        'principal_type',
        'registered_at',
        'registered_by',
        'status',
      ]);
      expect(device).toMatchObject({
        principal_type: 'VENDOR',
        principal_id: established.accountId,
        device_kind: 'VENDOR_BROWSER_CREDENTIAL',
      });
    }
    const registered = body.devices.map((device) => device.registered_at);
    expect(registered).toEqual(registered.toSorted().toReversed());
    const text = stringsOf(body);
    for (const secret of [established.recoveryEmail, established.recoveryPhone, SOME_SECRET_HASH]) {
      expect(text).not.toContain(secret);
    }
  });

  // Break caught: an ETag that misses a change the credential operations must see, or one that moves with a failed sign-in.
  it('moves its ETag with a browser, a status or a secret, and never with a failed sign-in or a rehash', async () => {
    const reader = await routes.platformAdmin();
    const etag = async (): Promise<string | null> =>
      (await reader.client.get(ONE(inA.accountId))).header('etag');
    const before = await etag();
    await routes.admin.query(
      `update vendor_credential set failed_attempt_count = failed_attempt_count + 3, locked_until = now() + interval '5 minutes'
        where vendor_account_id = $1`,
      [inA.accountId],
    );
    expect(await etag()).toBe(before);

    const first = await insertDevice(routes.admin, inA.accountId);
    const withOneBrowser = await etag();
    expect(withOneBrowser).not.toBe(before);

    // One browser ended and another registered: the count of active ones is what it was, and the set is not.
    await routes.admin.query(
      `update registered_device set status = 'REVOKED', ended_at = clock_timestamp() where id = $1`,
      [first.id],
    );
    await insertDevice(routes.admin, inA.accountId);
    const withBrowser = await etag();
    expect(withBrowser).not.toBe(withOneBrowser);

    await routes.admin.query(
      `update vendor_credential set secret_hash = $2, credential_established_at = clock_timestamp(), credential_generation = 1
        where vendor_account_id = $1`,
      [inA.accountId, SOME_SECRET_HASH],
    );
    const withSecret = await etag();
    expect(withSecret).not.toBe(withBrowser);
    await routes.admin.query(
      `update vendor_credential set secret_hash = $2 where vendor_account_id = $1`,
      [inA.accountId, `${SOME_SECRET_HASH}x`],
    );
    expect(await etag()).toBe(withSecret);

    // A secret replaced while one is established shows nothing new to a reader: only the generation says so, and the ETag must move.
    await routes.admin.query(
      `update vendor_credential set secret_hash = $2, credential_established_at = clock_timestamp(), credential_generation = 2
        where vendor_account_id = $1`,
      [inA.accountId, SOME_SECRET_HASH],
    );
    const replaced = await etag();
    expect(replaced).not.toBe(withSecret);

    await routes.admin.query(`update vendor_account set status = 'SUSPENDED' where id = $1`, [
      inA.accountId,
    ]);
    expect(await etag()).not.toBe(replaced);
    await routes.admin.query(`update vendor_account set status = 'ACTIVE' where id = $1`, [
      inA.accountId,
    ]);
  });

  // audit.md section 5.4: the read of a record of another hub is audited, with a reference to the record and no contents.
  it('records a crossing for a read of an account of another hub, and none for one of the reader’s own', async () => {
    const admin = await routes.platformAdmin();
    expect((await admin.client.get(ONE(inB.accountId))).status).toBe(200);
    expect(await crossingsOf(admin)).toEqual([
      { object_type: 'VendorAccount', object_id: inB.accountId, responsible_hub_id: HUB_B },
    ]);
    const senior = await routes.seniorOps(HUB_A);
    expect((await senior.client.get(ONE(inA.accountId))).status).toBe(200);
    expect(await crossingsOf(senior)).toEqual([]);
  });
});

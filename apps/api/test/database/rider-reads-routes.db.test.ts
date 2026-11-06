import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  TOKEN_SERVICE,
  type TokenService,
} from '../../src/platform/auth/ports/token-service.port.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { insertSessionRow, insertStaff, sessionRow, staffRow } from './support/identities.js';
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
  codeOf,
  startStaffRoutes,
  uuid,
  type Actor,
  type StaffRoutes,
} from './support/staff-routes.js';

/**
 * S0.53a, `listRiders` and `getRider` against the real application and a real PostgreSQL (`AC-SLICE-000-113`): what a staff reader sees of
 * the rider roster follows the hubs of its grant; the read of one tells a rider outside them (`HUB_SCOPE_VIOLATION`) from one that does not
 * exist (`NOT_FOUND`); a read of another hub is audited without contents; the ETag moves with the rider's status, PIN and devices and never
 * with a failed sign-in; **no response carries a PIN, a hash, a key or an attestation**; and a Vendor's session, and a Rider's although the
 * Rider bundle holds `dispatch.read`, is refused. The second hub's riders are a test fixture the Staging seed does not carry.
 */
const LIST = `${API}/ops/riders`;
const ONE = (id: string) => `${API}/ops/riders/${id}`;

let routes: StaffRoutes;
let tag: string;
let inA: RiderRow;
let inB: RiderRow;
let readyA: RiderRow;
let revokedA: RiderRow;
let suspendedA: RiderRow;
let readyKey: ReturnType<typeof deviceKey>;

interface Summary {
  readonly id: string;
  readonly full_name: string;
  readonly phone: string;
  readonly status: string;
  readonly primary_hub_id: string;
  readonly pin_established: boolean;
  readonly has_active_device: boolean;
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
interface Detail {
  readonly rider: Summary;
  readonly devices: Device[];
}

beforeAll(async () => {
  routes = await startStaffRoutes();
  tag = `Zr${uuid().slice(0, 6)}`;
  const named = (name: string, overrides: Partial<RiderRow>) =>
    insertRider(routes.admin, riderRow({ fullName: `${tag} ${name}`, ...overrides }));
  inA = await named('Alpha', { hubId: HUB_A });
  inB = await named('Bravo', { hubId: HUB_B });
  readyA = await named('Charlie', { hubId: HUB_A, pinHash: SOME_PIN_HASH });
  revokedA = await named('Delta', { hubId: HUB_A, pinHash: SOME_PIN_HASH, status: 'INACTIVE' });
  suspendedA = await named('Echo', { hubId: HUB_A, status: 'SUSPENDED' });
  readyKey = deviceKey();
  await insertRiderDevice(routes.admin, readyA.id, { key: readyKey });
  await insertRiderDevice(routes.admin, readyA.id, { status: 'REPLACED' });
  await insertRiderDevice(routes.admin, revokedA.id, { status: 'REVOKED' });
}, 120_000);

afterAll(async () => {
  await routes.stop();
});

const pageOf = (response: TestResponse): Page => {
  expect(response.status).toBe(200);
  return response.json() as Page;
};
const detailOf = (response: TestResponse): Detail => {
  expect(response.status).toBe(200);
  return response.json() as Detail;
};
const listed = async (reader: Actor, query = ''): Promise<string[]> =>
  pageOf(await reader.client.get(`${LIST}?q=${tag}${query}`))
    .items.map((item) => item.id)
    .toSorted();
const ids = (...rows: readonly RiderRow[]): string[] => rows.map((row) => row.id).toSorted();
const etagOf = async (reader: Actor, id: string): Promise<string> => {
  const response = await reader.client.get(ONE(id));
  expect(response.status).toBe(200);
  const etag = response.header('etag');
  if (etag === null) throw new Error('the read carries no ETag');
  return etag;
};

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

/**
 * A Senior Ops member whose session holds `dispatch.read` at every hub. The seeded grant is `own` for every staff bundle (the catalogue says
 * "own hub"), so no seeded persona reads across hubs; this session is arranged as the issue protocol would make it for a bundle that did.
 */
async function allHubReader(): Promise<Actor> {
  const tokens = routes.kit.app.app.get<TokenService>(TOKEN_SERVICE, { strict: false });
  const identity = await insertStaff(
    routes.admin,
    staffRow({ roleBundleId: BUNDLE_IDS.seniorOps, primaryHubId: HUB_A }),
  );
  const issued = tokens.issue();
  const csrf = tokens.issue();
  const row = await insertSessionRow(
    routes.admin,
    sessionRow({
      principalType: 'STAFF',
      principalId: identity.id,
      bundleId: BUNDLE_IDS.seniorOps,
      authorizedHubIds: [HUB_A],
      snapshot: {
        format: 1,
        name: 'Senior Ops',
        audience: 'STAFF',
        privileged: true,
        grants: GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.seniorOps)
          .map((grant) => ({
            permission: grant.permissionKey,
            hubScope: grant.permissionKey === 'dispatch.read' ? ('all' as const) : grant.hubScope,
            ownershipScope: grant.ownershipScope,
            tier: grant.tier,
          }))
          .toSorted((a, b) => (a.permission < b.permission ? -1 : 1)),
      },
      tokenHash: Buffer.from(issued.hash),
      csrfTokenHash: Buffer.from(csrf.hash),
    }),
  );
  return {
    client: presenting(routes.kit, issued.token, csrf.token),
    identity,
    token: issued.token,
    csrf: csrf.token,
    sessionId: row.id,
  };
}

describe('listRiders (AC-SLICE-000-113)', () => {
  // Break caught: a hub's staff listing the riders another hub employs.
  it('shows Ops Staff and Senior Ops of a hub the riders whose primary hub that is, and no other', async () => {
    for (const reader of [await routes.opsStaff(HUB_A), await routes.seniorOps(HUB_A)]) {
      expect(await listed(reader)).toEqual(ids(inA, readyA, revokedA, suspendedA));
    }
    expect(await listed(await routes.seniorOps(HUB_B))).toEqual(ids(inB));
  });

  // Break caught (OB-S1-75, task P1, AC-SLICE-001-83): the roster empty for a Platform Admin. Its grant of the key was `own` and the seeded
  // administrator has no primary hub, so it saw no rider (the plan's finding 7.47); since the Product Owner's decision of 5 November 2026 the
  // grant is of all hubs: the riders of every hub, with a hub of its own or none. The scope is the grant's: Platform Admin status is no bypass.
  it('gives a Platform Admin the riders of every hub, with a hub of its own or none', async () => {
    const everyRider = ids(inA, readyA, revokedA, suspendedA, inB);
    expect(await listed(await routes.platformAdmin())).toEqual(everyRider);
    expect(await listed(await routes.actor(BUNDLE_IDS.platformAdmin, HUB_A))).toEqual(everyRider);
  });

  // Break caught: `hub_id` widening what the caller may read, or a hub outside the grant answered other than with an empty page.
  it('narrows by hub_id and never widens: a hub outside the grant is an empty page, never a refusal', async () => {
    const senior = await routes.seniorOps(HUB_A);
    expect(await listed(senior, `&hub_id=${HUB_B}`)).toEqual([]);
    expect(await listed(senior, `&hub_id=${HUB_A}`)).toEqual(
      ids(inA, readyA, revokedA, suspendedA),
    );
    expect(await listed(await allHubReader(), `&hub_id=${HUB_B}`)).toEqual(ids(inB));
  });

  it('filters by status, and finds a rider by name or by phone number, in any case', async () => {
    const reader = await allHubReader();
    expect(await listed(reader, '&status=SUSPENDED')).toEqual(ids(suspendedA));
    expect(await listed(reader, '&status=INACTIVE')).toEqual(ids(revokedA));
    const byName = pageOf(
      await reader.client.get(`${LIST}?q=${encodeURIComponent(`${tag.toLowerCase()} bravo`)}`),
    ).items;
    expect(byName.map((item) => item.id)).toEqual([inB.id]);
    const byPhone = pageOf(
      await reader.client.get(`${LIST}?q=${encodeURIComponent(inA.phone)}`),
    ).items;
    expect(byPhone.map((item) => item.id)).toEqual([inA.id]);
  });

  // Break caught: the search text read as a pattern, so a `%` or `_` matches every rider (and a backslash escapes the next character).
  it('searches for text and not for a pattern: a percent sign, an underscore and a backslash match only themselves', async () => {
    const reader = await allHubReader();
    for (const query of ['%', '_', '\\', `${tag}%`, `${tag}_____`, '%%']) {
      const page = pageOf(await reader.client.get(`${LIST}?q=${encodeURIComponent(query)}`));
      expect(
        page.items.map((item) => item.id),
        query,
      ).toEqual([]);
    }
  });

  // Break caught: a credential value, a hash or a key in a list (the summary says *whether*, never *what*).
  it('says of each rider whether it has a PIN and an active device, and carries no PIN, hash, key or attestation', async () => {
    const response = await (await allHubReader()).client.get(`${LIST}?q=${tag}`);
    const page = pageOf(response);
    expect(page.items.find((item) => item.id === readyA.id)).toEqual({
      id: readyA.id,
      full_name: readyA.fullName,
      phone: readyA.phone,
      status: 'ACTIVE',
      primary_hub_id: HUB_A,
      pin_established: true,
      has_active_device: true,
    });
    expect(page.items.find((item) => item.id === inA.id)).toMatchObject({
      pin_established: false,
      has_active_device: false,
    });
    // A device that was revoked is not an active one, and a rider who was bound once and replaced still reads as bound only while one lives.
    expect(page.items.find((item) => item.id === revokedA.id)).toMatchObject({
      pin_established: true,
      has_active_device: false,
    });
    const text = stringsOf(response.json());
    for (const forbidden of [
      SOME_PIN_HASH,
      readyKey.publicKey,
      'pin_hash',
      'public_key',
      'attestation',
    ]) {
      expect(
        text.some((each) => each.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
    for (const item of page.items) {
      expect(Object.keys(item).toSorted()).toEqual([
        'full_name',
        'has_active_device',
        'id',
        'phone',
        'pin_established',
        'primary_hub_id',
        'status',
      ]);
    }
  });

  // Break caught: a page that skips or repeats a rider, a token that is not bound to the order, or a page size that is not bounded.
  it('pages in the order riders were created, each once, by an opaque token', async () => {
    const reader = await allHubReader();
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const query = `&page_size=2${token === null ? '' : `&page_token=${encodeURIComponent(token)}`}`;
      const page = pageOf(await reader.client.get(`${LIST}?q=${tag}${query}`));
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((item) => item.id));
      token = page.next_page_token;
      pages += 1;
    } while (token !== null && pages < 10);
    expect(seen).toEqual([inA.id, inB.id, readyA.id, revokedA.id, suspendedA.id]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('refuses a page size, a page token and a search that are not valid, naming the field', async () => {
    const reader = await allHubReader();
    for (const query of [
      'page_size=0',
      'page_size=101',
      'page_size=x',
      'page_size=1.5',
      'page_token=not-a-token',
      `q=${'x'.repeat(201)}`,
      'status=NOT_A_STATUS',
      'hub_id=not-a-uuid',
      // A number in another spelling is not the number, so that Number and parseInt cannot disagree about a page size.
      'page_size=1e1',
      'page_size=0x10',
      'page_size=%205',
      'page_size=5%20',
    ]) {
      const response = await reader.client.get(`${LIST}?${query}`);
      expect([response.status, codeOf(response)], query).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  // Break caught: a repeated parameter taken as the first of its values, the last, or an array handed to the filter (parameter pollution): a
  // query parameter is one text or absent.
  it('refuses a query parameter that is given twice', async () => {
    const reader = await allHubReader();
    for (const query of [
      'status=ACTIVE&status=INACTIVE',
      `hub_id=${HUB_A}&hub_id=${HUB_B}`,
      'q=a&q=b',
      'page_size=2&page_size=3',
      'page_token=a&page_token=b',
    ]) {
      const response = await reader.client.get(`${LIST}?${query}`);
      expect([response.status, codeOf(response)], query).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  it('carries no ETag: only the one rider’s read has a version', async () => {
    const response = await (await routes.seniorOps(HUB_A)).client.get(`${LIST}?q=${tag}`);
    expect(response.status).toBe(200);
    expect(response.header('etag')).toBeNull();
  });
});

describe('getRider (AC-SLICE-000-113)', () => {
  // Break caught: a rider of another hub read, or answered as absent when it exists (staff are told which, as for a staff identity).
  it('tells a reader outside the rider’s hub HUB_SCOPE_VIOLATION, and an id that names nothing NOT_FOUND', async () => {
    const senior = await routes.seniorOps(HUB_A);
    const outside = await senior.client.get(ONE(inB.id));
    expect([outside.status, codeOf(outside)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const absent = await senior.client.get(ONE(uuid()));
    expect([absent.status, codeOf(absent)]).toEqual([404, 'NOT_FOUND']);
    // A Platform Admin with no primary hub reaches every hub through `dispatch.read` (a grant of all hubs, task P1): a rider of either hub is read.
    const bare = await routes.platformAdmin();
    expect((await bare.client.get(ONE(readyA.id))).status).toBe(200);
    expect((await bare.client.get(ONE(inB.id))).status).toBe(200);
  });

  // Break caught: a device hidden because it ended (an officer verifying a stolen handset needs to see what was revoked and replaced), or a
  // key shown.
  it('shows the rider and every device it has held, in every status, newest first, with no key', async () => {
    const response = await (await routes.seniorOps(HUB_A)).client.get(ONE(readyA.id));
    const detail = detailOf(response);
    expect(detail.rider).toEqual({
      id: readyA.id,
      full_name: readyA.fullName,
      phone: readyA.phone,
      status: 'ACTIVE',
      primary_hub_id: HUB_A,
      pin_established: true,
      has_active_device: true,
    });
    expect(detail.devices.map((device) => device.status).toSorted()).toEqual([
      'ACTIVE',
      'REPLACED',
    ]);
    for (const device of detail.devices) {
      expect(device).toEqual({
        id: device.id,
        principal_type: 'RIDER',
        principal_id: readyA.id,
        device_kind: 'RIDER_ANDROID_KEYPAIR',
        status: device.status,
        registered_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as unknown,
        registered_by: null,
      });
    }
    const revoked = detailOf(await (await routes.seniorOps(HUB_A)).client.get(ONE(revokedA.id)));
    expect(revoked.devices.map((device) => device.status)).toEqual(['REVOKED']);
    expect(revoked.rider.has_active_device).toBe(false);
    const text = stringsOf(response.json());
    for (const forbidden of [
      SOME_PIN_HASH,
      readyKey.publicKey,
      'pin_hash',
      'public_key',
      'attestation',
    ]) {
      expect(
        text.some((each) => each.includes(forbidden)),
        forbidden,
      ).toBe(false);
    }
  });

  it('shows a rider with no PIN and no device as one who is not ready', async () => {
    const detail = detailOf(await (await routes.seniorOps(HUB_A)).client.get(ONE(inA.id)));
    expect(detail.rider).toMatchObject({ pin_established: false, has_active_device: false });
    expect(detail.devices).toEqual([]);
  });

  // Break caught: a version that does not move with what `reregisterRiderDevice` acts on, or one that moves with a failed sign-in.
  it('has an ETag that changes with the status, the name, the PIN and the device set, and not with a failed sign-in', async () => {
    // A reader of every hub, so that the rider can be moved between them without leaving the reader's scope.
    const reader = await allHubReader();
    const rider = await insertRider(
      routes.admin,
      riderRow({ fullName: `${tag} Version`, hubId: HUB_A, pinHash: SOME_PIN_HASH }),
    );
    const first = await etagOf(reader, rider.id);
    expect(first).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
    expect(await etagOf(reader, rider.id)).toBe(first);
    // The same representation has the same version for another reader.
    expect(await etagOf(await routes.opsStaff(HUB_A), rider.id)).toBe(first);

    // Nothing the representation and the PIN's generation do not hold may move it: a failed attempt, a lock, a rehash at a new cost.
    await routes.admin.query(
      `update rider_identity set failed_attempt_count = 4, locked_until = clock_timestamp() + interval '15 minutes' where id = $1`,
      [rider.id],
    );
    expect(await etagOf(reader, rider.id)).toBe(first);
    await routes.admin.query(`update rider_identity set pin_hash = $2 where id = $1`, [
      rider.id,
      `${SOME_PIN_HASH}rehashed`,
    ]);
    expect(await etagOf(reader, rider.id)).toBe(first);

    const seen = new Set([first]);
    const moved = async (change: string, values: unknown[] = []): Promise<void> => {
      await routes.admin.query(change, [rider.id, ...values]);
      const next = await etagOf(reader, rider.id);
      expect(seen.has(next), change).toBe(false);
      seen.add(next);
    };
    await moved(`update rider_identity set status = 'INACTIVE' where id = $1`);
    await moved(`update rider_identity set full_name = full_name || ' II' where id = $1`);
    await moved(`update rider_identity set primary_hub_id = '${HUB_B}' where id = $1`);
    await routes.admin.query(
      `update rider_identity set primary_hub_id = '${HUB_A}' where id = $1`,
      [rider.id],
    );
    // A new PIN is a new generation, which no read shows and the version holds.
    await moved(
      `update rider_identity set pin_hash = $2, pin_established_at = clock_timestamp(), credential_generation = credential_generation + 1,
              failed_attempt_count = 0, locked_until = null where id = $1`,
      [`${SOME_PIN_HASH}replaced`],
    );
    const device = await insertRiderDevice(routes.admin, rider.id);
    const afterRegistered = await etagOf(reader, rider.id);
    expect(seen.has(afterRegistered)).toBe(false);
    seen.add(afterRegistered);
    await routes.admin.query(
      `update registered_device set status = 'REVOKED', ended_at = clock_timestamp() where id = $1`,
      [device.id],
    );
    const afterRevoked = await etagOf(reader, rider.id);
    expect(seen.has(afterRevoked)).toBe(false);
    seen.add(afterRevoked);
    // A device that ended long ago changes neither the PIN nor whether one is active, and still changes the device set the version holds.
    await insertRiderDevice(routes.admin, rider.id, { status: 'REPLACED' });
    expect(seen.has(await etagOf(reader, rider.id))).toBe(false);
  });

  // Break caught (AC-113): the roster reachable from a handset, or by a vendor. The Rider bundle does hold the key, so the credential mode is
  // what refuses it: a browser-only operation takes no bearer credential (S0.25), and answers it as a request with no usable session. The
  // acceptance criterion words the Rider's refusal as PERMISSION_DENIED; a finding for the Product Owner (plan section 7.47).
  it('refuses a Vendor session with PERMISSION_DENIED and a Rider’s bearer credential with SESSION_INVALID, although the Rider bundle holds dispatch.read', async () => {
    const vendor = await arrangedFixedSession(routes.kit, routes.admin, 'VENDOR');
    const rider = await arrangedFixedSession(routes.kit, routes.admin, 'RIDER');
    const calls: [string, TestResponse, number, string][] = [
      [
        'vendor list',
        await presenting(routes.kit, vendor.token, vendor.csrf).get(LIST),
        403,
        'PERMISSION_DENIED',
      ],
      [
        'vendor one',
        await presenting(routes.kit, vendor.token, vendor.csrf).get(ONE(inA.id)),
        403,
        'PERMISSION_DENIED',
      ],
      ['rider list', await routes.kit.client.bearer(rider.token).get(LIST), 401, 'SESSION_INVALID'],
      [
        'rider one',
        await routes.kit.client.bearer(rider.token).get(ONE(inA.id)),
        401,
        'SESSION_INVALID',
      ],
    ];
    for (const [label, response, status, code] of calls) {
      expect([label, response.status, codeOf(response)]).toEqual([label, status, code]);
    }
  });

  it('answers 401 SESSION_INVALID to a caller with no session', async () => {
    for (const path of [LIST, ONE(inA.id)]) {
      const response = await routes.kit.client.fork().get(path);
      expect([response.status, codeOf(response)]).toEqual([401, 'SESSION_INVALID']);
    }
  });

  // Break caught: a read that changes anything, or that leaves a trace of a rider's PIN in the ledger.
  it('changes no rider data', async () => {
    const reader = await routes.seniorOps(HUB_A);
    const before = await routes.rows(
      `select (select count(*) from rider_identity)::int as riders, (select count(*) from registered_device)::int as devices,
              (select count(*) from setup_grant)::int as grants, (select count(*) from session where principal_type = 'RIDER')::int as sessions`,
    );
    await reader.client.get(`${LIST}?q=${tag}`);
    await reader.client.get(ONE(readyA.id));
    expect(
      await routes.rows(
        `select (select count(*) from rider_identity)::int as riders, (select count(*) from registered_device)::int as devices,
                (select count(*) from setup_grant)::int as grants, (select count(*) from session where principal_type = 'RIDER')::int as sessions`,
      ),
    ).toEqual(before);
  });
});

describe('the audit of a read outside the reader’s own hub (audit.md sections 5.4 and 6)', () => {
  // Break caught: no event for a foreign rider, one for a rider of the reader's own hub, or one that names the rider's PIN or number.
  it('records a crossing for a read of a rider of another hub, and none for one of the reader’s own', async () => {
    const reader = await allHubReader();
    expect((await reader.client.get(ONE(inB.id))).status).toBe(200);
    expect(await crossingsOf(reader)).toEqual([
      { object_type: 'RiderIdentity', object_id: inB.id, responsible_hub_id: HUB_B },
    ]);
    expect((await reader.client.get(ONE(inA.id))).status).toBe(200);
    expect(await crossingsOf(reader)).toHaveLength(1);
    const senior = await routes.seniorOps(HUB_A);
    expect((await senior.client.get(ONE(inA.id))).status).toBe(200);
    expect(await crossingsOf(senior)).toEqual([]);
  });

  // Break caught: one event for each rider of a foreign hub instead of one for each hub, or a list of the reader's own hub being audited.
  it('records one crossing for each foreign hub a list shows, naming the hub and the operation, and none for its own', async () => {
    const reader = await allHubReader();
    const page = pageOf(await reader.client.get(`${LIST}?q=${tag}`));
    expect(page.items.map((item) => item.primary_hub_id)).toContain(HUB_B);
    const events = await routes.rows<{
      object_type: string;
      object_id: string;
      responsible_hub_id: string;
      related_ids: Record<string, unknown>;
      enhanced: boolean;
    }>(
      `select object_type, object_id::text, responsible_hub_id::text, related_ids, enhanced from audit_event
        where event_code = 'auth.hub_boundary.crossed' and actor_id = $1 order by object_id`,
      [reader.identity.id],
    );
    expect(events).toEqual([
      {
        object_type: 'HUB',
        object_id: HUB_B,
        responsible_hub_id: HUB_B,
        related_ids: { operation_id: 'listRiders' },
        enhanced: true,
      },
    ]);
    const text = JSON.stringify(events);
    for (const secret of [inB.id, inB.phone, inB.fullName]) expect(text).not.toContain(secret);
    const senior = await routes.seniorOps(HUB_A);
    await senior.client.get(`${LIST}?q=${tag}`);
    expect(await crossingsOf(senior)).toEqual([]);
  });
});

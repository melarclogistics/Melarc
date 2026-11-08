import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { HUBS } from '../../src/tools/seed/hubs.js';
import { arrangedFixedSession, presenting } from './support/http-sessions.js';
import { startIntegrationKit, type IntegrationKit } from './support/integration.js';
import { assemble, staffPersona, type Machinery } from './support/personas.js';
import { seedReferenceData } from './support/seeded.js';
import { buildService, type BuiltService } from './support/service.js';
import { clientFor, createTestDatabase, type TestDatabase } from './support/test-database.js';

/**
 * S0.35, `listAssignableStaffRoleBundles` against the real application and a real PostgreSQL: the staff role bundles a maker may name
 * when creating a staff profile (MSC-DEC-439, MSC-DEC-443), by the three bundles that hold `permission.assignable_bundle.read` and by
 * no one else. The answer is configuration and not hub data: the same at every hub, a minimal projection of three properties, never a
 * permission, a count of them or who holds the bundle. Every staff session is issued by the real protocol for the seeded bundle.
 */
const PATH = '/api/v1/staff-role-bundles/assignable';
const HUB = HUBS[0]?.id ?? '';
const OTHER_HUB = 'b0b0b0b0-0000-4000-8000-00000000000b';

let database: TestDatabase;
let kit: IntegrationKit;
let built: BuiltService;
let machinery: Machinery;
let admin: pg.Client;

beforeAll(async () => {
  database = await createTestDatabase();
  await seedReferenceData(database);
  admin = clientFor(database.urlFor('postgres'));
  await admin.connect();
  await admin.query(`insert into hub (id, name) values ($1, 'Kumasi')`, [OTHER_HUB]);
  built = buildService(database, { poolMax: 2 });
  machinery = assemble(built);
  kit = await startIntegrationKit(database, {
    poolMax: 4,
    compiledFixedPolicy: { VENDOR: 1, RIDER: 1 },
    vendorOrganization: () => Promise.resolve('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a'),
  });
});

afterAll(async () => {
  await kit.stop();
  await built.close();
  await admin.end();
  await database.drop();
});

interface Item {
  readonly id: string;
  readonly name: string;
  readonly requires_platform_admin_approval: boolean;
}

async function asStaff(bundle: string, hub: string | null = HUB): Promise<TestClient> {
  const persona = await staffPersona(machinery, admin, { roleBundleId: bundle, primaryHubId: hub });
  return presenting(kit, persona.issued.token, persona.issued.csrfToken ?? undefined);
}
const itemsOf = (response: TestResponse): Item[] => {
  expect(response.status).toBe(200);
  return (response.json() as { items: Item[] }).items;
};
const codeOf = (response: TestResponse): string | undefined =>
  (response.json() as { code?: string }).code;

const HOLDERS = [
  ['Ops Staff', BUNDLE_IDS.opsStaff],
  ['Senior Ops', BUNDLE_IDS.seniorOps],
  ['Platform Admin', BUNDLE_IDS.platformAdmin],
] as const;

describe.each(HOLDERS)('%s reading the assignable staff role bundles', (_name, bundle) => {
  // Break caught: the list holding a bundle that is not for human staff (the fixed Vendor and Rider bundles), or one that is missing,
  // or the approval flag reporting the wrong tier: a privileged bundle (Senior Ops, Platform Admin) needs a Platform Admin to approve.
  it('is given the bundles of human staff, with the flag of the approval each needs', async () => {
    const client = await asStaff(bundle);

    const items = itemsOf(await client.get(PATH));

    const rows = await admin.query<{ id: string; name: string; privileged: boolean }>(
      `select id, name, privileged from role_bundle where audience = 'STAFF'`,
    );
    expect(items.map((item) => item.id).toSorted()).toEqual(
      rows.rows.map((row) => row.id).toSorted(),
    );
    for (const item of items) {
      const row = rows.rows.find((candidate) => candidate.id === item.id);
      expect(item).toEqual({
        id: row?.id,
        name: row?.name,
        requires_platform_admin_approval: row?.privileged,
      });
    }
    const ids = items.map((item) => item.id);
    expect(ids).toEqual(
      expect.arrayContaining([BUNDLE_IDS.opsStaff, BUNDLE_IDS.seniorOps, BUNDLE_IDS.platformAdmin]),
    );
    expect(ids).not.toContain(BUNDLE_IDS.vendor);
    expect(ids).not.toContain(BUNDLE_IDS.rider);
    expect(
      items.find((item) => item.id === BUNDLE_IDS.opsStaff)?.requires_platform_admin_approval,
    ).toBe(false);
    expect(
      items.find((item) => item.id === BUNDLE_IDS.seniorOps)?.requires_platform_admin_approval,
    ).toBe(true);
    expect(
      items.find((item) => item.id === BUNDLE_IDS.platformAdmin)?.requires_platform_admin_approval,
    ).toBe(true);
  });

  // Break caught: a projection that grows: a permission, a count of permissions or who holds the bundle is never represented (the
  // property names are the contract's three, and the answer carries no ETag and no page token).
  it('is a minimal projection of three properties, not paged and with no ETag', async () => {
    const client = await asStaff(bundle);

    const response = await client.get(PATH);

    expect(Object.keys(response.json() as object)).toEqual(['items']);
    for (const item of itemsOf(response)) {
      expect(Object.keys(item).toSorted()).toEqual([
        'id',
        'name',
        'requires_platform_admin_approval',
      ]);
    }
    expect(response.header('etag')).toBeNull();
    expect(itemsOf(response)).toEqual(
      itemsOf(response).toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
  });
});

describe('the answer is configuration, and not hub data', () => {
  // Break caught: the list narrowed by the hub of the reader (the key's scope is none: no hub is named or evaluated), or by the
  // reader having no primary hub.
  it('is the same for a reader in another hub and for one with no hub at all', async () => {
    const here = itemsOf(await (await asStaff(BUNDLE_IDS.opsStaff, HUB)).get(PATH));
    const there = itemsOf(await (await asStaff(BUNDLE_IDS.opsStaff, OTHER_HUB)).get(PATH));
    const nowhere = itemsOf(await (await asStaff(BUNDLE_IDS.platformAdmin, null)).get(PATH));

    expect(there).toEqual(here);
    expect(nowhere).toEqual(here);
  });
});

describe('who is refused the assignable bundles (AC-SLICE-000-44)', () => {
  // Break caught: a missing session answered 403, or a held session without the key answered 401; holding another read key opening
  // this one (the key is its own: `staff.identity.create` and `permission.read` do not gate it).
  it('answers 401 SESSION_INVALID with no session and 403 PERMISSION_DENIED to a session without the key', async () => {
    const none = await kit.client.fork().get(PATH);
    const finance = await (await asStaff(BUNDLE_IDS.finance)).get(PATH);

    expect([none.status, codeOf(none)]).toEqual([401, 'SESSION_INVALID']);
    expect([finance.status, codeOf(finance)]).toEqual([403, 'PERMISSION_DENIED']);
  });

  // Break caught: a Vendor reading a list that is for staff makers on the Ops Portal; or a Rider's bearer credential accepted by an
  // operation whose contract takes a browser session only (the three authentication models never mix: the credential is not one this
  // operation takes, so it is no session for it).
  it('answers a Vendor 403 PERMISSION_DENIED and a Rider, whose bearer credential this operation does not take, 401 SESSION_INVALID', async () => {
    const vendor = await arrangedFixedSession(kit, admin, 'VENDOR');
    const rider = await arrangedFixedSession(kit, admin, 'RIDER');

    const asVendor = await presenting(kit, vendor.token, vendor.csrf).get(PATH);
    const asRider = await kit.client.bearer(rider.token).get(PATH);

    expect([asVendor.status, codeOf(asVendor)]).toEqual([403, 'PERMISSION_DENIED']);
    expect([asRider.status, codeOf(asRider)]).toEqual([401, 'SESSION_INVALID']);
  });

  // Break caught: the read leaving a record behind: a read writes nothing, and the key permits nothing but the read.
  it('writes nothing', async () => {
    const client = await asStaff(BUNDLE_IDS.opsStaff);
    const before = await admin.query('select count(*)::int as n from audit_event');

    await client.get(PATH);

    expect((await admin.query('select count(*)::int as n from audit_event')).rows[0]).toEqual(
      before.rows[0],
    );
  });
});

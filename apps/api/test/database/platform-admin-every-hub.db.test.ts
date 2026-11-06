import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { API_RUNTIME_ROLE } from '../../src/platform/config/load-config.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS, GRANTS } from '../../src/tools/seed/bundles.js';
import { insertManifest, insertStop, manifestRow, stopRow } from './support/manifests.js';
import { insertNotification } from './support/notifications.js';
import { insertPickupRequest, insertVendorLocation, pickupRequestRow } from './support/pickups.js';
import { insertRider, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, startStaffRoutes, type StaffRoutes } from './support/staff-routes.js';
import { clientFor } from './support/test-database.js';
import { insertVendor, vendorRow } from './support/vendors.js';

/**
 * Task P1 (`AC-SLICE-001-83`; permissions.md section 5; the Product Owner's decision of 5 November 2026): the Platform Admin holds every key it
 * holds at every hub. The seeded Platform Admin has no primary hub, so before the decision it saw nothing of the floor (`OB-S1-75`: the rider
 * roster empty; `OB-S1-76`: the walk-in booking refused). Against the real application and a real PostgreSQL, with records in two hubs:
 *
 * - for every hub-scoped list and read the Platform Admin holds that the application has, it is given the records of **both** hubs, and reads a
 *   record of the other hub by its id;
 * - an Ops Staff officer and a Senior Ops user of one hub are given that hub's records alone, exactly as before;
 * - row-level security is unchanged: the runtime role under a hub set of one hub reads no row of the other, and under none reads none;
 * - the tier of every grant is what the maker-checker exception reads, and only the Platform Admin's grants carry tier P.
 */
const HUBS = { a: HUB_A, b: HUB_B } as const;

let routes: StaffRoutes;
let runtime: pg.Client;
const requests: Record<'a' | 'b', string> = { a: '', b: '' };
const manifests: Record<'a' | 'b', string> = { a: '', b: '' };
const stops: Record<'a' | 'b', string> = { a: '', b: '' };
const handovers: Record<'a' | 'b', string> = { a: '', b: '' };
const riders: Record<'a' | 'b', string> = { a: '', b: '' };
const notifications: Record<'a' | 'b', string> = { a: '', b: '' };
const organisations: Record<'a' | 'b', string> = { a: '', b: '' };

beforeAll(async () => {
  routes = await startStaffRoutes();
  runtime = clientFor(routes.database.urlFor(API_RUNTIME_ROLE));
  await runtime.connect();
  for (const which of ['a', 'b'] as const) {
    const hub = HUBS[which];
    const vendor = await insertVendor(routes.admin, vendorRow({ hubId: hub }));
    organisations[which] = vendor.organizationId;
    await insertVendorLocation(routes.admin, vendor.organizationId, { isDefault: true });
    requests[which] = (
      await insertPickupRequest(routes.admin, pickupRequestRow(vendor.organizationId, hub))
    ).id;
    riders[which] = (await insertRider(routes.admin, riderRow({ hubId: hub }))).id;
    // A run in progress under the hub's rider, with a stop for the hub's request and a custody handover to the hub opened on it: the stop and
    // the handover are the records of the two reads of the run that a Platform Admin holds besides the run's own.
    const run = await insertManifest(
      routes.admin,
      manifestRow(hub, { state: 'IN_PROGRESS', assignedRiderId: riders[which] }),
    );
    manifests[which] = run.id;
    stops[which] = (await insertStop(routes.admin, stopRow(run, requests[which], 1))).id;
    const opened = await routes.admin.query<{ id: string }>(
      `insert into run_custody_handover (id, manifest_id, responsible_hub_id, from_rider_id, to_hub_id, initiation_note, initiated_by)
       values (gen_random_uuid(), $1, $2, $3, $2, 'Fixture handover', '5eed0000-0000-4000-8000-0000000000e1') returning id`,
      [run.id, hub, riders[which]],
    );
    handovers[which] = opened.rows[0]?.id ?? '';
    notifications[which] = (
      await insertNotification(routes.admin, { hubId: hub, subjectId: requests[which] })
    ).id;
  }
}, 180_000);

afterAll(async () => {
  await runtime.end();
  await routes.stop();
});

const idsOf = (response: TestResponse): string[] =>
  (response.json() as { items: { id: string }[] }).items.map((item) => item.id).toSorted();

/** Every hub-scoped list the Platform Admin holds that the application has, with the records of each hub it must be given. */
const LISTS = [
  {
    operation: 'listPickupRequests',
    url: () => `${API}/pickup-requests?page_size=100`,
    ids: () => requests,
  },
  {
    operation: 'listPickupManifests',
    url: () => `${API}/pickup-manifests?page_size=100`,
    ids: () => manifests,
  },
  { operation: 'listRiders', url: () => `${API}/ops/riders?page_size=100`, ids: () => riders },
  {
    operation: 'listRunCustodyHandovers',
    url: () => `${API}/run-custody-handovers?page_size=100`,
    ids: () => handovers,
  },
  {
    operation: 'listNotifications',
    url: () => `${API}/notifications?page_size=100`,
    ids: () => notifications,
  },
] as const;

/** Every read of one record the Platform Admin holds that the application has, with the record of the second hub. */
const READS = [
  { operation: 'getPickupRequest', url: () => `${API}/pickup-requests/${requests.b}` },
  { operation: 'getPickupManifest', url: () => `${API}/pickup-manifests/${manifests.b}` },
  { operation: 'getRider', url: () => `${API}/ops/riders/${riders.b}` },
  { operation: 'getPickupStop', url: () => `${API}/pickup-stops/${stops.b}` },
  { operation: 'getRunCustodyHandover', url: () => `${API}/run-custody-handovers/${handovers.b}` },
] as const;

describe('the lists of the Platform Admin with no primary hub (AC-SLICE-001-83, OB-S1-75)', () => {
  // Break caught: a list read under the own-hub grant of a session with no hub (the defect: an empty page), or a list that gives the other
  // hub's records to the person of one hub.
  it.each(LISTS.map((each) => [each.operation, each] as const))(
    '%s gives the Platform Admin the records of both hubs, and the officer and the Senior Ops user hub A’s alone',
    async (_operation, list) => {
      const platformAdmin = await routes.platformAdmin();
      const officer = await routes.opsStaff(HUB_A);
      const senior = await routes.seniorOps(HUB_A);
      const ids = list.ids();

      const admin = await platformAdmin.client.get(list.url());
      expect(admin.status).toBe(200);
      expect(idsOf(admin)).toEqual([ids.a, ids.b].toSorted());
      for (const reader of [officer, senior]) {
        const answer = await reader.client.get(list.url());
        expect(answer.status).toBe(200);
        expect(idsOf(answer)).toEqual([ids.a]);
      }
    },
  );

  // Break caught: the vendor's saved locations of another hub's vendor refused to the Platform Admin, or given to the officer of the first hub.
  it('gives the Platform Admin the saved pickup locations of a vendor of either hub, and the officer those of their own hub’s vendor alone', async () => {
    const platformAdmin = await routes.platformAdmin();
    const officer = await routes.opsStaff(HUB_A);
    const locations = (organisation: string) =>
      `${API}/vendor-organizations/${organisation}/pickup-locations`;

    for (const which of ['a', 'b'] as const) {
      const answer = await platformAdmin.client.get(locations(organisations[which]));
      expect(answer.status, which).toBe(200);
      expect((answer.json() as { items: unknown[] }).items, which).toHaveLength(1);
    }
    expect((await officer.client.get(locations(organisations.a))).status).toBe(200);
    expect((await officer.client.get(locations(organisations.b))).status).not.toBe(200);
  });
});

describe('the reads of one record by the Platform Admin with no primary hub', () => {
  // Break caught: a record of another hub refused HUB_SCOPE_VIOLATION to the holder of an all-hub grant (the walk-in refusal's sibling), or
  // opened by the officer of the first hub.
  it.each(READS.map((each) => [each.operation, each] as const))(
    '%s opens a record of the second hub for the Platform Admin and refuses it to the officer of the first',
    async (_operation, read) => {
      const platformAdmin = await routes.platformAdmin();
      const officer = await routes.opsStaff(HUB_A);

      expect((await platformAdmin.client.get(read.url())).status).toBe(200);
      const refused = await officer.client.get(read.url());
      expect(refused.status).toBe(403);
      expect((refused.json() as { code: string }).code).toBe('HUB_SCOPE_VIOLATION');
    },
  );
});

describe('the queue summary of the Platform Admin with no primary hub', () => {
  // Break caught: the five pickup queues `0` for the administrator (before the decision), or a count that is not the sum of the hubs.
  it('counts the work of both hubs, as its lists show it', async () => {
    const platformAdmin = await routes.platformAdmin();
    const officer = await routes.opsStaff(HUB_A);
    const entry = (response: TestResponse, queue: string) =>
      (response.json() as { queues: { queue: string; count: number }[] }).queues.find(
        (each) => each.queue === queue,
      );

    const admin = await platformAdmin.client.get(`${API}/ops/queue-summary`);
    const own = await officer.client.get(`${API}/ops/queue-summary`);

    // The two pending requests, one in each hub: the administrator is waited on by both, the officer by the one of their hub.
    expect(entry(admin, 'PICKUP_AWAITING_CONFIRMATION')?.count).toBe(2);
    expect(entry(own, 'PICKUP_AWAITING_CONFIRMATION')?.count).toBe(1);
    const pending = await platformAdmin.client.get(`${API}/pickup-requests?state=PENDING`);
    expect(idsOf(pending)).toHaveLength(2);
  });
});

describe('row-level security is unchanged (AC-SLICE-001-83)', () => {
  /** The ids a table gives the runtime role under the context of a scope: what a list is given to read. */
  async function idsUnder(
    table: string,
    key: string,
    mode: 'SET' | 'ALL',
    hubs: string,
  ): Promise<string[]> {
    await runtime.query('begin');
    try {
      await runtime.query(
        `select set_config('melarc.principal_type', 'STAFF', true), set_config('melarc.principal_id', gen_random_uuid()::text, true),
                set_config('melarc.surface', 'OPS_PORTAL', true), set_config('melarc.authorization_key', $1, true),
                set_config('melarc.hub_scope_mode', $2, true), set_config('melarc.authorized_hub_ids', $3, true)`,
        [key, mode, hubs],
      );
      const found = await runtime.query<{ id: string }>(`select id from ${table} order by id`);
      return found.rows.map((row) => row.id);
    } finally {
      await runtime.query('rollback');
    }
  }

  // Break caught: the widening of a grant implemented in the database (a policy that lets a hub set read another hub's rows), or a context
  // with no hub reading every row. The all-hub grant reads both, because its context says so.
  it.each([
    ['pickup_request', 'pickup.read', requests],
    ['rider_identity', 'dispatch.read', riders],
  ] as const)(
    'gives the runtime role of %s the rows of the hubs of its context and no other',
    async (table, key, rows) => {
      expect(await idsUnder(table, key, 'SET', HUB_A)).toEqual([rows.a]);
      expect(await idsUnder(table, key, 'SET', HUB_B)).toEqual([rows.b]);
      expect(await idsUnder(table, key, 'SET', '')).toEqual([]);
      expect(await idsUnder(table, key, 'ALL', '')).toEqual([rows.a, rows.b].toSorted());
    },
  );
});

describe('the tier of the Platform Admin’s grants (the maker-checker exception reads it)', () => {
  // Break caught: the tier lost or changed by the widening, which would take the exception from the Platform Admin or give it to a lower tier.
  it('is P on every grant of the Platform Admin bundle and on no grant of another', async () => {
    const tiers = await routes.rows<{ bundle_id: string; n: number }>(
      `select bundle_id, count(*)::int as n from role_bundle_grant where tier = 'P' group by bundle_id`,
    );
    const ofAdmin = GRANTS.filter((grant) => grant.bundleId === BUNDLE_IDS.platformAdmin);
    expect(tiers).toEqual([{ bundle_id: BUNDLE_IDS.platformAdmin, n: ofAdmin.length }]);

    const approvers = await routes.rows<{ bundle_id: string; tier: string }>(
      `select bundle_id, tier from role_bundle_grant where permission_key = 'pickup.exception.approve' order by tier`,
    );
    expect(approvers).toEqual([
      { bundle_id: BUNDLE_IDS.opsStaff, tier: 'A' },
      { bundle_id: BUNDLE_IDS.platformAdmin, tier: 'P' },
      { bundle_id: BUNDLE_IDS.seniorOps, tier: 'S' },
    ]);
  });
});

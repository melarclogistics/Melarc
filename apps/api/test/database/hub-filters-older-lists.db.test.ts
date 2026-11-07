import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestClient, TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { insertStaff, staffRow } from './support/identities.js';
import { insertRider, riderRow } from './support/riders.js';
import { API, HUB_A, HUB_B, outcomeOf, type Actor } from './support/staff-routes.js';
import { startVendorRoutes, type VendorRoutes } from './support/vendor-routes.js';

/**
 * Task F (the Product Owner's decision of 7 November 2026, afternoon: every hub filter behaves the same), `AC-HUBF-13` of
 * features/operations/hub-filters.md: the three older lists that take a `hub_id` (`listStaffIdentities`, `listRiders`, `listVendorAccounts`) answer a staff
 * session's hub outside the grant as the four reads of task C3 do, **with an empty page and no statement**, so that a hub that exists outside the grant and a hub
 * that does not exist cannot be told apart by the time either takes. Against the real application and a real PostgreSQL: the answers (inside the grant, outside it,
 * unknown, every hub, none), the statements the application's login sent (the one thing a clock cannot show at the size of these tables), the refusal of a value that
 * is not a hub, and the audit. The lists' own route tests (`staff-identity-routes`, `rider-reads-routes`, `vendor-account-routes`) are unchanged and hold the rest.
 *
 * **Every derived expectation is paired with one written out by hand**: the hub's records are the same session's unfiltered read kept to the hub each carries, and
 * the records that this file arranges for each hub (two staff profiles, two riders and two vendor accounts in each) are found in the one hub and never in the other.
 */
const STAFF = `${API}/staff-identities`;
const RIDERS = `${API}/ops/riders`;
const VENDORS = `${API}/ops/vendors`;

/** The identifier of no hub. */
const NO_HUB = randomUUID();

interface Item {
  readonly id: string;
  readonly primary_hub_id?: string | null;
  readonly responsible_hub_id?: string | null;
}
interface Page {
  readonly items: Item[];
  readonly next_page_token: string | null;
}

/** One of the three lists: where it is, the table its statement reads (as the driver is given it, the shape of its ordering), and the hub each item carries. */
interface Listing {
  readonly operation: string;
  readonly path: string;
  /** The ordering clause that only this list's own statement has, in the normalised text of the tracer. */
  readonly ordering: RegExp;
  readonly hubOf: (item: Item) => string | null | undefined;
}
const LISTINGS: Record<'staff' | 'riders' | 'vendors', Listing> = {
  staff: {
    operation: 'listStaffIdentities',
    path: STAFF,
    ordering: /order by created_at, id/,
    hubOf: (item) => item.primary_hub_id,
  },
  riders: {
    operation: 'listRiders',
    path: RIDERS,
    ordering: /order by r\.created_at, r\.id/,
    hubOf: (item) => item.primary_hub_id,
  },
  vendors: {
    operation: 'listVendorAccounts',
    path: VENDORS,
    ordering: /order by a\.created_at, a\.id/,
    hubOf: (item) => item.responsible_hub_id,
  },
};

let routes: VendorRoutes;
let senior: Actor;
let officer: Actor;
let admin: Actor;
/** What this file arranges: two records of each list in each hub, by identifier. */
const arranged = {
  staff: { a: [] as string[], b: [] as string[] },
  riders: { a: [] as string[], b: [] as string[] },
  vendors: { a: [] as string[], b: [] as string[] },
};

beforeAll(async () => {
  routes = await startVendorRoutes();
  senior = await routes.actor(BUNDLE_IDS.seniorOps, HUB_A);
  officer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  admin = await routes.platformAdmin();
  for (const [side, hub] of [
    ['a', HUB_A],
    ['b', HUB_B],
  ] as const) {
    for (let index = 0; index < 2; index += 1) {
      arranged.staff[side].push(
        (await insertStaff(routes.admin, staffRow({ primaryHubId: hub }))).id,
      );
      arranged.riders[side].push((await insertRider(routes.admin, riderRow({ hubId: hub }))).id);
      arranged.vendors[side].push((await routes.vendor({ hubId: hub })).row.accountId);
    }
  }
}, 180_000);

afterAll(async () => {
  await routes.stop();
});

/** What a response is, but for its own identifier and moment: the status, the body, the headers and the cookies. */
const shapeOf = (response: TestResponse) => ({
  status: response.status,
  body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
  headers: response
    .headerEntries()
    .filter(([name]) => !/^(date|x-request-id|request-id)$/.test(name)),
  cookies: response.setCookies,
});

const withHub = (listing: Listing, hub?: string): string =>
  `${listing.path}?page_size=100${hub === undefined ? '' : `&hub_id=${hub}`}`;

async function read(client: TestClient, listing: Listing, hub?: string): Promise<Page> {
  const answer = await client.get(withHub(listing, hub));
  expect(answer.status, `${listing.operation} for ${hub ?? 'no hub'}`).toBe(200);
  const page = answer.json() as Page;
  expect(
    page.next_page_token,
    `${listing.operation}: one page holds what these tests arrange`,
  ).toBe(null);
  return page;
}

const idsOf = (page: Page): string[] => page.items.map((item) => item.id);
const hubAuditEvents = async (): Promise<number> =>
  (
    await routes.rows<{ n: number }>(
      `select count(*)::int as n from audit_event where event_code = 'auth.hub_boundary.crossed'`,
    )
  )[0]?.n ?? 0;

/** Who reads which list: Senior Ops holds the three keys at its own hub, the officer holds the rider and vendor keys (and not `staff.read`), the Platform Admin all three at every hub. */
const SESSIONS: readonly (readonly [string, () => Actor, readonly (keyof typeof LISTINGS)[]])[] = [
  ['a Senior Ops user of the first hub', () => senior, ['staff', 'riders', 'vendors']],
  ['an Ops Staff officer of the first hub', () => officer, ['riders', 'vendors']],
];

describe('AC-HUBF-13: a hub outside the grant, and a hub that does not exist, are an empty page on the three older lists, and one answer', () => {
  // Break caught (task F, `AC-HUBF-13`, `GBT-GS14`): a hub outside the grant that answers something other than the empty page (a refusal, which would tell a
  // caller which hubs exist, or another hub's records), the hub that exists answered another way than the identifier of no hub (down to the status, the body
  // and the headers), the session's own hub lost to the shortcut, or a list that changed when no hub is asked for.
  it.each(SESSIONS)(
    'for %s: its own hub is what it reads of it, a hub outside the grant and the identifier of no hub are each the empty page, and the two are one answer',
    async (_label, who, lists) => {
      const client = who().client;
      for (const name of lists) {
        const listing = LISTINGS[name];
        const whole = await read(client, listing);
        const own = await read(client, listing, HUB_A);

        // The hub's own records: the session's unfiltered read kept to the hub, in the same order ...
        expect(idsOf(own), `${listing.operation} for its own hub`).toEqual(
          whole.items.filter((item) => listing.hubOf(item) === HUB_A).map((item) => item.id),
        );
        // ... which are the ones arranged for it, and none of the other hub's.
        for (const id of arranged[name].a) expect(idsOf(own), listing.operation).toContain(id);
        for (const id of arranged[name].b) expect(idsOf(own), listing.operation).not.toContain(id);
        expect(own.items.length, `${listing.operation} has something to hide`).toBeGreaterThan(0);

        const outside = await client.get(withHub(listing, HUB_B));
        const nowhere = await client.get(withHub(listing, NO_HUB));
        for (const answer of [outside, nowhere]) {
          expect([answer.status, answer.json()], listing.operation).toEqual([
            200,
            { items: [], next_page_token: null },
          ]);
        }
        expect(shapeOf(outside), listing.operation).toEqual(shapeOf(nowhere));
      }
    },
  );

  // Break caught: a Platform Admin, whose grants are of every hub, answered empty for a hub it may read (the shortcut taken for a grant of every hub), or
  // told something for the identifier of no hub; or its read with no hub changed.
  it('for a Platform Admin, whose grants are of every hub: the second hub is its records, the identifier of no hub is the empty page, and no hub is every record', async () => {
    for (const [name, listing] of Object.entries(LISTINGS) as [keyof typeof LISTINGS, Listing][]) {
      const whole = await read(admin.client, listing);
      const second = await read(admin.client, listing, HUB_B);
      const nowhere = await admin.client.get(withHub(listing, NO_HUB));

      expect(idsOf(second), listing.operation).toEqual(
        whole.items.filter((item) => listing.hubOf(item) === HUB_B).map((item) => item.id),
      );
      for (const id of arranged[name].b) expect(idsOf(second), listing.operation).toContain(id);
      for (const id of arranged[name].a) expect(idsOf(second), listing.operation).not.toContain(id);
      expect([nowhere.status, nowhere.json()], listing.operation).toEqual([
        200,
        { items: [], next_page_token: null },
      ]);
      for (const id of [...arranged[name].a, ...arranged[name].b]) {
        expect(idsOf(whole), listing.operation).toContain(id);
      }
    }
  });

  // Break caught (task F, `GBT-GS14`): a hub outside the grant that is still read, so that the database walks the other hub's index and discards every
  // row, and the time tells a caller whether the hub exists and how much it holds. What the application's login sent to the server is read as the driver was
  // given it: for a hub outside the grant and for the identifier of no hub, no statement that is the list's own (the ordering clause only it has); for the
  // session's own hub and for no hub, the statement is there, so that an absence is the shortcut and not a trace that saw nothing. (At the size of these tables
  // a clock shows nothing above the request's own noise, so the statements are what holds it.)
  it.each(SESSIONS)(
    'for %s: no statement of the list is sent for a hub outside the grant or for the identifier of no hub, and one is for its own hub and for none',
    async (_label, who, lists) => {
      const client = who().client;
      for (const name of lists) {
        const listing = LISTINGS[name];
        const sent = async (hub?: string): Promise<string[]> => {
          const traced = await routes.kit.trace(() => client.get(withHub(listing, hub)));
          expect(traced.result.status, listing.operation).toBe(200);
          return traced.statements.filter((statement) => listing.ordering.test(statement));
        };

        expect(await sent(HUB_B), `${listing.operation} for the second hub`).toEqual([]);
        expect(await sent(NO_HUB), `${listing.operation} for no hub`).toEqual([]);
        expect((await sent(HUB_A)).length, `${listing.operation} for its own hub`).toBe(1);
        expect((await sent()).length, `${listing.operation} with no hub_id`).toBe(1);
      }
    },
  );

  // Break caught: the shortcut taken for a Platform Admin's reach (a grant of every hub reads, whatever hub is named: the second hub and the identifier of
  // no hub are both asked of the database, and the second hub's records come back from it).
  it('for a Platform Admin, a hub is asked of the database, the second hub and the identifier of no hub alike', async () => {
    for (const listing of Object.values(LISTINGS)) {
      for (const hub of [HUB_A, HUB_B, NO_HUB]) {
        const traced = await routes.kit.trace(() => admin.client.get(withHub(listing, hub)));
        expect(traced.result.status, listing.operation).toBe(200);
        expect(
          traced.statements.filter((statement) => listing.ordering.test(statement)).length,
          `${listing.operation} for ${hub}`,
        ).toBe(1);
      }
    }
  });

  // Break caught: a value that is not a hub answered with an empty page (the shortcut run before the value is judged), or refused as another failure than
  // VALIDATION_FAILED. At HTTP the contract's own validation refuses it first, naming the parameter by its bare name; the unit tests hold the service's own
  // refusal (`src/hub-filter-older-lists.test.ts`).
  it.each([
    ['a word', 'hub_id=not-a-uuid'],
    ['an empty value', 'hub_id='],
    ['a UUID with spaces around it', `hub_id=%20${HUB_B}%20`],
    ['a UUID written as a URN', `hub_id=urn:uuid:${HUB_B}`],
    ['a hub given twice', `hub_id=${HUB_A}&hub_id=${HUB_B}`],
  ])(
    'refuses %s as a hub on each list, for a session of one hub and for a Platform Admin',
    async (_what, raw) => {
      for (const [client, lists] of [
        [senior.client, ['staff', 'riders', 'vendors'] as const],
        [admin.client, ['staff', 'riders', 'vendors'] as const],
      ] as const) {
        for (const name of lists) {
          const listing = LISTINGS[name];
          const answer = await client.get(`${listing.path}?${raw}`);
          expect(outcomeOf(answer), `${listing.operation}: ${raw}`).toEqual([
            400,
            'VALIDATION_FAILED',
          ]);
        }
      }
    },
  );

  // Break caught: an event written for a page that returned nothing (a hub that was named and not reached is not an attempt on a hub), or one written for
  // the empty answer of a shortcut. The control is the Platform Admin, who has no hub of its own and so crosses the second hub: its read of that hub writes
  // what an audited read always wrote, so a count that cannot see an event does not pass for the absence of one.
  it('writes no audit event for a hub outside the grant or for the identifier of no hub', async () => {
    const control = await hubAuditEvents();
    await read(admin.client, LISTINGS.riders, HUB_B);
    expect(await hubAuditEvents(), 'a read of a hub that is crossed is audited').toBeGreaterThan(
      control,
    );
    const before = await hubAuditEvents();

    for (const [who, lists] of [
      [senior, ['staff', 'riders', 'vendors'] as const],
      [officer, ['riders', 'vendors'] as const],
    ] as const) {
      for (const name of lists) {
        for (const hub of [HUB_B, NO_HUB]) {
          await who.client.get(withHub(LISTINGS[name], hub));
        }
      }
    }

    expect(await hubAuditEvents()).toBe(before);
  });
});

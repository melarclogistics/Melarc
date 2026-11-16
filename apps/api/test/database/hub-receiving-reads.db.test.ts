import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { SecurityContext } from '../../src/platform/database/transaction-context.js';
import type { TestResponse } from '../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../src/tools/seed/bundles.js';
import { handOver, type HandedOver } from './support/handed-over.js';
import { manifestDays, type ManifestDays } from './support/manifest-days.js';
import { insertManifest, manifestRow } from './support/manifests.js';
import { grant, newBundle } from './support/policy-fixtures.js';
import { seedHubConfiguration } from './support/seeded.js';
import { API, HUB_A, HUB_B, codeOf, type Actor } from './support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from './support/vendor-routes.js';

/**
 * S1.35b, the reads of receiving by run (`listReceivingRuns`, `getReceivingRun`, `listMissingParcels`'s empty case, `getEvidenceLimits`; `hub.read`; `AC-SLICE-001-92` and `-98`; features/hub/hub-intake.md sections
 * 5.1 and 5.4; Run D, D-D2 and D-D3), against the real application and a real PostgreSQL. Each claim:
 *
 * - **The queue is by run, for the hubs of the grant**: a run is one row with its vendors counted (waiting, needing a decision, blind-count), the parcels its door photos expect and its handover; an officer sees
 *   the runs of their own hub and a hub outside the grant is an empty page, never an error and never another hub's run; a Platform Admin sees every hub, and each hub it is not at is a bounded audited crossing.
 * - **One page is the run**: each vendor is a section with its parcels and their door photos, **its own `ETag`** and its counts, derived and never typed; a blind-count vendor has no parcel and no number of the rider's
 *   (D-D3); no phone number, address or key is in any answer.
 * - **A count is what its list returns** (the two queues of `getQueueSummary` call the function the lists call): the runs waiting and the parcels being searched for, for every hub, with a hub and without.
 * - **The criteria and the answers are judged**: a view, a page, a hub and a token that are not valid are `VALIDATION_FAILED` naming the parameter, a run of another hub is `HUB_SCOPE_VIOLATION` and one that does not
 *   exist `NOT_FOUND`, and a session without `hub.read` is `PERMISSION_DENIED`.
 */
const RUNS = `${API}/receiving-runs`;
const RUN = (id: string) => `${RUNS}/${id}`;
const MISSING = `${API}/missing-parcels`;
const LIMITS = `${API}/evidence-limits`;
const SUMMARY = `${API}/ops/queue-summary`;
/** The telephone number the arranged stops carry in their summary (`runs.ts`): no answer of the receiving side names it. */
const A_PHONE = '233200000001';

let routes: VendorRoutes;
let days: ManifestDays;
let vendor: ArrangedVendor;
let photoRunA: HandedOver;
let blindRunA: HandedOver;
let photoRunB: HandedOver;

beforeAll(async () => {
  routes = await startVendorRoutes();
  await seedHubConfiguration(routes.database);
  days = await manifestDays(routes.admin);
  vendor = await routes.vendor();
  // The first hub: a run of two photographed stops (2 and 3 parcels) and a run of one stop with no photos (counted blind); the second hub: a run of one photographed stop. In this order, so that the
  // queue (oldest handover first) is the first hub's photo run, its blind run, then the second hub's.
  photoRunA = await handOver(routes, vendor, days, { collected: [2, 3], photos: true });
  blindRunA = await handOver(routes, vendor, days, { collected: [3] });
  photoRunB = await handOver(routes, vendor, days, { collected: [2], photos: true, hubId: HUB_B });
}, 300_000);

afterAll(async () => {
  await routes.stop();
});

interface Page<T> {
  readonly items: readonly T[];
  readonly next_page_token: string | null;
}
interface RunRow {
  readonly run_id: string;
  readonly run_code: string;
  readonly hub_id: string;
  readonly hub_name: string;
  readonly rider_name: string;
  readonly vendor_names: readonly string[];
  readonly vendors_total: number;
  readonly vendors_waiting: number;
  readonly vendors_needing_decision: number;
  readonly blind_count_vendors: number;
  readonly parcels_expected: number;
  readonly missing_searching: number;
  readonly handed_over_at: string;
  readonly checking_in: readonly { readonly name: string; readonly is_you: boolean }[];
}
interface ParcelRow {
  readonly id: string;
  readonly ordinal: number;
  readonly origin: string;
  readonly state: string;
  readonly photo_evidence_id: string | null;
  readonly arrived_by_name: string | null;
  readonly arrived_at: string | null;
  readonly missing_marked_at: string | null;
}
interface VendorSection {
  readonly intake_id: string;
  readonly intake_code: string;
  readonly intake_etag: string;
  readonly receiving_mode: string;
  readonly state: string;
  readonly vendor_name: string;
  readonly parcels_expected: number | null;
  readonly arrived_count: number | null;
  readonly received_count: number | null;
  readonly count_variance: string | null;
  readonly lock: unknown;
  readonly missing_count: number;
  readonly extra_count: number;
  readonly damaged_count: number;
  readonly parcels: readonly ParcelRow[];
}
interface RunPage {
  readonly run: {
    readonly id: string;
    readonly code: string;
    readonly hub_id: string;
    readonly hub_name: string;
    readonly service_date: string;
  };
  readonly rider_name: string;
  readonly handed_over_at: string;
  readonly vendors: readonly VendorSection[];
}

const pageOf = <T>(response: TestResponse): Page<T> => response.json() as Page<T>;
const runsOf = async (actor: Actor, query = ''): Promise<readonly RunRow[]> => {
  const response = await actor.client.get(`${RUNS}${query}`);
  expect(response.status, query).toBe(200);
  return pageOf<RunRow>(response).items;
};
const codeOfRun = (run: HandedOver): string => run.run.manifest.code;
const idOfRun = (run: HandedOver): string => run.run.manifest.id;

/** Every key of a JSON value, however deep. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) => [key, ...keysOf(member)]);
  }
  return [];
}

const officerA = (): Promise<Actor> => routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
const officerB = (): Promise<Actor> => routes.actor(BUNDLE_IDS.opsStaff, HUB_B);

describe('listReceivingRuns: the queue by run', () => {
  // Break caught: a queue by intake (a run drawn once for each vendor), a vendor counted twice, a run's parcels or blind vendors mis-added, or the order of the queue (oldest handover first) lost: the run is
  // one row, with its vendors counted by what they are, and its parcels the ones its door photos expect.
  it('is one row for each run of the officer’s hub, oldest handover first, with its vendors and parcels counted', async () => {
    const rows = await runsOf(await officerA());

    expect(rows.map((row) => row.run_id)).toEqual([idOfRun(photoRunA), idOfRun(blindRunA)]);
    const [photo, blind] = rows;
    expect(photo).toMatchObject({
      run_code: codeOfRun(photoRunA),
      hub_id: HUB_A,
      vendors_total: 2,
      vendors_waiting: 2,
      vendors_needing_decision: 0,
      blind_count_vendors: 0,
      parcels_expected: 5,
      missing_searching: 0,
      checking_in: [],
    });
    expect(blind).toMatchObject({
      run_code: codeOfRun(blindRunA),
      vendors_total: 1,
      vendors_waiting: 1,
      blind_count_vendors: 1,
      // A blind-count vendor has no door photo, so it adds no parcel: its stop is counted, never given a number.
      parcels_expected: 0,
    });
    for (const row of rows) {
      expect(row.hub_name).not.toBe('');
      expect(row.rider_name).not.toBe('');
      expect(row.vendor_names.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(row.handed_over_at))).toBe(false);
    }
    // The first row is the older: its handover came first.
    expect(Date.parse(rows[0]?.handed_over_at ?? '')).toBeLessThanOrEqual(
      Date.parse(rows[1]?.handed_over_at ?? ''),
    );
  });

  // Break caught: the scope of the grant not applied to the queue (another hub's run drawn), or a hub outside the grant an error that tells it exists: each officer reads their own hub's runs, and a hub they do not
  // reach is an empty page for any value of `hub_id`.
  it('is the runs of the officer’s own hub alone, and a hub outside the grant is an empty page and not an error', async () => {
    const a = await officerA();
    const b = await officerB();

    expect((await runsOf(b)).map((row) => row.run_id)).toEqual([idOfRun(photoRunB)]);
    expect(await runsOf(a, `?hub_id=${HUB_B}`)).toEqual([]);
    expect(await runsOf(a, `?hub_id=${randomUUID()}`)).toEqual([]);
    expect((await runsOf(a, `?hub_id=${HUB_A}`)).map((row) => row.run_id)).toEqual([
      idOfRun(photoRunA),
      idOfRun(blindRunA),
    ]);
  });

  // Break caught: a Platform Admin shown one hub, or a hub it is not at read without a trace: every hub, and one bounded audited crossing for each hub it reads that is not its own (audit.md section 5.4).
  it('is every hub’s runs for a Platform Admin, who is narrowed by a hub, and each hub read is audited once', async () => {
    const admin = await routes.platformAdmin();
    const before = await crossings('listReceivingRuns');

    const all = await runsOf(admin);
    expect(all.map((row) => row.run_id).toSorted()).toEqual(
      [idOfRun(photoRunA), idOfRun(blindRunA), idOfRun(photoRunB)].toSorted(),
    );
    expect((await runsOf(admin, `?hub_id=${HUB_B}`)).map((row) => row.run_id)).toEqual([
      idOfRun(photoRunB),
    ]);

    const after = await crossings('listReceivingRuns');
    // The first read crossed to both hubs (one event each), the second to the second hub alone.
    expect(
      after.filter((hub) => hub === HUB_A).length - before.filter((hub) => hub === HUB_A).length,
    ).toBe(1);
    expect(
      after.filter((hub) => hub === HUB_B).length - before.filter((hub) => hub === HUB_B).length,
    ).toBe(2);
  });

  // Break caught: a search that matches on the wrong thing (a run's code only, so a vendor or an intake cannot be found; or case-sensitive), a view that ignores what a vendor needs, or a filter that widens: `q`
  // finds a run by its code, an intake by its code and a vendor by the name the stop carries; `view` is waiting, needs_decision or all.
  it('is found by a run’s code, an intake’s code or a vendor’s name in any case, and by the view', async () => {
    const a = await officerA();
    const intake = photoRunA.intakes[1]?.code ?? '';

    expect((await runsOf(a, `?q=${codeOfRun(blindRunA)}`)).map((row) => row.run_id)).toEqual([
      idOfRun(blindRunA),
    ]);
    expect(
      (await runsOf(a, `?q=${encodeURIComponent(codeOfRun(blindRunA).toLowerCase())}`)).map(
        (row) => row.run_id,
      ),
    ).toEqual([idOfRun(blindRunA)]);
    expect((await runsOf(a, `?q=${intake.toLowerCase()}`)).map((row) => row.run_id)).toEqual([
      idOfRun(photoRunA),
    ]);
    // The name of the arranged vendor is on both runs; a name nobody has finds none.
    expect((await runsOf(a, '?q=fixture%20sender')).length).toBe(2);
    expect(await runsOf(a, '?q=nobody-by-this-name')).toEqual([]);
    // Every vendor waits, so the queue of the waiting is the queue, and none needs a decision.
    expect((await runsOf(a, '?view=waiting')).length).toBe(2);
    expect((await runsOf(a, '?view=all')).length).toBe(2);
    expect(await runsOf(a, '?view=needs_decision')).toEqual([]);
  });

  // Break caught: a page that repeats or skips a run (a position that is not the moment and the run together), or a token that is not judged: a page of one is followed to the end with no run twice.
  it('is paged by an opaque position, with no run twice and none missed, and a bad page or token is refused', async () => {
    const a = await officerA();
    const first = await a.client.get(`${RUNS}?page_size=1`);
    expect(first.status).toBe(200);
    const one = pageOf<RunRow>(first);
    expect(one.items.map((row) => row.run_id)).toEqual([idOfRun(photoRunA)]);
    expect(one.next_page_token).not.toBeNull();
    const second = pageOf<RunRow>(
      await a.client.get(
        `${RUNS}?page_size=1&page_token=${encodeURIComponent(one.next_page_token ?? '')}`,
      ),
    );
    expect(second.items.map((row) => row.run_id)).toEqual([idOfRun(blindRunA)]);
    expect(second.next_page_token).toBeNull();

    for (const query of [
      '?page_size=0',
      '?page_size=1000',
      '?page_token=not-a-token',
      '?view=everything',
      '?hub_id=not-a-uuid',
    ]) {
      const refused = await a.client.get(`${RUNS}${query}`);
      expect([refused.status, codeOf(refused)], query).toEqual([400, 'VALIDATION_FAILED']);
    }
  });

  // Break caught: a session without `hub.read` served the queue (the key of the count alone reads it), or a Vendor served it: the key is the list's, held at the hub.
  it('is read under hub.read alone', async () => {
    const countOnly = await routes.actor(
      await newBundle(routes.admin, [grant('hub.intake.count', 'own')]),
      HUB_A,
    );
    const refused = await countOnly.client.get(RUNS);
    expect([refused.status, codeOf(refused)]).toEqual([403, 'PERMISSION_DENIED']);
    const refusedMissing = await countOnly.client.get(MISSING);
    expect([refusedMissing.status, codeOf(refusedMissing)]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('getReceivingRun: one run is one page', () => {
  // Break caught: a page that draws a vendor without its door photos or its own `ETag`, a parcel's photo that is not the stop's own, or a number the officer must not be shown (the declared count of a blind
  // vendor, or any typed count): each vendor is a section, with its parcels in the order the photos were attached and its counts derived from them.
  it('shows each vendor with its parcels, their door photos and its own ETag, and no number of the rider’s', async () => {
    const officer = await officerA();
    const read = await officer.client.get(RUN(idOfRun(photoRunA)));
    expect(read.status).toBe(200);
    const page = read.json() as RunPage;

    expect(page.run).toMatchObject({
      id: idOfRun(photoRunA),
      code: codeOfRun(photoRunA),
      hub_id: HUB_A,
    });
    expect(page.run.service_date).toBe(days.today);
    expect(page.rider_name).not.toBe('');
    expect(page.vendors.map((section) => section.intake_id)).toEqual(
      photoRunA.intakes.map((intake) => intake.id),
    );
    const [first, second] = page.vendors;
    expect(first).toMatchObject({
      receiving_mode: 'PHOTO_CHECK_IN',
      state: 'AWAITING_COUNT',
      parcels_expected: 2,
      arrived_count: 0,
      received_count: null,
      count_variance: null,
      lock: null,
      missing_count: 0,
      extra_count: 0,
      damaged_count: 0,
    });
    expect(second).toMatchObject({ parcels_expected: 3, arrived_count: 0 });
    expect(first?.parcels.map((parcel) => [parcel.ordinal, parcel.origin, parcel.state])).toEqual([
      [1, 'DOOR_PHOTO', 'EXPECTED'],
      [2, 'DOOR_PHOTO', 'EXPECTED'],
    ]);
    expect(first?.parcels.map((parcel) => parcel.photo_evidence_id).toSorted()).toEqual(
      photoRunA.photoIds.slice(0, 2).toSorted(),
    );
    expect(second?.parcels.map((parcel) => parcel.photo_evidence_id).toSorted()).toEqual(
      photoRunA.photoIds.slice(2).toSorted(),
    );
    for (const parcel of [...(first?.parcels ?? []), ...(second?.parcels ?? [])]) {
      expect([parcel.arrived_by_name, parcel.arrived_at, parcel.missing_marked_at]).toEqual([
        null,
        null,
        null,
      ]);
    }
    // Each vendor's `ETag` is the token of its own intake: the one a read of the intake gives, so that the act on that vendor takes it back.
    for (const section of page.vendors) {
      const intake = await officer.client.get(`${API}/hub-intakes/${section.intake_id}`);
      expect(intake.status).toBe(200);
      expect(section.intake_etag).toBe(intake.header('etag'));
    }
    // The rider's number is the intake's (a photo intake shows it, D-D1), and no page of the run carries it.
    expect(keysOf(page).filter((key) => /declared/i.test(key))).toEqual([]);
  });

  // Break caught: a blind-count vendor drawn with parcels, an expected number or an arrived count (a number the officer must count blind, D-D3): its section has none and says it is counted.
  it('shows a blind-count vendor with no parcel, no expected number and no count', async () => {
    const read = await (await officerA()).client.get(RUN(idOfRun(blindRunA)));
    expect(read.status).toBe(200);
    const [section] = (read.json() as RunPage).vendors;
    expect(section).toMatchObject({
      receiving_mode: 'BLIND_COUNT',
      state: 'AWAITING_COUNT',
      parcels_expected: null,
      arrived_count: null,
      received_count: null,
      count_variance: null,
      parcels: [],
    });
  });

  // Break caught: a run of another hub told apart from one that does not exist by anyone but a staff member of a hub that reaches the other (the probe), or a run served to a session that cannot read it: the
  // second hub's run is HUB_SCOPE_VIOLATION for the first hub's officer, an id that matches nothing is NOT_FOUND, and a malformed id is refused.
  it('is HUB_SCOPE_VIOLATION on another hub’s run, NOT_FOUND on a run that does not exist, and VALIDATION_FAILED on an id that is not one', async () => {
    const a = await officerA();
    const other = await a.client.get(RUN(idOfRun(photoRunB)));
    expect([other.status, codeOf(other)]).toEqual([403, 'HUB_SCOPE_VIOLATION']);
    const missing = await a.client.get(RUN(randomUUID()));
    expect([missing.status, codeOf(missing)]).toEqual([404, 'NOT_FOUND']);
    const malformed = await a.client.get(RUN('not-an-id'));
    expect(malformed.status).toBe(400);
    // The same run is read by the officer of its own hub, and by a Platform Admin with an audited crossing.
    expect((await (await officerB()).client.get(RUN(idOfRun(photoRunB)))).status).toBe(200);
    const admin = await routes.platformAdmin();
    const before = (await crossings('getReceivingRun')).length;
    expect((await admin.client.get(RUN(idOfRun(photoRunB)))).status).toBe(200);
    expect((await crossings('getReceivingRun')).length - before).toBe(1);
  });

  // Break caught: a name that is more than a display name (a phone number, an address or a key reaching the page through the names the receiving side says): none is in any answer of the side.
  it('names people and vendors by their display names alone: no phone number, address or key is in any answer', async () => {
    const officer = await officerA();
    for (const path of [RUNS, RUN(idOfRun(photoRunA)), RUN(idOfRun(blindRunA)), MISSING]) {
      const read = await officer.client.get(path);
      expect(read.status, path).toBe(200);
      expect(read.text, path).not.toContain(A_PHONE);
      expect(
        keysOf(read.json()).filter((key) => /phone|email|address|credential|secret/i.test(key)),
        path,
      ).toEqual([]);
    }
  });
});

describe('listMissingParcels and getEvidenceLimits', () => {
  // Break caught: a list that answers for no run (the second view a view that does not exist, or the first an error): with no parcel missing both views are empty pages, and a view that is not one is refused.
  it('is an empty list while no parcel is missing, in both views, and refuses a view that is not one', async () => {
    const officer = await officerA();
    for (const view of ['searching', 'vendor_to_tell']) {
      const read = await officer.client.get(`${MISSING}?view=${view}`);
      expect(read.status, view).toBe(200);
      expect(read.json()).toEqual({ items: [], next_page_token: null });
    }
    const refused = await officer.client.get(`${MISSING}?view=everything`);
    expect([refused.status, codeOf(refused)]).toEqual([400, 'VALIDATION_FAILED']);
  });

  // Break caught: the limits the page offers a photo with being other than the store's own (a content type the store refuses, or a size it will not take), or an answer that may be kept by a cache.
  it('gives the officer the limits a photo is held to, and no cache keeps them', async () => {
    const read = await (await officerA()).client.get(LIMITS);
    expect(read.status).toBe(200);
    expect(read.header('cache-control')).toBe('no-store');
    const limits = read.json() as { allowed_content_types: string[]; max_byte_size: number };
    expect(Object.keys(limits).toSorted()).toEqual(['allowed_content_types', 'max_byte_size']);
    expect(limits.allowed_content_types).toContain('image/jpeg');
    expect(Number.isInteger(limits.max_byte_size)).toBe(true);
    expect(limits.max_byte_size).toBeGreaterThan(0);
    // A Vendor is not served: the limits are the Ops Portal's (the sweep holds the surface; this holds that an anonymous caller is refused).
    const anonymous = await routes.kit.client.fork().get(LIMITS);
    expect([anonymous.status, codeOf(anonymous)]).toEqual([401, 'SESSION_INVALID']);
  });
});

describe('getQueueSummary: the two queues of the receiving side', () => {
  const entryOf = (queues: readonly { queue: string }[], queue: string) =>
    queues.find((each) => each.queue === queue) as
      { queue: string; count: number; oldest_at?: string } | undefined;
  const summaryOf = async (actor: Actor, hub?: string) => {
    const read = await actor.client.get(hub === undefined ? SUMMARY : `${SUMMARY}?hub_id=${hub}`);
    expect(read.status).toBe(200);
    return (read.json() as { queues: { queue: string; count: number; oldest_at?: string }[] })
      .queues;
  };

  // Break caught: a count that is not its list's (the run of two vendors counted twice, or a blind run left out), a moment that is not the oldest handover, or a hub that narrows nothing: runs, not vendors, with
  // the hub the officer reaches and the hub asked for, and 0 for a hub outside the grant (never an error, never another hub's work).
  it('count the runs waiting as the list returns them, by hub, and the parcels being searched for', async () => {
    const a = await officerA();
    const rows = await runsOf(a, '?view=waiting');
    const waitingA = entryOf(await summaryOf(a), 'HUB_RECEIVING_RUNS_WAITING');
    expect(waitingA).toEqual({
      queue: 'HUB_RECEIVING_RUNS_WAITING',
      count: 2,
      oldest_at: rows[0]?.handed_over_at,
    });
    expect(entryOf(await summaryOf(a), 'HUB_MISSING_PARCELS_SEARCHING')).toEqual({
      queue: 'HUB_MISSING_PARCELS_SEARCHING',
      count: 0,
    });

    const admin = await routes.platformAdmin();
    expect(entryOf(await summaryOf(admin), 'HUB_RECEIVING_RUNS_WAITING')?.count).toBe(3);
    expect(entryOf(await summaryOf(admin, HUB_A), 'HUB_RECEIVING_RUNS_WAITING')?.count).toBe(2);
    const second = entryOf(await summaryOf(admin, HUB_B), 'HUB_RECEIVING_RUNS_WAITING');
    expect(second?.count).toBe(1);
    expect(second?.oldest_at).toBe((await runsOf(admin, `?hub_id=${HUB_B}`))[0]?.handed_over_at);
    // The officer of the first hub asking for the second: nothing of it is counted, and nothing is said.
    expect(entryOf(await summaryOf(a, HUB_B), 'HUB_RECEIVING_RUNS_WAITING')).toEqual({
      queue: 'HUB_RECEIVING_RUNS_WAITING',
      count: 0,
    });
  });

  // Break caught: the queue offered to a session that cannot read its list: a session without `hub.read` has no entry for either queue (and no zero in its place).
  it('have no entry for a session that does not hold hub.read', async () => {
    const reader = await routes.actor(
      await newBundle(routes.admin, [grant('pickup.read', 'own')]),
      HUB_A,
    );
    const queues = await summaryOf(reader);
    expect(entryOf(queues, 'HUB_RECEIVING_RUNS_WAITING')).toBeUndefined();
    expect(entryOf(queues, 'HUB_MISSING_PARCELS_SEARCHING')).toBeUndefined();
  });
});

describe('the manifest of a run, as the keys that read intakes see it (migration 0107)', () => {
  // Break caught: a policy that shows the keys of the receiving side every manifest of the hub (a run in progress, a draft: the pickup domain's), or one that shows another hub's, or a session that holds no hub: the three
  // keys that read intakes see the manifests of the hubs of the grant that the hub has been handed (a manifest that has an intake) and no other.
  it('is shown to the three keys that read intakes for the runs the hub has been handed, in the hubs of the grant alone', async () => {
    const draft = await insertManifest(routes.admin, manifestRow(HUB_A));
    const context = (key: string, hubs: readonly string[]): SecurityContext => ({
      principalType: 'STAFF',
      principalId: randomUUID(),
      sessionId: randomUUID(),
      surface: 'OPS_PORTAL',
      authorizationKey: key,
      hubScopeMode: 'SET',
      authorizedHubIds: [...hubs],
      correlationId: 'manifest-policy',
    });
    const seenBy = async (key: string, hubs: readonly string[]): Promise<string[]> =>
      (
        await routes.built.service.transactionWithContext(
          context(key, hubs),
          async (tx) =>
            (await tx.execute(sql`select id from pickup_manifest`)).rows as unknown as {
              id: string;
            }[],
        )
      )
        .map((row) => row.id)
        .toSorted();
    const handedA = [idOfRun(photoRunA), idOfRun(blindRunA)].toSorted();

    for (const key of ['hub.read', 'hub.intake.count', 'hub.osd.adjudicate']) {
      expect(await seenBy(key, [HUB_A]), key).toEqual(handedA);
    }
    expect(await seenBy('hub.read', [HUB_B])).toEqual([idOfRun(photoRunB)]);
    expect(await seenBy('hub.read', [HUB_A, HUB_B])).toEqual(
      [...handedA, idOfRun(photoRunB)].toSorted(),
    );
    expect(await seenBy('hub.read', [])).toEqual([]);
    // The draft run of the first hub, which no hub has been handed, is in none of them.
    expect(await seenBy('hub.read', [HUB_A, HUB_B])).not.toContain(draft.id);
    // The check that a run has an intake is a function and not a subquery in the policy: a policy's subquery is checked against the privileges of whoever reads the table, and the delivery worker's lane reads
    // manifests and may not read intakes, while a function needs EXECUTE alone (the first CI run of the branch: the lane relayed nothing). The lane has the one and not the other, and the policy names no role.
    const holds = async (statement: string): Promise<boolean | undefined> =>
      (await routes.rows<{ ok: boolean }>(statement))[0]?.ok;
    const execute = (role: string): Promise<boolean | undefined> =>
      holds(
        `select has_function_privilege('${role}', 'melarc.run_has_intake(uuid)', 'EXECUTE') as ok`,
      );
    expect(await execute('melarc_worker_cap_notification')).toBe(true);
    expect(await execute('melarc_api_runtime')).toBe(true);
    expect(await execute('public')).toBe(false);
    expect(
      await holds(
        `select has_table_privilege('melarc_worker_cap_notification', 'pickup_intake', 'SELECT') as ok`,
      ),
    ).toBe(false);
    const [policy] = await routes.rows<{ roles: string[]; qual: string }>(
      `select roles::text[] as roles, qual from pg_policies where tablename = 'pickup_manifest' and policyname = 'pickup_manifest_receiving_read'`,
    );
    expect(policy?.roles).toEqual(['public']);
    expect(policy?.qual).toContain('run_has_intake');
    expect(policy?.qual).not.toContain('pickup_intake');
  });
});

/** The hubs of the audited crossings an operation has written, in the order they were written: one entry for each. */
async function crossings(operation: string): Promise<string[]> {
  const rows = await routes.rows<{ hub: string }>(
    `select responsible_hub_id as hub from audit_event
      where event_code = 'auth.hub_boundary.crossed' and related_ids->>'operation_id' = $1
      order by recorded_at, id`,
    [operation],
  );
  return rows.map((row) => row.hub);
}

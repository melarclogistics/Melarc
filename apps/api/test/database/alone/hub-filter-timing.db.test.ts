// Runs alone: its bounds are wall-clock time (a read of a hub the session does not reach must answer in milliseconds, with 200,000 rows in that hub), and it loads tables of that size.
// Functional half, which runs on a pull request: ../hub-filters.db.test.ts and ../hub-filters-older-lists.db.test.ts (a hub outside the grant is answered empty and a count equals its list; no time asserted).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESERVED_SYSTEM_ACTOR_ID } from '../../../src/staff/reserved-system-actor.js';
import type { TestClient } from '../../../src/test-support/test-client.js';
import { BUNDLE_IDS } from '../../../src/tools/seed/bundles.js';
import { ARRANGER } from '../support/pickups.js';
import { insertRider, riderRow } from '../support/riders.js';
import { arrangedRider, type ArrangedRider } from '../support/runs.js';
import { API, HUB_A, HUB_B, type Actor } from '../support/staff-routes.js';
import {
  startVendorRoutes,
  type ArrangedVendor,
  type VendorRoutes,
} from '../support/vendor-routes.js';

/**
 * Task A1 (the Product Owner's audit of 7 November 2026), `AC-HUBF-05` and `GBT-GS14`: **a hub the session may not reach, and a hub that does not
 * exist, are indistinguishable to a caller, down to the time the answer takes.** The hub filter is a leakproof equality, so for a hub outside the
 * grant the database used to walk that hub's index before row-level security discarded every row it found: 0.7 to 0.9 seconds for a hub of 200,000
 * rows, against milliseconds for an identifier that names no hub, and seeded hub ids are guessable. A staff session could learn that a hub exists and
 * roughly how much it holds. The table here is large enough for that to show (200,000 requests and messages and 20,000 runs in a second hub, a tenth
 * of that in the first), the sessions are an Ops Staff officer of the first hub, a Vendor of the first hub and a Rider of it, and each read is timed
 * end to end through the real application for the second hub and for an identifier that names no hub.
 *
 * - **Staff, a hub outside the set of its grant** (the three lists and the summary): answered with no transaction and no statement. Both answers take
 *   the time of the request's own guards.
 * - **A Vendor, the list of requests** and **a Rider, the list of runs**: the statement names what the caller owns (its organisation, its assignment) so
 *   that the planner starts from that index and not the hub's. The time depends on what the caller owns and not on what the hub holds.
 * - **A Rider is not served the lists of requests** (task A3.1 of the audit follow-up: `listPickupRequests` and `getPickupRequest` name the browser session
 *   alone), so there is no timing of a Rider's list of requests to take; its refusal is held by `hub-filters.db.test.ts` (`AC-HUBF-15`).
 *
 * A read is timed as the median of several, after one that is not counted, the two answers asked in turn. The bounds are generous (50 milliseconds for a
 * read that does no work of its own, or four times what the caller's own session read costs on a loaded machine, and a small multiple of the other
 * answer) beside the 75 to 1,400 milliseconds of a leak at this size, and the file runs alone so that no other test of the suite is on the machine.
 */
const REQUESTS = `${API}/pickup-requests`;
const RUNS = `${API}/pickup-manifests`;
const MESSAGES = `${API}/notifications`;
const SUMMARY = `${API}/ops/queue-summary`;

/** An identifier that names no hub. */
const NO_HUB = '0de0de0d-0000-4000-8000-0000000000ee';

/** The second hub's rows, and the first hub's (a tenth of them). `HUB_TIMING_ROWS` lowers them for a quick look: below about 100,000 the leak does not show. */
const ROWS_SECOND_HUB = Number(process.env.HUB_TIMING_ROWS ?? 200_000);
const ROWS_FIRST_HUB = ROWS_SECOND_HUB / 10;
const RUNS_SECOND_HUB = ROWS_SECOND_HUB / 10;

const SESSION = `${API}/auth/session`;

/**
 * A read that does no work of its own must answer within this, in milliseconds, on a quiet machine (the request's own guards and nothing else), or
 * within four times what the caller's own session read costs now, whichever is longer. A leak at this size is 75 milliseconds for 20,000 runs and 400
 * to 1,400 for 200,000 requests or messages.
 */
const FAST_MS = 50;
/** One answer may take at most this many times the other, plus the floor that separates a difference from noise. */
const MULTIPLE = 3;
const FLOOR_MS = 10;
const SAMPLES = 9;

let routes: VendorRoutes;
let vendor: ArrangedVendor;
let browser: TestClient;
let rider: ArrangedRider;
let officer: Actor;

/** Organisations of a hub, made past row-level security as the arranged fixtures are; their identifiers in a stable order. */
async function organisations(hub: string, count: number, label: string): Promise<string[]> {
  await routes.admin.query(
    `insert into vendor_organization (id, responsible_hub_id, legal_name, trading_name, contact_email, operational_status, created_by,
                                      decided_by, decided_at, decision_reason)
     select gen_random_uuid(), $1::uuid, $2 || ' ' || g, null, 'contact@example.test', 'ACTIVE', $3::uuid, $3::uuid, now(), null
       from generate_series(1, $4::int) g`,
    [hub, label, RESERVED_SYSTEM_ACTOR_ID, count],
  );
  const rows = await routes.admin.query<{ id: string }>(
    `select id from vendor_organization where legal_name like $1 order by id`,
    [`${label} %`],
  );
  return rows.rows.map((row) => row.id);
}

beforeAll(async () => {
  routes = await startVendorRoutes();
  vendor = await routes.vendor();
  browser = routes.browser(vendor.device.credential.token);
  expect((await routes.signIn(browser, vendor.row.accountIdentifier, vendor.secret)).status).toBe(
    200,
  );
  officer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
  rider = await arrangedRider(routes.kit, routes.admin, HUB_A);

  const firstHubOrganisations = await organisations(HUB_A, 20, 'Timing first hub');
  const secondHubOrganisations = await organisations(HUB_B, 200, 'Timing second hub');

  // The requests, one statement: the first hub's are the Vendor under test's 500 and the rest of a tenth of the second hub's, spread over twenty
  // organisations; the second hub's are spread over two hundred. The states are the mix of a real history (most are confirmed).
  await routes.admin.query(
    `insert into pickup_request (id, code, vendor_organization_id, ad_hoc_sender_id, sender_name, responsible_hub_id, pickup_intent, state,
                                 declared_package_count, resolved_pickup_location, primary_phone, scheduled_service_date,
                                 default_payer_intent, created_by, attempt_number, created_at, confirmed_at, confirmed_by, cancelled_at, cancelled_by,
                                 cutoff_exception_state)
     select gen_random_uuid(), 'ACC-PR-' || translate(lpad(to_hex(g), 6, '0'), '0123456789abcdef', '23456789ABCDEFGH'),
            case when g <= 500 then $5::uuid
                 when g <= $1::int then ($3::uuid[])[1 + (g % 20)]
                 else ($4::uuid[])[1 + (g % 200)] end,
            null, 'Fixture Sender ' || (g % 5000),
            case when g <= $1::int then $6::uuid else $7::uuid end,
            'OWN_PACKAGES', s.state, 3, '{"address":"Fixture shop"}'::jsonb,
            '+23320' || lpad((g % 10000000)::text, 7, '0'),
            ((now() at time zone 'Africa/Accra')::date - (g % 730)),
            'RECIPIENT_PAYS', $2::uuid, 1,
            now() - ((g % 730) || ' days')::interval - ((g % 80000) || ' seconds')::interval,
            case when s.state in ('CONFIRMED', 'CANCELLED') then now() - ((g % 730) || ' days')::interval else null end,
            case when s.state in ('CONFIRMED', 'CANCELLED') then $2::uuid else null end,
            case when s.state = 'CANCELLED' then now() - ((g % 730) || ' days')::interval else null end,
            case when s.state = 'CANCELLED' then $2::uuid else null end,
            case when s.state = 'CONFIRMED' and g % 700 = 0 then 'PENDING_OPS_REVIEW' else null end
       from (
         select g,
                case
                  when g % 1000 = 0 then 'PENDING'
                  when g % 100 between 1 and 8 then 'CANCELLED'
                  when g % 100 between 9 and 10 then 'DECLINED'
                  else 'CONFIRMED'
                end as state
           from generate_series(1, $8::int) g
       ) s`,
    [
      ROWS_FIRST_HUB,
      ARRANGER,
      firstHubOrganisations,
      secondHubOrganisations,
      vendor.row.organizationId,
      HUB_A,
      HUB_B,
      ROWS_FIRST_HUB + ROWS_SECOND_HUB,
    ],
  );
  await routes.admin.query('analyze pickup_request');

  // The runs: the second hub's over fifty riders, the first hub's over five, and the Rider under test's forty, dispatched (the only ones it is shown).
  const secondHubRiders: string[] = [];
  for (let index = 0; index < 50; index += 1) {
    secondHubRiders.push((await insertRider(routes.admin, riderRow({ hubId: HUB_B }))).id);
  }
  const firstHubRiders: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    firstHubRiders.push((await insertRider(routes.admin, riderRow({ hubId: HUB_A }))).id);
  }
  await routes.admin.query(
    `insert into pickup_manifest (id, code, responsible_hub_id, service_date, state, assigned_rider_id, assigned_at, dispatched_at, started_at, completed_at, created_by, created_at)
     select gen_random_uuid(),
            'ACC-MF-' || translate(lpad(to_hex(g), 6, '0'), '0123456789abcdef', '23456789ABCDEFGH'),
            case when g <= $1::int then $2::uuid else $3::uuid end,
            ((now() at time zone 'Africa/Accra')::date - (g % 730)),
            s.state,
            case when g <= $1::int then ($4::uuid[])[1 + (g % 50)]
                 when g <= $1::int + 40 then $6::uuid
                 else ($5::uuid[])[1 + (g % 5)] end,
            now() - ((g % 730) || ' days')::interval,
            now() - ((g % 730) || ' days')::interval,
            case when s.state in ('IN_PROGRESS', 'COMPLETED') then now() - ((g % 730) || ' days')::interval else null end,
            case when s.state = 'COMPLETED' then now() - ((g % 730) || ' days')::interval else null end,
            $7::uuid,
            now() - ((g % 730) || ' days')::interval - ((g % 80000) || ' seconds')::interval
       from (select g, case when g % 100 < 2 then 'IN_PROGRESS' when g % 100 < 8 then 'DISPATCHED' else 'COMPLETED' end as state
               from generate_series(1, $8::int) g) s`,
    [
      RUNS_SECOND_HUB,
      HUB_B,
      HUB_A,
      secondHubRiders,
      firstHubRiders,
      rider.id,
      ARRANGER,
      RUNS_SECOND_HUB + RUNS_SECOND_HUB / 10,
    ],
  );
  await routes.admin.query('analyze pickup_manifest');

  // The message log: one delivered SMS message for each request, in the hub of its request. The triggers that guard the outbox and the log are put
  // aside for the bulk load and put back before anything reads (the arranged rows are as the lane leaves them).
  await routes.admin.query('begin');
  await routes.admin.query('alter table outbox disable trigger user');
  await routes.admin.query('alter table notification disable trigger user');
  await routes.admin.query(
    `create temp table ob on commit drop as
       select g, gen_random_uuid() as id, gen_random_uuid() as subject, case when g <= $3::int then $1::uuid else $2::uuid end as hub,
              now() - ((g % 730) || ' days')::interval - ((g % 80000) || ' seconds')::interval as created
         from generate_series(1, $4::int) g`,
    [HUB_A, HUB_B, ROWS_FIRST_HUB, ROWS_FIRST_HUB + ROWS_SECOND_HUB],
  );
  await routes.admin.query(
    `insert into outbox (id, event_type, aggregate_type, aggregate_id, responsible_hub_id, originating_principal_type,
                         originating_principal_id, operation_id, correlation_id, relay_state, relayed_at, last_outcome,
                         attempt_count, lease_version)
     select id, 'pickup.request.confirmed', 'PICKUP_REQUEST', subject, hub, 'STAFF', '5eed0000-0000-4000-8000-0000000000e1',
            'confirmPickupRequest', gen_random_uuid(), 'RELAYED', now(), 'MATERIALISED', 1, 1
       from ob`,
  );
  await routes.admin.query(
    `insert into notification (id, outbox_id, message_kind, template_version, audience, channel, responsible_hub_id,
                               subject_type, subject_id, state, suppression_reason, outcome_class, provider_outcome_class,
                               destination_hint, destination_digest, provider_message_ref, attempt_count, expires_at,
                               lease_owner, lease_version, lease_expires_at, sent_at, delivered_at, created_at, parameters)
     select gen_random_uuid(), id, 'PICKUP_CONFIRMED_SENDER', 1, 'AD_HOC_SENDER', 'SMS', hub, 'PICKUP_REQUEST', subject, 'DELIVERED',
            null, 'ACCEPTED', null, '+233******111', repeat('d1', 32), 'provider-ref-arranged', 1, created + interval '6 hours',
            null, 0, null, created, created, created, '{}'::jsonb
       from ob`,
  );
  await routes.admin.query('alter table outbox enable trigger user');
  await routes.admin.query('alter table notification enable trigger user');
  await routes.admin.query('commit');
  await routes.admin.query('analyze notification');
  await routes.admin.query('analyze outbox');
}, 900_000);

afterAll(async () => {
  await routes.stop();
});

/** One timed read of `path` by `client`, in milliseconds; the read must be answered. */
async function timed(client: TestClient, path: string): Promise<number> {
  const started = performance.now();
  const response = await client.get(path);
  const elapsed = performance.now() - started;
  expect(response.status, path).toBe(200);
  return elapsed;
}

const median = (times: readonly number[]): number =>
  [...times].toSorted((a, b) => a - b)[Math.floor(times.length / 2)] ?? Number.NaN;

/**
 * What a read of this caller costs when it does no work of its own beyond its guards and the answer of its own session (`getCurrentSession`): the
 * yardstick of "fast" on the machine as it is now. A fixed bound alone would fail on a loaded machine for a reason that is not the hub's.
 */
async function baselineOf(client: TestClient): Promise<number> {
  await timed(client, SESSION);
  const times: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) times.push(await timed(client, SESSION));
  return median(times);
}

const withHub = (path: string, hub: string): string => `${path}?hub_id=${hub}`;

/**
 * Times the read for the second hub (it exists, and holds the rows) and for an identifier that names no hub, and asserts what the audit asks: neither
 * answer is slow (each is within `FAST_MS` or four of the caller's own baseline, whichever is the longer) and neither is more than a small multiple of
 * the other. The two are asked in turn, so that a change in the machine's load between them
 * falls on both; each is the median of `SAMPLES`, after one that is not counted.
 */
async function indistinguishable(label: string, client: TestClient, path: string): Promise<void> {
  const baseline = await baselineOf(client);
  const existingPath = withHub(path, HUB_B);
  const missingPath = withHub(path, NO_HUB);
  await timed(client, existingPath);
  await timed(client, missingPath);
  const existingTimes: number[] = [];
  const missingTimes: number[] = [];
  for (let sample = 0; sample < SAMPLES; sample += 1) {
    existingTimes.push(await timed(client, existingPath));
    missingTimes.push(await timed(client, missingPath));
  }
  const existing = median(existingTimes);
  const missing = median(missingTimes);
  // Printed so that the figures the documents quote can be read from a run: the median of the samples, in milliseconds, end to end through the application.
  console.info(
    `${label}: a hub of ${String(ROWS_SECOND_HUB)} rows ${existing.toFixed(1)} ms, a hub that does not exist ${missing.toFixed(1)} ms (the caller's own session: ${baseline.toFixed(1)} ms)`,
  );
  const bound = Math.max(FAST_MS, 4 * baseline);
  expect(existing, `${label}: a hub that exists, outside the grant`).toBeLessThan(bound);
  expect(missing, `${label}: a hub that does not exist`).toBeLessThan(bound);
  expect(existing, `${label}: the hub that exists against the one that does not`).toBeLessThan(
    MULTIPLE * missing + FLOOR_MS,
  );
  expect(missing, `${label}: the hub that does not exist against the one that does`).toBeLessThan(
    MULTIPLE * existing + FLOOR_MS,
  );
}

describe('the arrangement is large enough for the time of a hub to show', () => {
  // Break caught: a table too small for the leak to show, which would let every assertion below pass for the wrong reason.
  it('holds the rows it says it holds, in the second hub', async () => {
    const [requests] = await routes.rows<{ n: string }>(
      `select count(*)::text as n from pickup_request where responsible_hub_id = $1`,
      [HUB_B],
    );
    const [messages] = await routes.rows<{ n: string }>(
      `select count(*)::text as n from notification where responsible_hub_id = $1`,
      [HUB_B],
    );
    const [runs] = await routes.rows<{ n: string }>(
      `select count(*)::text as n from pickup_manifest where responsible_hub_id = $1`,
      [HUB_B],
    );
    const [vendorRequests] = await routes.rows<{ n: string }>(
      `select count(*)::text as n from pickup_request where vendor_organization_id = $1`,
      [vendor.row.organizationId],
    );
    expect(Number(requests?.n)).toBe(ROWS_SECOND_HUB);
    expect(Number(messages?.n)).toBe(ROWS_SECOND_HUB);
    expect(Number(runs?.n)).toBe(RUNS_SECOND_HUB);
    expect(Number(vendorRequests?.n)).toBe(500);
  });
});

describe('a staff session of the first hub (AC-HUBF-05, GBT-GS14)', () => {
  // Break caught: a hub outside the grant that is read (the index of the other hub walked and every row discarded: 0.7 to 0.9 seconds at this size,
  // against milliseconds for a hub that does not exist), so that the time tells whether the hub exists and how much it holds. Each read is timed by
  // a session of its own: the authenticated API allows a session 120 requests a minute (`rate_limit_authenticated_api`), and the thirty or so that
  // one timing makes would take a shared session over it.
  it.each([
    ['the list of pickup requests', REQUESTS],
    ['the list of pickup runs', RUNS],
    ['the message log', MESSAGES],
    ['the queue summary', SUMMARY],
  ])(
    'answers %s for a hub that exists and for one that does not in the same short time',
    async (label, path) => {
      const timer = await routes.actor(BUNDLE_IDS.opsStaff, HUB_A);
      await indistinguishable(`staff, ${label}`, timer.client, path);
    },
    120_000,
  );

  // Break caught: a shortcut that answers fast because it answers wrongly (an error, a refusal, the other hub's rows), or one that is fast for the
  // second hub because it is fast for every hub: the session's own hub, which it may read, still returns its rows.
  it('still answers what it holds for its own hub, and an empty page and a count of 0 for the others', async () => {
    const own = await officer.client.get(withHub(REQUESTS, HUB_A));
    expect(own.status).toBe(200);
    expect((own.json() as { items: unknown[] }).items.length).toBeGreaterThan(0);
    for (const hub of [HUB_B, NO_HUB]) {
      for (const path of [REQUESTS, RUNS, MESSAGES]) {
        const answer = await officer.client.get(withHub(path, hub));
        expect([answer.status, answer.json()], `${path} for ${hub}`).toEqual([
          200,
          { items: [], next_page_token: null },
        ]);
      }
      const summary = await officer.client.get(withHub(SUMMARY, hub));
      const queues = (summary.json() as { queues: { queue: string; count: number }[] }).queues;
      expect(summary.status).toBe(200);
      expect(queues.length).toBeGreaterThan(0);
      expect(queues.every((entry) => entry.count === 0)).toBe(true);
    }
  });
});

describe('a Vendor of the first hub (AC-HUBF-12; the audit of 7 November 2026)', () => {
  // Break caught: the Vendor's own organisation left out of its statement, so that the database starts from the hub's index and lets row-level
  // security discard the rows of every other vendor (0.4 seconds at this size for a hub that exists, against microseconds for one that does not).
  it('answers the list of requests for a hub that exists, where it has no request, and for one that does not in the same short time', async () => {
    await indistinguishable('vendor, the list of requests', browser, REQUESTS);
  }, 120_000);

  // Break caught: a hub that narrows nothing for the Vendor, or an organisation named in a way that widens the list.
  it('still reads its own requests of its own hub, and nothing of the second hub', async () => {
    const own = await browser.get(`${withHub(REQUESTS, HUB_A)}&page_size=100`);
    expect(own.status).toBe(200);
    const items = (own.json() as { items: { responsible_hub_id: string }[] }).items;
    expect(items.length).toBe(100);
    expect(items.every((item) => item.responsible_hub_id === HUB_A)).toBe(true);
    const other = await browser.get(withHub(REQUESTS, HUB_B));
    expect(other.json()).toEqual({ items: [], next_page_token: null });
  });
});

describe('a Rider of the first hub (AC-HUBF-12; the audit of 7 November 2026)', () => {
  // Break caught: the Rider's own assignment left out of its statement, so that the database starts from the hub's index and lets row-level security
  // discard the runs of every other rider (50 milliseconds at this size for a hub that exists, against microseconds for one that does not).
  it('answers the list of runs for a hub that exists, where it has no run, and for one that does not in the same short time', async () => {
    await indistinguishable('rider, the list of runs', rider.client, RUNS);
  }, 120_000);

  // Break caught: runs that are not the Rider's shown for a hub, or its own hidden by the statement that names it.
  it('still reads its own dispatched runs of its own hub, and nothing of the second hub', async () => {
    const own = await rider.client.get(`${withHub(RUNS, HUB_A)}&page_size=100`);
    expect(own.status).toBe(200);
    const items = (own.json() as { items: { responsible_hub_id: string }[] }).items;
    expect(items.length).toBe(40);
    expect(items.every((item) => item.responsible_hub_id === HUB_A)).toBe(true);
    const other = await rider.client.get(withHub(RUNS, HUB_B));
    expect(other.json()).toEqual({ items: [], next_page_token: null });
  });
});
